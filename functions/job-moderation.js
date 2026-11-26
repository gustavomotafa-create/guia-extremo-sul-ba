const { createHash } = require("node:crypto");
const { isIP } = require("node:net");

const RULE_VERSION = "1.0.0";
const DEFAULT_VALIDITY_DAYS = 30;
const MAX_VALIDITY_DAYS = 90;
const MAX_EXTERNAL_LINKS = 3;

const CONTRACTS = new Set(["clt", "pj", "freelancer", "estagio", "temporario"]);
const MODALITIES = new Set(["presencial", "remoto", "hibrido"]);
const REGIONS = new Set(["extremo_sul_ba", "bahia", "remote_brazil"]);
const DEFAULT_MUNICIPALITIES = [
  "Posto da Mata",
  "Nova Viçosa",
  "Teixeira de Freitas",
  "Mucuri",
  "Eunápolis",
  "Itabatã",
  "Medeiros Neto",
  "Caravelas",
  "Alcobaça",
];
const MUNICIPALITY_ALIASES = new Map([
  ["posto da mata", "nova vicosa"],
  ["itabata", "mucuri"],
]);
const SHORTENER_HOSTS = new Set([
  "adf.ly",
  "bit.do",
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "lnkd.in",
  "ow.ly",
  "rb.gy",
  "rebrand.ly",
  "short.io",
  "shorturl.at",
  "t.co",
  "tiny.cc",
  "tiny.one",
  "tinyurl.com",
]);

const MONEY_REQUEST_PATTERNS = [
  /\b(?:pague|pagar|pagamento|taxa|pix|deposito|transferencia)\b.{0,80}\b(?:vaga|candidatura|participar|selecao|entrevista|contratacao|curso|capacitacao)\b/,
  /\b(?:vaga|candidatura|participar|selecao|entrevista|contratacao)\b.{0,80}\b(?:pague|pagar|pagamento|taxa|pix|deposito|transferencia)\b/,
  /\b(?:curso|treinamento|capacitacao)\b.{0,80}\b(?:obrigatorio|obrigatoriamente)\b.{0,50}\b(?:pago|comprar|pagamento)\b/,
  /\b(?:taxa de inscricao|taxa para participar|pix obrigatorio|deposito obrigatorio)\b/,
];
const DISCRIMINATION_PATTERNS = [
  /\b(?:nao aceitamos|nao contratar|proibido contratar|somente|apenas)\s+(?:pessoas?\s+)?(?:negr[oa]s?|branc[oa]s?|indigenas?|mulheres?|homens?|mulheres trans|homens trans|pessoas com deficiencia|pessoas deficientes)\b/,
  /\b(?:vaga|trabalho)\s+(?:exclusiva|exclusivo)\s+para\s+(?:branc[oa]s?|negr[oa]s?|indigenas?)\b/,
];
const ILLEGAL_ACTIVITY_PATTERNS = [
  /\b(?:trabalho|vaga|servico)\s+(?:com|de)\s+(?:trafico de drogas|venda de drogas ilicitas|lavagem de dinheiro|documentos falsos)\b/,
  /\b(?:falsificar documentos|vender documentos falsos|lavar dinheiro|traficar drogas)\b/,
];

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedMunicipality(value) {
  const normalized = normalizeText(value);
  return MUNICIPALITY_ALIASES.get(normalized) || normalized;
}

function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (isRecord(value)) {
    if (typeof value.toDate === "function") return parseDate(value.toDate());
    if (Number.isFinite(value.seconds)) return value.seconds * 1000;
  }
  return null;
}

function normalizeRegion(value) {
  const normalized = normalizeText(value).replace(/[\s-]+/g, "_");
  if (["extremo_sul", "extremo_sul_bahia", "extremo_sul_da_bahia", "extremo_sul_ba"].includes(normalized)) {
    return "extremo_sul_ba";
  }
  if (["ba", "bahia"].includes(normalized)) return "bahia";
  if (["remoto", "remoto_brasil", "brasil_remoto", "remote_brazil"].includes(normalized)) {
    return "remote_brazil";
  }
  return normalized;
}

