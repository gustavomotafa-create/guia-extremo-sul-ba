const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_JOB_TTL_DAYS,
  DEFAULT_STALE_AFTER_DAYS,
  MAX_SOURCE_RESPONSE_BYTES,
  EXTREMO_SUL_MUNICIPALITY_NAMES,
  EXPECTED_MUNICIPALITY_COUNT,
  JOBICY_BRAZIL_SOURCE,
  REMOTE_OK_API_URL,
  REMOTE_OK_SOURCE,
  MAX_PERSIST_LEADS_PER_RUN,
  RECONCILE_BATCH_SIZE,
  addRemoteOkSourceReference,
  buildAutomatedJobLeadPayload,
  buildExpiredLeadPatch,
  calculateExpiresAt,
  persistJobsWithRepository,
  reconcileExpiredPendingLeads,
  evaluateValidity,
  fetchRemoteOkJobs,
  fetchJobicyJobs,
  fetchBahiaMunicipalities,
  mapRemoteOkRecord,
  mapJobicyRecord,
  normalizeJob,
  main,
  parseSources,
  runJobSearch,
  validateMunicipalities,
} = require("./job-bot");

function municipalityFixture(index, name = `Município ${index}`) {
  return {
    id: String(2900000 + index).padStart(7, "0"),
    nome: name,
    microrregiao: { mesorregiao: { UF: { sigla: "BA" } } },
  };
}

function municipalityListWithExtremoSul() {
  const names = [
    "Alcobaça",
    "Caravelas",
    "Ibirapuã",
    "Itamaraju",
    "Itanhém",
    "Jucuruçu",
    "Lajedão",
    "Medeiros Neto",
    "Mucuri",
    "Nova Viçosa",
    "Prado",
    "Teixeira de Freitas",
    "Vereda",
  ];
  return Array.from({ length: EXPECTED_MUNICIPALITY_COUNT }, (_, index) => (
    municipalityFixture(index, names[index] || `Município ${index}`)
  ));
}

const source = {
  id: "approved-feed",
  name: "Fonte autorizada",
  type: "json",
  enabled: true,
  feedUrl: "https://jobs.example.test/feed.json",
  url: "https://jobs.example.test/feed.json",
  termsUrl: "https://jobs.example.test/terms",
  attributionUrl: "https://jobs.example.test/attribution",
  authorized: true,
};

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function registeredTestSource(overrides = {}) {
  const configured = { ...source, ...overrides };
  return parseSources(
    JSON.stringify([configured]),
    new Map([[configured.id, configured.feedUrl]]),
  )[0];
}

function authorizedSourcesJson(overrides = {}) {
  const configured = { ...source, ...overrides };
  return JSON.stringify([{
    id: configured.id,
    name: configured.name,
    type: "json",
    enabled: true,
    authorized: true,
    url: configured.feedUrl,
    termsUrl: configured.termsUrl,
    attributionUrl: configured.attributionUrl,
  }]);
}

function normalizedPersistenceJob(overrides = {}, now = new Date("2026-01-10T00:00:00.000Z")) {
  const municipalities = validateMunicipalities(municipalityListWithExtremoSul());
  return normalizeJob({
    id: "persistence-1",
    title: "Tecnico de suporte",
    company: "Empresa Exemplo",
    city: "Teixeira de Freitas",
    url: "https://jobs.example.test/vagas/persistence-1",
    description: "Atendimento e suporte.",
    ...overrides,
  }, source, municipalities, now);
}

function mockLeadRepository(initialDocuments = []) {
  const documents = new Map(initialDocuments.map(([id, data]) => [id, { ...data }]));
  let timestampCount = 0;
  const repository = {
    documents,
    serverTimestamp() {
      timestampCount += 1;
      return `server-time-${timestampCount}`;
    },
    async upsertLead(id, buildPlan) {
      const existing = documents.get(id) || null;
      const plan = buildPlan(existing);
      documents.set(id, { ...(existing || {}), ...plan.data });
      return plan;
    },
    async listExpiredCandidates({ now, limit, cursor }) {
      const cutoff = now.getTime();
      const candidates = [...documents.entries()]
        .filter(([, data]) => {
          const expiry = Date.parse(data.expiresAt || data.validThrough || "");
          return Number.isFinite(expiry) && expiry <= cutoff;
        })
        .sort((left, right) => (
          Date.parse(left[1].expiresAt || left[1].validThrough)
          - Date.parse(right[1].expiresAt || right[1].validThrough)
        ));
      const cursorIndex = cursor
        ? candidates.findIndex(([id]) => id === cursor) + 1
        : 0;
      return candidates.slice(cursorIndex, cursorIndex + limit).map(([id, data]) => ({
        id,
        data: { ...data },
        cursor: id,
      }));
    },
    async reconcileLead(id, now) {
      const existing = documents.get(id);
      if (!existing) return false;
      const patch = buildExpiredLeadPatch(existing, now, repository.serverTimestamp());
      if (!patch) return false;
      documents.set(id, { ...existing, ...patch });
      return true;
    },
  };
  return repository;
}

function reportFixture() {
  return {
    status: "completed",
    municipalityCount: EXPECTED_MUNICIPALITY_COUNT,
    sourcesConfigured: 1,
    sourcesAttempted: 1,
    sourcesSucceeded: 1,
    sourceRecords: 1,
    jobsNormalized: 1,
    duplicateJobs: 0,
    skippedRecords: 0,
    availableJobs: 0,
    unavailableJobs: 0,
    unknownAvailabilityJobs: 1,
    activeValidityJobs: 1,
    expiredJobs: 0,
    staleJobs: 0,
    duplicatesIgnored: 0,
    countryRemoteJobs: 0,
    firestoreWrites: 0,
    geographicSummary: {
      extremoSulBahia: { count: 0, jobs: [] },
      outrosMunicipiosBahia: { count: 0, jobs: [] },
      remotoBrasil: { count: 0, jobs: [] },
      semLocalConfirmado: { count: 0, jobs: [] },
    },
    sourceResults: [],
    warnings: [],
    errors: [],
  };
}

test("validates exactly 417 unique Bahia municipalities", () => {
  const municipalities = validateMunicipalities(
    Array.from({ length: EXPECTED_MUNICIPALITY_COUNT }, (_, index) => municipalityFixture(index)),
  );
  assert.equal(municipalities.length, 417);
  assert.throws(() => validateMunicipalities(municipalities.slice(1)), /expected 417/);
  assert.throws(
    () => validateMunicipalities([...municipalities.slice(0, -1), municipalityFixture(0)]),
    /invalid, duplicate, or non-BA/,
  );
});

test("fetches and validates the official IBGE municipality response", async () => {
  let requestedUrl;
  const municipalities = Array.from({ length: 417 }, (_, index) => municipalityFixture(index));
  const result = await fetchBahiaMunicipalities(async (url) => {
    requestedUrl = url;
    return response(municipalities);
  });
  assert.match(requestedUrl, /servicodados\.ibge\.gov\.br\/api\/v1\/localidades\/estados\/BA\/municipios$/);
  assert.equal(result.length, 417);
});

