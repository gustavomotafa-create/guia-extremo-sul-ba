const { readFileSync } = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const { deleteField, doc, getDoc, setDoc, updateDoc } = require("firebase/firestore");

const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skipReason = firestoreEmulatorHost
  ? false
  : "Run with firebase emulators:exec --project demo-girassol-vagas --only firestore";

let testEnvironment;
let firestorePort;

function assertSafeEmulatorConfiguration() {
  const projectId = process.env.GCLOUD_PROJECT || "";
  if (!projectId.startsWith("demo-")) {
    throw new Error("Rules tests require an isolated demo-* Firebase project ID.");
  }

  const separator = firestoreEmulatorHost.lastIndexOf(":");
  const host = firestoreEmulatorHost.slice(0, separator);
  firestorePort = Number(firestoreEmulatorHost.slice(separator + 1));
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || !Number.isInteger(firestorePort)) {
    throw new Error("Rules tests may connect only to a local Firestore Emulator.");
  }
}

before(async () => {
  if (skipReason) return;

  assertSafeEmulatorConfiguration();
  testEnvironment = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT,
    firestore: {
      host: firestoreEmulatorHost.slice(0, firestoreEmulatorHost.lastIndexOf(":")),
      port: firestorePort,
      rules: readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"),
    },
  });
});

after(async () => {
  if (testEnvironment) await testEnvironment.cleanup();
});

function userContext(uid, email = `${uid}@example.com`, claims = {}) {
  return testEnvironment.authenticatedContext(uid, {
    email,
    email_verified: true,
    ...claims,
  }).firestore();
}

async function seedDocument(collectionName, documentId, data) {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), collectionName, documentId), data);
  });
}

async function seedUser(uid, userProfile) {
  await seedDocument("users", uid, userProfile);
}

function profile(uid, role = "candidate", extra = {}) {
  return {
    email: `${uid}@example.com`,
    name: "Test User",
    role,
    ...extra,
  };
}

test("a user cannot change their existing role directly", { skip: skipReason }, async () => {
  const uid = "change-role";
  await seedUser(uid, profile(uid));

  await assertFails(updateDoc(doc(userContext(uid), "users", uid), { role: "admin" }));
});

test("a profile without role cannot add role admin", { skip: skipReason }, async () => {
  const uid = "missing-role";
  await seedUser(uid, {
    email: `${uid}@example.com`,
    name: "Test User",
  });
  const userRef = doc(userContext(uid), "users", uid);

  await assertFails(updateDoc(userRef, { role: "admin" }));
});

test("a profile without role cannot add admin true", { skip: skipReason }, async () => {
  const uid = "missing-role-admin-field";
  await seedUser(uid, {
    email: `${uid}@example.com`,
    name: "Test User",
  });

  const userRef = doc(userContext(uid), "users", uid);
  await assertFails(updateDoc(userRef, { admin: true }));
});

test("a user cannot remove role from their profile", { skip: skipReason }, async () => {
  const uid = "remove-role";
  await seedUser(uid, profile(uid));

  await assertFails(updateDoc(
    doc(userContext(uid), "users", uid),
    { role: deleteField() },
  ));
});

test("a user cannot add an admin field that was not previously present", { skip: skipReason }, async () => {
  const uid = "add-admin-field";
  await seedUser(uid, profile(uid));

  await assertFails(updateDoc(doc(userContext(uid), "users", uid), { admin: true }));
});

test("a profile with admin false cannot change it to true", { skip: skipReason }, async () => {
  const uid = "promote-admin-field";
  await seedUser(uid, profile(uid, "candidate", { admin: false }));

  await assertFails(updateDoc(
    doc(userContext(uid), "users", uid),
    { admin: true },
  ));
});

