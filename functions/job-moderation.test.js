const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateJobModeration, RULE_VERSION } = require("./job-moderation");

const NOW = "2026-11-26T12:00:00.000Z";

function validJob(overrides = {}) {
  return {
    companyName: "Mercado Girassol",
    title: "Atendente de loja",
    city: "Teixeira de Freitas",
    contract: "CLT",
    modality: "Presencial",
    whatsapp: "73999998888",
    description: "Atender clientes, organizar produtos e apoiar a equipe da loja.",
    requirements: "Boa comunicação e disponibilidade de horário.",
    ...overrides,
  };
}

function trustedCompany(overrides = {}) {
  return {
    now: NOW,
    profileRole: "company",
    emailVerified: true,
    companyActive: true,
    hasPublicationHistory: true,
    ...overrides,
  };
}

test("approves a clean job and defaults validity to 30 days deterministically", () => {
  const first = evaluateJobModeration(validJob(), trustedCompany());
  const second = evaluateJobModeration(validJob(), trustedCompany());

  assert.equal(first.decision, "approve");
  assert.deepEqual(first, second);
  assert.equal(first.expiresAt, "2026-12-26T12:00:00.000Z");
  assert.equal(first.ruleVersion, RULE_VERSION);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.reasons, []);
  assert.deepEqual(first.flags, []);
});

test("accepts an explicit future expiry within the maximum validity window", () => {
  const result = evaluateJobModeration(
    validJob({ expiresAt: "2027-01-01T12:00:00.000Z" }),
    trustedCompany(),
  );
  assert.equal(result.decision, "approve");
  assert.equal(result.expiresAt, "2027-01-01T12:00:00.000Z");
});

test("blocks missing, undersized, oversized, and invalidly typed required fields", () => {
  const result = evaluateJobModeration(
    validJob({
      companyName: "A",
      title: "Vaga",
      description: "Curta",
      requirements: 42,
    }),
    trustedCompany(),
  );

  assert.equal(result.decision, "block");
  assert.ok(result.flags.includes("invalid_companyName"));
  assert.ok(result.flags.includes("invalid_title"));
  assert.ok(result.flags.includes("invalid_description"));
  assert.ok(result.flags.includes("invalid_requirements"));

  const oversized = evaluateJobModeration(
    validJob({
      companyName: "E".repeat(181),
      description: "D".repeat(4001),
    }),
    trustedCompany(),
  );
  assert.equal(oversized.decision, "block");
  assert.ok(oversized.flags.includes("invalid_companyName"));
  assert.ok(oversized.flags.includes("invalid_description"));
});

test("blocks invalid contract, modality, municipality, region, and WhatsApp values", () => {
  const result = evaluateJobModeration(
    validJob({
      contract: "Contrato informal",
      modality: "Qualquer lugar",
      city: "Cidade inventada",
      region: "Nordeste",
      whatsapp: "123",
    }),
    trustedCompany(),
  );

  assert.equal(result.decision, "block");
  assert.ok(result.flags.includes("invalid_contract"));
  assert.ok(result.flags.includes("invalid_modality"));
  assert.ok(result.flags.includes("invalid_municipality"));
  assert.ok(result.flags.includes("invalid_region"));
  assert.ok(result.flags.includes("invalid_whatsapp"));
});

test("accepts municipalities supplied from a validated IBGE list", () => {
  const result = evaluateJobModeration(
    validJob({ city: "Porto Seguro" }),
    trustedCompany({
      validMunicipalities: [
        { name: "Porto Seguro", id: "2925303", region: "Bahia" },
      ],
    }),
  );
  assert.equal(result.decision, "approve");
});

test("maps known localities to their municipality and rejects an inconsistent region", () => {
  const valid = evaluateJobModeration(
    validJob({ city: "Posto da Mata", region: "Extremo Sul da Bahia" }),
    trustedCompany({
      validMunicipalities: [
        { name: "Nova Viçosa", id: "2923001", region: "extremo_sul_ba" },
      ],
    }),
  );
  const invalid = evaluateJobModeration(
    validJob({ city: "Porto Seguro", region: "Extremo Sul da Bahia" }),
    trustedCompany({
      validMunicipalities: [
        { name: "Porto Seguro", id: "2925303", region: "sul_ba" },
      ],
    }),
  );

  assert.equal(valid.decision, "approve");
  assert.equal(invalid.decision, "block");
  assert.ok(invalid.flags.includes("inconsistent_region"));
});

test("blocks invalid or expired dates and derives expiry from the injected clock", () => {
  const expired = evaluateJobModeration(
    validJob({ expiresAt: "2026-11-25T12:00:00.000Z" }),
    trustedCompany(),
  );
  const tooFar = evaluateJobModeration(
    validJob({ expiresAt: "2027-03-01T12:00:00.000Z" }),
    trustedCompany(),
  );
  const noClock = evaluateJobModeration(validJob(), trustedCompany({ now: undefined }));

  assert.equal(expired.decision, "block");
  assert.ok(expired.flags.includes("invalid_expiration"));
  assert.equal(tooFar.decision, "block");
  assert.ok(tooFar.flags.includes("invalid_expiration"));
  assert.equal(noClock.decision, "block");
  assert.ok(noClock.flags.includes("invalid_reference_time"));
});