test("requires explicit authorization, attribution, JSON type, and safe HTTPS hosts for configured sources", () => {
  const warnings = [];
  const parsed = parseSources(JSON.stringify([
    source,
    { ...source, id: "unauthorized", authorized: false },
    { ...source, id: "disabled", enabled: false },
  ]), new Map(), warnings);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].authorized, true);
  assert.equal(parsed[0].type, "json");
  assert.equal(parsed[0].attributionUrl, source.attributionUrl);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].message, /lacks explicit authorization/);
  assert.match(warnings[1].message, /not explicitly enabled/);

  const rejectedWarnings = [];
  const invalidSources = [
    { ...source, id: "http-feed", url: "http://jobs.example.test/feed.json" },
    { ...source, id: "localhost", url: "https://localhost/feed.json" },
    { ...source, id: "loopback", url: "https://127.0.0.1/feed.json" },
    { ...source, id: "private-v4", url: "https://10.2.3.4/feed.json" },
    { ...source, id: "private-v4-172", url: "https://172.16.0.4/feed.json" },
    { ...source, id: "private-v4-192", url: "https://192.168.1.4/feed.json" },
    { ...source, id: "loopback-v6", url: "https://[::1]/feed.json" },
    { ...source, id: "private-v6", url: "https://[fd00::1]/feed.json" },
    { ...source, id: "local-domain", url: "https://feed.internal.local/jobs.json" },
    { ...source, id: "private-attribution", attributionUrl: "https://192.168.1.9/license" },
  ];
  assert.deepEqual(
    parseSources(JSON.stringify(invalidSources), new Map(), rejectedWarnings),
    [],
  );
  assert.equal(rejectedWarnings.length, invalidSources.length);
  assert.ok(rejectedWarnings.every((warning) => /ignored/.test(warning.message)));

  assert.deepEqual(
    parseSources(JSON.stringify([{ ...source, authorized: undefined }]), new Map()),
    [],
  );
  assert.deepEqual(
    parseSources(JSON.stringify([{ ...source, attributionUrl: undefined }]), new Map()),
    [],
  );
  assert.deepEqual(
    parseSources(JSON.stringify([{ ...source, type: "html" }]), new Map()),
    [],
  );

  assert.throws(
    () => parseSources(JSON.stringify([{
      ...source,
      url: REMOTE_OK_API_URL,
      attributionUrl: REMOTE_OK_API_URL,
    }])),
    /Remote OK, Remotive, and SINE sources are blocked/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{
      ...source,
      id: "remoteok-proxy",
      url: "https://proxy.example.test/feed.json",
    }])),
    /Remote OK, Remotive, and SINE sources are blocked/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{ ...source, url: "https://api.remoteok.com/feed.json" }])),
    /Remote OK, Remotive, and SINE sources are blocked/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{ ...source, url: "https://api.remotive.com/feed.json" }])),
    /Remote OK, Remotive, and SINE sources are blocked/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{ ...source, id: "sinebahia-jobs" }])),
    /Remote OK, Remotive, and SINE sources are blocked/,
  );
});

test("records configuration warnings for sources that are disabled or lack authorization", async () => {
  const warnings = [];
  const sources = parseSources(JSON.stringify([
    { ...source, id: "unapproved", authorized: false },
    { ...source, id: "disabled", enabled: false },
  ]), new Map(), warnings);
  const { report } = await runJobSearch({
    sources,
    sourceWarnings: warnings,
    fetchImpl: async () => response(municipalityListWithExtremoSul()),
  });

  assert.equal(report.warnings.length, 2);
  assert.equal(report.sourceResults.length, 0);
  assert.equal(report.sourcesAttempted, 0);
  assert.match(report.warnings[0].message, /lacks explicit authorization/);
  assert.match(report.warnings[1].message, /not explicitly enabled/);
});

test("enforces the JSON response-size limit while streaming configured feeds", async () => {
  const configuredSource = registeredTestSource();
  const requests = [];
  const { report } = await runJobSearch({
    sources: [configuredSource],
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("servicodados.ibge.gov.br")) {
        return response(municipalityListWithExtremoSul());
      }
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SOURCE_RESPONSE_BYTES + 1));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        url: configuredSource.feedUrl,
        headers: { get: () => null },
        body,
      };
    },
  });

  assert.equal(report.sourceResults[0].status, "error");
  assert.match(report.errors[0].message, /2MiB|2097152-byte limit/);
  assert.equal(requests[1].options.redirect, "manual");
  assert.ok(requests[1].options.signal instanceof AbortSignal);
});

test("revalidates a configured source URL immediately before making its request", async () => {
  const configuredSource = registeredTestSource();
  configuredSource.feedUrl = "https://127.0.0.1/private.json";
  const requests = [];
  const { report } = await runJobSearch({
    sources: [configuredSource],
    fetchImpl: async (url) => {
      requests.push(String(url));
      return response(municipalityListWithExtremoSul());
    },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /servicodados\.ibge\.gov\.br/);
  assert.equal(report.sourceResults[0].status, "error");
  assert.match(report.errors[0].message, /public HTTPS URL/);
});

test("normalizes real source details without inventing fields and marks unknown availability", () => {
  const municipalities = validateMunicipalities([
    ...Array.from({ length: 416 }, (_, index) => municipalityFixture(index)),
    {
      id: "2931353",
      nome: "Teixeira de Freitas",
      microrregiao: { mesorregiao: { UF: { sigla: "BA" } } },
    },
  ]);
  const job = normalizeJob({
    id: "abc-123",
    title: "Atendente",
    company: "Mercado Local",
    city: "Teixeira de Freitas",
    url: "https://jobs.example.test/vagas/abc-123",
  }, source, municipalities, new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(job.title, "Atendente");
  assert.equal(job.city, "Teixeira de Freitas");
  assert.equal(job.companyName, "Mercado Local");
  assert.equal(job.description, null);
  assert.equal(job.salary, null);
  assert.equal(job.availability, "unknown");
  assert.equal(job.locationScope, "municipality");
  assert.equal(job.ibgeCode, job.municipalityId);
  assert.equal(job.id, normalizeJob({
    id: "abc-123",
    title: "Atendente",
    company: "Mercado Local",
    city: "Teixeira de Freitas",
    url: "https://jobs.example.test/vagas/abc-123",
  }, source, municipalities, new Date("2026-01-01T00:00:00.000Z")).id);
});

test("deduplicates source records and reports unavailable records without publishing", async () => {
  const municipalities = Array.from({ length: 416 }, (_, index) => municipalityFixture(index));
  municipalities.push({
    id: "2931353",
    nome: "Teixeira de Freitas",
    microrregiao: { mesorregiao: { UF: { sigla: "BA" } } },
  });
  const jobs = [
    {
      id: "1",
      title: "Atendente",
      company: "Mercado Local",
      city: "Teixeira de Freitas",
      url: "https://jobs.example.test/vagas/1",
    },
    {
      id: "1",
      title: "Atendente",
      company: "Mercado Local",
      city: "Teixeira de Freitas",
      url: "https://jobs.example.test/vagas/1?utm_source=alternate",
    },
    {
      id: "3",
      title: "Vendedor",
      company: "Loja",
      city: "Teixeira de Freitas",
      url: "https://jobs.example.test/vagas/3",
      available: false,
    },
  ];
  let callCount = 0;
  const { report, jobs: normalized } = await runJobSearch({
    sources: [registeredTestSource()],
    now: new Date("2026-01-01T00:00:00.000Z"),
    fetchImpl: async (url) => {
      callCount += 1;
      if (String(url).includes("servicodados.ibge.gov.br")) return response(municipalities);
      return response(jobs);
    },
  });

  assert.equal(callCount, 2);
  assert.equal(report.municipalityCount, 417);
  assert.equal(report.jobsNormalized, 2);
  assert.equal(report.duplicateJobs, 1);
  assert.equal(report.unavailableJobs, 1);
  assert.equal(normalized.some((job) => job.status === "aprovada"), false);
});

test("reports the absence of authorized vacancy sources without claiming no vacancies exist", async () => {
  const municipalities = Array.from({ length: 417 }, (_, index) => municipalityFixture(index));
  const { report, jobs } = await runJobSearch({
    sources: [],
    fetchImpl: async () => response(municipalities),
  });

  assert.equal(report.status, "blocked_no_authorized_source");
  assert.equal(report.sourcesAttempted, 0);
  assert.equal(report.jobsNormalized, 0);
  assert.equal(jobs.length, 0);
});

test("keeps Remote OK inactive and does not request its feed", async () => {
  const municipalities = Array.from({ length: 417 }, (_, index) => municipalityFixture(index));
  const requests = [];
  const { report } = await runJobSearch({
    sources: [REMOTE_OK_SOURCE],
    fetchImpl: async (url) => {
      requests.push(String(url));
      return response(municipalities);
    },
  });

  assert.equal(REMOTE_OK_SOURCE.authorized, false);
  assert.equal(REMOTE_OK_SOURCE.termsReviewed, false);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /servicodados\.ibge\.gov\.br/);
  assert.equal(report.sourcesAttempted, 0);
  assert.equal(report.sourceResults[0].status, "skipped_unverified");
  assert.equal(report.firestoreWrites, 0);
});

test("Remote OK fetch is blocked even when a caller supplies authorization flags", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    fetchRemoteOkJobs({ ...REMOTE_OK_SOURCE, authorized: true, termsReviewed: true }, async () => {
      fetchCalls += 1;
      return response([]);
    }),
    /Remote OK is inactive/,
  );
  assert.equal(fetchCalls, 0);

  const municipalities = Array.from({ length: 417 }, (_, index) => municipalityFixture(index));
  const requests = [];
  const { report } = await runJobSearch({
    sources: [{ ...REMOTE_OK_SOURCE, authorized: true, termsReviewed: true }],
    fetchImpl: async (url) => {
      requests.push(String(url));
      return response(municipalities);
    },
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /servicodados\.ibge\.gov\.br/);
  assert.equal(report.sourceResults[0].status, "skipped_unverified");
});

