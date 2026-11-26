const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const IBGE_MUNICIPALITIES_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/BA/municipios";
const JOBICY_API_URL = "https://jobicy.com/api/jobs";
const JOBICY_DOCUMENTATION_URL = "https://jobicy.com/jobs-rss-feed";
const REMOTE_OK_API_URL = "https://remoteok.com/api";
const EXPECTED_MUNICIPALITY_COUNT = 417;
const REQUEST_TIMEOUT_MS = 15000;
const JOBICY_PAGE_SIZE = 100;
const JOBICY_MAX_PAGES = 10;
const JOBICY_REQUEST_GAP_MS = 1100;
const DEFAULT_JOB_TTL_DAYS = 30;
const DEFAULT_STALE_AFTER_DAYS = 7;
const MAX_PERSIST_LEADS_PER_RUN = 200;
const RECONCILE_BATCH_SIZE = 100;
const MAX_RECONCILE_BATCHES = 2;
const PENDING_REVIEW_STATUSES = new Set([
  "new",
  "pending",
  "pending_review",
  "pending-review",
  "lead_pending_review",
  "aguardando_revisao",
  "aguardando revisao",
]);
const REMOTE_OK_ENABLED = false;
const REMOTE_OK_GLOBAL_LOCATIONS = new Set(["worldwide", "global", "anywhere in the world"]);
const AUTHORIZED_GENERIC_FEEDS = new Map();
const APPROVED_GENERIC_SOURCE = Symbol("approvedGenericSource");
const EXTREMO_SUL_MUNICIPALITY_NAMES = new Set([
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
].map(normalizeText));
const MUNICIPALITY_ALIASES = new Map([
  ["Posto da Mata", "Nova Viçosa"],
  ["Itabatã", "Mucuri"],
].map(([alias, municipality]) => [normalizeText(alias), {
  municipality: normalizeText(municipality),
  locality: alias,
}]));
const IRRELEVANT_URL_PARAM = /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|referrer)$/i;

const JOBICY_BRAZIL_SOURCE = {
  id: "jobicy-brazil",
  name: "Jobicy — vagas remotas elegíveis no Brasil",
  provider: "jobicy",
  feedUrl: JOBICY_API_URL,
  termsUrl: JOBICY_DOCUMENTATION_URL,
  authorized: true,
};

const REMOTE_OK_SOURCE = Object.freeze({
  id: "remoteok",
  name: "Remote OK — vagas remotas (inativo)",
  provider: "remoteok",
  feedUrl: REMOTE_OK_API_URL,
  termsUrl: REMOTE_OK_API_URL,
  authorized: false,
  termsReviewed: false,
});

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function validatePublicUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }

  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || [...url.searchParams.keys()].some((key) => /token|secret|credential|api[_-]?key|auth/i.test(key))
  ) {
    throw new Error(`${label} must be a public HTTPS URL without embedded credentials.`);
  }

  return url.href;
}