test("blocks requests for candidate payments and mandatory paid courses", () => {
  for (const description of [
    "Pague uma taxa para participar do processo seletivo e fazer a entrevista.",
    "Curso obrigatório pago para concorrer à vaga, adquira antes da entrevista.",
  ]) {
    const result = evaluateJobModeration(validJob({ description }), trustedCompany());
    assert.equal(result.decision, "block");
    assert.ok(result.flags.includes("candidate_payment_request"));
  }
});

test("blocks insecure, local/private, and shortened links", async (t) => {
  const links = [
    ["http", "http://example.com/vaga"],
    ["ftp", "ftp://example.com/vaga"],
    ["localhost", "https://localhost/vaga"],
    ["local domain", "https://jobs.local/vaga"],
    ["private IPv4", "https://192.168.1.12/vaga"],
    ["loopback IPv4", "https://127.0.0.1/vaga"],
    ["private IPv6", "https://[fc00::1]/vaga"],
    ["mapped private IPv4", "https://[::ffff:127.0.0.1]/vaga"],
    ["shortener", "https://bit.ly/vaga"],
  ];

  for (const [label, url] of links) {
    await t.test(label, () => {
      const result = evaluateJobModeration(
        validJob({ applicationUrl: url }),
        trustedCompany(),
      );
      assert.equal(result.decision, "block");
      assert.ok(
        result.flags.includes("unsafe_link") || result.flags.includes("suspicious_shortener"),
      );
    });
  }
});

test("blocks explicit discriminatory and illegal activity content", async (t) => {
  const descriptions = [
    ["discrimination", "Somente homens podem se candidatar a esta vaga."],
    ["illegal activity", "Vaga de trabalho com lavagem de dinheiro."],
  ];

  for (const [label, description] of descriptions) {
    await t.test(label, () => {
      const result = evaluateJobModeration(validJob({ description }), trustedCompany());
      assert.equal(result.decision, "block");
      assert.ok(
        result.flags.includes("discriminatory_content") || result.flags.includes("illegal_activity"),
      );
    });
  }
});

test("routes low-confidence advertiser trust signals to exceptional review", () => {
  const unverified = evaluateJobModeration(
    validJob(),
    trustedCompany({ emailVerified: false }),
  );
  const newCandidate = evaluateJobModeration(
    validJob(),
    trustedCompany({
      profileRole: "candidate",
      hasPublicationHistory: false,
    }),
  );
  const inactiveCompany = evaluateJobModeration(
    validJob(),
    trustedCompany({ companyActive: false }),
  );
  const unknownAdvertiser = evaluateJobModeration(
    validJob(),
    trustedCompany({ profileRole: undefined }),
  );

  assert.equal(unverified.decision, "review");
  assert.ok(unverified.flags.includes("email_unverified"));
  assert.equal(newCandidate.decision, "review");
  assert.ok(newCandidate.flags.includes("candidate_without_history"));
  assert.equal(inactiveCompany.decision, "review");
  assert.ok(inactiveCompany.flags.includes("company_not_active"));
  assert.equal(unknownAdvertiser.decision, "review");
  assert.ok(unknownAdvertiser.flags.includes("unknown_advertiser_type"));
});

test("routes excessive links and an active duplicate fingerprint to review", () => {
  const manyLinks = evaluateJobModeration(
    validJob({
      description: "Confira https://one.example, https://two.example, https://three.example e https://four.example.",
    }),
    trustedCompany(),
  );
  const duplicate = evaluateJobModeration(
    validJob(),
    trustedCompany({ duplicateFingerprint: { active: true } }),
  );

  assert.equal(manyLinks.decision, "review");
  assert.ok(manyLinks.flags.includes("excessive_external_links"));
  assert.equal(duplicate.decision, "review");
  assert.ok(duplicate.flags.includes("active_duplicate"));
});

test("blocking violations take precedence over review signals", () => {
  const result = evaluateJobModeration(
    validJob({ description: "Pague uma taxa para participar do processo seletivo." }),
    trustedCompany({
      emailVerified: false,
      duplicateFingerprint: true,
    }),
  );

  assert.equal(result.decision, "block");
  assert.ok(result.flags.includes("candidate_payment_request"));
  assert.ok(result.flags.includes("email_unverified"));
  assert.ok(result.flags.includes("active_duplicate"));
  assert.ok(result.reasons.some((reason) => reason.severity === "block"));
  assert.ok(result.reasons.some((reason) => reason.severity === "review"));
});

test("fingerprints are stable across accents and whitespace", () => {
  const first = evaluateJobModeration(validJob(), trustedCompany());
  const second = evaluateJobModeration(
    validJob({
      companyName: "  Mercado Girassol ",
      city: " TEIXEIRA   DE FREITAS ",
      title: "Atendente de loja",
    }),
    trustedCompany(),
  );

  assert.equal(first.fingerprint, second.fingerprint);
});
