const admin = require("firebase-admin");
const { defineSecret, defineString } = require("firebase-functions/params");
const { HttpsError, onCall, onRequest } = require("firebase-functions/v2/https");
const { evaluateJobModeration } = require("./job-moderation");

admin.initializeApp();

const db = admin.firestore();
const REGION = "southamerica-east1";
const FREE_DAILY_LIMIT = 2;
const EXTRA_PACK_SIZE = 2;
const EXTRA_PACK_PRICE = 5;
const ADMIN_EMAILS = ["sunflowercollectivegf@gmail.com"];
const ACTIVE_JOB_STATUSES = new Set(["aprovada", "pendente", "aguardando_pagamento"]);
const AUTOMATED_LEAD_PENDING_STATUSES = new Set([
  "",
  "new",
  "pending",
  "pending_review",
  "pending-review",
  "lead_pending_review",
  "aguardando_revisao",
  "aguardando revisao",
]);

const mercadoPagoAccessToken = defineSecret("MERCADO_PAGO_ACCESS_TOKEN");
const publicSiteUrl = defineString("PUBLIC_SITE_URL", {
  default: "https://gustavomotafa-create.github.io/guia-extremo-sul-ba",
});
const publicFunctionsUrl = defineString("PUBLIC_FUNCTIONS_URL", {
  default: "",
});

function todayInBahia(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bahia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function cleanString(value, fallback = "") {
  return String(value || fallback).trim().slice(0, 4000);
}

function cleanWhatsapp(value) {
  return cleanString(value).replace(/\D/g, "");
}

function parseSalary(value) {
  const number = Number(String(value || "").replace(/[^\d,.-]/g, "").replace(".", "").replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function moderationContextFor(auth, role, companyData = {}, hasPublicationHistory = false, duplicateFingerprint = false, now = new Date()) {
  return {
    now,
    profileRole: role,
    emailVerified: auth.token.email_verified === true,
    companyActive: companyData.active === true && companyData.verifiedByAdmin === true,
    hasPublicationHistory,
    duplicateFingerprint,
  };
}

function assertModerationAllowsSubmission(result) {
  if (result.decision !== "block") return;
  const reason = result.reasons.find((item) => item.severity === "block");
  throw new HttpsError("failed-precondition", reason?.message || "A vaga não passou pela moderação automática.");
}

function moderationFields(result) {
  return {
    expiresAt: result.expiresAt,
    fingerprint: result.fingerprint,
    moderationStatus: result.decision,
    moderationFlags: result.flags,
    moderationReasons: result.reasons,
    moderationVersion: result.ruleVersion,
    moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function activeDuplicateExists(snapshot, excludedJobId = "") {
  return snapshot?.size >= 20 || (snapshot?.docs || []).some((document) => {
    if (document.id === excludedJobId) return false;
    return ACTIVE_JOB_STATUSES.has(document.data()?.status);
  });
}

function publisherHistoryQuery(uid) {
  return db.collection("jobs")
    .where("companyId", "==", uid)
    .limit(20);
}

function hasPublisherHistory(snapshot) {
  return (snapshot?.docs || []).some((document) => document.data()?.status === "aprovada");
}

function duplicateFingerprintQuery(fingerprint) {
  return db.collection("jobs")
    .where("fingerprint", "==", fingerprint)
    .limit(20);
}

function moderationQuotaStatus(decision, paymentStatus) {
  if (decision === "review") return "pendente";
  if (paymentStatus === "aguardando_pagamento") return "aguardando_pagamento";
  return decision === "approve" ? "aprovada" : "pendente";
}

function moderationStatusForPayment(job, moderation) {
  const result = moderationFields(moderation);
  if (moderation.decision === "block") {
    const reason = moderation.reasons.find((item) => item.severity === "block");
    return {
      ...result,
      status: "rejeitada",
      moderationStatus: "block",
      rejectionReason: reason?.message || "A vaga não passou pela moderação automática.",
    };
  }
  if (moderation.decision === "review") {
    return {
      ...result,
      status: "pendente",
      moderationStatus: "review",
      rejectionReason: "",
    };
  }
  return {
    ...result,
    status: job.status === "pausada" ? "pausada" : "aprovada",
    moderationStatus: "approve",
    rejectionReason: "",
  };
}

function isAdminAuth(auth) {
  return Boolean(
    auth
      && (
        auth.token.admin === true
        || (auth.token.email_verified === true && ADMIN_EMAILS.includes(auth.token.email))
      ),
  );
}

async function assertPublisher(auth) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Entre para publicar vagas.");
  }

  const profile = await db.collection("users").doc(auth.uid).get();
  const role = profile.exists ? profile.data().role : null;

  return { uid: auth.uid, role, email: auth.token.email || "" };
}

async function assertAdminUser(auth) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Entre para revisar oportunidades.");
  }
  if (isAdminAuth(auth)) return { uid: auth.uid, email: auth.token.email || "" };

  const profile = await db.collection("users").doc(auth.uid).get();
  if (profile.exists && profile.data().role === "admin") {
    return { uid: auth.uid, email: auth.token.email || "" };
  }
  throw new HttpsError("permission-denied", "Somente administradores podem revisar oportunidades.");
}

function automatedLeadReviewState(lead) {
  const statuses = ["reviewStatus", "triageStatus", "status"]
    .map((field) => cleanString(lead[field]).toLowerCase().replace(/\s+/g, "_"))
    .filter(Boolean);
  const hasApproved = statuses.some((status) => ["approved", "aprovada", "aprovado"].includes(status));
  const hasRejected = statuses.some((status) => ["rejected", "rejeitada", "rejeitado"].includes(status));
  if (hasApproved && hasRejected) return "conflict";
  if (hasApproved) return "approved";
  if (hasRejected) return "rejected";
  return statuses.every((status) => AUTOMATED_LEAD_PENDING_STATUSES.has(status))
    ? "pending"
    : "other";
}

function reviewDraftValue(edits, previousDraft, lead, field, fallback = "") {
  if (Object.hasOwn(edits, field)) return edits[field];
  if (Object.hasOwn(previousDraft, field)) return previousDraft[field];
  return lead[field] ?? fallback;
}

function buildAutomatedLeadReviewDraft(lead, edits = {}, previousDraft = {}) {
  const stringField = (field, fallback = "", maxLength = 4000) => (
    cleanString(reviewDraftValue(edits, previousDraft, lead, field, fallback)).slice(0, maxLength)
  );
  const benefitsValue = reviewDraftValue(edits, previousDraft, lead, "benefits", []);
  const benefits = Array.isArray(benefitsValue)
    ? benefitsValue.map((item) => cleanString(item).slice(0, 300)).filter(Boolean).slice(0, 12)
    : cleanString(benefitsValue).split(",").map((item) => item.trim().slice(0, 300)).filter(Boolean).slice(0, 12);

  return {
    companyName: stringField("companyName", "", 180),
    title: stringField("title", "", 180),
    city: stringField("city", lead.city || lead.locationLabel || "", 120),
    category: stringField("category", "Serviços Gerais", 120),
    salaryLabel: stringField("salaryLabel", lead.salary ?? "A combinar", 120),
    contract: stringField("contract", "", 80),
    modality: stringField("modality", "", 80),
    level: stringField("level", "Júnior", 80),
    whatsapp: cleanWhatsapp(reviewDraftValue(edits, previousDraft, lead, "whatsapp", "")).slice(0, 20),
    description: stringField("description", "", 4000),
    requirements: stringField("requirements", "", 4000),
    benefits,
    logoUrl: stringField("logoUrl", "", 1000),
  };
}

function verifiedHttpsUrl(value, label, { required = false } = {}) {
  const rawUrl = cleanString(value);
  if (!rawUrl && !required) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid");
    return url.href;
  } catch {
    throw new HttpsError("failed-precondition", `${label} precisa ser uma URL HTTPS válida.`);
  }
}

