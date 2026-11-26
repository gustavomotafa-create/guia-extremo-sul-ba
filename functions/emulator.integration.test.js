// Run locally with:
// firebase emulators:exec --project demo-girassol-vagas --only auth,firestore,functions "node --test functions/emulator.integration.test.js"
const assert = require("node:assert/strict");
const { test } = require("node:test");

const PROJECT_ID = "demo-girassol-vagas";
const REGION = "southamerica-east1";
const AUTH_API_KEY = "emulator-api-key";
const FIRESTORE_OWNER_TOKEN = "owner";
const ADMIN_EMAIL = "sunflowercollectivegf@gmail.com";
const hasEmulatorEnvironment = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST,
);

function localEmulatorUrl(host, defaultPort) {
  const value = host || `127.0.0.1:${defaultPort}`;
  const url = new URL(value.includes("://") ? value : `http://${value}`);
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
    `Refusing non-local emulator endpoint: ${url.host}`,
  );
  return url.origin;
}

function emulatorEndpoints() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  assert.equal(projectId, PROJECT_ID, "Use the isolated demo-girassol-vagas emulator project.");
  return {
    auth: localEmulatorUrl(process.env.FIREBASE_AUTH_EMULATOR_HOST, 9099),
    firestore: localEmulatorUrl(process.env.FIRESTORE_EMULATOR_HOST, 8080),
    functions: localEmulatorUrl(process.env.FUNCTIONS_EMULATOR_HOST, 5001),
  };
}

function firestoreDocumentUrl(baseUrl, path) {
  return `${baseUrl}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
}

async function postJson(url, body, idToken) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  return { response, body: responseBody };
}

async function createAuthAccount(authUrl, email, password) {
  const { response, body } = await postJson(
    `${authUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${AUTH_API_KEY}`,
    { email, password, returnSecureToken: true },
  );
  assert.equal(response.ok, true, `Auth emulator signup failed: ${JSON.stringify(body)}`);
  const verified = await postJson(
    `${authUrl}/identitytoolkit.googleapis.com/v1/accounts:update?key=${AUTH_API_KEY}`,
    { localId: body.localId, emailVerified: true },
  );
  assert.equal(verified.response.ok, true, `Auth emulator verification failed: ${JSON.stringify(verified.body)}`);
  return { uid: body.localId, email, password };
}

async function signInWithPassword(authUrl, email, password) {
  const { response, body } = await postJson(
    `${authUrl}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${AUTH_API_KEY}`,
    { email, password, returnSecureToken: true },
  );
  assert.equal(response.ok, true, `Auth emulator sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

function stringValue(value) {
  return { stringValue: value };
}

function booleanValue(value) {
  return { booleanValue: value };
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return booleanValue(value);
  if (typeof value === "number") return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === "object") {
    return { mapValue: { fields: encodeFields(value) } };
  }
  return stringValue(String(value));
}

function encodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, encodeValue(value)]));
}

function decodeValue(value) {
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (value.arrayValue) return (value.arrayValue.values || []).map(decodeValue);
  if (value.mapValue) return decodeFields(value.mapValue.fields || {});
  return undefined;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

async function firestoreRequest(firestoreUrl, path, { method = "GET", idToken, fields } = {}) {
  return fetch(firestoreDocumentUrl(firestoreUrl, path), {
    method,
    headers: {
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      ...(fields ? { "Content-Type": "application/json" } : {}),
    },
    ...(fields ? { body: JSON.stringify({ fields: encodeFields(fields) }) } : {}),
  });
}

async function readFirestoreDocument(firestoreUrl, path, idToken = FIRESTORE_OWNER_TOKEN) {
  const response = await firestoreRequest(firestoreUrl, path, { idToken });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `Firestore read failed: ${JSON.stringify(body)}`);
  return decodeFields(body.fields);
}

async function callFunction(functionsUrl, name, idToken, data) {
  const { response, body } = await postJson(
    `${functionsUrl}/${PROJECT_ID}/${REGION}/${name}`,
    { data },
    idToken,
  );
  if (!response.ok || body.error) {
    const error = body.error || {};
    throw new Error(`${name} failed (${response.status} ${error.status || ""}): ${error.message || JSON.stringify(body)}`);
  }
  return body.result;
}

