const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { URL } = require("node:url");
const { evaluateJobModeration } = require("./job-moderation");

const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const leadId = "a".repeat(64);
const adminAuth = {
  uid: "admin-user",
  token: {
    admin: true,
    email: "admin@example.test",
    email_verified: true,
  },
};

function createMockFirestore(seed = {}, { fetchImpl, secret = "" } = {}) {
  const collections = new Map(
    Object.entries(seed).map(([name, documents]) => [name, new Map(Object.entries(documents))]),
  );
  const transactions = [];
  let timestampCount = 0;
  let autoIdCount = 0;

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function applyFields(existing = {}, incoming = {}) {
    const updated = { ...existing };
    for (const [field, value] of Object.entries(incoming)) {
      if (value && typeof value === "object" && Number.isFinite(value.mockIncrement)) {
        updated[field] = Number(updated[field] || 0) + value.mockIncrement;
      } else {
        updated[field] = value;
      }
    }
    return updated;
  }

  function documentReference(collectionName, id) {
    return {
      collectionName,
      id: String(id),
      async get() {
        const document = getCollection(collectionName).get(String(id));
        return {
          exists: Boolean(document),
          data: () => (document ? { ...document } : undefined),
        };
      },
      async set(data, options = {}) {
        const documents = getCollection(collectionName);
        documents.set(String(id), options.merge
          ? applyFields(documents.get(String(id)) || {}, data)
          : applyFields({}, data));
      },
    };
  }

  function queryReference(collectionName, filters = [], maxResults = Infinity) {
    const query = {
      collectionName,
      filters,
      maxResults,
      where(field, operator, value) {
        return queryReference(collectionName, [...filters, { field, operator, value }], maxResults);
      },
      limit(limit) {
        return queryReference(collectionName, filters, limit);
      },
      async get() {
        const documents = [...getCollection(collectionName).entries()]
          .filter(([, data]) => filters.every(({ field, operator, value }) => (
            operator === "==" && data[field] === value
          )))
          .slice(0, maxResults)
          .map(([id, data]) => ({ id, data: () => ({ ...data }) }));
        return { docs: documents, size: documents.length, empty: documents.length === 0 };
      },
    };
    return query;
  }

  const db = {
    collection(name) {
      return {
        doc(id) {
          const generatedId = id === undefined ? `auto-${++autoIdCount}` : id;
          return documentReference(name, generatedId);
        },
        where(field, operator, value) {
          return queryReference(name, [{ field, operator, value }]);
        },
        limit(limit) {
          return queryReference(name, [], limit);
        },
      };
    },
    async runTransaction(callback) {
      const operations = [];
      const transaction = {
        async get(reference) {
          if (Array.isArray(reference.filters)) {
            return queryReference(reference.collectionName, reference.filters, reference.maxResults).get();
          }
          const document = getCollection(reference.collectionName).get(reference.id);
          return {
            exists: Boolean(document),
            data: () => (document ? { ...document } : undefined),
          };
        },
        set(reference, data, options = {}) {
          operations.push({ type: "set", reference, data, options });
        },
        create(reference, data) {
          operations.push({ type: "create", reference, data });
        },
        update(reference, data) {
          operations.push({ type: "update", reference, data });
        },
      };

      const result = await callback(transaction);
      for (const operation of operations) {
        const documents = getCollection(operation.reference.collectionName);
        if (operation.type === "create") {
          if (documents.has(operation.reference.id)) {
            throw new Error(`Document already exists: ${operation.reference.collectionName}/${operation.reference.id}`);
          }
          documents.set(operation.reference.id, applyFields({}, operation.data));
        } else if (operation.type === "set") {
          documents.set(operation.reference.id, operation.options.merge
            ? applyFields(documents.get(operation.reference.id) || {}, operation.data)
            : applyFields({}, operation.data));
        } else {
          const existing = documents.get(operation.reference.id);
          if (!existing) {
            throw new Error(`Document does not exist: ${operation.reference.collectionName}/${operation.reference.id}`);
          }
          documents.set(operation.reference.id, applyFields(existing, operation.data));
        }
      }

      transactions.push({
        operations: operations.map(({ type, reference }) => ({
          type,
          collection: reference.collectionName,
          id: reference.id,
        })),
      });
      return result;
    },
    documents(name) {
      return getCollection(name);
    },
    transactions,
  };
  const firestore = () => db;
  firestore.FieldValue = {
    serverTimestamp() {
      timestampCount += 1;
      return `mock-server-timestamp-${timestampCount}`;
    },
    increment(amount) {
      return { mockIncrement: amount };
    },
  };

  return { db, firestore, collections, transactions, fetchImpl, secret };
}