function positiveDays(value, fallback, label = "ttlDays") {
  const parsed = Number(value);
  if (value == null || value === "") return fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number of days.`);
  }
  return parsed;
}

function normalizeUrlForDedup(value) {
  const url = new URL(validatePublicUrl(value, "Job source URL"));
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (IRRELEVANT_URL_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function validDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function calculateExpiresAt(record, source, collectedAt) {
  const explicitExpiry = validDate(record.validThrough || record.expiresAt);
  if (explicitExpiry) return explicitExpiry.toISOString();

  const publicationDate = validDate(record.publishedAt);
  const baseDate = publicationDate || validDate(collectedAt);
  const ttlDays = positiveDays(
    source.ttlDays ?? source.defaultTtlDays,
    DEFAULT_JOB_TTL_DAYS,
    "source ttlDays",
  );
  return new Date(baseDate.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

function evaluateValidity(record, now = new Date(), staleAfterDays = DEFAULT_STALE_AFTER_DAYS) {
  const referenceDate = validDate(now);
  if (!referenceDate) throw new Error("Validity reference date must be valid.");

  const expiresAt = validDate(record.expiresAt || record.validThrough);
  if (expiresAt && expiresAt.getTime() <= referenceDate.getTime()) return "expired";

  const lastCollectedAt = validDate(record.collectedAt || record.fetchedAt || record.lastSeenAt);
  const staleWindowDays = positiveDays(staleAfterDays, DEFAULT_STALE_AFTER_DAYS, "staleAfterDays");
  if (
    !lastCollectedAt
    || lastCollectedAt.getTime() > referenceDate.getTime()
    || referenceDate.getTime() - lastCollectedAt.getTime() > staleWindowDays * 24 * 60 * 60 * 1000
  ) {
    return "stale";
  }

  return "active";
}

function isRemoteOkHost(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "remoteok.com" || hostname.endsWith(".remoteok.com");
  } catch {
    return false;
  }
}

function isRemoteOkSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && isRemoteOkHost(url.href)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function isBrazilEligibleRemoteOkLocation(value) {
  const location = normalizeText(value);
  return location === "brazil"
    || location === "brasil"
    || REMOTE_OK_GLOBAL_LOCATIONS.has(location);
}

function isRemoteOkLabel(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "").includes("remoteok");
}

function mapRemoteOkRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  return {
    id: record.id,
    title: record.position,
    companyName: record.company,
    url: isRemoteOkSourceUrl(record.apply_url) ? record.apply_url : "",
    description: record.description || "",
    modality: "Remoto",
    publishedAt: record.date,
    sourceLocation: record.location,
    countryEligibility: isBrazilEligibleRemoteOkLocation(record.location) ? "Brazil" : null,
  };
}

function validateMunicipalities(municipalities) {
  if (!Array.isArray(municipalities) || municipalities.length !== EXPECTED_MUNICIPALITY_COUNT) {
    throw new Error(`IBGE returned ${Array.isArray(municipalities) ? municipalities.length : 0} municipalities; expected ${EXPECTED_MUNICIPALITY_COUNT}.`);
  }

  const ids = new Set();
  const names = new Set();
  const validated = municipalities.map((municipality) => {
    const id = String(municipality.id || "");
    const name = String(municipality.nome || "").trim();
    const state = municipality.microrregiao?.mesorregiao?.UF?.sigla
      || municipality.regiaoImediata?.regiaoIntermediaria?.UF?.sigla
      || municipality.uf?.sigla
      || municipality.uf;

    if (!/^\d{7}$/.test(id) || !name || state !== "BA" || ids.has(id) || names.has(normalizeText(name))) {
      throw new Error("IBGE municipality response contains an invalid, duplicate, or non-BA municipality.");
    }

    ids.add(id);
    names.add(normalizeText(name));
    return { id, name, normalizedName: normalizeText(name), state: "BA" };
  });

  return validated.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
}

function getExtremoSulMunicipalityIds(municipalities) {
  return new Set(municipalities
    .filter((municipality) => EXTREMO_SUL_MUNICIPALITY_NAMES.has(municipality.normalizedName))
    .map((municipality) => municipality.id));
}

async function fetchBahiaMunicipalities(fetchImpl = fetch) {
  const response = await fetchImpl(IBGE_MUNICIPALITIES_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`IBGE request failed with HTTP ${response.status}.`);
  return validateMunicipalities(await response.json());
}

function parseSources(rawValue = "[]", approvedFeeds = AUTHORIZED_GENERIC_FEEDS) {
  let configured;
  try {
    configured = JSON.parse(rawValue);
  } catch {
    throw new Error("JOB_SEARCH_SOURCES_JSON must be valid JSON.");
  }
  if (!Array.isArray(configured)) throw new Error("JOB_SEARCH_SOURCES_JSON must be a JSON array.");

  return configured.map((source, index) => {
    const id = String(source.id || "").trim();
    const name = String(source.name || "").trim();
    if (!id || !name) throw new Error(`Source at index ${index} must have an id and name.`);
    if (isRemoteOkLabel(`${id} ${name}`)) {
      throw new Error("Remote OK is disabled and cannot be configured as a generic feed.");
    }
    const feedUrl = validatePublicUrl(source.feedUrl, `Source ${id} feedUrl`);
    const termsUrl = validatePublicUrl(source.termsUrl, `Source ${id} termsUrl`);
    if (isRemoteOkHost(feedUrl) || isRemoteOkHost(termsUrl)) {
      throw new Error("Remote OK is disabled and cannot be configured as a generic feed.");
    }
    if (approvedFeeds.get(id) !== feedUrl) {
      throw new Error(`Source ${id} is not registered in the code-reviewed generic feed allowlist.`);
    }
    const parsedSource = {
      id,
      name,
      feedUrl,
      termsUrl,
      authorized: source.authorized === true && source.termsReviewed === true,
      ttlDays: positiveDays(source.ttlDays, DEFAULT_JOB_TTL_DAYS, `Source ${id} ttlDays`),
      staleAfterDays: positiveDays(source.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, `Source ${id} staleAfterDays`),
    };
    Object.defineProperty(parsedSource, APPROVED_GENERIC_SOURCE, { value: true });
    return parsedSource;
  });
}

function findMunicipalityMatch(value, municipalities) {
  const candidates = String(value || "").split(/[,;|]/).map(normalizeText).filter(Boolean);
  for (const candidate of candidates) {
    const alias = MUNICIPALITY_ALIASES.get(candidate);
    const normalizedName = alias?.municipality || candidate;
    const municipality = municipalities.find((item) => item.normalizedName === normalizedName);
    if (municipality) return { municipality, locality: alias?.locality || null };
  }
  return { municipality: null, locality: null };
}

function findMunicipality(value, municipalities) {
  return findMunicipalityMatch(value, municipalities).municipality;
}

function isRemoteRecord(record, location, source) {
  if (source.provider === "remoteok") return record.countryEligibility === "Brazil";
  const normalizedLocation = normalizeText(location);
  const remoteModality = /(^|[^a-z])remot(e|o)([^a-z]|$)/.test(normalizeText(record.modality));
  const remoteLocation = [
    "remote",
    "remoto",
    "brazil",
    "brasil",
    ...REMOTE_OK_GLOBAL_LOCATIONS,
  ].includes(normalizedLocation);
  return record.countryEligibility === "Brazil"
    || remoteModality
    || remoteLocation;
}

function classifyLocation(record, source, municipalities, extremoSulIds) {
  const rawLocation = String(record.city || record.location || record.sourceLocation || record.state || "").trim();
  const { municipality, locality } = findMunicipalityMatch(rawLocation, municipalities);
  if (municipality) {
    const inExtremoSul = extremoSulIds.has(municipality.id);
    return {
      locationScope: "municipality",
      city: municipality.name,
      municipalityId: municipality.id,
      ibgeCode: municipality.id,
      state: "BA",
      locality,
      region: inExtremoSul ? "extremo_sul_ba" : null,
      locationLabel: locality ? `${locality}, ${municipality.name}` : municipality.name,
      sourceLocation: rawLocation || null,
    };
  }

  const normalizedLocation = normalizeText(rawLocation);
  if (/extremo sul/.test(normalizedLocation)) {
    return {
      locationScope: "regional_extremo_sul",
      city: null,
      municipalityId: null,
      ibgeCode: null,
      state: "BA",
      locality: null,
      region: "extremo_sul_ba",
      locationLabel: "Extremo Sul da Bahia",
      sourceLocation: rawLocation || null,
    };
  }

  if (
    ["ba", "bahia", "estado da bahia", "todo estado da bahia", "todo o estado da bahia"]
      .includes(normalizedLocation)
  ) {
    return {
      locationScope: "statewide_ba",
      city: null,
      municipalityId: null,
      ibgeCode: null,
      state: "BA",
      locality: null,
      region: null,
      locationLabel: "Bahia",
      sourceLocation: rawLocation || String(record.state || "").trim() || null,
    };
  }

  if (isRemoteRecord(record, rawLocation, source)) {
    const eligibility = record.countryEligibility === "Brazil" ? "Brasil" : "";
    return {
      locationScope: "remote",
      city: null,
      municipalityId: null,
      ibgeCode: null,
      state: null,
      locality: null,
      region: null,
      locationLabel: eligibility ? `Remoto — elegível no ${eligibility}` : "Remoto",
      sourceLocation: rawLocation || null,
    };
  }

  return {
    locationScope: "unverified",
    city: null,
    municipalityId: null,
    ibgeCode: null,
    state: null,
    locality: null,
    region: null,
    locationLabel: rawLocation || "Localização não verificada",
    sourceLocation: rawLocation || null,
  };
}

function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeJob(record, source, municipalities, now = new Date()) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  const title = String(record.title || "").trim();
  const sourceUrl = String(record.url || record.sourceUrl || "").trim();
  if (source.provider !== "remoteok" && isRemoteOkHost(sourceUrl)) return null;
  if (source.provider === "remoteok" && record.countryEligibility !== "Brazil") return null;
  const location = String(record.city || record.location || record.sourceLocation || record.state || "").trim();
  if (!title || (!location && !isRemoteRecord(record, location, source))) return null;

  let canonicalSourceUrl;
  let normalizedSourceUrl;
  try {
    canonicalSourceUrl = validatePublicUrl(sourceUrl, "Job source URL");
    normalizedSourceUrl = normalizeUrlForDedup(sourceUrl);
  } catch {
    return null;
  }

  const collectionDate = validDate(now);
  if (!collectionDate) throw new Error("Collection timestamp must be valid.");
  const collectedAt = collectionDate.toISOString();
  const geography = classifyLocation(record, source, municipalities, getExtremoSulMunicipalityIds(municipalities));
  const companyName = String(record.companyName || record.company || "").trim();
  const description = String(record.description || "").trim();
  const normalizedTitle = normalizeText(title);
  const normalizedCompany = normalizeText(companyName);
  const fingerprint = stableHash([
    normalizedTitle,
    normalizedCompany,
    geography.ibgeCode || geography.locationScope,
    normalizeText(description),
  ].join("\n"));
  const sourceRecordId = String(record.id || record.externalId || "").trim();
  const sourceIdentity = [
    source.id,
    normalizedTitle,
    normalizedCompany,
  ].join("\n");
  const identity = sourceRecordId
    ? `id:${normalizeText(sourceRecordId)}`
    : `url:${normalizedSourceUrl}`;
  const deduplicationKey = stableHash(`${sourceIdentity}\n${identity}`);
  const id = sourceRecordId
    ? stableHash(`${source.id}\n${normalizeText(sourceRecordId)}`)
    : deduplicationKey;
  const expiresAt = calculateExpiresAt(record, source, collectedAt);
  const validityStatus = evaluateValidity(
    { expiresAt, collectedAt },
    collectionDate,
    source.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS,
  );
  const availability = record.available === false || validityStatus === "expired"
    ? "unavailable"
    : record.available === true
      ? "available"
      : "unknown";

  return {
    id,
    fingerprint,
    deduplicationKey,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: canonicalSourceUrl,
    normalizedSourceUrl,
    termsUrl: source.termsUrl,
    sourceRecordId: sourceRecordId || null,
    source: {
      id: source.id,
      name: source.name,
      provider: source.provider || "json-feed",
      url: canonicalSourceUrl,
      termsUrl: source.termsUrl,
    },
    origin: "automated_source",
    title,
    companyName: companyName || null,
    ...geography,
    description: description || null,
    salary: record.salary == null ? null : String(record.salary),
    contract: String(record.contract || "").trim() || null,
    modality: String(record.modality || "").trim() || null,
    level: String(record.level || "").trim() || null,
    category: String(record.category || "").trim() || null,
    publishedAt: record.publishedAt && !Number.isNaN(Date.parse(record.publishedAt))
      ? new Date(record.publishedAt).toISOString()
      : null,
    validThrough: expiresAt,
    expiresAt,
    collectedAt,
    fetchedAt: collectedAt,
    lastSeenAt: collectedAt,
    ttlDays: positiveDays(source.ttlDays ?? source.defaultTtlDays, DEFAULT_JOB_TTL_DAYS, "source ttlDays"),
    availability,
    validityStatus,
  };
}

function mapJobicyRecord(record) {
  const salary = record.salaryMin == null && record.salaryMax == null
    ? null
    : [record.salaryMin, record.salaryMax]
      .filter((amount) => amount != null)
      .join("–");

  return {
    id: record.id,
    title: record.jobTitle,
    companyName: record.companyName,
    url: record.url,
    description: record.jobExcerpt || "",
    salary: salary && record.salaryCurrency
      ? `${salary} ${record.salaryCurrency}${record.salaryPeriod ? ` / ${record.salaryPeriod}` : ""}`
      : salary,
    contract: Array.isArray(record.jobType) ? record.jobType.join(", ") : record.jobType,
    modality: "Remoto",
    level: record.jobLevel,
    category: Array.isArray(record.jobIndustry) ? record.jobIndustry.join(", ") : record.jobIndustry,
    publishedAt: record.pubDate,
    sourceLocation: record.jobGeo,
    countryEligibility: "Brazil",
  };
}

function jobicyStatusMap(payload) {
  if (!Array.isArray(payload?.jobs)) throw new Error("Jobicy status response must contain a jobs array.");
  return new Map(payload.jobs.map((item) => [String(item.id), item.status]));
}

async function fetchJobicyJobs(source, fetchImpl, sleepImpl) {
  let lastRequestAt = 0;
  const records = [];
  let cursor = "";
  let pages = 0;
  let truncated = false;

  async function request(url) {
    if (lastRequestAt) {
      const waitMs = Math.max(0, JOBICY_REQUEST_GAP_MS - (Date.now() - lastRequestAt));
      if (waitMs) await sleepImpl(waitMs);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      lastRequestAt = Date.now();

      if (response.status !== 429 && response.status !== 503) return response;
      if (attempt === 2) return response;

      const retryAfter = Number(response.headers?.get("Retry-After")) || 1;
      await sleepImpl(Math.max(1, retryAfter) * 1000);
    }

    throw new Error("Jobicy request failed after retries.");
  }

  do {
    const url = new URL(source.feedUrl);
    url.searchParams.set("geo", "brazil");
    url.searchParams.set("count", String(JOBICY_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await request(url);
    if (!response.ok) throw new Error(`Jobicy jobs feed returned HTTP ${response.status}.`);
    const payload = await response.json();
    if (payload?.success === false || !Array.isArray(payload?.jobs)) {
      throw new Error(payload?.error || "Jobicy jobs response must contain a jobs array.");
    }

    records.push(...payload.jobs.map(mapJobicyRecord));
    pages += 1;
    cursor = payload.nextCursor || "";
    if (!cursor || payload.hasMore === false) break;
    if (pages >= JOBICY_MAX_PAGES) {
      truncated = true;
      break;
    }
  } while (cursor);

  const availabilityById = new Map();
  let availabilityError = "";
  const ids = [...new Set(records.map((record) => String(record.id || "")).filter((id) => /^\d+$/.test(id)))];

  try {
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      const url = new URL(`${source.feedUrl.replace(/\/$/, "")}/status`);
      url.searchParams.set("ids", batch.join(","));
      const response = await request(url);
      if (!response.ok) throw new Error(`Jobicy status endpoint returned HTTP ${response.status}.`);
      for (const [id, status] of jobicyStatusMap(await response.json())) {
        availabilityById.set(id, status);
      }
    }
  } catch (error) {
    availabilityError = error.message;
  }

  return { records, availabilityById, pages, truncated, availabilityError };
}

async function fetchRemoteOkJobs(source, fetchImpl) {
  if (!REMOTE_OK_ENABLED || !source.authorized || source.termsReviewed !== true) {
    throw new Error("Remote OK is inactive until its usage and aggregation permissions are reviewed.");
  }

  const response = await fetchImpl(source.feedUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Remote OK feed returned HTTP ${response.status}.`);

  const payload = await response.json();
  const legalNotice = Array.isArray(payload)
    ? payload.find((item) => typeof item?.legal === "string")?.legal
    : "";
  const normalizedLegalNotice = normalizeText(legalNotice);
  if (
    !Array.isArray(payload)
    || !normalizedLegalNotice.includes("link back")
    || !normalizedLegalNotice.includes("follow")
    || !normalizedLegalNotice.includes("without nofollow")
    || !normalizedLegalNotice.includes("mention remote ok")
  ) {
    throw new Error("Remote OK response is missing its required attribution terms.");
  }

  const records = payload.filter((item) => item && typeof item === "object" && item.position);
  return {
    records: records.map(mapRemoteOkRecord),
    availabilityById: new Map(),
    pages: 1,
    truncated: false,
    availabilityError: "",
  };
}