test("unregistered generic source objects are skipped before fetch", async () => {
  const municipalities = Array.from({ length: 417 }, (_, index) => municipalityFixture(index));
  const requests = [];
  const { report } = await runJobSearch({
    sources: [source],
    fetchImpl: async (url) => {
      requests.push(String(url));
      return response(municipalities);
    },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /servicodados\.ibge\.gov\.br/);
  assert.equal(report.sourceResults[0].status, "skipped_unverified");
});

test("maps only explicitly Brazil-eligible Remote OK locations and preserves source URLs", () => {
  const municipalities = validateMunicipalities(
    Array.from({ length: 417 }, (_, index) => municipalityFixture(index)),
  );
  const source = { ...REMOTE_OK_SOURCE, authorized: true, termsReviewed: true };
  const eligibleLocations = ["Brazil", "Brasil", "Worldwide", "Global", "Anywhere in the world"];
  const ineligibleLocations = ["US Only", "United States", "Latin America", "Anywhere", "", "Brazil, US"];

  for (const location of eligibleLocations) {
    const mapped = mapRemoteOkRecord({
      id: `remote-${location}`,
      position: "Pessoa desenvolvedora",
      company: "Empresa Remota",
      apply_url: "https://remoteok.com/remote-jobs/remote-example",
      location,
    });
    const job = normalizeJob(mapped, source, municipalities);
    assert.equal(job.locationScope, "remote");
    assert.equal(job.city, null);
    assert.equal(job.municipalityId, null);
    assert.equal(job.sourceUrl, "https://remoteok.com/remote-jobs/remote-example");
  }

  for (const location of ineligibleLocations) {
    const mapped = mapRemoteOkRecord({
      id: `remote-${location}`,
      position: "Pessoa desenvolvedora",
      company: "Empresa Remota",
      apply_url: "https://remoteok.com/remote-jobs/remote-example",
      location,
    });
    assert.equal(normalizeJob(mapped, source, municipalities), null);
  }

  const externalApplyUrl = mapRemoteOkRecord({
    id: "remote-external-url",
    position: "Pessoa desenvolvedora",
    company: "Empresa Remota",
    apply_url: "https://example.test/apply",
    location: "Brazil",
  });
  assert.equal(normalizeJob(externalApplyUrl, source, municipalities), null);
});

test("cross-source duplicates preserve Remote OK attribution in a serializable persistence shape", () => {
  const municipalities = validateMunicipalities(
    Array.from({ length: 417 }, (_, index) => municipalityFixture(index)),
  );
  const jobicyRecord = {
    id: 123,
    jobTitle: "Pessoa desenvolvedora",
    companyName: "Empresa Remota",
    url: "https://jobicy.com/jobs/123",
    jobGeo: "Brazil",
    jobExcerpt: "Oportunidade compartilhada.",
  };
  const remoteOkRecord = {
    id: "remote-123",
    position: "Pessoa desenvolvedora",
    company: "Empresa Remota",
    apply_url: "https://remoteok.com/remote-jobs/remote-123",
    location: "Brazil",
    description: "Oportunidade compartilhada.",
  };
  const primaryJob = normalizeJob(
    mapJobicyRecord(jobicyRecord),
    JOBICY_BRAZIL_SOURCE,
    municipalities,
  );
  const duplicateJob = normalizeJob(
    mapRemoteOkRecord(remoteOkRecord),
    REMOTE_OK_SOURCE,
    municipalities,
  );

  addRemoteOkSourceReference(primaryJob, duplicateJob);
  const expectedReferences = [
    {
      sourceId: JOBICY_BRAZIL_SOURCE.id,
      sourceName: JOBICY_BRAZIL_SOURCE.name,
      sourceUrl: jobicyRecord.url,
      termsUrl: JOBICY_BRAZIL_SOURCE.termsUrl,
    },
    {
      sourceId: REMOTE_OK_SOURCE.id,
      sourceName: REMOTE_OK_SOURCE.name,
      sourceUrl: remoteOkRecord.apply_url,
      termsUrl: REMOTE_OK_SOURCE.termsUrl,
    },
  ];
  assert.equal(primaryJob.sourceName, JOBICY_BRAZIL_SOURCE.name);
  assert.deepEqual(primaryJob.sourceReferences, expectedReferences);
  assert.deepEqual(
    JSON.parse(JSON.stringify({ ...primaryJob, reviewStatus: "pending_review" })).sourceReferences,
    expectedReferences,
  );
});

test("generic feeds do not follow redirects or ingest Remote OK proxy records", async () => {
  const registeredSource = registeredTestSource();
  const municipalities = Array.from({ length: 417 }, (_, index) => municipalityFixture(index));
  const redirectRequests = [];
  const redirected = await runJobSearch({
    sources: [registeredSource],
    fetchImpl: async (url, options) => {
      redirectRequests.push({ url: String(url), options });
      if (String(url).includes("servicodados.ibge.gov.br")) return response(municipalities);
      return response({}, 302);
    },
  });

  assert.equal(redirectRequests.length, 2);
  assert.equal(redirectRequests[1].options.redirect, "manual");
  assert.equal(redirected.report.sourceResults[0].status, "error");
  assert.equal(redirectRequests.some((request) => request.url === REMOTE_OK_API_URL), false);

  const proxied = await runJobSearch({
    sources: [registeredSource],
    fetchImpl: async (url) => {
      if (String(url).includes("servicodados.ibge.gov.br")) return response(municipalities);
      return response({
        jobs: [{
          title: "Atendente",
          city: "Município 0",
          company: "Empresa",
          url: "https://remoteok.com/remote-jobs/proxied",
        }],
      });
    },
  });

  assert.equal(proxied.report.jobsNormalized, 0);
  assert.equal(proxied.report.sourceResults[0].status, "error");

  const remoteOkMarker = await runJobSearch({
    sources: [registeredSource],
    fetchImpl: async (url) => {
      if (String(url).includes("servicodados.ibge.gov.br")) return response(municipalities);
      return response({
        legal: "Remote OK API Terms of Service.",
        jobs: [{ title: "Atendente", city: "Município 0", url: "https://jobs.example.test/1" }],
      });
    },
  });
  assert.equal(remoteOkMarker.report.jobsNormalized, 0);
  assert.equal(remoteOkMarker.report.sourceResults[0].status, "error");

  for (const blockedSourceName of ["Remotive", "SINE Bahia"]) {
    const blockedFeed = await runJobSearch({
      sources: [registeredTestSource()],
      fetchImpl: async (url) => {
        if (String(url).includes("servicodados.ibge.gov.br")) return response(municipalities);
        return response({
          jobs: [{
            title: "Atendente",
            company: "Empresa",
            city: "Teixeira de Freitas",
            url: "https://jobs.example.test/blocked",
            sourceName: blockedSourceName,
          }],
        });
      },
    });
    assert.equal(blockedFeed.report.jobsNormalized, 0);
    assert.equal(blockedFeed.report.sourceResults[0].status, "error");
  }
});

test("maps authorized JSON fields, classifies an Extremo Sul municipality, and deduplicates Jobicy", async () => {
  const fieldMapping = {
    id: "posting.code",
    title: "posting.role",
    company: "employer.name",
    location: "workplace",
    modality: "workMode",
    url: "links.public",
    publishedAt: "dates.published",
    validThrough: "dates.expires",
    description: "summary",
    country: "country",
  };
  const configuredSource = registeredTestSource({ fieldMapping });
  const jobicyRecord = {
    id: 777,
    jobTitle: "Pessoa desenvolvedora",
    companyName: "Empresa Remota",
    url: "https://jobicy.com/jobs/777",
    jobGeo: "Brazil",
    jobExcerpt: "Experiencia com desenvolvimento de software.",
    pubDate: "2026-01-09T12:00:00.000Z",
  };
  const configuredRecords = [
    {
      posting: { code: "local-1", role: "Analista local" },
      employer: { name: "Empresa Extremo Sul" },
      workplace: "Teixeira de Freitas",
      workMode: "Presencial",
      links: { public: "https://jobs.example.test/vagas/local-1" },
      dates: {
        published: "2026-01-09T12:00:00.000Z",
        expires: "2026-02-01T00:00:00.000Z",
      },
      summary: "Atividades administrativas.",
      country: "Brazil",
    },
    {
      posting: { code: "remote-duplicate", role: "Pessoa desenvolvedora" },
      employer: { name: "Empresa Remota" },
      workplace: "Brazil",
      workMode: "Remoto",
      links: { public: "https://jobs.example.test/vagas/remote-duplicate" },
      dates: {
        published: "2026-01-09T12:00:00.000Z",
        expires: "2026-02-01T00:00:00.000Z",
      },
      summary: "Experiencia com desenvolvimento de software.",
      country: "Brazil",
    },
  ];

  const { report, jobs } = await runJobSearch({
    sources: [JOBICY_BRAZIL_SOURCE, configuredSource],
    sleepImpl: async () => {},
    now: new Date("2026-01-10T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      if (requestUrl.hostname === "servicodados.ibge.gov.br") {
        return response(municipalityListWithExtremoSul());
      }
      if (requestUrl.hostname === "jobicy.com") {
        if (requestUrl.pathname.endsWith("/status")) {
          return response({ jobs: [{ id: 777, status: "active" }] });
        }
        return response({ jobs: [jobicyRecord], hasMore: false, nextCursor: null });
      }
      return response({ jobs: configuredRecords });
    },
  });

  const localJob = jobs.find((job) => job.title === "Analista local");
  const primaryRemoteJob = jobs.find((job) => job.sourceId === JOBICY_BRAZIL_SOURCE.id);
  assert.equal(report.jobsNormalized, 2);
  assert.equal(report.duplicateJobs, 1);
  assert.equal(report.sourceResults[1].duplicates, 1);
  assert.equal(localJob.city, "Teixeira de Freitas");
  assert.equal(localJob.locationScope, "municipality");
  assert.equal(localJob.region, "extremo_sul_ba");
  assert.equal(localJob.ibgeCode, "2900011");
  assert.equal(localJob.publishedAt, "2026-01-09T12:00:00.000Z");
  assert.equal(localJob.expiresAt, "2026-02-01T00:00:00.000Z");
  const configuredReference = primaryRemoteJob.sourceReferences.find(
    (reference) => reference.sourceId === configuredSource.id,
  );
  assert.ok(configuredReference);
  assert.equal(configuredReference.attributionUrl, configuredSource.attributionUrl);
});