function loadHandlers(mock) {
  class MockHttpsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const exports = {};
  const admin = {
    initializeApp() {},
    firestore: mock.firestore,
  };
  const params = {
    defineSecret() {
      return { value: () => mock.secret || "" };
    },
    defineString(_name, options = {}) {
      return { value: () => options.default || "" };
    },
  };
  const https = {
    HttpsError: MockHttpsError,
    onCall(_options, handler) {
      return handler;
    },
    onRequest(_options, handler) {
      return handler;
    },
  };
  const sandbox = {
    exports,
    URL,
    require(name) {
      if (name === "firebase-admin") return admin;
      if (name === "firebase-functions/params") return params;
      if (name === "firebase-functions/v2/https") return https;
      if (name === "./job-moderation") return { evaluateJobModeration };
      throw new Error(`Unexpected dependency in callable test: ${name}`);
    },
    fetch: mock.fetchImpl || (async () => { throw new Error("Unexpected network request in callable test."); }),
    process: { env: { GCLOUD_PROJECT: "test-project" } },
  };

  vm.runInNewContext(source, sandbox, { filename: path.join(__dirname, "index.js") });
  return exports;
}

function pendingLead(overrides = {}) {
  return {
    reviewStatus: "pending_review",
    triageStatus: "pending",
    title: "Assistente administrativo",
    companyName: "Empresa Exemplo",
    city: "Teixeira de Freitas",
    state: "BA",
    locationScope: "municipality",
    region: "extremo_sul_ba",
    ibgeCode: "2931350",
    municipalityId: "2931350",
    locationLabel: "Teixeira de Freitas",
    modality: "Presencial",
    contract: "CLT",
    level: "Júnior",
    category: "Administração",
    salary: "R$ 2.000,00",
    description: "Atendimento ao público e apoio administrativo.",
    requirements: "Ensino médio completo e conhecimento básico de informática.",
    benefits: ["Vale-transporte"],
    whatsapp: "73999990000",
    validityStatus: "active",
    availability: "available",
    expiresAt: "2099-12-31T23:59:59.000Z",
    sourceId: "approved-feed",
    sourceName: "Fonte autorizada",
    sourceUrl: "https://jobs.example.test/vagas/assistente-001",
    attributionUrl: "https://jobs.example.test/attribution",
    termsUrl: "https://jobs.example.test/terms",
    source: {
      id: "approved-feed",
      name: "Fonte autorizada",
      url: "https://jobs.example.test/vagas/assistente-001",
      attributionUrl: "https://jobs.example.test/attribution",
      termsUrl: "https://jobs.example.test/terms",
    },
    collectedAt: "2026-11-25T12:00:00.000Z",
    fetchedAt: "2026-11-25T12:00:00.000Z",
    ...overrides,
  };
}

function createCallableTest(seed, options = {}) {
  const mock = createMockFirestore(seed, options);
  const handlers = loadHandlers(mock);
  return {
    handler: handlers.reviewAutomatedJobLead,
    createJobDraft: handlers.createJobDraft,
    updateCompanyJob: handlers.updateCompanyJob,
    setCompanyVerification: handlers.setCompanyVerification,
    listCompaniesForAdmin: handlers.listCompaniesForAdmin,
    mercadoPagoWebhook: handlers.mercadoPagoWebhook,
    db: mock.db,
    transactions: mock.transactions,
  };
}

