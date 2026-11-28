const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const IBGE_MUNICIPALITIES_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/BA/municipios";
const JOBICY_API_URL = "https://jobicy.com/api/jobs";
const JOBICY_DOCUMENTATION_URL = "https://jobicy.com/jobs-rss-feed";
const REMOTE_OK_API_URL = "https://remoteok.com/api";
const EXPECTED_MUNICIPALITY_COUNT = 417;
const REQUEST_TIMEOUT_MS = 15000;
const SOURCE_REQUEST_TIMEOUT_MS = 8000;
const MAX_SOURCE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GEOGRAPHIC_SUMMARY_JOBS = 200;
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
    || isBlockedHostname(url.hostname)
  ) {
    throw new Error(`${label} must be a public HTTPS URL without embedded credentials.`);
  }

  return url.href;
}

function ipv4IsNonPublic(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0);
}

function ipv6ToBigInt(hostname) {
  let value = hostname.toLowerCase();
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = value.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    const firstGroup = ((octets[0] << 8) | octets[1]).toString(16);
    const secondGroup = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, lastColon)}:${firstGroup}:${secondGroup}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6IsNonPublic(hostname) {
  const address = ipv6ToBigInt(hostname);
  if (address == null) return true;
  if (address === 0n || address === 1n) return true;

  const prefix = (bits) => address >> BigInt(128 - bits);
  if (
    prefix(7) === 0x7en
    || prefix(10) === 0x3fan
    || prefix(10) === 0x3fbn
    || prefix(8) === 0xffn
    || prefix(32) === 0x20010db8n
  ) {
    return true;
  }

  const upper96 = address >> 32n;
  if (upper96 === 0xffffn) {
    const ipv4 = Number(address & 0xffffffffn);
    const mappedHostname = [
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ].join(".");
    return ipv4IsNonPublic(mappedHostname);
  }
  return upper96 === 0n;
}

function isBlockedHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
  ) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return ipv4IsNonPublic(normalized);
  if (ipVersion === 6) return ipv6IsNonPublic(normalized);
  return false;
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

function isBlockedSourceLabel(value) {
  const normalized = normalizeText(value);
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return isRemoteOkLabel(value)
    || compact.includes("remotive")
    || /(^|[^a-z])sine(bahia)?([^a-z]|$)/.test(normalized);
}

function isBlockedSourceHost(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return isRemoteOkHost(value)
      || hostname === "remotive.com"
      || hostname.endsWith(".remotive.com")
      || hostname.split(".").some((label) => label.includes("sine"))
      || [
        "maisemprego.mte.gov.br",
        "empregabrasil.mte.gov.br",
        "sine.mte.gov.br",
      ].some((blockedHost) => hostname === blockedHost || hostname.endsWith(`.${blockedHost}`));
  } catch {
    return false;
  }
}