test("reports geographic groups in priority order with counts and summarized job lists", async () => {
  const records = [
    {
      id: "extremo-1",
      title: "Vaga Extremo Sul",
      company: "Empresa A",
      city: "Teixeira de Freitas",
      url: "https://jobs.example.test/vagas/extremo-1",
    },
    {
      id: "municipality-1",
      title: "Vaga Outro Municipio",
      company: "Empresa B",
      city: "Município 20",
      url: "https://jobs.example.test/vagas/municipality-1",
    },
    {
      id: "remote-1",
      title: "Vaga Remota Brasil",
      company: "Empresa C",
      city: "Brazil",
      countryEligibility: "Brazil",
      modality: "Remoto",
      url: "https://jobs.example.test/vagas/remote-1",
    },
    {
      id: "unverified-1",
      title: "Vaga Sem Local Confirmado",
      company: "Empresa D",
      city: "Local não reconhecido",
      url: "https://jobs.example.test/vagas/unverified-1",
    },
    {
      id: "remote-foreign",
      title: "Remota sem elegibilidade brasileira",
      company: "Empresa E",
      city: "Worldwide",
      country: "United States",
      modality: "Remoto",
      url: "https://jobs.example.test/vagas/remote-foreign",
    },
  ];
  const { report } = await runJobSearch({
    sources: [registeredTestSource()],
    now: new Date("2026-01-10T00:00:00.000Z"),
    fetchImpl: async (url) => (
      String(url).includes("servicodados.ibge.gov.br")
        ? response(municipalityListWithExtremoSul())
        : response({ jobs: records })
    ),
  });
  const summary = report.geographicSummary;

  assert.deepEqual(Object.keys(summary), [
    "extremoSulBahia",
    "outrosMunicipiosBahia",
    "remotoBrasil",
    "semLocalConfirmado",
  ]);
  assert.equal(summary.extremoSulBahia.count, 1);
  assert.equal(summary.extremoSulBahia.jobs[0].city, "Teixeira de Freitas");
  assert.equal(summary.outrosMunicipiosBahia.count, 1);
  assert.equal(summary.outrosMunicipiosBahia.jobs[0].city, "Município 20");
  assert.equal(summary.remotoBrasil.count, 1);
  assert.equal(summary.remotoBrasil.jobs[0].title, "Vaga Remota Brasil");
  assert.equal(summary.remotoBrasil.jobs[0].locationScope, "remote");
  assert.equal(summary.semLocalConfirmado.count, 2);
  assert.equal(summary.semLocalConfirmado.jobs.some(
    (job) => job.title === "Vaga Sem Local Confirmado",
  ), true);
  assert.equal(summary.semLocalConfirmado.jobs.some(
    (job) => job.title === "Remota sem elegibilidade brasileira",
  ), true);
});

test("maps Jobicy country-eligible remote listings without assigning a Bahia municipality", () => {
  const municipalities = validateMunicipalities(
    Array.from({ length: 417 }, (_, index) => municipalityFixture(index)),
  );
  const job = normalizeJob(mapJobicyRecord({
    id: 123,
    jobTitle: "Pessoa desenvolvedora",
    companyName: "Empresa Remota",
    url: "https://jobicy.com/jobs/123",
    jobGeo: "Brazil",
    jobExcerpt: "Trabalho remoto no Brasil.",
    salaryMin: 5000,
    salaryMax: 7000,
    salaryCurrency: "BRL",
    salaryPeriod: "monthly",
  }), JOBICY_BRAZIL_SOURCE, municipalities);

  assert.equal(job.city, null);
  assert.equal(job.municipalityId, null);
  assert.equal(job.state, null);
  assert.equal(job.locationScope, "remote");
  assert.equal(job.sourceLocation, "Brazil");
  assert.equal(job.salary, "5000–7000 BRL / monthly");
  assert.equal(job.sourceUrl, "https://jobicy.com/jobs/123");
});

test("Jobicy adapter paginates sequentially and checks status without paid links", async () => {
  const requests = [];
  const waits = [];
  const record = {
    id: 123,
    jobTitle: "Pessoa desenvolvedora",
    companyName: "Empresa Remota",
    url: "https://jobicy.com/jobs/123",
    jobGeo: "Brazil",
    jobExcerpt: "Trabalho remoto no Brasil.",
  };
  const result = await fetchJobicyJobs(JOBICY_BRAZIL_SOURCE, async (url) => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.pathname.endsWith("/status")) {
      return response({ jobs: [{ id: 123, status: "active" }] });
    }

    return response({
      jobs: [record],
      hasMore: false,
      nextCursor: null,
    });
  }, async (milliseconds) => waits.push(milliseconds));

  assert.equal(result.records.length, 1);
  assert.equal(result.availabilityById.get("123"), "active");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("geo"), "brazil");
  assert.equal(requests[0].searchParams.get("count"), "100");
  assert.equal(requests[0].searchParams.has("cursor"), false);
  assert.equal(requests[1].pathname, "/api/jobs/status");
  assert.equal(requests[1].searchParams.get("ids"), "123");
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 1000);
});

test("reports Jobicy active, closed, and unknown statuses without publishing or writing", async () => {
  const municipalities = Array.from({ length: 417 }, (_, index) => municipalityFixture(index));
  const records = ["active", "closed", "unknown"].map((status, index) => ({
    id: index + 10,
    jobTitle: `Cargo ${index}`,
    companyName: `Empresa ${index}`,
    url: `https://jobicy.com/jobs/${index + 10}`,
    jobGeo: "Brazil",
    jobExcerpt: `Descrição ${index}`,
    expectedStatus: status,
  }));
  const calls = [];
  const { report, jobs } = await runJobSearch({
    sources: [JOBICY_BRAZIL_SOURCE],
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      calls.push(requestUrl);
      if (requestUrl.hostname === "servicodados.ibge.gov.br") return response(municipalities);
      if (requestUrl.pathname.endsWith("/status")) {
        return response({
          jobs: records.map((record) => ({ id: record.id, status: record.expectedStatus })),
        });
      }
      return response({ jobs: records, hasMore: false, nextCursor: null });
    },
  });

  assert.equal(report.jobsNormalized, 3);
  assert.equal(report.countryRemoteJobs, 3);
  assert.equal(report.availableJobs, 1);
  assert.equal(report.unavailableJobs, 1);
  assert.equal(report.unknownAvailabilityJobs, 1);
  assert.equal(report.firestoreWrites, 0);
  assert.equal(jobs.every((job) => job.city === null && !("status" in job)), true);
  assert.equal(calls.length, 3);
});