function request(action, auth = adminAuth, data = {}) {
  return {
    auth,
    data: { leadId, action, ...data },
  };
}

test("blocks unauthenticated and non-admin callers", async () => {
  const { handler, db } = createCallableTest({
    automatedJobLeads: { [leadId]: pendingLead() },
    users: { "candidate-user": { role: "candidate" } },
  });

  await assert.rejects(
    handler(request("approve", null)),
    (error) => error.code === "unauthenticated",
  );
  await assert.rejects(
    handler(request("approve", {
      uid: "candidate-user",
      token: { email: "candidate@example.test", email_verified: false },
    })),
    (error) => error.code === "permission-denied",
  );
  assert.equal(db.documents("jobs").size, 0);
  assert.equal(db.documents("automatedJobLeads").get(leadId).reviewStatus, "pending_review");
});

test("admin verification atomically toggles company trust and records actor metadata", async () => {
  const { setCompanyVerification, db, transactions } = createCallableTest({
    companies: {
      [publisherId]: {
        ownerUid: publisherId,
        name: "Mercado Girassol",
        email: "empresa@example.test",
        active: false,
        verifiedByAdmin: false,
      },
    },
  });

  const verified = await setCompanyVerification({
    auth: adminAuth,
    data: { companyId: publisherId, verified: true },
  });
  let company = db.documents("companies").get(publisherId);
  assert.equal(verified.verifiedByAdmin, true);
  assert.equal(company.verifiedByAdmin, true);
  assert.equal(company.active, true);
  assert.equal(company.verifiedByUid, adminAuth.uid);
  assert.equal(company.verifiedByEmail, adminAuth.token.email);
  assert.ok(company.verifiedAt);
  assert.deepEqual(transactions[0].operations.map(({ type, collection }) => [type, collection]), [
    ["update", "companies"],
  ]);

  await setCompanyVerification({
    auth: adminAuth,
    data: { companyId: publisherId, verified: false },
  });
  company = db.documents("companies").get(publisherId);
  assert.equal(company.verifiedByAdmin, false);
  assert.equal(company.active, false);
  assert.equal(company.verifiedAt, null);
  assert.equal(company.verifiedByUid, null);
  assert.ok(company.verificationRevokedAt);
  assert.equal(company.verificationRevokedByUid, adminAuth.uid);
});

test("only administrators can update company verification and missing companies are rejected", async () => {
  const { setCompanyVerification } = createCallableTest({
    users: { "candidate-user": { role: "candidate" } },
    companies: {
      [publisherId]: { ownerUid: publisherId, active: false, verifiedByAdmin: false },
    },
  });
  await assert.rejects(
    setCompanyVerification({
      auth: { uid: "candidate-user", token: { email_verified: false } },
      data: { companyId: publisherId, verified: true },
    }),
    (error) => error.code === "permission-denied",
  );
  await assert.rejects(
    setCompanyVerification({
      auth: adminAuth,
      data: { companyId: "missing-company", verified: true },
    }),
    (error) => error.code === "not-found",
  );
});