async function fetchSourceJobs(source, fetchImpl, sleepImpl) {
  if (source.provider === "jobicy") {
    return fetchJobicyJobs(source, fetchImpl, sleepImpl);
  }
  if (source.provider === "remoteok") {
    return fetchRemoteOkJobs(source, fetchImpl);
  }
  if (source[APPROVED_GENERIC_SOURCE] !== true || isRemoteOkHost(source.feedUrl)) {
    throw new Error("Generic source is not registered or targets the disabled Remote OK host.");
  }

  const response = await fetchImpl(source.feedUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Generic source redirects are not followed.");
  }
  if (response.url && isRemoteOkHost(response.url)) {
    throw new Error("Generic source resolved to the disabled Remote OK host.");
  }
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);

  const payload = await response.json();
  const records = Array.isArray(payload) ? payload : payload?.jobs;
  if (!Array.isArray(records)) throw new Error("Source response must be a JSON array or contain a jobs array.");
  const payloadItems = Array.isArray(payload) ? payload : [payload];
  const remoteOkPayload = payloadItems.some((item) => (
    typeof item?.legal === "string" && isRemoteOkLabel(item.legal)
  )) || records.some((record) => (
    record && (
      [record.provider, record.source, record.sourceName].some(isRemoteOkLabel)
      || isRemoteOkHost(record.url || record.sourceUrl || record.apply_url)
    )
  ));
  if (remoteOkPayload) throw new Error("Generic feed contains Remote OK records and is rejected.");
  return { records, availabilityById: new Map(), pages: 1, truncated: false, availabilityError: "" };
}