test("calculates source expiry with explicit validity, configured TTL, and a 30-day default", () => {
  const collectedAt = "2026-01-10T12:00:00.000Z";
  assert.equal(
    calculateExpiresAt({}, {}, collectedAt),
    "2026-02-09T12:00:00.000Z",
  );
  assert.equal(
    calculateExpiresAt({ publishedAt: "2026-01-01T00:00:00.000Z" }, { ttlDays: 10 }, collectedAt),
    "2026-01-11T00:00:00.000Z",
  );
  assert.equal(
    calculateExpiresAt({ validThrough: "2026-01-20T08:30:00-03:00" }, { ttlDays: 2 }, collectedAt),
    "2026-01-20T11:30:00.000Z",
  );
  const configuredSource = parseSources(
    JSON.stringify([{ ...source, ttlDays: 12, staleAfterDays: 4 }]),
    new Map([[source.id, source.feedUrl]]),
  )[0];
  assert.equal(configuredSource.ttlDays, 12);
  assert.equal(configuredSource.staleAfterDays, 4);
  assert.equal(DEFAULT_JOB_TTL_DAYS, 30);
});

test("evaluates active, expired, and stale validity deterministically", () => {
  const reference = new Date("2026-01-10T00:00:00.000Z");
  assert.equal(evaluateValidity({
    expiresAt: "2026-01-11T00:00:00.000Z",
    collectedAt: "2026-01-09T00:00:00.000Z",
  }, reference), "active");
  assert.equal(evaluateValidity({
    expiresAt: "2026-01-10T00:00:00.000Z",
    collectedAt: "2026-01-09T00:00:00.000Z",
  }, reference), "expired");
  assert.equal(evaluateValidity({
    expiresAt: "2026-02-10T00:00:00.000Z",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  }, reference), "stale");
  assert.equal(evaluateValidity({
    expiresAt: "2026-02-10T00:00:00.000Z",
    collectedAt: "2026-01-09T00:00:00.000Z",
  }, reference, 1), "active");
  assert.equal(DEFAULT_STALE_AFTER_DAYS, 7);
});

test("deduplicates source listings despite case, whitespace, and tracking URL variations", async () => {
  const records = [
    {
      title: "  Analista   de Dados ",
      company: "  Empresa Exemplo ",
      city: "Teixeira de Freitas",
      url: "https://jobs.example.test/vagas/123/?utm_source=site&ref=email#apply",
      description: "Atividades e requisitos.",
    },
    {
      title: "analista de dados",
      company: "empresa exemplo",
      city: "Teixeira de Freitas",
      url: "https://jobs.example.test/vagas/123?ref=network&utm_source=outro",
      description: "Atividades e requisitos.",
    },
  ];
  const { report, jobs } = await runJobSearch({
    sources: [registeredTestSource()],
    now: new Date("2026-01-10T00:00:00.000Z"),
    fetchImpl: async (url) => {
      if (String(url).includes("servicodados.ibge.gov.br")) {
        return response(municipalityListWithExtremoSul());
      }
      return response(records);
    },
  });

  assert.equal(jobs.length, 1);
  assert.equal(report.duplicateJobs, 1);
  assert.equal(report.duplicatesIgnored, 1);
  assert.equal(report.sourceResults[0].duplicatesIgnored, 1);
  assert.equal(jobs[0].source.id, "approved-feed");
  assert.equal(jobs[0].normalizedSourceUrl, "https://jobs.example.test/vagas/123");
});

test("classifies Extremo Sul, municipality aliases, statewide, remote, and unverified locations", () => {
  const municipalities = validateMunicipalities(municipalityListWithExtremoSul());
  const makeJob = (overrides = {}) => normalizeJob({
    title: "Oportunidade",
    company: "Empresa",
    url: "https://jobs.example.test/vaga",
    city: "Teixeira de Freitas",
    ...overrides,
  }, source, municipalities, new Date("2026-01-01T00:00:00.000Z"));

  const municipal = makeJob();
  assert.equal(municipal.locationScope, "municipality");
  assert.equal(municipal.region, "extremo_sul_ba");
  assert.equal(municipal.ibgeCode, municipal.municipalityId);
  assert.ok(EXTREMO_SUL_MUNICIPALITY_NAMES.has("teixeira de freitas"));

  const postoDaMata = makeJob({ city: "Posto da Mata" });
  assert.equal(postoDaMata.city, "Nova Viçosa");
  assert.equal(postoDaMata.locality, "Posto da Mata");
  assert.equal(postoDaMata.locationScope, "municipality");

  const itabata = makeJob({ city: "Itabatã" });
  assert.equal(itabata.city, "Mucuri");
  assert.equal(itabata.locality, "Itabatã");
  assert.equal(itabata.locationScope, "municipality");

  const regional = makeJob({ city: "Extremo Sul da Bahia" });
  assert.equal(regional.locationScope, "regional_extremo_sul");
  assert.equal(regional.ibgeCode, null);

  const statewide = makeJob({ city: "Bahia" });
  assert.equal(statewide.locationScope, "statewide_ba");
  assert.equal(statewide.ibgeCode, null);

  const remote = makeJob({ city: "", modality: "Remoto", countryEligibility: "Brazil" });
  assert.equal(remote.locationScope, "remote");
  assert.equal(remote.city, null);
  assert.equal(remote.ibgeCode, null);

  const unverified = makeJob({ city: "Cidade não reconhecida" });
  assert.equal(unverified.locationScope, "unverified");
  assert.equal(unverified.ibgeCode, null);

  const unverifiedWithinBa = makeJob({ city: "Local não reconhecido", state: "BA" });
  assert.equal(unverifiedWithinBa.locationScope, "unverified");
  assert.equal(unverifiedWithinBa.ibgeCode, null);
});

test("marks expired listings in normalized output and execution report", async () => {
  const municipalities = municipalityListWithExtremoSul();
  const { report, jobs } = await runJobSearch({
    sources: [registeredTestSource()],
    now: new Date("2026-01-10T00:00:00.000Z"),
    fetchImpl: async (url) => {
      if (String(url).includes("servicodados.ibge.gov.br")) return response(municipalities);
      return response([{
        id: "expired-1",
        title: "Vaga encerrada",
        company: "Empresa",
        city: "Teixeira de Freitas",
        url: "https://jobs.example.test/vagas/expired-1",
        validThrough: "2026-01-09T23:59:59.000Z",
      }]);
    },
  });

  assert.equal(jobs[0].validityStatus, "expired");
  assert.equal(jobs[0].availability, "unavailable");
  assert.equal(report.expiredJobs, 1);
  assert.equal(report.activeValidityJobs, 0);
  assert.equal(report.sourceResults[0].expired, 1);
});

test("builds a pure pending-review automated lead payload without writing to Firestore", () => {
  const municipalities = validateMunicipalities(municipalityListWithExtremoSul());
  const job = normalizeJob({
    id: "lead-1",
    title: "Técnico",
    company: "Empresa Exemplo",
    city: "Itabatã",
    url: "https://jobs.example.test/vagas/lead-1",
  }, source, municipalities, new Date("2026-01-10T00:00:00.000Z"));
  const original = JSON.parse(JSON.stringify(job));
  const payload = buildAutomatedJobLeadPayload(job);

  assert.deepEqual(job, original);
  assert.equal(payload.origin, "automated_source");
  assert.equal(payload.source.id, source.id);
  assert.equal(payload.triageStatus, "pending");
  assert.equal(payload.reviewStatus, "pending_review");
  assert.equal(payload.city, "Mucuri");
  assert.ok(payload.ibgeCode);
  assert.ok(payload.expiresAt);
  assert.equal(payload.collectedAt, payload.fetchedAt);
  assert.equal(payload.deduplicationKey, job.deduplicationKey);
});