test("company verification listing requires an admin and exposes basic verification metadata", async () => {
  const { listCompaniesForAdmin } = createCallableTest({
    companies: {
      "company-1": {
        ownerUid: "owner-1",
        name: "Mercado Girassol",
        email: "empresa@example.test",
        active: true,
        verifiedByAdmin: true,
        verifiedAt: "2026-11-25T12:00:00.000Z",
        verifiedByUid: "admin-user",
        verifiedByEmail: "admin@example.test",
        privateBillingToken: "must-not-be-returned",
      },
    },
    users: { "candidate-user": { role: "candidate" } },
  });

  await assert.rejects(
    listCompaniesForAdmin({
      auth: { uid: "candidate-user", token: { email_verified: false } },
    }),
    (error) => error.code === "permission-denied",
  );
  const result = await listCompaniesForAdmin({ auth: adminAuth });
  assert.equal(result.hasMore, false);
  assert.equal(JSON.stringify(result.companies), JSON.stringify([{
    id: "company-1",
    ownerUid: "owner-1",
    name: "Mercado Girassol",
    tradeName: "",
    email: "empresa@example.test",
    cnpj: "",
    active: true,
    verifiedByAdmin: true,
    verifiedAt: "2026-11-25T12:00:00.000Z",
    verifiedByUid: "admin-user",
    verifiedByEmail: "admin@example.test",
  }]));
});

test("saves review edits only on the pending lead without publishing a job", async () => {
  const { handler, db, transactions } = createCallableTest({
    automatedJobLeads: { [leadId]: pendingLead() },
  });

  const result = await handler(request("save", adminAuth, {
    edits: { title: "Assistente administrativo sênior", whatsapp: "(73) 98888-0000" },
  }));
  const savedLead = db.documents("automatedJobLeads").get(leadId);

  assert.equal(result.action, "saved");
  assert.equal(result.leadId, leadId);
  assert.equal(savedLead.reviewDraft.title, "Assistente administrativo sênior");
  assert.equal(savedLead.reviewDraft.whatsapp, "73988880000");
  assert.equal(savedLead.reviewStatus, "pending_review");
  assert.equal(savedLead.triageStatus, "pending");
  assert.equal(db.documents("jobs").size, 0);
  assert.deepEqual(transactions[0].operations.map(({ type, collection }) => [type, collection]), [
    ["update", "automatedJobLeads"],
  ]);
});

test("approves atomically with a deterministic jobs ID and the expected publication fields", async () => {
  const { handler, db, transactions } = createCallableTest({
    automatedJobLeads: { [leadId]: pendingLead() },
  });

  const result = await handler(request("approve"));
  const jobId = `automated_${leadId}`;
  const publishedJob = db.documents("jobs").get(jobId);
  const approvedLead = db.documents("automatedJobLeads").get(leadId);

  assert.equal(result.action, "approved");
  assert.equal(result.leadId, leadId);
  assert.equal(result.jobId, jobId);
  assert.equal(result.alreadyProcessed, false);
  assert.equal(publishedJob.status, "aprovada");
  assert.equal(publishedJob.companyName, "Empresa Exemplo");
  assert.equal(publishedJob.city, "Teixeira de Freitas");
  assert.equal(publishedJob.ibgeCode, "2931350");
  assert.equal(publishedJob.paymentStatus, "gratis");
  assert.equal(publishedJob.quotaType, "automated");
  assert.equal(publishedJob.origin, "automated_source");
  assert.equal(publishedJob.sourceUrl, "https://jobs.example.test/vagas/assistente-001");
  assert.equal(approvedLead.reviewStatus, "approved");
  assert.equal(approvedLead.triageStatus, "approved");
  assert.equal(approvedLead.jobId, jobId);
  assert.deepEqual(transactions[0].operations.map(({ type, collection }) => [type, collection]), [
    ["create", "jobs"],
    ["update", "automatedJobLeads"],
  ]);
});

test("repeated approval returns the existing job and does not create a duplicate", async () => {
  const { handler, db, transactions } = createCallableTest({
    automatedJobLeads: { [leadId]: pendingLead() },
  });

  const firstResult = await handler(request("approve"));
  const secondResult = await handler(request("approve"));

  assert.equal(firstResult.alreadyProcessed, false);
  assert.equal(secondResult.alreadyProcessed, true);
  assert.equal(secondResult.jobId, `automated_${leadId}`);
  assert.equal(db.documents("jobs").size, 1);
  assert.equal(transactions[1].operations.length, 0);
});