function addSourceReference(primaryJob, duplicateJob) {
  const sourceReference = {
    sourceId: duplicateJob.sourceId,
    sourceName: duplicateJob.sourceName,
    sourceUrl: duplicateJob.sourceUrl,
    termsUrl: duplicateJob.termsUrl,
  };
  const references = primaryJob.sourceReferences || [{
    sourceId: primaryJob.sourceId,
    sourceName: primaryJob.sourceName,
    sourceUrl: primaryJob.sourceUrl,
    termsUrl: primaryJob.termsUrl,
  }];
  if (!references.some((reference) => (
    reference.sourceId === sourceReference.sourceId
    && reference.sourceUrl === sourceReference.sourceUrl
  ))) {
    references.push(sourceReference);
  }
  primaryJob.sourceReferences = references;
}

function addRemoteOkSourceReference(primaryJob, duplicateJob) {
  return addSourceReference(primaryJob, duplicateJob);
}

function sourceDeduplicationKeys(job) {
  const identity = [
    job.sourceId,
    normalizeText(job.title),
    normalizeText(job.companyName),
  ].join("\n");
  const keys = [];
  if (job.sourceRecordId) {
    keys.push(stableHash(`${identity}\nid:${normalizeText(job.sourceRecordId)}`));
  }
  if (job.normalizedSourceUrl) {
    keys.push(stableHash(`${identity}\nurl:${job.normalizedSourceUrl}`));
  }
  return keys;
}