test("persists leads once under the deterministic canonical ID and preserves createdAt", async () => {
  const job = normalizedPersistenceJob();
  const repository = mockLeadRepository();
  const first = await persistJobsWithRepository(
    [job],
    repository,
    { now: new Date("2026-01-10T00:00:00.000Z") },
  );
  const createdAt = repository.documents.get(job.deduplicationKey).createdAt;

  const second = await persistJobsWithRepository(
    [job],
    repository,
    { now: new Date("2026-01-11T00:00:00.000Z") },
  );

  assert.equal(first.created, 1);
  assert.equal(first.writes, 1);
  assert.equal(second.mergedPending, 1);
  assert.equal(second.writes, 1);
  assert.equal(repository.documents.size, 1);
  assert.equal(repository.documents.has(job.deduplicationKey), true);
  assert.equal(repository.documents.get(job.deduplicationKey).createdAt, createdAt);
  assert.equal(repository.documents.get(job.deduplicationKey).seenCount, 2);
  assert.equal(repository.documents.get(job.deduplicationKey).lastSeenAt, "2026-01-11T00:00:00.000Z");
  assert.equal(MAX_PERSIST_LEADS_PER_RUN, 200);
});

test("preserves reviewed and curated fields while refreshing tracking metadata", async () => {
  const reviewedJobs = ["approved", "rejected"].map((reviewStatus) => (
    normalizedPersistenceJob({
      id: `persistence-${reviewStatus}`,
      url: `https://jobs.example.test/vagas/persistence-${reviewStatus}`,
    })
  ));
  const repository = mockLeadRepository(reviewedJobs.map((job, index) => [
    job.deduplicationKey,
    {
      ...buildAutomatedJobLeadPayload(job),
      createdAt: `original-created-at-${index}`,
      title: "Titulo revisado manualmente",
      description: "Descricao curada manualmente.",
      reviewStatus: index === 0 ? "approved" : "rejected",
      triageStatus: index === 0 ? "approved" : "rejected",
      seenCount: 4,
    },
  ]));
  const result = await persistJobsWithRepository(
    reviewedJobs.map((job) => ({ ...job, description: "Descricao alterada na origem." })),
    repository,
    { now: new Date("2026-01-12T00:00:00.000Z") },
  );

  assert.equal(result.trackingOnly, 2);
  for (const [index, job] of reviewedJobs.entries()) {
    const persisted = repository.documents.get(job.deduplicationKey);
    const reviewStatus = index === 0 ? "approved" : "rejected";
    assert.equal(persisted.reviewStatus, reviewStatus);
    assert.equal(persisted.triageStatus, reviewStatus);
    assert.equal(persisted.title, "Titulo revisado manualmente");
    assert.equal(persisted.description, "Descricao curada manualmente.");
    assert.equal(persisted.createdAt, `original-created-at-${index}`);
    assert.equal(persisted.seenCount, 5);
    assert.equal(persisted.lastSeenAt, "2026-01-12T00:00:00.000Z");
  }
});

test("reconciles expired pending leads without changing reviewed records", async () => {
  const now = new Date("2026-01-12T00:00:00.000Z");
  const repository = mockLeadRepository([
    ["pending-expired", {
      reviewStatus: "pending_review",
      triageStatus: "pending",
      validityStatus: "active",
      availability: "unknown",
      expiresAt: "2026-01-11T00:00:00.000Z",
      title: "Pendente",
    }],
    ["approved-expired", {
      reviewStatus: "approved",
      triageStatus: "approved",
      validityStatus: "active",
      availability: "available",
      expiresAt: "2026-01-11T00:00:00.000Z",
      title: "Aprovada",
    }],
  ]);
  const result = await persistJobsWithRepository([], repository, { now });
  const pending = repository.documents.get("pending-expired");
  const approved = repository.documents.get("approved-expired");

  assert.equal(result.reconciliation.scanned, 2);
  assert.equal(result.reconciliation.updated, 1);
  assert.equal(result.writes, 1);
  assert.equal(pending.validityStatus, "expired");
  assert.equal(pending.availability, "unavailable");
  assert.equal(pending.reviewStatus, "pending_review");
  assert.equal(pending.expiredAt, now.toISOString());
  assert.equal(approved.validityStatus, "active");
  assert.equal(approved.availability, "available");
  assert.equal(RECONCILE_BATCH_SIZE, 100);
});

test("caps expiry reconciliation reads and reports when more candidates may remain", async () => {
  const repository = mockLeadRepository([
    ["expired-1", {
      reviewStatus: "pending_review",
      expiresAt: "2026-01-01T00:00:00.000Z",
      validityStatus: "active",
    }],
    ["expired-2", {
      reviewStatus: "pending_review",
      expiresAt: "2026-01-02T00:00:00.000Z",
      validityStatus: "active",
    }],
  ]);
  const result = await reconcileExpiredPendingLeads(
    repository,
    new Date("2026-01-10T00:00:00.000Z"),
    { batchSize: 1, maxBatches: 1 },
  );

  assert.equal(result.scanned, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.truncated, true);
  assert.equal(repository.documents.get("expired-2").validityStatus, "active");
});

test("rejects persistence batches above the limit before writing any lead", async () => {
  const repository = mockLeadRepository();
  const jobs = Array.from({ length: MAX_PERSIST_LEADS_PER_RUN + 1 }, (_, index) => (
    normalizedPersistenceJob({
      id: `too-many-${index}`,
      title: `Cargo ${index}`,
      url: `https://jobs.example.test/vagas/too-many-${index}`,
    })
  ));

  await assert.rejects(
    persistJobsWithRepository(jobs, repository),
    /capped at 200 unique leads per run; no leads were written/,
  );
  assert.equal(repository.documents.size, 0);
});

test("main activates --persist with injected credentials and reports completed writes", async () => {
  const job = normalizedPersistenceJob();
  const repository = mockLeadRepository();
  const simulatedCredential = '{"simulated":true}';
  const exitCodes = [];
  let persistenceCalls = 0;
  let stdout = "";
  const report = await main(["--persist"], {
    env: {
      JOB_SEARCH_SOURCES_JSON: authorizedSourcesJson(),
      FIREBASE_SERVICE_ACCOUNT_JSON: simulatedCredential,
    },
    runJobSearch: async () => ({ report: reportFixture(), jobs: [job] }),
    persistJobs: async (jobs, credential, { onProgress }) => {
      persistenceCalls += 1;
      assert.equal(credential, simulatedCredential);
      return persistJobsWithRepository(jobs, repository, {
        now: new Date("2026-01-10T00:00:00.000Z"),
        onProgress,
      });
    },
    writeStdout: (text) => { stdout += text; },
    setExitCode: (code) => exitCodes.push(code),
  });

  assert.equal(persistenceCalls, 1);
  assert.equal(report.persistence.created, 1);
  assert.equal(report.persistence.upserted, 1);
  assert.equal(report.persistence.writes, 1);
  assert.equal(report.firestoreWrites, 1);
  assert.equal(report.status, "completed");
  assert.deepEqual(exitCodes, []);
  assert.equal(JSON.parse(stdout).firestoreWrites, 1);
});

test("main persists built-in Jobicy when explicitly requested without extra feeds", async () => {
  const job = normalizedPersistenceJob();
  const repository = mockLeadRepository();
  const simulatedCredential = '{"simulated":true}';
  let persistenceCalls = 0;
  const report = await main(["--persist"], {
    env: { FIREBASE_SERVICE_ACCOUNT_JSON: simulatedCredential },
    runJobSearch: async ({ sources }) => {
      assert.deepEqual(
        sources.filter(({ authorized }) => authorized).map(({ id }) => id),
        [JOBICY_BRAZIL_SOURCE.id],
      );
      return { report: reportFixture(), jobs: [job] };
    },
    persistJobs: async (jobs, credential, { onProgress }) => {
      persistenceCalls += 1;
      assert.equal(credential, simulatedCredential);
      return persistJobsWithRepository(jobs, repository, {
        now: new Date("2026-01-10T00:00:00.000Z"),
        onProgress,
      });
    },
    writeStdout: () => {},
    setExitCode: (code) => { assert.fail(`Unexpected CLI exit code ${code}`); },
  });

  assert.equal(persistenceCalls, 1);
  assert.equal(report.persistence.created, 1);
  assert.equal(report.firestoreWrites, 1);
  assert.equal(repository.documents.size, 1);
});