test("rejects a lead without creating a jobs document", async () => {
  const { handler, db, transactions } = createCallableTest({
    automatedJobLeads: { [leadId]: pendingLead() },
  });

  const result = await handler(request("reject", adminAuth, { reason: "A fonte não confirma a vaga." }));
  const rejectedLead = db.documents("automatedJobLeads").get(leadId);

  assert.equal(result.action, "rejected");
  assert.equal(result.leadId, leadId);
  assert.equal(result.alreadyProcessed, false);
  assert.equal(rejectedLead.reviewStatus, "rejected");
  assert.equal(rejectedLead.triageStatus, "rejected");
  assert.equal(rejectedLead.rejectionReason, "A fonte não confirma a vaga.");
  assert.equal(db.documents("jobs").size, 0);
  assert.deepEqual(transactions[0].operations.map(({ type, collection }) => [type, collection]), [
    ["update", "automatedJobLeads"],
  ]);
});

test("blocks approval when a lead is expired or unavailable", async (t) => {
  const cases = [
    ["expired", { validityStatus: "expired", expiresAt: "2026-11-25T00:00:00.000Z" }],
    ["unavailable", { availability: "unavailable" }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const { handler, db } = createCallableTest({
        automatedJobLeads: { [leadId]: pendingLead(overrides) },
      });

      await assert.rejects(
        handler(request("approve")),
        (error) => error.code === "failed-precondition",
      );
      assert.equal(db.documents("jobs").size, 0);
      assert.equal(db.documents("automatedJobLeads").get(leadId).reviewStatus, "pending_review");
    });
  }
});

test("blocks approval when required jobs fields are missing", async () => {
  const { handler, db } = createCallableTest({
    automatedJobLeads: {
      [leadId]: pendingLead({ requirements: "" }),
    },
  });

  await assert.rejects(
    handler(request("approve")),
    (error) => error.code === "invalid-argument",
  );
  assert.equal(db.documents("jobs").size, 0);
  assert.equal(db.documents("automatedJobLeads").get(leadId).reviewStatus, "pending_review");
});

const publisherId = "publisher-user";
const publisherAuth = {
  uid: publisherId,
  token: { email: "publisher@example.test", email_verified: true },
};

function publisherJob(overrides = {}) {
  return {
    companyName: "Mercado Girassol",
    title: "Atendente de loja",
    city: "Teixeira de Freitas",
    category: "Vendas",
    salaryLabel: "A combinar",
    contract: "CLT",
    modality: "Presencial",
    level: "Júnior",
    whatsapp: "73999998888",
    description: "Atender clientes, organizar produtos e apoiar a equipe da loja.",
    requirements: "Boa comunicação e disponibilidade de horário.",
    benefits: ["Vale-transporte"],
    ...overrides,
  };
}

function bahiaDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bahia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function publisherSeed(role = "company", company = { active: true }) {
  if (role === "company" && company.active === true && company.verifiedByAdmin === undefined) {
    company = { ...company, verifiedByAdmin: true };
  }
  return {
    users: { [publisherId]: { role } },
    companies: { [publisherId]: company },
  };
}