function municipalityEntries(context) {
  const supplied = context.validMunicipalities || context.municipalities;
  if (!Array.isArray(supplied)) {
    return DEFAULT_MUNICIPALITIES.map((name) => ({
      name,
      normalizedName: normalizedMunicipality(name),
      region: null,
    }));
  }

  return supplied
    .map((entry) => {
      const name = typeof entry === "string"
        ? entry
        : entry?.name || entry?.municipality || entry?.nome;
      if (!name) return null;
      return {
        name: String(name),
        normalizedName: normalizedMunicipality(name),
        region: entry && typeof entry === "object" ? normalizeRegion(entry.region) : null,
      };
    })
    .filter(Boolean);
}

function ipv4FromMappedIpv6(host) {
  const sections = host.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections[1] ? sections[1].split(":") : [];
  const missingGroups = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(missingGroups, 0)).fill("0"), ...right];
  if (groups.length !== 8 || groups.slice(0, 5).some((group) => group !== "0") || groups[5] !== "ffff") {
    return null;
  }
  const high = Number.parseInt(groups[6], 16);
  const low = Number.parseInt(groups[7], 16);
  return [
    high >> 8,
    high & 255,
    low >> 8,
    low & 255,
  ].join(".");
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !host
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".lan")
    || host.endsWith(".test")
    || host.endsWith(".home.arpa")
    || host.endsWith(".internal")
    || host === "host.docker.internal"
    || !host.includes(".") && isIP(host) === 0
  ) {
    return true;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = host.split(".").map(Number);
    const [first, second] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
      || first >= 224;
  }

  if (ipVersion === 6) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") || host.startsWith("fec") || host.startsWith("ff")) {
      return true;
    }
    const mappedIpv4 = ipv4FromMappedIpv6(host);
    if (mappedIpv4) return isPrivateOrLocalHost(mappedIpv4);
  }

  return false;
}

function extractLinks(jobInput) {
  const links = new Set();
  for (const value of Object.values(jobInput)) {
    const strings = Array.isArray(value) ? value : [value];
    for (const item of strings) {
      if (typeof item !== "string") continue;
      const matches = item.match(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi) || [];
      for (const match of matches) {
        const cleaned = match.replace(/[),.;!?]+$/g, "");
        links.add(cleaned.toLowerCase().startsWith("www.") ? `https://${cleaned}` : cleaned);
      }
    }
  }
  for (const [field, value] of Object.entries(jobInput)) {
    if (/(?:url|link|website|site)$/i.test(field) && typeof value === "string" && value.trim()) {
      const candidate = value.trim();
      links.add(candidate.startsWith("www.") ? `https://${candidate}` : candidate);
    }
  }
  return [...links];
}

function validateLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return "unsafe_link";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "unsafe_link";
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isPrivateOrLocalHost(hostname)) return "unsafe_link";
  if ([...SHORTENER_HOSTS].some((shortener) => hostname === shortener || hostname.endsWith(`.${shortener}`))) {
    return "suspicious_shortener";
  }
  return null;
}

function addFinding(findings, flags, code, message, severity) {
  flags.add(code);
  findings.push({ code, message, severity });
}