function recordIdentifiesBlockedSource(record) {
  if (!record || typeof record !== "object") return false;
  const sourceMetadata = record.source && typeof record.source === "object"
    ? record.source
    : {};
  const labels = [
    record.provider,
    record.source,
    record.sourceName,
    record.sourceId,
    record.source_name,
    sourceMetadata.provider,
    sourceMetadata.id,
    sourceMetadata.name,
  ];
  const urls = [
    record.url,
    record.sourceUrl,
    record.apply_url,
    record.applyUrl,
    record.jobUrl,
    record.link,
    sourceMetadata.url,
  ];
  return labels.some(isBlockedSourceLabel) || urls.some(isBlockedSourceHost);
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

function addSourceWarning(warnings, sourceId, index, message) {
  warnings.push({ sourceId: sourceId || null, index, message });
}

function validateFieldMapping(fieldMapping) {
  if (fieldMapping == null) return {};
  if (!fieldMapping || typeof fieldMapping !== "object" || Array.isArray(fieldMapping)) {
    throw new Error("fieldMapping must be a JSON object.");
  }
  const supportedFields = new Set([
    "id",
    "title",
    "company",
    "location",
    "city",
    "modality",
    "url",
    "publishedAt",
    "validThrough",
    "description",
    "salary",
    "contract",
    "country",
    "available",
  ]);
  const result = {};
  for (const [field, fieldPath] of Object.entries(fieldMapping)) {
    if (!supportedFields.has(field) || typeof fieldPath !== "string") {
      throw new Error(`fieldMapping contains an unsupported field or non-string path: ${field}.`);
    }
    const pathParts = fieldPath.split(".");
    if (
      pathParts.length > 8
      || pathParts.some((part) => (
        !/^[a-zA-Z0-9_$-]+$/.test(part)
        || ["__proto__", "prototype", "constructor"].includes(part)
      ))
    ) {
      throw new Error(`fieldMapping path for ${field} is invalid.`);
    }
    result[field] = fieldPath;
  }
  return result;
}

function parseSources(
  rawValue = "[]",
  approvedFeeds = AUTHORIZED_GENERIC_FEEDS,
  warnings = [],
) {
  let configured;
  try {
    configured = JSON.parse(rawValue);
  } catch {
    throw new Error("JOB_SEARCH_SOURCES_JSON must be valid JSON.");
  }
  if (!Array.isArray(configured)) throw new Error("JOB_SEARCH_SOURCES_JSON must be a JSON array.");

  const parsedSources = [];
  configured.forEach((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      addSourceWarning(warnings, null, index, "Source entry must be a JSON object; it was ignored.");
      return;
    }
    const id = String(source.id || "").trim();
    const name = String(source.name || "").trim();
    const rawUrl = source.url;
    const identity = `${id} ${name} ${source.provider || ""}`;
    if (
      isBlockedSourceLabel(identity)
      || isBlockedSourceHost(rawUrl)
      || isBlockedSourceHost(source.attributionUrl)
      || isBlockedSourceHost(source.termsUrl)
    ) {
      throw new Error("Remote OK, Remotive, and SINE sources are blocked from generic-feed configuration.");
    }
    if (source.enabled !== true) {
      addSourceWarning(warnings, id, index, "Source is not explicitly enabled; it was ignored.");
      return;
    }
    if (source.authorized !== true) {
      addSourceWarning(warnings, id, index, "Source lacks explicit authorization; it was ignored.");
      return;
    }
    if (source.type !== "json") {
      addSourceWarning(warnings, id, index, "Source type must be explicitly set to json; it was ignored.");
      return;
    }
    if (!id || !name || typeof rawUrl !== "string" || typeof source.attributionUrl !== "string") {
      addSourceWarning(
        warnings,
        id,
        index,
        "Source requires id, name, url, and attributionUrl; it was ignored.",
      );
      return;
    }

    let feedUrl;
    let attributionUrl;
    let termsUrl;
    let fieldMapping;
    try {
      feedUrl = validatePublicUrl(rawUrl, `Source ${id} url`);
      attributionUrl = validatePublicUrl(source.attributionUrl, `Source ${id} attributionUrl`);
      termsUrl = source.termsUrl
        ? validatePublicUrl(source.termsUrl, `Source ${id} termsUrl`)
        : attributionUrl;
      fieldMapping = validateFieldMapping(source.fieldMapping);
    } catch (error) {
      addSourceWarning(warnings, id, index, `${error.message} Source was ignored.`);
      return;
    }
    if (isBlockedSourceHost(feedUrl) || isBlockedSourceHost(attributionUrl) || isBlockedSourceHost(termsUrl)) {
      throw new Error("Remote OK, Remotive, and SINE sources are blocked from generic-feed configuration.");
    }
    if (approvedFeeds.has(id) && approvedFeeds.get(id) !== feedUrl) {
      addSourceWarning(warnings, id, index, "Configured URL differs from the reviewed URL; source was ignored.");
      return;
    }
    let ttlDays;
    let staleAfterDays;
    try {
      ttlDays = positiveDays(source.ttlDays, DEFAULT_JOB_TTL_DAYS, `Source ${id} ttlDays`);
      staleAfterDays = positiveDays(source.staleAfterDays, DEFAULT_STALE_AFTER_DAYS, `Source ${id} staleAfterDays`);
    } catch (error) {
      addSourceWarning(warnings, id, index, `${error.message} Source was ignored.`);
      return;
    }
    const parsedSource = {
      id,
      name,
      type: "json",
      enabled: true,
      feedUrl,
      attributionUrl,
      termsUrl,
      fieldMapping,
      authorized: true,
      ttlDays,
      staleAfterDays,
    };
    Object.defineProperty(parsedSource, APPROVED_GENERIC_SOURCE, { value: true });
    parsedSources.push(parsedSource);
  });
  return parsedSources;
}