function buildAutomatedJobLeadPayload(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("A normalized job is required to build an automated lead payload.");
  }

  const source = job.source || {
    id: job.sourceId,
    name: job.sourceName,
    url: job.sourceUrl,
    termsUrl: job.termsUrl,
  };
  return {
    ...job,
    source: { ...source },
    ...(Array.isArray(job.sourceReferences)
      ? { sourceReferences: job.sourceReferences.map((reference) => ({ ...reference })) }
      : {}),
    origin: "automated_source",
    triageStatus: "pending",
    reviewStatus: "pending_review",
  };
}

function isPendingLead(lead) {
  if (!lead || typeof lead !== "object") return false;
  return ["reviewStatus", "triageStatus", "status"].every((field) => {
    const status = normalizeText(lead[field]);
    return !status || PENDING_REVIEW_STATUSES.has(status);
  });
}

function buildLeadPersistencePlan(job, existing, {
  now = new Date(),
  serverTimestamp = null,
} = {}) {
  if (!job || !/^[a-f0-9]{64}$/i.test(String(job.deduplicationKey || ""))) {
    throw new Error("A canonical 64-character deduplicationKey is required for persistence.");
  }
  const referenceDate = validDate(now);
  if (!referenceDate) throw new Error("Persistence reference date must be valid.");

  const nowIso = referenceDate.toISOString();
  const timestampValue = serverTimestamp ?? nowIso;
  const seenCount = existing
    ? Math.max(1, Number.isFinite(Number(existing.seenCount)) ? Number(existing.seenCount) : 1) + 1
    : 1;
  const validityMetadata = {
    collectedAt: job.collectedAt || nowIso,
    fetchedAt: job.fetchedAt || nowIso,
    lastSeenAt: nowIso,
    expiresAt: job.expiresAt || job.validThrough || null,
    validThrough: job.validThrough || job.expiresAt || null,
    validityStatus: job.validityStatus || evaluateValidity(job, referenceDate),
    availability: job.availability || "unknown",
    ttlDays: positiveDays(job.ttlDays, DEFAULT_JOB_TTL_DAYS),
    seenCount,
    updatedAt: timestampValue,
  };

  if (existing && !isPendingLead(existing)) {
    return {
      id: job.deduplicationKey,
      action: "tracking_only",
      data: validityMetadata,
    };
  }

  const data = {
    ...buildAutomatedJobLeadPayload(job),
    ...validityMetadata,
    createdAt: existing?.createdAt ?? timestampValue,
    firstSeenAt: existing?.firstSeenAt ?? existing?.createdAt ?? timestampValue,
  };
  if (existing) {
    for (const field of ["reviewStatus", "triageStatus", "status"]) {
      if (existing[field] && PENDING_REVIEW_STATUSES.has(normalizeText(existing[field]))) {
        data[field] = existing[field];
      }
    }
  }

  return {
    id: job.deduplicationKey,
    action: existing ? "merge_pending" : "create",
    data,
  };
}

function buildExpiredLeadPatch(lead, now = new Date(), serverTimestamp = null) {
  if (!isPendingLead(lead)) return null;
  const referenceDate = validDate(now);
  if (!referenceDate) throw new Error("Reconciliation reference date must be valid.");
  const expiresAt = validDate(lead.expiresAt || lead.validThrough);
  if (!expiresAt || expiresAt.getTime() > referenceDate.getTime()) return null;
  if (lead.validityStatus === "expired" && lead.availability === "unavailable" && lead.expiredAt) {
    return null;
  }

  const nowIso = referenceDate.toISOString();
  return {
    validityStatus: "expired",
    availability: "unavailable",
    expiredAt: nowIso,
    reconciledAt: nowIso,
    updatedAt: serverTimestamp ?? nowIso,
  };
}