function fingerprintFor(jobInput, municipality) {
  const fields = [
    normalizeText(jobInput.title),
    normalizeText(jobInput.companyName),
    municipality,
    normalizeText(jobInput.contract),
    normalizeText(jobInput.modality),
    String(jobInput.whatsapp || "").replace(/\D/g, ""),
  ];
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

function evaluateJobModeration(jobInput, context = {}) {
  const input = isRecord(jobInput) ? jobInput : {};
  const ctx = isRecord(context) ? context : {};
  const reasons = [];
  const flags = new Set();
  const blockReasons = [];
  const reviewReasons = [];
  const addBlock = (code, message) => {
    addFinding(blockReasons, flags, code, message, "block");
  };
  const addReview = (code, message) => {
    addFinding(reviewReasons, flags, code, message, "review");
  };

  if (!isRecord(jobInput)) {
    addBlock("invalid_job_input", "Os dados da vaga precisam ser um objeto.");
  }

  const requiredTextFields = [
    ["companyName", "Nome do anunciante", 2, 180],
    ["title", "Título da vaga", 5, 120],
    ["city", "Município ou local", 2, 120],
    ["description", "Descrição", 30, 4000],
    ["requirements", "Requisitos", 5, 2000],
  ];
  for (const [field, label, minLength, maxLength] of requiredTextFields) {
    const value = typeof input[field] === "string" ? input[field].trim() : "";
    if (value.length < minLength || value.length > maxLength) {
      addBlock(
        `invalid_${field}`,
        `${label} deve ter entre ${minLength} e ${maxLength} caracteres.`,
      );
    }
  }

  const contract = normalizeText(input.contract);
  if (!CONTRACTS.has(contract)) {
    addBlock("invalid_contract", "Tipo de contrato inválido.");
  }
  const modality = normalizeText(input.modality);
  if (!MODALITIES.has(modality)) {
    addBlock("invalid_modality", "Modalidade inválida.");
  }

  const municipality = normalizedMunicipality(input.city);
  const remoteLocation = normalizeText(input.locationScope) === "remote"
    || ["remoto", "remoto brasil"].includes(normalizeText(input.city));
  const municipalities = municipalityEntries(ctx);
  const matchedMunicipality = municipalities.find((entry) => entry.normalizedName === municipality);
  const region = normalizeRegion(input.region);
  const allowedRegions = Array.isArray(ctx.allowedRegions)
    ? new Set(ctx.allowedRegions.map(normalizeRegion))
    : REGIONS;
  const regionLabel = normalizeRegion(input.city);
  const isRegionLocation = ["extremo_sul_ba", "bahia"].includes(regionLabel);

  if (remoteLocation) {
    if (modality !== "remoto") {
      addBlock("inconsistent_remote_location", "Uma vaga remota precisa usar a modalidade Remoto.");
    }
  } else if (!matchedMunicipality && !isRegionLocation) {
    addBlock("invalid_municipality", "Município ou região não está na lista permitida.");
  }
  if (region && !allowedRegions.has(region)) {
    addBlock("invalid_region", "Região inválida.");
  }
  if (region === "remote_brazil" && !remoteLocation) {
    addBlock("inconsistent_region", "A região Remoto Brasil exige uma vaga remota.");
  }
  if (remoteLocation && region && region !== "remote_brazil") {
    addBlock("inconsistent_region", "Vaga remota precisa usar uma região compatível.");
  }
  if (
    region === "extremo_sul_ba"
    && matchedMunicipality?.region
    && matchedMunicipality.region !== "extremo_sul_ba"
  ) {
    addBlock("inconsistent_region", "O município informado não pertence ao Extremo Sul da Bahia.");
  }

  const whatsapp = String(input.whatsapp || "").replace(/\D/g, "");
  if (whatsapp.length < 10 || whatsapp.length > 13) {
    addBlock("invalid_whatsapp", "WhatsApp deve conter entre 10 e 13 dígitos.");
  }

  const referenceTime = parseDate(ctx.now ?? input.submittedAt ?? input.createdAt);
  let expiresAt = null;
  if (referenceTime === null) {
    addBlock("invalid_reference_time", "Informe um horário de referência válido em context.now.");
  } else {
    const suppliedExpiry = input.expiresAt ?? input.validThrough;
    if (suppliedExpiry === undefined || suppliedExpiry === null || suppliedExpiry === "") {
      const validityDays = Number.isInteger(ctx.defaultValidityDays)
        ? ctx.defaultValidityDays
        : DEFAULT_VALIDITY_DAYS;
      if (validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) {
        addBlock("invalid_default_validity", "Validade padrão deve estar entre 1 e 90 dias.");
      } else {
        expiresAt = new Date(referenceTime + validityDays * 86400000).toISOString();
      }
    } else {
      const suppliedExpiryTime = parseDate(suppliedExpiry);
      if (suppliedExpiryTime === null || suppliedExpiryTime <= referenceTime) {
        addBlock("invalid_expiration", "A validade da vaga precisa ser uma data futura válida.");
      } else if (suppliedExpiryTime > referenceTime + MAX_VALIDITY_DAYS * 86400000) {
        addBlock("invalid_expiration", "A validade não pode exceder 90 dias.");
      } else {
        expiresAt = new Date(suppliedExpiryTime).toISOString();
      }
    }
  }

  const content = normalizeText([
    input.title,
    input.companyName,
    input.description,
    input.requirements,
    ...(Array.isArray(input.benefits) ? input.benefits : [input.benefits]),
  ].join(" "));
  if (MONEY_REQUEST_PATTERNS.some((pattern) => pattern.test(content))) {
    addBlock("candidate_payment_request", "A vaga aparenta exigir pagamento, taxa ou compra de curso do candidato.");
  }
  if (DISCRIMINATION_PATTERNS.some((pattern) => pattern.test(content))) {
    addBlock("discriminatory_content", "O conteúdo contém critério explícito de exclusão discriminatória.");
  }
  if (ILLEGAL_ACTIVITY_PATTERNS.some((pattern) => pattern.test(content))) {
    addBlock("illegal_activity", "O conteúdo aparenta divulgar atividade ilegal.");
  }

  const links = extractLinks(input);
  for (const link of links) {
    const linkIssue = validateLink(link);
    if (linkIssue === "unsafe_link") {
      addBlock("unsafe_link", "Foi encontrado link sem HTTPS ou para host local/privado.");
    } else if (linkIssue === "suspicious_shortener") {
      addBlock("suspicious_shortener", "Foi encontrado um encurtador de links não permitido.");
    }
  }
  const maximumLinks = Number.isInteger(ctx.maximumExternalLinks)
    ? ctx.maximumExternalLinks
    : MAX_EXTERNAL_LINKS;
  if (maximumLinks < 0 || links.length > maximumLinks) {
    addReview("excessive_external_links", "A vaga contém mais links externos do que o limite automático.");
  }

  if (ctx.emailVerified !== true) {
    addReview("email_unverified", "O email do anunciante ainda não foi confirmado.");
  }
  if (ctx.profileRole === "candidate" && ctx.hasPublicationHistory !== true) {
    addReview("candidate_without_history", "Conta de candidato sem histórico de publicações.");
  }
  if (ctx.profileRole === "company" && ctx.companyActive !== true) {
    addReview("company_not_active", "Empresa ainda não está marcada como ativa.");
  }
  if (!["candidate", "company", "admin"].includes(ctx.profileRole)) {
    addReview("unknown_advertiser_type", "Tipo de anunciante não reconhecido.");
  }
  const duplicateIsActive = ctx.duplicateFingerprint === true
    || ctx.duplicateFingerprint?.active === true
    || ctx.activeDuplicateFingerprint === true;
  if (duplicateIsActive) {
    addReview("active_duplicate", "Já existe uma vaga ativa com a mesma impressão digital.");
  }

  const fingerprint = fingerprintFor(input, municipality);
  reasons.push(...blockReasons, ...reviewReasons);
  const decision = blockReasons.length
    ? "block"
    : reviewReasons.length
      ? "review"
      : "approve";

  return {
    decision,
    reasons,
    flags: [...flags].sort(),
    ruleVersion: RULE_VERSION,
    fingerprint,
    expiresAt,
  };
}

module.exports = {
  evaluateJobModeration,
  RULE_VERSION,
};