function validJob(overrides = {}) {
  return {
    companyName: "Empresa Girassol",
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

test("Firebase Emulator Suite: rules, moderation, company verification and lead approval", {
  skip: !hasEmulatorEnvironment
    ? "Run with firebase emulators:exec; no Auth/Firestore emulator environment detected."
    : false,
}, async (t) => {
  const endpoints = emulatorEndpoints();
  const documentsToDelete = [];
  const accountsToDelete = [];

  t.after(async () => {
    await Promise.all(documentsToDelete.map(async (path) => {
      const current = await firestoreRequest(endpoints.firestore, path, {
        idToken: FIRESTORE_OWNER_TOKEN,
      });
      if (current.status === 404) return;
      assert.equal(current.ok, true, `Could not inspect fixture ${path} during cleanup.`);
      const response = await firestoreRequest(endpoints.firestore, path, {
        method: "DELETE",
        idToken: FIRESTORE_OWNER_TOKEN,
      });
      assert.equal(response.ok, true, `Could not delete fixture ${path}.`);
    }));
    await Promise.all(accountsToDelete.map(async (account) => {
      const { response, body } = await postJson(
        `${endpoints.auth}/identitytoolkit.googleapis.com/v1/accounts:delete?key=${AUTH_API_KEY}`,
        { idToken: account.idToken },
      );
      assert.equal(response.ok, true, `Could not delete emulator account: ${JSON.stringify(body)}`);
    }));
  });

  async function createAccount(role, emailOverride = "") {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const email = emailOverride || `${role}-${suffix}@example.test`;
    const password = "Local-emulator-only-Password-123!";
    const account = await createAuthAccount(endpoints.auth, email, password);
    account.idToken = await signInWithPassword(endpoints.auth, email, password);
    accountsToDelete.push(account);

    await firestoreRequest(endpoints.firestore, `users/${account.uid}`, {
      method: "PATCH",
      idToken: account.idToken,
      fields: { email, role: role === "admin" ? "candidate" : role, name: `${role} test account` },
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      assert.equal(response.ok, true, `Could not create test profile: ${JSON.stringify(body)}`);
    });
    documentsToDelete.push(`users/${account.uid}`);

    if (role === "company") {
      const companyPath = `companies/${account.uid}`;
      const response = await firestoreRequest(endpoints.firestore, companyPath, {
        method: "PATCH",
        idToken: account.idToken,
        fields: {
          ownerUid: account.uid,
          name: `Empresa ${suffix}`,
          email,
          active: false,
        },
      });
      const body = await response.json().catch(() => ({}));
      assert.equal(response.ok, true, `Could not create test company: ${JSON.stringify(body)}`);
      documentsToDelete.push(companyPath);
    }

    return account;
  }

  const adminUser = await createAccount("admin", ADMIN_EMAIL);
  const adminToken = adminUser.idToken;
  const verifiedCompany = await createAccount("company");
  const unverifiedCompany = await createAccount("company");

  await t.test("client rules reject direct publication, lead writes, and company self-verification", async () => {
    const jobWrite = await firestoreRequest(
      endpoints.firestore,
      `jobs/rules-denied-${Date.now()}`,
      {
        method: "PATCH",
        idToken: verifiedCompany.idToken,
        fields: { status: "aprovada", companyId: verifiedCompany.uid },
      },
    );
    const leadWrite = await firestoreRequest(
      endpoints.firestore,
      `automatedJobLeads/${"b".repeat(64)}`,
      {
        method: "PATCH",
        idToken: adminToken,
        fields: { status: "pending_review" },
      },
    );
    const companyWrite = await firestoreRequest(
      endpoints.firestore,
      `companies/${verifiedCompany.uid}`,
      {
        method: "PATCH",
        idToken: verifiedCompany.idToken,
        fields: { active: true, verifiedByAdmin: true },
      },
    );

    assert.equal(jobWrite.ok, false, "clients must not publish jobs directly");
    assert.equal(leadWrite.ok, false, "clients must not write automated leads, including admins");
    assert.equal(companyWrite.ok, false, "company owners must not self-activate or self-verify");
  });

  await t.test("admin callable verifies and activates a company", async () => {
    const result = await callFunction(endpoints.functions, "setCompanyVerification", adminToken, {
      companyId: verifiedCompany.uid,
      verified: true,
    });
    const company = await readFirestoreDocument(endpoints.firestore, `companies/${verifiedCompany.uid}`);

    assert.equal(result.verifiedByAdmin, true);
    assert.equal(company.active, true);
    assert.equal(company.verifiedByAdmin, true);
    assert.equal(company.verifiedByUid, adminUser.uid);
    assert.ok(company.verifiedAt);
  });

  let publishedJobId;
  await t.test("clean verified-company vacancy publishes automatically", async () => {
    const result = await callFunction(
      endpoints.functions,
      "createJobDraft",
      verifiedCompany.idToken,
      validJob(),
    );
    publishedJobId = result.jobId;
    documentsToDelete.push(`jobs/${publishedJobId}`);
    const job = await readFirestoreDocument(endpoints.firestore, `jobs/${publishedJobId}`);

    assert.equal(result.status, "aprovada");
    assert.equal(job.status, "aprovada");
    assert.equal(job.moderationStatus, "approve");
    assert.deepEqual(job.moderationFlags, []);
    assert.ok(job.expiresAt);
  });

  await t.test("unverified company vacancy goes to exceptional review", async () => {
    const result = await callFunction(
      endpoints.functions,
      "createJobDraft",
      unverifiedCompany.idToken,
      validJob({ title: "Auxiliar de estoque" }),
    );
    documentsToDelete.push(`jobs/${result.jobId}`);
    const job = await readFirestoreDocument(endpoints.firestore, `jobs/${result.jobId}`);

    assert.equal(result.status, "pendente");
    assert.equal(job.status, "pendente");
    assert.equal(job.moderationStatus, "review");
    assert.ok(job.moderationFlags.includes("company_not_active"));
  });

  await t.test("fraud and insecure application links are blocked before persistence", async () => {
    for (const payload of [
      validJob({
        title: "Vaga com taxa",
        description: "Pague uma taxa para participar do processo seletivo e fazer a entrevista.",
      }),
      validJob({
        title: "Vaga com link inseguro",
        applicationUrl: "http://127.0.0.1/apply",
      }),
    ]) {
      await assert.rejects(
        callFunction(endpoints.functions, "createJobDraft", verifiedCompany.idToken, payload),
        /FAILED_PRECONDITION|failed-precondition/,
      );
    }
  });

  await t.test("clean company edit keeps the approved vacancy published", async () => {
    const result = await callFunction(
      endpoints.functions,
      "updateCompanyJob",
      verifiedCompany.idToken,
      {
        jobId: publishedJobId,
        edits: validJob({ title: "Atendente de loja sênior" }),
      },
    );
    const job = await readFirestoreDocument(endpoints.firestore, `jobs/${publishedJobId}`);

    assert.equal(result.status, "aprovada");
    assert.equal(job.status, "aprovada");
    assert.equal(job.moderationStatus, "approve");
    assert.equal(job.title, "Atendente de loja sênior");
  });

  await t.test("admin can approve an externally collected lead transactionally", async () => {
    const leadId = "c".repeat(64);
    const jobId = `automated_${leadId}`;
    const leadPath = `automatedJobLeads/${leadId}`;
    documentsToDelete.push(leadPath, `jobs/${jobId}`);
    const seedResponse = await firestoreRequest(endpoints.firestore, leadPath, {
      method: "PATCH",
      idToken: FIRESTORE_OWNER_TOKEN,
      fields: {
        reviewStatus: "pending_review",
        triageStatus: "pending",
        title: "Assistente administrativo",
        companyName: "Fonte Externa",
        city: "Teixeira de Freitas",
        modality: "Presencial",
        contract: "CLT",
        whatsapp: "73999990000",
        description: "Atendimento ao público e apoio nas rotinas administrativas.",
        requirements: "Ensino médio completo e conhecimento básico de informática.",
        benefits: [],
        expiresAt: "2099-12-31T23:59:59.000Z",
        sourceId: "authorized-feed",
        sourceName: "Fonte autorizada",
        sourceUrl: "https://jobs.example.test/vagas/assistant",
        source: {
          id: "authorized-feed",
          name: "Fonte autorizada",
          url: "https://jobs.example.test/vagas/assistant",
        },
      },
    });
    assert.equal(seedResponse.ok, true, "emulator owner token must seed private test fixtures");

    const result = await callFunction(endpoints.functions, "reviewAutomatedJobLead", adminToken, {
      leadId,
      action: "approve",
    });
    const published = await readFirestoreDocument(endpoints.firestore, `jobs/${jobId}`);
    const reviewedLead = await readFirestoreDocument(endpoints.firestore, leadPath);

    assert.equal(result.alreadyProcessed, false);
    assert.equal(published.status, "aprovada");
    assert.equal(published.automatedLeadId, leadId);
    assert.equal(reviewedLead.reviewStatus, "approved");
    assert.equal(reviewedLead.jobId, jobId);
  });
});