async function reconcileExpiredPendingLeads(repository, now = new Date(), {
  batchSize = RECONCILE_BATCH_SIZE,
  maxBatches = MAX_RECONCILE_BATCHES,
} = {}) {
  if (
    !repository
    || typeof repository.listExpiredCandidates !== "function"
    || typeof repository.reconcileLead !== "function"
    || typeof repository.serverTimestamp !== "function"
  ) {
    throw new Error("A lead repository with expiry reconciliation methods is required.");
  }
  const referenceDate = validDate(now);
  if (!referenceDate) throw new Error("Reconciliation reference date must be valid.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > RECONCILE_BATCH_SIZE) {
    throw new Error(`Reconciliation batchSize must be between 1 and ${RECONCILE_BATCH_SIZE}.`);
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_RECONCILE_BATCHES) {
    throw new Error(`Reconciliation maxBatches must be between 1 and ${MAX_RECONCILE_BATCHES}.`);
  }

  let cursor = null;
  let scanned = 0;
  let updated = 0;
  let batches = 0;
  let lastBatchSize = 0;

  while (batches < maxBatches) {
    const candidates = await repository.listExpiredCandidates({
      now: referenceDate,
      limit: batchSize,
      cursor,
    });
    if (!Array.isArray(candidates)) {
      throw new Error("Lead repository must return an array of reconciliation candidates.");
    }
    batches += 1;
    scanned += candidates.length;
    lastBatchSize = candidates.length;

    for (const candidate of candidates) {
      if (!candidate?.id || !buildExpiredLeadPatch(
        candidate.data,
        referenceDate,
        repository.serverTimestamp(),
      )) {
        continue;
      }
      if (await repository.reconcileLead(candidate.id, referenceDate)) updated += 1;
    }

    if (candidates.length < batchSize) break;
    cursor = candidates[candidates.length - 1].cursor ?? candidates[candidates.length - 1].id;
  }

  return {
    scanned,
    updated,
    batches,
    truncated: batches === maxBatches && lastBatchSize === batchSize,
  };
}

async function persistJobsWithRepository(jobs, repository, {
  now = new Date(),
  maxLeads = MAX_PERSIST_LEADS_PER_RUN,
  reconciliationBatchSize = RECONCILE_BATCH_SIZE,
  reconciliationMaxBatches = MAX_RECONCILE_BATCHES,
} = {}) {
  const referenceDate = validDate(now);
  if (!referenceDate) throw new Error("Persistence reference date must be valid.");
  if (!Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > MAX_PERSIST_LEADS_PER_RUN) {
    throw new Error(`maxLeads must be between 1 and ${MAX_PERSIST_LEADS_PER_RUN}.`);
  }
  if (
    !repository
    || typeof repository.upsertLead !== "function"
    || typeof repository.serverTimestamp !== "function"
  ) {
    throw new Error("A lead repository with upsertLead and serverTimestamp is required.");
  }

  const uniqueJobs = new Map();
  for (const job of jobs) {
    if (!job || !/^[a-f0-9]{64}$/i.test(String(job.deduplicationKey || ""))) {
      throw new Error("Every persisted lead must have a canonical 64-character deduplicationKey.");
    }
    if (!uniqueJobs.has(job.deduplicationKey)) uniqueJobs.set(job.deduplicationKey, job);
  }
  if (uniqueJobs.size > maxLeads) {
    throw new Error(`Persistence capped at ${maxLeads} unique leads per run; no leads were written.`);
  }

  const counts = { created: 0, mergedPending: 0, trackingOnly: 0 };
  for (const job of uniqueJobs.values()) {
    const result = await repository.upsertLead(job.deduplicationKey, (existing) => (
      buildLeadPersistencePlan(job, existing, {
        now: referenceDate,
        serverTimestamp: repository.serverTimestamp(),
      })
    ));
    if (result?.action === "create") counts.created += 1;
    else if (result?.action === "merge_pending") counts.mergedPending += 1;
    else if (result?.action === "tracking_only") counts.trackingOnly += 1;
  }

  const reconciliation = await reconcileExpiredPendingLeads(repository, referenceDate, {
    batchSize: reconciliationBatchSize,
    maxBatches: reconciliationMaxBatches,
  });
  return {
    ...counts,
    upserted: uniqueJobs.size,
    reconciliation,
    writes: uniqueJobs.size + reconciliation.updated,
  };
}