test("main stays in dry-run by default without calling persistence", async () => {
  let persistenceCalls = 0;
  const report = await main([], {
    env: {},
    runJobSearch: async () => ({ report: reportFixture(), jobs: [] }),
    persistJobs: async () => {
      persistenceCalls += 1;
      assert.fail("Dry-run must not call persistence.");
    },
    writeStdout: () => {},
  });

  assert.equal(persistenceCalls, 0);
  assert.equal(report.firestoreWrites, 0);
  assert.equal(report.persistence, undefined);
});

test("main reports missing persistence credentials without writing", async () => {
  const exitCodes = [];
  const report = await main(["--persist"], {
    env: {},
    runJobSearch: async () => ({
      report: reportFixture(),
      jobs: [normalizedPersistenceJob()],
    }),
    writeStdout: () => {},
    setExitCode: (code) => exitCodes.push(code),
  });

  assert.equal(report.status, "partial");
  assert.equal(report.firestoreWrites, 0);
  assert.equal(report.persistence.writes, 0);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].stage, "firestore");
  assert.match(report.errors[0].message, /requires FIREBASE_SERVICE_ACCOUNT_JSON/);
  assert.deepEqual(exitCodes, [1]);
});

test("main persists a valid configured feed once per canonical lead across repeated runs", async () => {
  const feedUrl = "https://authorized.example.test/api/jobs";
  const configuredSource = registeredTestSource({
    id: "workflow-persist-source",
    name: "Workflow test feed",
    feedUrl,
    url: feedUrl,
  });
  const sourceJson = authorizedSourcesJson({
    id: configuredSource.id,
    name: configuredSource.name,
    feedUrl,
    url: feedUrl,
  });
  const record = {
    id: "feed-job-1",
    title: "Assistente administrativo",
    company: "Empresa do Feed",
    city: "Teixeira de Freitas",
    url: "https://authorized.example.test/jobs/1",
    description: "Apoio administrativo e atendimento.",
    publishedAt: "2026-11-25T10:00:00.000Z",
    validThrough: "2026-12-25T10:00:00.000Z",
  };
  const municipalities = municipalityListWithExtremoSul();
  const now = new Date("2026-11-26T12:00:00.000Z");
  const repository = mockLeadRepository();
  const simulatedCredential = '{"simulated":true}';
  const fetchImpl = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.hostname === "servicodados.ibge.gov.br") return response(municipalities);
    if (requestUrl.href === feedUrl) {
      return response({ jobs: [record, { ...record, id: "feed-job-duplicate" }] });
    }
    throw new Error(`Unexpected request in persisted-source test: ${requestUrl.href}`);
  };
  let persistenceCalls = 0;
  const execute = () => main(["--persist"], {
    env: {
      JOB_SEARCH_SOURCES_JSON: sourceJson,
      FIREBASE_SERVICE_ACCOUNT_JSON: simulatedCredential,
    },
    runJobSearch: ({ sources, sourceWarnings }) => {
      const configured = sources.filter(({ id }) => id === configuredSource.id);
      assert.equal(configured.length, 1);
      return runJobSearch({ sources: configured, fetchImpl, now, sourceWarnings });
    },
    persistJobs: (jobs, credential, { onProgress }) => {
      persistenceCalls += 1;
      assert.equal(credential, simulatedCredential);
      return persistJobsWithRepository(jobs, repository, { now, onProgress });
    },
    writeStdout: () => {},
    setExitCode: (code) => { assert.fail(`Unexpected CLI exit code ${code}`); },
  });

  const first = await execute();
  const second = await execute();

  assert.equal(first.jobsNormalized, 1);
  assert.equal(first.duplicateJobs, 1);
  assert.equal(first.persistence.created, 1);
  assert.equal(first.persistence.upserted, 1);
  assert.equal(first.firestoreWrites, 1);
  assert.equal(second.persistence.created, 0);
  assert.equal(second.persistence.mergedPending, 1);
  assert.equal(second.persistence.upserted, 1);
  assert.equal(second.firestoreWrites, 1);
  assert.equal(repository.documents.size, 1);
  assert.equal([...repository.documents.values()][0].seenCount, 2);
  assert.equal(persistenceCalls, 2);
});

test("main fails closed on malformed configured source JSON", async () => {
  const job = normalizedPersistenceJob();
  let persistenceCalls = 0;
  let searches = 0;
  await assert.rejects(
    main(["--persist"], {
      env: {
        JOB_SEARCH_SOURCES_JSON: "{malformed",
        FIREBASE_SERVICE_ACCOUNT_JSON: '{"simulated":true}',
      },
      runJobSearch: async () => {
        searches += 1;
        return { report: reportFixture(), jobs: [job] };
      },
      persistJobs: async () => {
        persistenceCalls += 1;
        return persistJobsWithRepository([job], mockLeadRepository());
      },
      writeStdout: () => {},
    }),
    /JOB_SEARCH_SOURCES_JSON must be valid JSON/,
  );
  assert.equal(searches, 0);
  assert.equal(persistenceCalls, 0);
});

test("main retains confirmed persistence counts when a later lead write fails", async () => {
  const jobs = [
    normalizedPersistenceJob(),
    normalizedPersistenceJob({
      id: "persistence-second",
      url: "https://jobs.example.test/vagas/persistence-second",
    }),
  ];
  const repository = mockLeadRepository();
  const upsertLead = repository.upsertLead.bind(repository);
  let attempts = 0;
  repository.upsertLead = async (...args) => {
    attempts += 1;
    if (attempts === 2) throw new Error("simulated write failure");
    return upsertLead(...args);
  };
  const exitCodes = [];
  const report = await main(["--persist"], {
    env: {
      JOB_SEARCH_SOURCES_JSON: authorizedSourcesJson(),
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"simulated":true}',
    },
    runJobSearch: async () => ({ report: reportFixture(), jobs }),
    persistJobs: (leads, _credential, { onProgress }) => persistJobsWithRepository(
      leads,
      repository,
      { now: new Date("2026-01-10T00:00:00.000Z"), onProgress },
    ),
    writeStdout: () => {},
    setExitCode: (code) => exitCodes.push(code),
  });

  assert.equal(report.status, "partial");
  assert.deepEqual(report.errors.map(({ stage }) => stage), ["firestore"]);
  assert.equal(report.persistence.created, 1);
  assert.equal(report.persistence.upserted, 1);
  assert.equal(report.persistence.writes, 1);
  assert.equal(report.firestoreWrites, 1);
  assert.deepEqual(exitCodes, [1]);
});

test("main retains completed upserts when expiry reconciliation fails", async () => {
  const jobs = [
    normalizedPersistenceJob(),
    normalizedPersistenceJob({
      id: "persistence-second",
      url: "https://jobs.example.test/vagas/persistence-second",
    }),
  ];
  const repository = mockLeadRepository([
    ["expired-first", {
      reviewStatus: "pending_review",
      triageStatus: "pending",
      validityStatus: "active",
      expiresAt: "2026-01-09T00:00:00.000Z",
    }],
    ["expired-second", {
      reviewStatus: "pending_review",
      triageStatus: "pending",
      validityStatus: "active",
      expiresAt: "2026-01-09T00:00:00.000Z",
    }],
  ]);
  const reconcileLead = repository.reconcileLead.bind(repository);
  let reconciliations = 0;
  repository.reconcileLead = async (...args) => {
    reconciliations += 1;
    if (reconciliations === 2) throw new Error("simulated reconciliation failure");
    return reconcileLead(...args);
  };
  const report = await main(["--persist"], {
    env: {
      JOB_SEARCH_SOURCES_JSON: authorizedSourcesJson(),
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"simulated":true}',
    },
    runJobSearch: async () => ({ report: reportFixture(), jobs }),
    persistJobs: (leads, _credential, { onProgress }) => persistJobsWithRepository(
      leads,
      repository,
      { now: new Date("2026-01-10T00:00:00.000Z"), onProgress },
    ),
    writeStdout: () => {},
    setExitCode: () => {},
  });

  assert.equal(report.status, "partial");
  assert.deepEqual(report.errors.map(({ stage }) => stage), ["firestore"]);
  assert.equal(report.persistence.created, 2);
  assert.equal(report.persistence.upserted, 2);
  assert.equal(report.persistence.reconciliation.scanned, 2);
  assert.equal(report.persistence.reconciliation.updated, 1);
  assert.equal(report.persistence.writes, 3);
  assert.equal(report.firestoreWrites, 3);
});