test("profile creation rejects admin roles and admin fields", { skip: skipReason }, async () => {
  const adminRoleUid = "create-admin-role";
  const adminFieldUid = "create-admin-field";
  const db = userContext(adminRoleUid);

  await assertFails(setDoc(
    doc(db, "users", adminRoleUid),
    profile(adminRoleUid, "admin"),
  ));
  await assertFails(setDoc(
    doc(userContext(adminFieldUid), "users", adminFieldUid),
    profile(adminFieldUid, "candidate", { admin: true }),
  ));
});

test("a user cannot remove an existing admin field", { skip: skipReason }, async () => {
  const uid = "remove-admin-field";
  await seedUser(uid, profile(uid, "candidate", { admin: false }));

  await assertFails(updateDoc(
    doc(userContext(uid), "users", uid),
    { admin: deleteField() },
  ));
});

test("users can still create ordinary candidate and company profiles", { skip: skipReason }, async () => {
  for (const role of ["candidate", "company"]) {
    const uid = `create-${role}`;
    await assertSucceeds(setDoc(
      doc(userContext(uid), "users", uid),
      profile(uid, role),
    ));
  }
});

test("users can still edit normal fields on their own profile", { skip: skipReason }, async () => {
  const uid = "edit-normal-profile";
  await seedUser(uid, profile(uid));

  await assertSucceeds(updateDoc(
    doc(userContext(uid), "users", uid),
    { name: "Updated User" },
  ));
});

test("a user cannot update another user's profile", { skip: skipReason }, async () => {
  const ownerUid = "profile-owner";
  const otherUid = "other-user";
  await seedUser(otherUid, profile(otherUid));

  await assertFails(updateDoc(
    doc(userContext(ownerUid), "users", otherUid),
    { name: "Unauthorized edit" },
  ));
});

test("a verified allowlisted admin can update another user's profile", { skip: skipReason }, async () => {
  const adminUid = "verified-allowlisted-admin";
  const otherUid = "allowlisted-admin-target";
  await seedUser(otherUid, profile(otherUid));

  await assertSucceeds(updateDoc(
    doc(userContext(adminUid, "sunflowercollectivegf@gmail.com"), "users", otherUid),
    { name: "Updated by verified admin" },
  ));
});

test("an unverified allowlisted email cannot update another user's profile", { skip: skipReason }, async () => {
  const adminUid = "unverified-allowlisted-admin";
  const otherUid = "unverified-admin-target";
  await seedUser(otherUid, profile(otherUid));

  await assertFails(updateDoc(
    doc(
      userContext(adminUid, "sunflowercollectivegf@gmail.com", { email_verified: false }),
      "users",
      otherUid,
    ),
    { name: "Must be denied" },
  ));
});

test("a user with the admin custom claim can update another user's profile", { skip: skipReason }, async () => {
  const adminUid = "custom-claim-admin";
  const otherUid = "custom-claim-admin-target";
  await seedUser(otherUid, profile(otherUid));

  await assertSucceeds(updateDoc(
    doc(userContext(adminUid, `${adminUid}@example.com`, { admin: true }), "users", otherUid),
    { name: "Updated by custom-claim admin" },
  ));
});

test("company owner can create their own company without verification fields", { skip: skipReason }, async () => {
  const uid = "company-create-unverified";

  await assertSucceeds(setDoc(
    doc(userContext(uid), "companies", uid),
    { ownerUid: uid, name: "Test Company" },
  ));
});

test("company owner cannot create their own company with active true", { skip: skipReason }, async () => {
  const uid = "company-create-active";

  await assertFails(setDoc(
    doc(userContext(uid), "companies", uid),
    { ownerUid: uid, name: "Test Company", active: true },
  ));
});

test("company owner cannot create their own company with verifiedByAdmin true", { skip: skipReason }, async () => {
  const uid = "company-create-verified";

  await assertFails(setDoc(
    doc(userContext(uid), "companies", uid),
    { ownerUid: uid, name: "Test Company", verifiedByAdmin: true },
  ));
});

test("company owner can create their own company with active false", { skip: skipReason }, async () => {
  const uid = "company-create-inactive";

  await assertSucceeds(setDoc(
    doc(userContext(uid), "companies", uid),
    { ownerUid: uid, name: "Test Company", active: false },
  ));
});