test("automatically publishes a clean advertiser submission with moderation audit fields", async () => {
  const { createJobDraft, db } = createCallableTest(publisherSeed());
  const result = await createJobDraft({ auth: publisherAuth, data: publisherJob() });
  const savedJob = db.documents("jobs").get(result.jobId);

  assert.equal(result.status, "aprovada");
  assert.equal(result.moderationStatus, "approve");
  assert.equal(savedJob.status, "aprovada");
  assert.equal(savedJob.moderationStatus, "approve");
  assert.deepEqual(savedJob.moderationFlags, []);
  assert.equal(savedJob.moderationVersion, "1.0.0");
  assert.match(savedJob.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(savedJob.expiresAt > new Date().toISOString());
  assert.ok(savedJob.moderatedAt);
  assert.ok(savedJob.publishedAt);
});

test("routes unverified and untrusted advertiser submissions to exceptional review", async () => {
  const unverifiedAuth = {
    uid: publisherId,
    token: { email: "publisher@example.test", email_verified: false },
  };
  const unverified = createCallableTest(publisherSeed());
  const unverifiedResult = await unverified.createJobDraft({
    auth: unverifiedAuth,
    data: publisherJob(),
  });

  assert.equal(unverifiedResult.status, "pendente");
  assert.equal(unverified.db.documents("jobs").get(unverifiedResult.jobId).moderationStatus, "review");
  assert.ok(unverified.db.documents("jobs").get(unverifiedResult.jobId).moderationFlags.includes("email_unverified"));

  const inactiveCompany = createCallableTest(publisherSeed("company", { active: false }));
  const inactiveResult = await inactiveCompany.createJobDraft({
    auth: publisherAuth,
    data: publisherJob(),
  });
  assert.equal(inactiveResult.status, "pendente");
  assert.ok(inactiveCompany.db.documents("jobs").get(inactiveResult.jobId).moderationFlags.includes("company_not_active"));

  const selfActivatedCompany = createCallableTest(
    publisherSeed("company", { active: true, verifiedByAdmin: false }),
  );
  const selfActivatedResult = await selfActivatedCompany.createJobDraft({
    auth: publisherAuth,
    data: publisherJob({ title: "Assistente de loja" }),
  });
  assert.equal(selfActivatedResult.status, "pendente");
  assert.ok(selfActivatedCompany.db.documents("jobs").get(selfActivatedResult.jobId).moderationFlags.includes("company_not_active"));

  const newCandidate = createCallableTest(publisherSeed("candidate"));
  const candidateResult = await newCandidate.createJobDraft({
    auth: publisherAuth,
    data: publisherJob(),
  });
  assert.equal(candidateResult.status, "pendente");
  assert.ok(newCandidate.db.documents("jobs").get(candidateResult.jobId).moderationFlags.includes("candidate_without_history"));

  const returningCandidate = createCallableTest({
    ...publisherSeed("candidate"),
    jobs: {
      "previous-candidate-job": { companyId: publisherId, status: "aprovada" },
    },
  });
  const returningResult = await returningCandidate.createJobDraft({
    auth: publisherAuth,
    data: publisherJob({ title: "Assistente de estoque" }),
  });
  assert.equal(returningResult.status, "aprovada");
});

test("admin-verified and activated company moves from review to automatic publication", async () => {
  const { createJobDraft, setCompanyVerification, db } = createCallableTest({
    ...publisherSeed("company", { active: false, verifiedByAdmin: false }),
  });
  const firstSubmission = await createJobDraft({
    auth: publisherAuth,
    data: publisherJob(),
  });
  assert.equal(firstSubmission.status, "pendente");
  assert.ok(db.documents("jobs").get(firstSubmission.jobId).moderationFlags.includes("company_not_active"));

  await setCompanyVerification({
    auth: adminAuth,
    data: { companyId: publisherId, verified: true },
  });
  const secondSubmission = await createJobDraft({
    auth: publisherAuth,
    data: publisherJob({ title: "Assistente de estoque" }),
  });
  const secondJob = db.documents("jobs").get(secondSubmission.jobId);
  assert.equal(secondSubmission.status, "aprovada");
  assert.equal(secondJob.moderationStatus, "approve");
  assert.equal(db.documents("companies").get(publisherId).verifiedByAdmin, true);
});

test("checks active duplicate fingerprints transactionally and routes duplicates to review", async () => {
  const data = publisherJob();
  const fingerprint = evaluateJobModeration(data, {
    now: "2026-11-26T12:00:00.000Z",
  }).fingerprint;
  const { createJobDraft, db } = createCallableTest({
    ...publisherSeed(),
    jobs: {
      existing: { companyId: "another-publisher", status: "aprovada", fingerprint },
    },
  });

  const result = await createJobDraft({ auth: publisherAuth, data });
  const created = db.documents("jobs").get(result.jobId);
  assert.equal(result.status, "pendente");
  assert.equal(created.moderationStatus, "review");
  assert.ok(created.moderationFlags.includes("active_duplicate"));
});

test("keeps a review decision pending while payment remains a separate requirement", async () => {
  const dateKey = bahiaDateKey();
  const { createJobDraft, db } = createCallableTest({
    ...publisherSeed("company", { active: false }),
    companyDailyUsage: {
      [`${publisherId}_${dateKey}`]: { freeUsed: 2, paidCredits: 0, paidUsed: 0 },
    },
  }, {
    secret: "simulated-access-token",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { id: "preference-review", init_point: "https://checkout.example.test/review" };
      },
    }),
  });

  const result = await createJobDraft({ auth: publisherAuth, data: publisherJob() });
  const savedJob = db.documents("jobs").get(result.jobId);
  assert.equal(result.requiresPayment, true);
  assert.equal(result.status, "pendente");
  assert.equal(result.paymentStatus, "aguardando_pagamento");
  assert.equal(savedJob.status, "pendente");
  assert.equal(savedJob.moderationStatus, "review");
});