test("runs the regional feed and --persist pipeline against an in-memory repository", async () => {
  const ibgeCodes = new Map([
    ["Teixeira de Freitas", "2931350"],
    ["Porto Seguro", "2925303"],
    ["Eunápolis", "2910727"],
    ["Nova Viçosa", "2923001"],
    ["Mucuri", "2922003"],
  ]);
  const municipalities = municipalityListWithExtremoSul().map((municipality, index) => {
    const name = index === 13 ? "Porto Seguro" : index === 14 ? "Eunápolis" : municipality.nome;
    return {
      ...municipality,
      nome: name,
      id: ibgeCodes.get(name) || municipality.id,
    };
  });
  const records = [
    {
      id: "tf-001",
      title: "Analista de RH",
      company: "Rede Varejo Regional",
      city: "Teixeira de Freitas",
      url: "https://jobs.example.test/vagas/tf-001",
      description: "Rotinas de recrutamento e apoio ao departamento pessoal.",
    },
    {
      id: "ps-001",
      title: "Vendedor interno",
      company: "Comércio Costa do Descobrimento",
      city: "Porto Seguro",
      url: "https://jobs.example.test/vagas/ps-001",
      description: "Atendimento ao cliente e organização da loja.",
    },
    {
      id: "eu-001",
      title: "Recepcionista",
      company: "Clínica Exemplo Eunápolis",
      city: "Eunápolis",
      url: "https://jobs.example.test/vagas/eu-001",
      description: "Atendimento presencial e agendamento de consultas.",
    },
    {
      id: "nv-001",
      title: "Técnico de manutenção",
      company: "Serviços Regionais",
      city: "Posto da Mata",
      url: "https://jobs.example.test/vagas/nv-001",
      description: "Manutenção preventiva em equipamentos comerciais.",
    },
    {
      id: "mu-001",
      title: "Auxiliar de logística",
      company: "Distribuidora Exemplo",
      city: "Itabatã",
      url: "https://jobs.example.test/vagas/mu-001",
      description: "Conferência de mercadorias e apoio ao estoque.",
    },
  ].map((record) => ({
    ...record,
    publishedAt: "2026-11-25T12:00:00.000Z",
    validThrough: "2026-12-25T23:59:59.000Z",
  }));
  const feedRecords = [
    ...records,
    {
      ...records[0],
      id: "tf-001-duplicate",
      title: "  ANALISTA DE RH ",
      url: `${records[0].url}?utm_source=regional-test`,
    },
  ];
  const configuredSource = registeredTestSource();
  const fetchImpl = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.hostname === "servicodados.ibge.gov.br") {
      return response(municipalities);
    }
    if (requestUrl.href === configuredSource.feedUrl) {
      return response({ jobs: feedRecords });
    }
    throw new Error(`Unexpected request in controlled test: ${requestUrl.href}`);
  };
  const now = new Date("2026-11-26T12:00:00.000Z");
  const expiredDocument = ["previously-expired", {
    reviewStatus: "pending_review",
    triageStatus: "pending",
    validityStatus: "active",
    availability: "unknown",
    expiresAt: "2026-11-25T00:00:00.000Z",
  }];
  const repository = mockLeadRepository([expiredDocument]);
  const simulatedCredential = '{"simulated":true}';

  const executePersistedSearch = () => main(["--persist"], {
    env: {
      JOB_SEARCH_SOURCES_JSON: authorizedSourcesJson(),
      FIREBASE_SERVICE_ACCOUNT_JSON: simulatedCredential,
    },
    runJobSearch: ({ sourceWarnings }) => runJobSearch({
      sources: [configuredSource],
      fetchImpl,
      now,
      sourceWarnings,
    }),
    persistJobs: (jobs, credential, { onProgress }) => {
      assert.equal(credential, simulatedCredential);
      const preparedLeads = jobs.map(buildAutomatedJobLeadPayload);
      for (const lead of preparedLeads) {
        assert.equal(lead.origin, "automated_source");
        assert.equal(lead.triageStatus, "pending");
        assert.equal(lead.reviewStatus, "pending_review");
      }
      return persistJobsWithRepository(jobs, repository, { now, onProgress });
    },
    writeStdout: () => {},
    setExitCode: (code) => { assert.fail(`Unexpected CLI exit code ${code}`); },
  });

  const firstReport = await executePersistedSearch();
  const firstLeads = [...repository.documents.entries()]
    .filter(([id]) => id !== "previously-expired");
  const firstCreatedAt = new Map(firstLeads.map(([id, lead]) => [id, lead.createdAt]));
  const firstRegionalJobs = firstReport.geographicSummary.extremoSulBahia.jobs;
  const firstRegionalByCity = new Map(firstRegionalJobs.map((job) => [job.city, job]));

  assert.equal(firstReport.municipalityCount, EXPECTED_MUNICIPALITY_COUNT);
  assert.equal(firstReport.jobsNormalized, 5);
  assert.equal(firstReport.duplicateJobs, 1);
  assert.equal(firstReport.duplicatesIgnored, 1);
  assert.equal(firstReport.geographicSummary.extremoSulBahia.count, 3);
  assert.equal(firstRegionalByCity.get("Teixeira de Freitas").ibgeCode, "2931350");
  assert.equal(firstRegionalByCity.get("Nova Viçosa").ibgeCode, "2923001");
  assert.equal(firstRegionalByCity.get("Mucuri").ibgeCode, "2922003");
  assert.equal(firstRegionalByCity.get("Nova Viçosa").locationLabel, "Posto da Mata, Nova Viçosa");
  assert.equal(firstRegionalByCity.get("Mucuri").locationLabel, "Itabatã, Mucuri");
  assert.equal(firstReport.geographicSummary.outrosMunicipiosBahia.count, 2);
  const otherMunicipalities = new Map(
    firstReport.geographicSummary.outrosMunicipiosBahia.jobs.map((job) => [job.city, job]),
  );
  assert.equal(otherMunicipalities.get("Porto Seguro").ibgeCode, "2925303");
  assert.equal(otherMunicipalities.get("Eunápolis").ibgeCode, "2910727");
  assert.equal(firstReport.persistence.created, 5);
  assert.equal(firstReport.persistence.reconciliation.updated, 1);
  assert.equal(firstReport.firestoreWrites, 6);

  const approvedId = firstLeads.find(([, lead]) => lead.city === "Teixeira de Freitas")[0];
  repository.documents.set(approvedId, {
    ...repository.documents.get(approvedId),
    title: "Título revisado pela equipe",
    description: "Descrição curada manualmente.",
    reviewStatus: "approved",
    triageStatus: "approved",
  });

  const secondReport = await executePersistedSearch();
  const preservedLead = repository.documents.get(approvedId);
  const pendingLeads = [...repository.documents.entries()]
    .filter(([id, lead]) => id !== "previously-expired" && id !== approvedId && lead.triageStatus === "pending");

  assert.equal(secondReport.jobsNormalized, 5);
  assert.equal(secondReport.duplicateJobs, 1);
  assert.equal(secondReport.geographicSummary.extremoSulBahia.count, 3);
  assert.equal(secondReport.persistence.created, 0);
  assert.equal(secondReport.persistence.mergedPending, 4);
  assert.equal(secondReport.persistence.trackingOnly, 1);
  assert.equal(secondReport.persistence.writes, 5);
  assert.equal(secondReport.firestoreWrites, 5);
  assert.equal(repository.documents.size, 6);
  assert.equal(preservedLead.reviewStatus, "approved");
  assert.equal(preservedLead.triageStatus, "approved");
  assert.equal(preservedLead.title, "Título revisado pela equipe");
  assert.equal(preservedLead.description, "Descrição curada manualmente.");
  assert.equal(preservedLead.seenCount, 2);
  assert.equal(preservedLead.createdAt, firstCreatedAt.get(approvedId));
  assert.equal(pendingLeads.length, 4);
  assert.ok(pendingLeads.every(([, lead]) => lead.seenCount === 2));
  assert.equal(repository.documents.get("previously-expired").validityStatus, "expired");
  assert.equal(repository.documents.get("previously-expired").availability, "unavailable");
});