function timestampDate(value) {
  if (value && typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildAutomatedPublishedJob(lead, leadId, adminUser, draft) {
  const requiredFields = [
    draft.companyName,
    draft.title,
    draft.city,
    draft.contract,
    draft.modality,
    draft.whatsapp,
    draft.description,
    draft.requirements,
  ];
  if (requiredFields.some((value) => !value)) {
    throw new HttpsError(
      "invalid-argument",
      "Complete empresa, cargo, município/local, contrato, modalidade, WhatsApp, descrição e requisitos antes de aprovar.",
    );
  }

  if (lead.validityStatus === "expired" || lead.availability === "unavailable") {
    throw new HttpsError("failed-precondition", "Esta oportunidade está marcada como expirada ou indisponível.");
  }
  const expiresAt = lead.expiresAt || lead.validThrough || null;
  const expiryDate = timestampDate(expiresAt);
  if (!expiryDate || expiryDate.getTime() <= Date.now()) {
    throw new HttpsError("failed-precondition", "A validade da oportunidade expirou ou não foi informada.");
  }

  const sourceData = lead.source && typeof lead.source === "object" ? lead.source : {};
  const sourceId = cleanString(lead.sourceId || sourceData.id).slice(0, 120);
  const sourceName = cleanString(lead.sourceName || sourceData.name).slice(0, 240);
  const sourceUrl = verifiedHttpsUrl(lead.sourceUrl || sourceData.url, "Link da vaga na fonte", { required: true });
  if (!sourceId || !sourceName) {
    throw new HttpsError("failed-precondition", "A oportunidade precisa ter uma fonte identificável.");
  }
  const sourceAttributionUrl = verifiedHttpsUrl(
    lead.attributionUrl || sourceData.attributionUrl,
    "Link de atribuição da fonte",
  );
  const sourceTermsUrl = verifiedHttpsUrl(
    lead.termsUrl || sourceData.termsUrl,
    "Link dos termos da fonte",
  );
  const sourceReferences = Array.isArray(lead.sourceReferences)
    ? lead.sourceReferences.slice(0, 20).map((reference) => ({
      sourceId: cleanString(reference?.sourceId).slice(0, 120),
      sourceName: cleanString(reference?.sourceName).slice(0, 240),
      sourceUrl: verifiedHttpsUrl(reference?.sourceUrl, "Link de vaga referenciada", { required: true }),
      termsUrl: verifiedHttpsUrl(reference?.termsUrl, "Link dos termos referenciados"),
      attributionUrl: verifiedHttpsUrl(reference?.attributionUrl, "Link de atribuição referenciado"),
    }))
    : [];
  const source = {
    id: sourceId,
    name: sourceName,
    provider: cleanString(sourceData.provider || "json-feed").slice(0, 80),
    url: sourceUrl,
    termsUrl: sourceTermsUrl,
    attributionUrl: sourceAttributionUrl,
  };
  const originalCity = cleanString(lead.city || lead.locationLabel);
  const sameMunicipality = normalizeCityKey(draft.city) === normalizeCityKey(originalCity);
  const locationMetadata = sameMunicipality
    ? {
      ibgeCode: lead.ibgeCode || lead.municipalityId || null,
      municipalityId: lead.municipalityId || lead.ibgeCode || null,
      region: lead.region || null,
      locationScope: lead.locationScope || "unverified",
      locationLabel: lead.locationLabel || draft.city,
      locality: lead.locality || null,
      sourceLocation: lead.sourceLocation || null,
    }
    : {
      ibgeCode: null,
      municipalityId: null,
      region: null,
      locationScope: "unverified",
      locationLabel: draft.city,
      locality: null,
      sourceLocation: draft.city,
    };

  return {
    automatedLeadId: leadId,
    companyId: adminUser.uid,
    companyOwnerUid: adminUser.uid,
    companyName: draft.companyName,
    title: draft.title,
    city: draft.city,
    state: "BA",
    ...locationMetadata,
    category: draft.category || "Serviços Gerais",
    contract: draft.contract,
    modality: draft.modality,
    level: draft.level || "Júnior",
    salary: parseSalary(draft.salaryLabel),
    salaryLabel: draft.salaryLabel || "A combinar",
    whatsapp: draft.whatsapp,
    description: draft.description,
    requirements: draft.requirements,
    benefits: draft.benefits,
    logoUrl: draft.logoUrl,
    tags: [draft.modality, draft.contract].filter(Boolean),
    status: "aprovada",
    paymentStatus: "gratis",
    quotaType: "automated",
    origin: "automated_source",
    source,
    sourceId,
    sourceName,
    sourceUrl,
    sourceAttributionUrl,
    sourceTermsUrl,
    sourceReferences,
    sourcePublishedAt: lead.publishedAt || null,
    collectedAt: lead.collectedAt || null,
    fetchedAt: lead.fetchedAt || null,
    expiresAt,
    validThrough: expiresAt,
    validityStatus: lead.validityStatus || "active",
    availability: lead.availability || "unknown",
    dateKey: todayInBahia(),
    publishedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function normalizeCityKey(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function assertJobOwnerOrAdmin(auth, jobId) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Entre para continuar.");
  }

  const jobRef = db.collection("jobs").doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) {
    throw new HttpsError("not-found", "Vaga não encontrada.");
  }

  const job = jobSnap.data();
  if (job.companyId !== auth.uid && !isAdminAuth(auth)) {
    throw new HttpsError("permission-denied", "Você não pode pagar por esta vaga.");
  }

  return { jobRef, job };
}

function buildJobPayload(data, auth, quota, moderation = null) {
  const companyName = cleanString(data.companyName);
  const title = cleanString(data.title);
  const city = cleanString(data.city);
  const contract = cleanString(data.contract);
  const modality = cleanString(data.modality);
  const whatsapp = cleanWhatsapp(data.whatsapp);
  const description = cleanString(data.description);
  const requirements = cleanString(data.requirements);
  const salaryLabel = cleanString(data.salaryLabel || data.salary, "A combinar");
  const salary = parseSalary(data.salary || data.salaryLabel);
  const benefits = Array.isArray(data.benefits)
    ? data.benefits.map((item) => cleanString(item)).filter(Boolean).slice(0, 12)
    : cleanString(data.benefits).split(",").map((item) => item.trim()).filter(Boolean).slice(0, 12);

  const requiredFields = { companyName, title, city, contract, modality, whatsapp, description, requirements };
  const missing = Object.entries(requiredFields).filter(([, value]) => !value).map(([key]) => key);

  if (missing.length) {
    throw new HttpsError("invalid-argument", "Preencha todos os campos obrigatórios da vaga.");
  }

  return {
    companyId: auth.uid,
    companyName,
    title,
    city,
    state: "BA",
    category: cleanString(data.category, "Serviços Gerais"),
    contract,
    modality,
    level: cleanString(data.level, "Júnior"),
    salary,
    salaryLabel,
    whatsapp,
    description,
    requirements,
    benefits,
    logoUrl: cleanString(data.logoUrl),
    tags: [modality, contract].filter(Boolean),
    status: quota.status,
    paymentStatus: quota.paymentStatus,
    quotaType: quota.quotaType,
    origin: quota.origin || "company",
    source: quota.origin || "company",
    dateKey: quota.dateKey,
    ...(moderation ? moderationFields(moderation) : {}),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function functionsBaseUrl() {
  const configured = publicFunctionsUrl.value();
  if (configured) return configured.replace(/\/$/, "");
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  return `https://${REGION}-${projectId}.cloudfunctions.net`;
}

async function createMercadoPagoPreference({ auth, companyId, dateKey, jobId = "", kind }) {
  const paymentRef = db.collection("payments").doc();
  const siteUrl = publicSiteUrl.value().replace(/\/$/, "");
  const token = mercadoPagoAccessToken.value();

  if (!token) {
    throw new HttpsError("failed-precondition", "Configure o segredo MERCADO_PAGO_ACCESS_TOKEN no Firebase.");
  }

  const payload = {
    items: [
      {
        id: "girassol-vagas-extra-pack",
        title: "Pacote de 2 publicações extras - Girassol Vagas",
        quantity: 1,
        unit_price: EXTRA_PACK_PRICE,
        currency_id: "BRL",
      },
    ],
    payer: {
      email: auth.token.email || undefined,
    },
    external_reference: paymentRef.id,
    metadata: {
      payment_id: paymentRef.id,
      company_id: companyId,
      date_key: dateKey,
      job_id: jobId,
      credits: EXTRA_PACK_SIZE,
      kind,
    },
    notification_url: `${functionsBaseUrl()}/mercadoPagoWebhook`,
    back_urls: {
      success: `${siteUrl}/empresa/?pagamento=aprovado`,
      pending: `${siteUrl}/empresa/?pagamento=pendente`,
      failure: `${siteUrl}/precos/?pagamento=erro`,
    },
    auto_return: "approved",
  };

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpsError("internal", body.message || "Não foi possível criar o checkout do Mercado Pago.");
  }

  await paymentRef.set({
    companyId,
    jobId: jobId || null,
    dateKey,
    kind,
    amount: EXTRA_PACK_PRICE,
    credits: EXTRA_PACK_SIZE,
    status: "pending",
    provider: "mercado_pago",
    providerPreferenceId: body.id || null,
    checkoutUrl: body.init_point || body.sandbox_init_point || "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    paymentId: paymentRef.id,
    checkoutUrl: body.init_point || body.sandbox_init_point || "",
  };
}

exports.createJobDraft = onCall({ region: REGION, secrets: [mercadoPagoAccessToken] }, async (request) => {
  const company = await assertPublisher(request.auth);
  const dateKey = todayInBahia();
  const isAdminOrigin = company.role === "admin" || isAdminAuth(request.auth);
  if (isAdminOrigin) {
    const jobRef = db.collection("jobs").doc();
    const status = cleanString(request.data?.status, "aprovada");
    const jobPayload = buildJobPayload(request.data || {}, request.auth, {
      status: ["pendente", "aprovada", "rejeitada", "pausada"].includes(status) ? status : "aprovada",
      paymentStatus: "gratis",
      quotaType: "manual",
      origin: "admin",
      dateKey,
    });

    if (jobPayload.status === "aprovada") {
      jobPayload.publishedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await jobRef.set(jobPayload);
    return {
      jobId: jobRef.id,
      status: jobPayload.status,
      paymentStatus: jobPayload.paymentStatus,
      origin: "admin",
      requiresPayment: false,
    };
  }

  const moderationNow = new Date().toISOString();
  const preliminaryModeration = evaluateJobModeration(
    request.data || {},
    moderationContextFor(request.auth, company.role, { active: true }, true, false, moderationNow),
  );
  assertModerationAllowsSubmission(preliminaryModeration);

  const usageRef = db.collection("companyDailyUsage").doc(`${company.uid}_${dateKey}`);
  const jobRef = db.collection("jobs").doc();

  const result = await db.runTransaction(async (transaction) => {
    const [usageSnap, duplicateSnapshot, companySnapshot, historySnapshot] = await Promise.all([
      transaction.get(usageRef),
      transaction.get(duplicateFingerprintQuery(preliminaryModeration.fingerprint)),
      transaction.get(db.collection("companies").doc(company.uid)),
      transaction.get(publisherHistoryQuery(company.uid)),
    ]);

    const moderation = evaluateJobModeration(
      request.data || {},
      moderationContextFor(
        request.auth,
        company.role,
        companySnapshot.exists ? companySnapshot.data() : {},
        hasPublisherHistory(historySnapshot),
        activeDuplicateExists(duplicateSnapshot),
        moderationNow,
      ),
    );
    assertModerationAllowsSubmission(moderation);

    const usage = usageSnap.exists ? usageSnap.data() : {};
    const freeUsed = Number(usage.freeUsed || 0);
    const paidCredits = Number(usage.paidCredits || 0);

    let quota = {
      status: "pendente",
      paymentStatus: "gratis",
      quotaType: "gratis",
      origin: "company",
      dateKey,
    };
    let requiresPayment = false;
    const usagePatch = {
      companyId: company.uid,
      dateKey,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (freeUsed < FREE_DAILY_LIMIT) {
      usagePatch.freeUsed = admin.firestore.FieldValue.increment(1);
    } else if (paidCredits > 0) {
      quota = { status: "pendente", paymentStatus: "paga", quotaType: "paga", origin: "company", dateKey };
      usagePatch.paidCredits = admin.firestore.FieldValue.increment(-1);
      usagePatch.paidUsed = admin.firestore.FieldValue.increment(1);
    } else {
      quota = {
        status: "aguardando_pagamento",
        paymentStatus: "aguardando_pagamento",
        quotaType: "paga",
        origin: "company",
        dateKey,
      };
      requiresPayment = true;
    }

    quota.status = moderationQuotaStatus(moderation.decision, quota.paymentStatus);
    const jobPayload = buildJobPayload(request.data || {}, request.auth, quota, moderation);
    if (jobPayload.status === "aprovada") {
      jobPayload.publishedAt = admin.firestore.FieldValue.serverTimestamp();
    }
    const usagePayload = {
      companyId: company.uid,
      dateKey,
      ...usagePatch,
    };

    if (!usageSnap.exists) {
      usagePayload.freeUsed = usagePayload.freeUsed || 0;
      usagePayload.paidCredits = usagePayload.paidCredits || 0;
      usagePayload.paidUsed = usagePayload.paidUsed || 0;
      usagePayload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    transaction.set(usageRef, usagePayload, { merge: true });
    transaction.set(jobRef, jobPayload);

    return {
      jobId: jobRef.id,
      status: jobPayload.status,
      paymentStatus: jobPayload.paymentStatus,
      requiresPayment,
      moderationStatus: moderation.decision,
      moderationFlags: moderation.flags,
    };
  });

  if (result.requiresPayment) {
    const checkout = await createMercadoPagoPreference({
      auth: request.auth,
      companyId: company.uid,
      dateKey,
      jobId: result.jobId,
      kind: "job_publication_pack",
    });

    return { ...result, ...checkout };
  }

  return result;
});

exports.updateCompanyJob = onCall({ region: REGION }, async (request) => {
  const publisher = await assertPublisher(request.auth);
  const jobId = cleanString(request.data?.jobId).slice(0, 200);
  const edits = request.data?.edits;
  if (!jobId || !edits || typeof edits !== "object" || Array.isArray(edits)) {
    throw new HttpsError("invalid-argument", "Informe a vaga e os campos revisados.");
  }

  const moderationNow = new Date().toISOString();
  const preliminaryModeration = evaluateJobModeration(
    edits,
    moderationContextFor(request.auth, publisher.role, { active: true }, true, false, moderationNow),
  );
  assertModerationAllowsSubmission(preliminaryModeration);

  const jobRef = db.collection("jobs").doc(jobId);
  return db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(jobRef);
    if (!jobSnapshot.exists) {
      throw new HttpsError("not-found", "Vaga não encontrada.");
    }

    const original = jobSnapshot.data();
    if (original.companyId !== publisher.uid) {
      throw new HttpsError("permission-denied", "Você não pode editar esta vaga.");
    }

    const [duplicateSnapshot, companySnapshot, historySnapshot] = await Promise.all([
      transaction.get(duplicateFingerprintQuery(preliminaryModeration.fingerprint)),
      transaction.get(db.collection("companies").doc(publisher.uid)),
      transaction.get(publisherHistoryQuery(publisher.uid)),
    ]);

    let moderation = evaluateJobModeration(
      edits,
      moderationContextFor(
        request.auth,
        publisher.role,
        companySnapshot.exists ? companySnapshot.data() : {},
        hasPublisherHistory(historySnapshot),
        activeDuplicateExists(duplicateSnapshot, jobId),
        moderationNow,
      ),
    );
    assertModerationAllowsSubmission(moderation);
    if (original.status === "rejeitada" && moderation.decision === "approve") {
      moderation = {
        ...moderation,
        decision: "review",
        flags: [...new Set([...moderation.flags, "previously_rejected"])].sort(),
        reasons: [
          ...moderation.reasons,
          {
            code: "previously_rejected",
            message: "Vaga rejeitada anteriormente; requer reavaliação administrativa.",
            severity: "review",
          },
        ],
      };
    }

    const paymentStatus = original.paymentStatus || "gratis";
    const status = original.status === "pausada"
      ? "pausada"
      : moderationQuotaStatus(moderation.decision, paymentStatus);
    const jobPayload = buildJobPayload(edits, request.auth, {
      status,
      paymentStatus,
      quotaType: original.quotaType || "gratis",
      origin: original.origin || "company",
      dateKey: original.dateKey || todayInBahia(),
    }, moderation);
    delete jobPayload.createdAt;
    if (status === "aprovada") {
      jobPayload.publishedAt = admin.firestore.FieldValue.serverTimestamp();
    } else {
      jobPayload.publishedAt = null;
    }
    jobPayload.rejectionReason = "";

    transaction.update(jobRef, jobPayload);
    return {
      jobId,
      status,
      paymentStatus,
      moderationStatus: moderation.decision,
      moderationFlags: moderation.flags,
    };
  });
});

exports.setCompanyVerification = onCall({ region: REGION }, async (request) => {
  const adminUser = await assertAdminUser(request.auth);
  const companyId = cleanString(request.data?.companyId).slice(0, 200);
  const verified = request.data?.verified;
  if (!companyId || typeof verified !== "boolean") {
    throw new HttpsError("invalid-argument", "Informe a empresa e o novo estado de verificação.");
  }

  const companyRef = db.collection("companies").doc(companyId);
  return db.runTransaction(async (transaction) => {
    const companySnapshot = await transaction.get(companyRef);
    if (!companySnapshot.exists) {
      throw new HttpsError("not-found", "Empresa não encontrada.");
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    transaction.update(companyRef, {
      verifiedByAdmin: verified,
      active: verified,
      verifiedAt: verified ? now : null,
      verifiedByUid: verified ? adminUser.uid : null,
      verifiedByEmail: verified ? adminUser.email : null,
      verificationUpdatedAt: now,
      verificationUpdatedByUid: adminUser.uid,
      verificationRevokedAt: verified ? null : now,
      verificationRevokedByUid: verified ? null : adminUser.uid,
      updatedAt: now,
    });

    return {
      companyId,
      verifiedByAdmin: verified,
      active: verified,
    };
  });
});

exports.listCompaniesForAdmin = onCall({ region: REGION }, async (request) => {
  await assertAdminUser(request.auth);
  const snapshot = await db.collection("companies").limit(201).get();
  const hasMore = snapshot.docs.length > 200;
  const companies = snapshot.docs.slice(0, 200).map((document) => {
    const company = document.data();
    return {
      id: document.id,
      ownerUid: company.ownerUid || document.id,
      name: cleanString(company.name).slice(0, 180),
      tradeName: cleanString(company.tradeName).slice(0, 180),
      email: cleanString(company.email).slice(0, 254),
      cnpj: cleanString(company.cnpj).slice(0, 32),
      active: company.active === true,
      verifiedByAdmin: company.verifiedByAdmin === true,
      verifiedAt: timestampDate(company.verifiedAt)?.toISOString() || null,
      verifiedByUid: company.verifiedByUid || null,
      verifiedByEmail: company.verifiedByEmail || null,
    };
  });
  return { companies, hasMore };
});

exports.reviewAutomatedJobLead = onCall({ region: REGION }, async (request) => {
  const adminUser = await assertAdminUser(request.auth);
  const requestData = request.data || {};
  const leadId = cleanString(requestData.leadId).toLowerCase();
  const action = cleanString(requestData.action);
  if (!/^[a-f0-9]{64}$/.test(leadId)) {
    throw new HttpsError("invalid-argument", "Identificador do lead inválido.");
  }
  if (!["save", "approve", "reject"].includes(action)) {
    throw new HttpsError("invalid-argument", "Ação de triagem inválida.");
  }
  if (
    requestData.edits !== undefined
    && (!requestData.edits || typeof requestData.edits !== "object" || Array.isArray(requestData.edits))
  ) {
    throw new HttpsError("invalid-argument", "Os campos revisados precisam ser um objeto.");
  }

  const leadRef = db.collection("automatedJobLeads").doc(leadId);
  const jobId = `automated_${leadId}`;
  const jobRef = db.collection("jobs").doc(jobId);
  const requestedEdits = requestData.edits || {};
  const rejectionReason = cleanString(requestData.reason).slice(0, 1000);

  return db.runTransaction(async (transaction) => {
    const leadSnapshot = await transaction.get(leadRef);
    if (!leadSnapshot.exists) {
      throw new HttpsError("not-found", "Lead automatizado não encontrado.");
    }

    const lead = leadSnapshot.data();
    const reviewState = automatedLeadReviewState(lead);

    if (action === "reject") {
      if (reviewState === "rejected") {
        return { action: "rejected", leadId, alreadyProcessed: true };
      }
      if (reviewState !== "pending") {
        throw new HttpsError("failed-precondition", "Somente leads pendentes podem ser rejeitados.");
      }
      transaction.update(leadRef, {
        reviewStatus: "rejected",
        triageStatus: "rejected",
        rejectionReason: rejectionReason || "Lead rejeitado pelo administrador.",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedByUid: adminUser.uid,
        reviewedByEmail: adminUser.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { action: "rejected", leadId, alreadyProcessed: false };
    }

    if (action === "save") {
      if (reviewState !== "pending") {
        throw new HttpsError("failed-precondition", "Somente leads pendentes podem ser editados.");
      }
      const reviewDraft = buildAutomatedLeadReviewDraft(
        lead,
        requestedEdits,
        lead.reviewDraft && typeof lead.reviewDraft === "object" ? lead.reviewDraft : {},
      );
      transaction.update(leadRef, {
        reviewDraft,
        reviewDraftUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewDraftUpdatedByUid: adminUser.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { action: "saved", leadId };
    }

    if (reviewState === "approved") {
      if (lead.jobId) {
        return { action: "approved", leadId, jobId: lead.jobId, alreadyProcessed: true };
      }
      const existingJobSnapshot = await transaction.get(jobRef);
      if (existingJobSnapshot.exists && existingJobSnapshot.data().automatedLeadId === leadId) {
        transaction.update(leadRef, {
          jobId,
          jobPath: `jobs/${jobId}`,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { action: "approved", leadId, jobId, alreadyProcessed: true };
      }
      throw new HttpsError("failed-precondition", "Lead aprovado sem referência segura à vaga publicada.");
    }
    if (reviewState !== "pending") {
      throw new HttpsError("failed-precondition", "Somente leads pendentes podem ser aprovados.");
    }

    const existingJobSnapshot = await transaction.get(jobRef);
    if (existingJobSnapshot.exists) {
      if (existingJobSnapshot.data().automatedLeadId !== leadId) {
        throw new HttpsError("already-exists", "Já existe um documento associado a este identificador de publicação.");
      }
      transaction.update(leadRef, {
        reviewStatus: "approved",
        triageStatus: "approved",
        jobId,
        jobPath: `jobs/${jobId}`,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewedByUid: adminUser.uid,
        reviewedByEmail: adminUser.email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { action: "approved", leadId, jobId, alreadyProcessed: true };
    }

    const previousDraft = lead.reviewDraft && typeof lead.reviewDraft === "object"
      ? lead.reviewDraft
      : {};
    const reviewDraft = buildAutomatedLeadReviewDraft(lead, requestedEdits, previousDraft);
    const jobPayload = buildAutomatedPublishedJob(lead, leadId, adminUser, reviewDraft);
    transaction.create(jobRef, jobPayload);
    transaction.update(leadRef, {
      reviewDraft,
      reviewStatus: "approved",
      triageStatus: "approved",
      jobId,
      jobPath: `jobs/${jobId}`,
      publishedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedByUid: adminUser.uid,
      reviewedByEmail: adminUser.email,
      rejectionReason: "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { action: "approved", leadId, jobId, alreadyProcessed: false };
  });
});

exports.createPublicationCheckout = onCall({ region: REGION, secrets: [mercadoPagoAccessToken] }, async (request) => {
  const jobId = cleanString(request.data?.jobId);
  if (!jobId) throw new HttpsError("invalid-argument", "Informe a vaga para pagamento.");

  const { job } = await assertJobOwnerOrAdmin(request.auth, jobId);
  if (job.paymentStatus !== "aguardando_pagamento") {
    throw new HttpsError("failed-precondition", "Esta vaga não está aguardando pagamento.");
  }

  return createMercadoPagoPreference({
    auth: request.auth,
    companyId: job.companyId,
    dateKey: job.dateKey || todayInBahia(),
    jobId,
    kind: "job_publication_pack",
  });
});

exports.createExtraPublicationPackCheckout = onCall({ region: REGION, secrets: [mercadoPagoAccessToken] }, async (request) => {
  const company = await assertPublisher(request.auth);
  return createMercadoPagoPreference({
    auth: request.auth,
    companyId: company.uid,
    dateKey: todayInBahia(),
    kind: "extra_publication_pack",
  });
});

exports.mercadoPagoWebhook = onRequest({ region: REGION, secrets: [mercadoPagoAccessToken] }, async (request, response) => {
  const paymentId = request.query["data.id"] || request.query.id || request.body?.data?.id;

  if (!paymentId) {
    response.status(200).send("ignored");
    return;
  }

  const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${mercadoPagoAccessToken.value()}`,
    },
  });

  if (!mpResponse.ok) {
    response.status(200).send("payment not available yet");
    return;
  }

  const payment = await mpResponse.json();
  if (payment.status !== "approved") {
    response.status(200).send("not approved");
    return;
  }

  const metadata = payment.metadata || {};
  const localPaymentId = payment.external_reference || metadata.payment_id;
  const companyId = metadata.company_id;
  const dateKey = metadata.date_key || todayInBahia();
  const jobId = metadata.job_id || "";
  const credits = Number(metadata.credits || EXTRA_PACK_SIZE);

  if (!localPaymentId || !companyId) {
    response.status(200).send("missing metadata");
    return;
  }

  const paymentRef = db.collection("payments").doc(localPaymentId);
  const usageRef = db.collection("companyDailyUsage").doc(`${companyId}_${dateKey}`);
  const jobRef = jobId ? db.collection("jobs").doc(jobId) : null;
  let publisherAuthUser = null;
  if (jobRef) {
    try {
      publisherAuthUser = await admin.auth().getUser(companyId);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  const moderationNow = new Date().toISOString();

  await db.runTransaction(async (transaction) => {
    const [paymentSnap, usageSnap, jobSnapshot] = await Promise.all([
      transaction.get(paymentRef),
      transaction.get(usageRef),
      jobRef ? transaction.get(jobRef) : Promise.resolve(null),
    ]);
    if (paymentSnap.exists && paymentSnap.data().status === "approved") return;
    let paymentModeration = null;
    if (
      jobSnapshot?.exists
      && jobSnapshot.data().paymentStatus === "aguardando_pagamento"
      && ["aguardando_pagamento", "pendente"].includes(jobSnapshot.data().status)
    ) {
      const currentJob = jobSnapshot.data();
      const ownerId = cleanString(currentJob.companyId);
      const [profileSnapshot, companySnapshot, historySnapshot] = ownerId
        ? await Promise.all([
          transaction.get(db.collection("users").doc(ownerId)),
          transaction.get(db.collection("companies").doc(ownerId)),
          transaction.get(publisherHistoryQuery(ownerId)),
        ])
        : [{ exists: false }, { exists: false }, { docs: [] }];
      const ownerMatchesPayment = ownerId === companyId;
      const moderationAuth = {
        token: {
          email_verified: ownerMatchesPayment
            && publisherAuthUser?.emailVerified === true
            && publisherAuthUser.disabled !== true,
        },
      };
      const role = ownerMatchesPayment && profileSnapshot.exists
        ? profileSnapshot.data().role
        : undefined;
      const companyData = ownerMatchesPayment && companySnapshot.exists
        ? companySnapshot.data()
        : {};
      const hasHistory = hasPublisherHistory(historySnapshot);
      const preliminaryModeration = evaluateJobModeration(
        currentJob,
        moderationContextFor(
          moderationAuth,
          role,
          companyData,
          hasHistory,
          false,
          moderationNow,
        ),
      );
      const duplicateSnapshot = await transaction.get(
        duplicateFingerprintQuery(preliminaryModeration.fingerprint),
      );
      const moderation = evaluateJobModeration(
        currentJob,
        moderationContextFor(
          moderationAuth,
          role,
          companyData,
          hasHistory,
          activeDuplicateExists(duplicateSnapshot, jobRef.id),
          moderationNow,
        ),
      );
      paymentModeration = moderationStatusForPayment(currentJob, moderation);
    }

    transaction.set(paymentRef, {
      companyId,
      jobId: jobId || null,
      dateKey,
      amount: payment.transaction_amount || EXTRA_PACK_PRICE,
      credits,
      status: "approved",
      provider: "mercado_pago",
      providerPaymentId: String(payment.id),
      paymentMethod: payment.payment_method_id || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    const usagePayload = {
      companyId,
      dateKey,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!usageSnap.exists) {
      usagePayload.freeUsed = 0;
      usagePayload.paidCredits = 0;
      usagePayload.paidUsed = 0;
      usagePayload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    if (jobRef) {
      if (jobSnapshot?.exists && paymentModeration) {
        transaction.update(jobRef, {
          ...paymentModeration,
          paymentStatus: "paga",
          paymentId: localPaymentId,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(paymentModeration.status === "aprovada"
            ? { publishedAt: admin.firestore.FieldValue.serverTimestamp() }
            : { publishedAt: null }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      transaction.set(usageRef, {
        ...usagePayload,
        paidCredits: admin.firestore.FieldValue.increment(Math.max(credits - 1, 0)),
        paidUsed: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      transaction.set(usageRef, {
        ...usagePayload,
        paidCredits: admin.firestore.FieldValue.increment(credits),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });

  response.status(200).send("ok");
});
