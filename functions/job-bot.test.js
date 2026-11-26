const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_JOB_TTL_DAYS,
  DEFAULT_STALE_AFTER_DAYS,
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
  feedUrl: "https://jobs.example.test/feed.json",
  termsUrl: "https://jobs.example.test/terms",
  authorized: true,
  termsReviewed: true,
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

test("parses only public HTTPS sources and requires reviewed authorization", () => {
  const approvedFeeds = new Map([
    [source.id, source.feedUrl],
    ["unreviewed", source.feedUrl],
  ]);
  const parsed = parseSources(JSON.stringify([
    { ...source, authorized: true, termsReviewed: true },
    { ...source, id: "unreviewed", authorized: true, termsReviewed: false },
  ]), approvedFeeds);
  assert.equal(parsed[0].authorized, true);
  assert.equal(parsed[1].authorized, false);
  assert.throws(
    () => parseSources(JSON.stringify([source])),
    /not registered in the code-reviewed generic feed allowlist/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{ ...source, feedUrl: "https://example.test/?api_key=secret" }])),
    /without embedded credentials/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{
      ...source,
      feedUrl: REMOTE_OK_API_URL,
      termsUrl: REMOTE_OK_API_URL,
      authorized: true,
      termsReviewed: true,
    }])),
    /Remote OK is disabled/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{
      ...source,
      id: "remoteok-proxy",
      feedUrl: "https://proxy.example.test/feed.json",
    }]), new Map([["remoteok-proxy", "https://proxy.example.test/feed.json"]])),
    /Remote OK is disabled/,
  );
  assert.throws(
    () => parseSources(JSON.stringify([{
      ...source,
      feedUrl: "https://api.remoteok.com/feed.json",
    }])),
    /Remote OK is disabled/,
  );
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
