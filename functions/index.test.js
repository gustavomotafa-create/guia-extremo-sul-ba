const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { URL } = require("node:url");

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

function createMockFirestore(seed = {}) {
  const collections = new Map(
    Object.entries(seed).map(([name, documents]) => [name, new Map(Object.entries(documents))]),
  );
  const transactions = [];
  let timestampCount = 0;

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
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
    };
  }

  const db = {
    collection(name) {
      return {
        doc(id) {
          return documentReference(name, id);
        },
      };
    },
    async runTransaction(callback) {
      const operations = [];
      const transaction = {
        async get(reference) {
          const document = getCollection(reference.collectionName).get(reference.id);
          return {
            exists: Boolean(document),
            data: () => (document ? { ...document } : undefined),
          };
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
          documents.set(operation.reference.id, { ...operation.data });
        } else {
          const existing = documents.get(operation.reference.id);
          if (!existing) {
            throw new Error(`Document does not exist: ${operation.reference.collectionName}/${operation.reference.id}`);
          }
          documents.set(operation.reference.id, { ...existing, ...operation.data });
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

  return { db, firestore, collections, transactions };
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
      return { value: () => "" };
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
      throw new Error(`Unexpected dependency in callable test: ${name}`);
    },
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

function createCallableTest(seed) {
  const mock = createMockFirestore(seed);
  const handlers = loadHandlers(mock);
  return {
    handler: handlers.reviewAutomatedJobLead,
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