function readMappedValue(record, fieldMapping, key, fallbacks = []) {
  const configuredPath = fieldMapping[key];
  const paths = configuredPath ? [configuredPath] : fallbacks;
  for (const fieldPath of paths) {
    let value = record;
    for (const part of fieldPath.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function mapConfiguredJsonRecord(record, source) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const mapping = source.fieldMapping || {};
  const location = mapping.location
    ? readMappedValue(record, mapping, "location")
    : mapping.city
      ? readMappedValue(record, mapping, "city")
      : readMappedValue(record, mapping, "location", ["city", "location", "sourceLocation"]);
  const country = readMappedValue(record, mapping, "country", ["country", "countryEligibility"]);
  const normalizedCountry = normalizeText(country ?? location);
  const brazilEligible = /(^|[^a-z])(brazil|brasil)([^a-z]|$)/.test(normalizedCountry);
  return {
    id: readMappedValue(record, mapping, "id", ["id", "externalId"]),
    title: readMappedValue(record, mapping, "title", ["title"]),
    companyName: readMappedValue(record, mapping, "company", ["companyName", "company"]),
    city: location,
    location,
    modality: readMappedValue(record, mapping, "modality", ["modality"]),
    url: readMappedValue(record, mapping, "url", ["url", "sourceUrl", "applyUrl"]),
    publishedAt: readMappedValue(record, mapping, "publishedAt", ["publishedAt", "published_at"]),
    validThrough: readMappedValue(record, mapping, "validThrough", ["validThrough", "expiresAt"]),
    description: readMappedValue(record, mapping, "description", ["description"]),
    salary: readMappedValue(record, mapping, "salary", ["salary"]),
    contract: readMappedValue(record, mapping, "contract", ["contract"]),
    available: readMappedValue(record, mapping, "available", ["available"]),
    countryEligibility: brazilEligible ? "Brazil" : null,
  };
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
  const termsUrl = source.termsUrl || source.attributionUrl || null;
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
    termsUrl,
    attributionUrl: source.attributionUrl || null,
    countryEligibility: record.countryEligibility === "Brazil" ? "Brazil" : null,
    sourceRecordId: sourceRecordId || null,
    source: {
      id: source.id,
      name: source.name,
      provider: source.provider || "json-feed",
      url: canonicalSourceUrl,
      termsUrl,
      attributionUrl: source.attributionUrl || null,
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

async function readJsonResponse(response, sourceId) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_RESPONSE_BYTES) {
    throw new Error(`Source ${sourceId} response exceeds the ${MAX_SOURCE_RESPONSE_BYTES}-byte limit.`);
  }

  let text;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SOURCE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Source ${sourceId} response exceeds the ${MAX_SOURCE_RESPONSE_BYTES}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else if (typeof response.text === "function") {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_RESPONSE_BYTES) {
      throw new Error(`Source ${sourceId} response exceeds the ${MAX_SOURCE_RESPONSE_BYTES}-byte limit.`);
    }
  } else if (typeof response.json === "function") {
    const payload = await response.json();
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_RESPONSE_BYTES) {
      throw new Error(`Source ${sourceId} response exceeds the ${MAX_SOURCE_RESPONSE_BYTES}-byte limit.`);
    }
    return payload;
  } else {
    throw new Error(`Source ${sourceId} response body is unreadable.`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Source ${sourceId} response is not valid JSON.`);
  }
}

async function fetchSourceJobs(source, fetchImpl, sleepImpl) {
  if (source.provider === "jobicy") {
    return fetchJobicyJobs(source, fetchImpl, sleepImpl);
  }
  if (source.provider === "remoteok") {
    return fetchRemoteOkJobs(source, fetchImpl);
  }
  if (
    source[APPROVED_GENERIC_SOURCE] !== true
    || !source.authorized
    || source.enabled !== true
    || source.type !== "json"
    || isBlockedSourceLabel(`${source.id} ${source.name} ${source.provider || ""}`)
  ) {
    throw new Error("Generic source is not authorized, enabled, or supported.");
  }
  const feedUrl = validatePublicUrl(source.feedUrl, `Source ${source.id} url`);
  const attributionUrl = validatePublicUrl(source.attributionUrl, `Source ${source.id} attributionUrl`);
  if (
    isBlockedSourceHost(feedUrl)
    || isBlockedSourceHost(attributionUrl)
    || isBlockedSourceHost(source.termsUrl)
  ) {
    throw new Error("Remote OK, Remotive, and SINE sources are blocked from generic-feed requests.");
  }

  const response = await fetchImpl(feedUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Generic source redirects are not followed.");
  }
  if (response.url) {
    const resolvedUrl = validatePublicUrl(response.url, `Source ${source.id} response URL`);
    const expectedUrl = new URL(feedUrl);
    const actualUrl = new URL(resolvedUrl);
    expectedUrl.hash = "";
    actualUrl.hash = "";
    if (actualUrl.href !== expectedUrl.href) {
      throw new Error("Generic source resolved to a different URL; redirects are not followed.");
    }
  }
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);

  const payload = await readJsonResponse(response, source.id);
  const records = Array.isArray(payload) ? payload : payload?.jobs;
  if (!Array.isArray(records)) throw new Error("Source response must be a JSON array or contain a jobs array.");
  const payloadItems = Array.isArray(payload) ? payload : [payload];
  const blockedPayload = payloadItems.some((item) => (
    typeof item?.legal === "string" && isBlockedSourceLabel(item.legal)
  )) || records.some(recordIdentifiesBlockedSource);
  if (blockedPayload) {
    throw new Error("Generic feed contains a blocked Remote OK, Remotive, or SINE source and is rejected.");
  }
  return {
    records: records.map((record) => mapConfiguredJsonRecord(record, source)),
    availabilityById: new Map(),
    pages: 1,
    truncated: false,
    availabilityError: "",
  };
}

function addSourceReference(primaryJob, duplicateJob) {
  const sourceReference = {
    sourceId: duplicateJob.sourceId,
    sourceName: duplicateJob.sourceName,
    sourceUrl: duplicateJob.sourceUrl,
    termsUrl: duplicateJob.termsUrl,
    ...(duplicateJob.attributionUrl ? { attributionUrl: duplicateJob.attributionUrl } : {}),
  };
  const references = primaryJob.sourceReferences || [{
    sourceId: primaryJob.sourceId,
    sourceName: primaryJob.sourceName,
    sourceUrl: primaryJob.sourceUrl,
    termsUrl: primaryJob.termsUrl,
    ...(primaryJob.attributionUrl ? { attributionUrl: primaryJob.attributionUrl } : {}),
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

function createPersistenceProgress() {
  return {
    created: 0,
    mergedPending: 0,
    trackingOnly: 0,
    upserted: 0,
    reconciliation: {
      scanned: 0,
      updated: 0,
      batches: 0,
      truncated: false,
    },
    writes: 0,
  };
}

function copyPersistenceProgress(progress) {
  return {
    ...progress,
    reconciliation: { ...progress.reconciliation },
  };
}

async function reconcileExpiredPendingLeads(repository, now = new Date(), {
  batchSize = RECONCILE_BATCH_SIZE,
  maxBatches = MAX_RECONCILE_BATCHES,
  onProgress = () => {},
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
  let truncated = false;

  const notifyProgress = () => onProgress({ scanned, updated, batches, truncated });

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
    truncated = batches === maxBatches && lastBatchSize === batchSize;
    notifyProgress();

    for (const candidate of candidates) {
      if (!candidate?.id || !buildExpiredLeadPatch(
        candidate.data,
        referenceDate,
        repository.serverTimestamp(),
      )) {
        continue;
      }
      if (await repository.reconcileLead(candidate.id, referenceDate)) {
        updated += 1;
        notifyProgress();
      }
    }

    if (candidates.length < batchSize) break;
    cursor = candidates[candidates.length - 1].cursor ?? candidates[candidates.length - 1].id;
  }

  notifyProgress();
  return { scanned, updated, batches, truncated };
}

async function persistJobsWithRepository(jobs, repository, {
  now = new Date(),
  maxLeads = MAX_PERSIST_LEADS_PER_RUN,
  reconciliationBatchSize = RECONCILE_BATCH_SIZE,
  reconciliationMaxBatches = MAX_RECONCILE_BATCHES,
  onProgress = () => {},
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

  const progress = createPersistenceProgress();
  const notifyProgress = () => onProgress(copyPersistenceProgress(progress));
  notifyProgress();

  for (const job of uniqueJobs.values()) {
    const result = await repository.upsertLead(job.deduplicationKey, (existing) => (
      buildLeadPersistencePlan(job, existing, {
        now: referenceDate,
        serverTimestamp: repository.serverTimestamp(),
      })
    ));
    progress.upserted += 1;
    progress.writes += 1;
    if (result?.action === "create") progress.created += 1;
    else if (result?.action === "merge_pending") progress.mergedPending += 1;
    else if (result?.action === "tracking_only") progress.trackingOnly += 1;
    notifyProgress();
  }

  const reconciliation = await reconcileExpiredPendingLeads(repository, referenceDate, {
    batchSize: reconciliationBatchSize,
    maxBatches: reconciliationMaxBatches,
    onProgress: (reconciliationProgress) => {
      progress.reconciliation = { ...reconciliationProgress };
      progress.writes = progress.upserted + progress.reconciliation.updated;
      notifyProgress();
    },
  });
  progress.reconciliation = reconciliation;
  progress.writes = uniqueJobs.size + reconciliation.updated;
  notifyProgress();
  return copyPersistenceProgress(progress);
}

function summarizeGeographicJob(job) {
  return {
    title: job.title,
    companyName: job.companyName,
    city: job.city,
    locationLabel: job.locationLabel,
    ibgeCode: job.ibgeCode,
    locationScope: job.locationScope,
    modality: job.modality,
    sourceId: job.sourceId,
    sourceName: job.sourceName,
    sourceUrl: job.sourceUrl,
    attributionUrl: job.attributionUrl || job.termsUrl,
    validityStatus: job.validityStatus,
  };
}

function geographicGroup(jobs) {
  const orderedJobs = [...jobs].sort((left, right) => (
    String(left.city || left.locationLabel || "").localeCompare(
      String(right.city || right.locationLabel || ""),
      "pt-BR",
    ) || String(left.title).localeCompare(String(right.title), "pt-BR")
  ));
  return {
    count: orderedJobs.length,
    jobs: orderedJobs.slice(0, MAX_GEOGRAPHIC_SUMMARY_JOBS).map(summarizeGeographicJob),
    truncated: orderedJobs.length > MAX_GEOGRAPHIC_SUMMARY_JOBS,
  };
}

function buildGeographicSummary(jobs) {
  const extremoSulBahia = [];
  const outrosMunicipiosBahia = [];
  const remotoBrasil = [];
  const semLocalConfirmado = [];

  for (const job of jobs) {
    if (job.locationScope === "municipality" && job.region === "extremo_sul_ba") {
      extremoSulBahia.push(job);
    } else if (job.locationScope === "municipality" && /^\d{7}$/.test(String(job.ibgeCode || ""))) {
      outrosMunicipiosBahia.push(job);
    } else if (job.locationScope === "remote" && job.countryEligibility === "Brazil") {
      remotoBrasil.push(job);
    } else {
      semLocalConfirmado.push(job);
    }
  }

  return {
    extremoSulBahia: geographicGroup(extremoSulBahia),
    outrosMunicipiosBahia: geographicGroup(outrosMunicipiosBahia),
    remotoBrasil: geographicGroup(remotoBrasil),
    semLocalConfirmado: geographicGroup(semLocalConfirmado),
  };
}

async function runJobSearch({
  sources = [],
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = new Date(),
  sourceWarnings = [],
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
    warnings: [...sourceWarnings],
    geographicSummary: buildGeographicSummary([]),
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
      attributionUrl: source.attributionUrl || source.termsUrl,
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
  report.countryRemoteJobs = uniqueJobs.filter(
    (job) => job.locationScope === "remote" && job.countryEligibility === "Brazil",
  ).length;
  report.geographicSummary = buildGeographicSummary(uniqueJobs);
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

async function persistJobs(jobs, serviceAccountJson, options = {}) {
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
    return await persistJobsWithRepository(jobs, repository, options);
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
    if (report.persistence.skipped) {
      lines.push(
        "### Persistência de leads automatizados",
        `- Persistência não executada: ${report.persistence.reason}`,
        "",
      );
    } else {
      lines.push(
        "### Persistência de leads automatizados",
        `- Upserts / novos / pendentes atualizados / revisados preservados: ${report.persistence.upserted} / ${report.persistence.created} / ${report.persistence.mergedPending} / ${report.persistence.trackingOnly}`,
        `- Leads expirados reconciliados: ${report.persistence.reconciliation.updated} de ${report.persistence.reconciliation.scanned} lidos${report.persistence.reconciliation.truncated ? " (limite atingido; há possíveis pendências adicionais)" : ""}`,
        "",
      );
    }
  }

  const geographic = report.geographicSummary;
  lines.push(
    "### Resumo geográfico",
    `- Extremo Sul da Bahia: ${geographic.extremoSulBahia.count}`,
    `- Outros municípios da Bahia: ${geographic.outrosMunicipiosBahia.count}`,
    `- Remoto elegível no Brasil: ${geographic.remotoBrasil.count}`,
    `- Sem local confirmado: ${geographic.semLocalConfirmado.count}`,
    "",
  );

  if (report.sourceResults.length) {
    lines.push("### Fontes consultadas", ...report.sourceResults.map((source) => (
      `- ${source.sourceName} (${source.status}) — ${source.endpoint}; atribuição: ${source.attributionUrl}`
    )), "");
  }
  if (report.warnings.length) {
    lines.push(
      "### Avisos de configuração",
      ...report.warnings.map((warning) => (
        `- ${warning.sourceId ? `${warning.sourceId}: ` : ""}${warning.message}`
      )),
      "",
    );
  }
  if (report.errors.length) {
    lines.push("### Erros", ...report.errors.map((error) => `- ${error.stage}${error.sourceId ? ` (${error.sourceId})` : ""}: ${error.message}`), "");
  }
  if (report.status === "blocked_no_authorized_source") {
    lines.push("Nenhuma fonte autorizada está configurada; nenhuma busca de vagas foi feita. Isso não significa que não existam vagas.", "");
  }

  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const persist = argv.includes("--persist");
  const outputIndex = argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? argv[outputIndex + 1] : "";
  const environment = dependencies.env || process.env;
  const runJobSearchImpl = dependencies.runJobSearch || runJobSearch;
  const persistJobsImpl = dependencies.persistJobs || persistJobs;
  const writeStdout = dependencies.writeStdout || ((text) => process.stdout.write(text));
  const setExitCode = dependencies.setExitCode || ((code) => {
    process.exitCode = code;
  });
  const sourceWarnings = [];
  const configuredSources = parseSources(
    environment.JOB_SEARCH_SOURCES_JSON || "[]",
    AUTHORIZED_GENERIC_FEEDS,
    sourceWarnings,
  );
  const sources = [
    JOBICY_BRAZIL_SOURCE,
    REMOTE_OK_SOURCE,
    ...configuredSources,
  ];
  const { report, jobs } = await runJobSearchImpl({ sources, sourceWarnings });

  if (persist) {
    report.persistence = createPersistenceProgress();
    const updatePersistenceProgress = (progress) => {
      report.persistence = copyPersistenceProgress(progress);
      report.firestoreWrites = progress.writes;
    };

    try {
      report.persistence = await persistJobsImpl(
        jobs,
        environment.FIREBASE_SERVICE_ACCOUNT_JSON,
        { onProgress: updatePersistenceProgress },
      );
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
  if (environment.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, summary, "utf8");
  }
  writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "failed" || report.status === "partial") setExitCode(1);
  return report;
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
  SOURCE_REQUEST_TIMEOUT_MS,
  MAX_SOURCE_RESPONSE_BYTES,
  MAX_GEOGRAPHIC_SUMMARY_JOBS,
  EXTREMO_SUL_MUNICIPALITY_NAMES,
  buildAutomatedJobLeadPayload,
  buildExpiredLeadPatch,
  buildGeographicSummary,
  buildLeadPersistencePlan,
  calculateExpiresAt,
  createFirestoreLeadRepository,
  evaluateValidity,
  fetchJobicyJobs,
  fetchRemoteOkJobs,
  fetchBahiaMunicipalities,
  main,
  addRemoteOkSourceReference,
  addSourceReference,
  mapRemoteOkRecord,
  mapConfiguredJsonRecord,
  mapJobicyRecord,
  normalizeUrlForDedup,
  normalizeJob,
  parseSources,
  persistJobs,
  persistJobsWithRepository,
  reconcileExpiredPendingLeads,
  runJobSearch,
  validateMunicipalities,
  validatePublicUrl,
};
