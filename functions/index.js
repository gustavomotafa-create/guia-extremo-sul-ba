const admin = require("firebase-admin");
const { defineSecret, defineString } = require("firebase-functions/params");
const { HttpsError, onCall, onRequest } = require("firebase-functions/v2/https");

admin.initializeApp();

const db = admin.firestore();
const REGION = "southamerica-east1";
const FREE_DAILY_LIMIT = 3;
const EXTRA_PACK_SIZE = 3;
const EXTRA_PACK_PRICE = 5;
const ADMIN_EMAILS = ["sunflowercollectivegf@gmail.com"];

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

function isAdminAuth(auth) {
  return Boolean(
    auth
      && (
        auth.token.admin === true
        || (auth.token.email_verified === true && ADMIN_EMAILS.includes(auth.token.email))
      ),
  );
}

async function assertCompany(auth) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Entre para publicar vagas.");
  }

  const profile = await db.collection("users").doc(auth.uid).get();
  const role = profile.exists ? profile.data().role : null;

  if (role !== "company" && role !== "admin" && !isAdminAuth(auth)) {
    throw new HttpsError("permission-denied", "Use uma conta de empresa para publicar vagas.");
  }

  return { uid: auth.uid, role, email: auth.token.email || "" };
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

function buildJobPayload(data, auth, quota) {
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
    dateKey: quota.dateKey,
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
        title: "Pacote de 3 publicações extras - Girassol Vagas",
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
  const company = await assertCompany(request.auth);
  const dateKey = todayInBahia();
  const usageRef = db.collection("companyDailyUsage").doc(`${company.uid}_${dateKey}`);
  const jobRef = db.collection("jobs").doc();
  let requiresPayment = false;

  const result = await db.runTransaction(async (transaction) => {
    const usageSnap = await transaction.get(usageRef);
    const usage = usageSnap.exists ? usageSnap.data() : {};
    const freeUsed = Number(usage.freeUsed || 0);
    const paidCredits = Number(usage.paidCredits || 0);

    let quota = {
      status: "pendente",
      paymentStatus: "gratis",
      quotaType: "gratis",
      dateKey,
    };
    const usagePatch = {
      companyId: company.uid,
      dateKey,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (freeUsed < FREE_DAILY_LIMIT) {
      usagePatch.freeUsed = admin.firestore.FieldValue.increment(1);
    } else if (paidCredits > 0) {
      quota = { status: "pendente", paymentStatus: "paga", quotaType: "paga", dateKey };
      usagePatch.paidCredits = admin.firestore.FieldValue.increment(-1);
      usagePatch.paidUsed = admin.firestore.FieldValue.increment(1);
    } else {
      quota = {
        status: "aguardando_pagamento",
        paymentStatus: "aguardando_pagamento",
        quotaType: "paga",
        dateKey,
      };
      requiresPayment = true;
    }

    const jobPayload = buildJobPayload(request.data || {}, request.auth, quota);
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
    };
  });

  if (requiresPayment) {
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
  const company = await assertCompany(request.auth);
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

  await db.runTransaction(async (transaction) => {
    const paymentSnap = await transaction.get(paymentRef);
    const usageSnap = await transaction.get(usageRef);
    if (paymentSnap.exists && paymentSnap.data().status === "approved") return;

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
      transaction.update(jobRef, {
        status: "pendente",
        paymentStatus: "paga",
        paymentId: localPaymentId,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
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