test("blocks fraudulent or insecure submissions before writing a job or consuming quota", async () => {
  const { createJobDraft, db, transactions } = createCallableTest(publisherSeed());
  await assert.rejects(
    createJobDraft({
      auth: publisherAuth,
      data: publisherJob({
        applicationUrl: "http://127.0.0.1/apply",
        description: "Pague uma taxa para participar do processo seletivo e fazer a entrevista.",
      }),
    }),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(db.documents("jobs").size, 0);
  assert.equal(transactions.length, 0);
});

test("paid clean submissions publish after an approved payment webhook", async () => {
  let paymentId = "";
  let jobId = "";
  let dateKey = "";
  const fetchImpl = async (url) => {
    if (url.endsWith("/checkout/preferences")) {
      return {
        ok: true,
        async json() {
          return { id: "preference-1", init_point: "https://checkout.example.test/pref-1" };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          id: "provider-payment-1",
          status: "approved",
          external_reference: paymentId,
          transaction_amount: 5,
          metadata: {
            company_id: publisherId,
            date_key: dateKey,
            job_id: jobId,
            credits: 2,
          },
        };
      },
    };
  };
  const seed = publisherSeed();
  dateKey = bahiaDateKey();
  seed.companyDailyUsage = {
    [`${publisherId}_${dateKey}`]: { freeUsed: 2, paidCredits: 0, paidUsed: 0 },
  };
  const { createJobDraft, mercadoPagoWebhook, db } = createCallableTest(seed, {
    fetchImpl,
    secret: "simulated-access-token",
  });

  const result = await createJobDraft({ auth: publisherAuth, data: publisherJob() });
  paymentId = result.paymentId;
  jobId = result.jobId;
  assert.equal(result.requiresPayment, true);
  assert.equal(result.status, "aguardando_pagamento");
  assert.equal(db.documents("jobs").get(jobId).moderationStatus, "approve");

  let responseStatus;
  let responseBody;
  await mercadoPagoWebhook(
    { query: { "data.id": "provider-payment-1" }, body: {} },
    {
      status(status) {
        responseStatus = status;
        return this;
      },
      send(body) {
        responseBody = body;
      },
    },
  );

  const paidJob = db.documents("jobs").get(jobId);
  assert.equal(responseStatus, 200);
  assert.equal(responseBody, "ok");
  assert.equal(paidJob.status, "aprovada");
  assert.equal(paidJob.paymentStatus, "paga");
  assert.equal(paidJob.moderationStatus, "approve");
  assert.ok(paidJob.publishedAt);
});

test("paid jobs that are expired or not clean remain pending for exception review", async (t) => {
  for (const [name, moderationStatus, expiresAt, expectedFlag, duplicate] of [
    ["expired", "approve", "2020-01-01T00:00:00.000Z", "payment_recheck_required", false],
    ["already flagged", "review", "2099-12-31T23:59:59.000Z", "payment_recheck_required", false],
    ["active duplicate", "approve", "2099-12-31T23:59:59.000Z", "active_duplicate", true],
  ]) {
    await t.test(name, async () => {
      const jobId = `job-${name.replace(/\s+/g, "-")}`;
      const paymentId = `payment-${name.replace(/\s+/g, "-")}`;
      const dateKey = bahiaDateKey();
      const { mercadoPagoWebhook, db } = createCallableTest({
        jobs: {
          [jobId]: {
            companyId: publisherId,
            status: "aguardando_pagamento",
            paymentStatus: "aguardando_pagamento",
            moderationStatus,
            moderationFlags: [],
            moderationReasons: [],
            fingerprint: "a".repeat(64),
            expiresAt,
          },
          ...(duplicate ? {
            "active-copy": {
              companyId: "another-publisher",
              status: "aprovada",
              fingerprint: "a".repeat(64),
            },
          } : {}),
        },
        payments: { [paymentId]: { status: "pending" } },
        companyDailyUsage: {
          [`${publisherId}_${dateKey}`]: { freeUsed: 2, paidCredits: 0, paidUsed: 0 },
        },
      }, {
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              id: "provider-payment",
              status: "approved",
              external_reference: paymentId,
              transaction_amount: 5,
              metadata: { company_id: publisherId, date_key: dateKey, job_id: jobId, credits: 2 },
            };
          },
        }),
        secret: "simulated-access-token",
      });

      await mercadoPagoWebhook(
        { query: { "data.id": "provider-payment" }, body: {} },
        { status() { return this; }, send() {} },
      );

      const job = db.documents("jobs").get(jobId);
      assert.equal(job.status, "pendente");
      assert.equal(job.moderationStatus, "review");
      assert.ok(job.moderationFlags.includes(expectedFlag));
      assert.equal(job.paymentStatus, "paga");
    });
  }
});