async function runJobSearch({
  sources = [],
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = new Date(),
} = {}) {
  const report = {
    startedAt: now.toISOString(),
    completedAt: null,
    status: "running",
    municipalityCount: 0,
    sourcesConfigured: sources.length,
    sourcesAttempted: 0,
    sourcesSucceeded: 0,
    sourceRecords: 0,
    jobsNormalized: 0,
    duplicateJobs: 0,
    skippedRecords: 0,
    availableJobs: 0,
    unavailableJobs: 0,
    unknownAvailabilityJobs: 0,
    activeValidityJobs: 0,
    expiredJobs: 0,
    staleJobs: 0,
    countryRemoteJobs: 0,
    firestoreWrites: 0,
    duplicatesIgnored: 0,
    sourceResults: [],
    errors: [],
  };

  let municipalities;
  try {
    municipalities = await fetchBahiaMunicipalities(fetchImpl);
    report.municipalityCount = municipalities.length;
  } catch (error) {
    report.errors.push({ stage: "ibge", message: error.message });
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    return { report, jobs: [] };
  }

  const uniqueJobs = [];
  const jobsBySourceDeduplicationKey = new Map();
  const jobsByContentFingerprint = new Map();

  for (const source of sources) {
    const sourceDetails = {
      sourceId: source.id,
      sourceName: source.name,
      provider: source.provider || "json-feed",
      endpoint: source.feedUrl,
      termsUrl: source.termsUrl,
    };

    if (
      !source.authorized
      || (source.provider === "remoteok" && (!REMOTE_OK_ENABLED || source.termsReviewed !== true))
      || (!source.provider && source[APPROVED_GENERIC_SOURCE] !== true)
    ) {
      report.sourceResults.push({ ...sourceDetails, status: "skipped_unverified", records: 0, accepted: 0 });
      continue;
    }

    report.sourcesAttempted += 1;
    try {
      const result = await fetchSourceJobs(source, fetchImpl, sleepImpl);
      const { records, availabilityById } = result;
      report.sourcesSucceeded += 1;
      report.sourceRecords += records.length;
      let accepted = 0;
      let skipped = 0;
      let duplicates = 0;
      let expired = 0;
      let stale = 0;

      for (const record of records) {
        const job = normalizeJob(record, source, municipalities, now);
        if (!job) {
          skipped += 1;
          continue;
        }

        if (source.provider === "jobicy") {
          const availability = availabilityById.get(String(record.id));
          if (job.validityStatus === "expired") {
            job.availability = "unavailable";
          } else {
            if (availability === "active") job.availability = "available";
            if (availability === "closed") job.availability = "unavailable";
            if (availability === "unknown") job.availability = "unknown";
          }
        }

        const sourceKeys = sourceDeduplicationKeys(job);
        const sameSourceDuplicate = sourceKeys
          .map((key) => jobsBySourceDeduplicationKey.get(key))
          .find(Boolean);
        const contentDuplicate = jobsByContentFingerprint.get(job.fingerprint);
        const duplicateJob = sameSourceDuplicate
          || (contentDuplicate?.sourceId !== job.sourceId ? contentDuplicate : null);
        if (duplicateJob) {
          duplicates += 1;
          report.duplicatesIgnored += 1;
          if (duplicateJob.sourceId !== job.sourceId) {
            addSourceReference(duplicateJob, job);
          }
          continue;
        }

        for (const key of sourceKeys) jobsBySourceDeduplicationKey.set(key, job);
        if (!contentDuplicate) jobsByContentFingerprint.set(job.fingerprint, job);
        uniqueJobs.push(job);
        accepted += 1;
        if (job.validityStatus === "expired") expired += 1;
        if (job.validityStatus === "stale") stale += 1;
      }

      report.skippedRecords += skipped;
      report.duplicateJobs += duplicates;
      if (result.truncated) {
        report.errors.push({
          stage: "source",
          sourceId: source.id,
          message: `Pagination stopped at ${JOBICY_MAX_PAGES} pages; newer results were collected, but the 7-day feed may be incomplete.`,
        });
      }
      if (result.availabilityError) {
        report.errors.push({
          stage: "availability",
          sourceId: source.id,
          message: result.availabilityError,
        });
      }

      report.sourceResults.push({
        ...sourceDetails,
        status: result.truncated || result.availabilityError ? "partial" : "ok",
        records: records.length,
        accepted,
        skipped,
        duplicates,
        duplicatesIgnored: duplicates,
        expired,
        stale,
        pages: result.pages,
        availabilityChecked: availabilityById.size,
        paginationTruncated: result.truncated,
        availabilityCheckError: result.availabilityError || null,
      });
    } catch (error) {
      report.errors.push({ stage: "source", sourceId: source.id, message: error.message });
      report.sourceResults.push({ ...sourceDetails, status: "error", records: 0, accepted: 0 });
    }
  }

  report.jobsNormalized = uniqueJobs.length;
  report.activeValidityJobs = uniqueJobs.filter((job) => job.validityStatus === "active").length;
  report.expiredJobs = uniqueJobs.filter((job) => job.validityStatus === "expired").length;
  report.staleJobs = uniqueJobs.filter((job) => job.validityStatus === "stale").length;
  report.countryRemoteJobs = uniqueJobs.filter((job) => job.locationScope === "remote").length;
  report.availableJobs = uniqueJobs.filter((job) => job.availability === "available").length;
  report.unavailableJobs = uniqueJobs.filter((job) => job.availability === "unavailable").length;
  report.unknownAvailabilityJobs = uniqueJobs.filter((job) => job.availability === "unknown").length;
  report.status = sources.some((source) => source.authorized)
    ? report.errors.length ? "partial" : "completed"
    : "blocked_no_authorized_source";
  report.completedAt = new Date().toISOString();

  return { report, jobs: uniqueJobs };
}

function createFirestoreLeadRepository(db, admin) {
  const collection = db.collection("automatedJobLeads");
  return {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    async upsertLead(id, buildPlan) {
      const reference = collection.doc(id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const plan = buildPlan(snapshot.exists ? snapshot.data() : null);
        transaction.set(reference, plan.data, { merge: true });
        return plan;
      });
    },
    async listExpiredCandidates({ now, limit, cursor }) {
      let query = collection
        .where("expiresAt", "<=", now.toISOString())
        .orderBy("expiresAt")
        .limit(limit);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      return snapshot.docs.map((document) => ({
        id: document.id,
        data: document.data(),
        cursor: document,
      }));
    },
    async reconcileLead(id, now) {
      const reference = collection.doc(id);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) return false;
        const patch = buildExpiredLeadPatch(
          snapshot.data(),
          now,
          admin.firestore.FieldValue.serverTimestamp(),
        );
        if (!patch) return false;
        transaction.set(reference, patch, { merge: true });
        return true;
      });
    },
  };
}