test("company owner cannot add, change, or remove active and verifiedByAdmin", { skip: skipReason }, async (t) => {
  const cases = [
    { name: "add active", initial: {}, update: { active: true } },
    { name: "change active", initial: { active: false }, update: { active: true } },
    { name: "remove active", initial: { active: false }, update: { active: deleteField() } },
    { name: "add verifiedByAdmin", initial: {}, update: { verifiedByAdmin: true } },
    { name: "change verifiedByAdmin", initial: { verifiedByAdmin: false }, update: { verifiedByAdmin: true } },
    { name: "remove verifiedByAdmin", initial: { verifiedByAdmin: false }, update: { verifiedByAdmin: deleteField() } },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const uid = `company-protected-field-${index}`;
      await seedDocument("companies", uid, {
        ownerUid: uid,
        name: "Test Company",
        ...scenario.initial,
      });

      await assertFails(updateDoc(
        doc(userContext(uid), "companies", uid),
        scenario.update,
      ));
    });
  }
});

test("company owner can edit a common field on their own company", { skip: skipReason }, async () => {
  const uid = "company-edit-common";
  await seedDocument("companies", uid, { ownerUid: uid, name: "Old Company Name" });

  await assertSucceeds(updateDoc(
    doc(userContext(uid), "companies", uid),
    { name: "Updated Company Name" },
  ));
});

test("another user cannot edit a company's document", { skip: skipReason }, async () => {
  const ownerUid = "company-owner";
  await seedDocument("companies", ownerUid, { ownerUid, name: "Test Company" });

  await assertFails(updateDoc(
    doc(userContext("other-company-user"), "companies", ownerUid),
    { name: "Unauthorized Company Name" },
  ));
});

test("admin can change a company's active field", { skip: skipReason }, async () => {
  const companyUid = "company-admin-active";
  await seedDocument("companies", companyUid, {
    ownerUid: companyUid,
    name: "Test Company",
    active: false,
  });

  await assertSucceeds(updateDoc(
    doc(userContext("company-admin", "company-admin@example.com", { admin: true }), "companies", companyUid),
    { active: true },
  ));
});

test("admin can read an automated job lead", { skip: skipReason }, async () => {
  const leadId = "admin-readable-lead";
  await seedDocument("automatedJobLeads", leadId, { title: "Test Lead" });

  await assertSucceeds(getDoc(
    doc(userContext("lead-admin", "lead-admin@example.com", { admin: true }), "automatedJobLeads", leadId),
  ));
});

test("a regular user cannot read an automated job lead", { skip: skipReason }, async () => {
  const leadId = "user-private-lead";
  await seedDocument("automatedJobLeads", leadId, { title: "Test Lead" });

  await assertFails(getDoc(
    doc(userContext("regular-lead-user"), "automatedJobLeads", leadId),
  ));
});

test("an anonymous user cannot read an automated job lead", { skip: skipReason }, async () => {
  const leadId = "anonymous-private-lead";
  await seedDocument("automatedJobLeads", leadId, { title: "Test Lead" });

  await assertFails(getDoc(
    doc(testEnvironment.unauthenticatedContext().firestore(), "automatedJobLeads", leadId),
  ));
});

test("an admin cannot write an automated job lead", { skip: skipReason }, async () => {
  const leadId = "admin-cannot-write-lead";

  await assertFails(setDoc(
    doc(userContext("lead-admin-writer", "lead-admin-writer@example.com", { admin: true }), "automatedJobLeads", leadId),
    { title: "Unauthorized Lead" },
  ));
});

test("a regular user cannot write an automated job lead", { skip: skipReason }, async () => {
  const leadId = "user-cannot-write-lead";

  await assertFails(setDoc(
    doc(userContext("regular-lead-writer"), "automatedJobLeads", leadId),
    { title: "Unauthorized Lead" },
  ));
});