test("re-evaluates company edits and auto-publishes only clean revisions", async () => {
  const jobId = "company-job-1";
  const original = {
    ...publisherJob(),
    companyId: publisherId,
    status: "aprovada",
    paymentStatus: "gratis",
    quotaType: "gratis",
    origin: "company",
    dateKey: bahiaDateKey(),
    createdAt: "original-created-at",
  };
  original.fingerprint = evaluateJobModeration(original, {
    now: "2026-11-26T12:00:00.000Z",
  }).fingerprint;
  const cleanEdit = createCallableTest({
    ...publisherSeed(),
    jobs: { [jobId]: original },
  });
  const cleanResult = await cleanEdit.updateCompanyJob({
    auth: publisherAuth,
    data: { jobId, edits: publisherJob({ title: "Atendente de loja sênior" }) },
  });
  const cleanSaved = cleanEdit.db.documents("jobs").get(jobId);

  assert.equal(cleanResult.status, "aprovada");
  assert.equal(cleanSaved.status, "aprovada");
  assert.equal(cleanSaved.moderationStatus, "approve");
  assert.equal(cleanSaved.title, "Atendente de loja sênior");
  assert.equal(cleanSaved.createdAt, "original-created-at");

  const reviewEdit = createCallableTest({
    ...publisherSeed("company", { active: false }),
    jobs: { [jobId]: original },
  });
  const reviewResult = await reviewEdit.updateCompanyJob({
    auth: publisherAuth,
    data: { jobId, edits: publisherJob({ title: "Atendente de loja júnior" }) },
  });
  const reviewSaved = reviewEdit.db.documents("jobs").get(jobId);
  assert.equal(reviewResult.status, "pendente");
  assert.equal(reviewSaved.moderationStatus, "review");
  assert.ok(reviewSaved.moderationFlags.includes("company_not_active"));
});