async function persistJobs(jobs, serviceAccountJson) {
  if (!serviceAccountJson) {
    throw new Error("Firestore persistence requires FIREBASE_SERVICE_ACCOUNT_JSON.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.");
  }

  const admin = require("firebase-admin");
  const app = admin.initializeApp(
    { credential: admin.credential.cert(serviceAccount) },
    `girassol-job-bot-${process.pid}`,
  );
  try {
    const repository = createFirestoreLeadRepository(app.firestore(), admin);
    return await persistJobsWithRepository(jobs, repository);
  } finally {
    await app.delete();
  }
}

function renderSummary(report) {
  const lines = [
    "## Girassol Vagas — busca diária (dry-run)",
    "",
    `- **Resultado:** ${report.status}`,
    `- **Municípios validados pelo IBGE:** ${report.municipalityCount}/417`,
    `- **Fontes configuradas / consultadas / bem-sucedidas:** ${report.sourcesConfigured} / ${report.sourcesAttempted} / ${report.sourcesSucceeded}`,
    `- **Registros recebidos / normalizados / duplicados / ignorados:** ${report.sourceRecords} / ${report.jobsNormalized} / ${report.duplicateJobs} / ${report.skippedRecords}`,
    `- **Disponibilidade disponível / indisponível / desconhecida:** ${report.availableJobs} / ${report.unavailableJobs} / ${report.unknownAvailabilityJobs}`,
    `- **Validade ativa / expirada / desatualizada:** ${report.activeValidityJobs} / ${report.expiredJobs} / ${report.staleJobs}`,
    `- **Duplicatas ignoradas:** ${report.duplicatesIgnored}`,
    `- **Vagas remotas sem município específico:** ${report.countryRemoteJobs}`,
    `- **Gravações no Firestore:** ${report.firestoreWrites}`,
    "",
  ];

  if (report.persistence) {
    lines.push(
      "### Persistência de leads automatizados",
      `- Upserts / novos / pendentes atualizados / revisados preservados: ${report.persistence.upserted} / ${report.persistence.created} / ${report.persistence.mergedPending} / ${report.persistence.trackingOnly}`,
      `- Leads expirados reconciliados: ${report.persistence.reconciliation.updated} de ${report.persistence.reconciliation.scanned} lidos${report.persistence.reconciliation.truncated ? " (limite atingido; há possíveis pendências adicionais)" : ""}`,
      "",
    );
  }

  if (report.sourceResults.length) {
    lines.push("### Fontes consultadas", ...report.sourceResults.map((source) => (
      `- ${source.sourceName} (${source.status}) — ${source.endpoint}; termos/documentação: ${source.termsUrl}`
    )), "");
  }
  if (report.errors.length) {
    lines.push("### Erros", ...report.errors.map((error) => `- ${error.stage}${error.sourceId ? ` (${error.sourceId})` : ""}: ${error.message}`), "");
  }
  if (report.status === "blocked_no_authorized_source") {
    lines.push("Nenhuma fonte autorizada está configurada; nenhuma busca de vagas foi feita. Isso não significa que não existam vagas.", "");
  }

  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const persist = argv.includes("--persist");
  const outputIndex = argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? argv[outputIndex + 1] : "";
  const sources = [
    JOBICY_BRAZIL_SOURCE,
    REMOTE_OK_SOURCE,
    ...parseSources(process.env.JOB_SEARCH_SOURCES_JSON || "[]"),
  ];
  const { report, jobs } = await runJobSearch({ sources });

  if (persist) {
    try {
      report.persistence = await persistJobs(jobs, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      report.firestoreWrites = report.persistence.writes;
    } catch (error) {
      report.errors.push({ stage: "firestore", message: error.message });
      report.status = "partial";
    }
  }

  if (outputPath) {
    const absolutePath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const summary = renderSummary(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "failed" || report.status === "partial") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_MUNICIPALITY_COUNT,
  IBGE_MUNICIPALITIES_URL,
  JOBICY_API_URL,
  JOBICY_BRAZIL_SOURCE,
  JOBICY_DOCUMENTATION_URL,
  REMOTE_OK_API_URL,
  REMOTE_OK_SOURCE,
  DEFAULT_JOB_TTL_DAYS,
  DEFAULT_STALE_AFTER_DAYS,
  MAX_PERSIST_LEADS_PER_RUN,
  RECONCILE_BATCH_SIZE,
  MAX_RECONCILE_BATCHES,
  EXTREMO_SUL_MUNICIPALITY_NAMES,
  buildAutomatedJobLeadPayload,
  buildExpiredLeadPatch,
  buildLeadPersistencePlan,
  calculateExpiresAt,
  createFirestoreLeadRepository,
  evaluateValidity,
  fetchJobicyJobs,
  fetchRemoteOkJobs,
  fetchBahiaMunicipalities,
  addRemoteOkSourceReference,
  addSourceReference,
  mapRemoteOkRecord,
  mapJobicyRecord,
  normalizeUrlForDedup,
  normalizeJob,
  parseSources,
  persistJobs,
  persistJobsWithRepository,
  reconcileExpiredPendingLeads,
  runJobSearch,
  validateMunicipalities,
};
