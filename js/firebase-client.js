const FIREBASE_VERSION = "10.12.4";

let servicesPromise;

export function isFirebaseConfigured() {
  const config = window.GIRASSOL_FIREBASE_CONFIG;
  return Boolean(config?.apiKey && !config.apiKey.startsWith("COLE_"));
}

export function getContacts() {
  return window.GIRASSOL_CONTACTS || {
    whatsapp: "5527988492573",
    email: "sunflowercollectivegf@gmail.com",
  };
}

async function loadSdk() {
  const [appSdk, authSdk, firestoreSdk, functionsSdk] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-functions.js`),
  ]);

  return { appSdk, authSdk, firestoreSdk, functionsSdk };
}

export async function getServices() {
  if (!isFirebaseConfigured()) return null;

  if (!servicesPromise) {
    servicesPromise = (async () => {
      const { appSdk, authSdk, firestoreSdk, functionsSdk } = await loadSdk();
      const app = appSdk.initializeApp(window.GIRASSOL_FIREBASE_CONFIG);
      const auth = authSdk.getAuth(app);
      const db = firestoreSdk.getFirestore(app);
      const functions = functionsSdk.getFunctions(app, "southamerica-east1");

      return { app, auth, db, functions, authSdk, firestoreSdk, functionsSdk };
    })();
  }

  return servicesPromise;
}

export async function getUserProfile(uid) {
  const services = await getServices();
  if (!services) return null;
  const { db, firestoreSdk } = services;
  const snap = await firestoreSdk.getDoc(firestoreSdk.doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

function safeAccountRole(role) {
  return role === "company" ? "company" : "candidate";
}

async function ensureUserProfile(services, user, role = "candidate") {
  const { db, firestoreSdk } = services;
  const safeRole = safeAccountRole(role);
  const userRef = firestoreSdk.doc(db, "users", user.uid);
  const profile = await firestoreSdk.getDoc(userRef);

  if (profile.exists()) return { id: profile.id, ...profile.data() };

  await firestoreSdk.setDoc(userRef, {
    email: user.email,
    name: user.displayName || "",
    role: safeRole,
    createdAt: firestoreSdk.serverTimestamp(),
  });

  if (safeRole === "company") {
    await firestoreSdk.setDoc(firestoreSdk.doc(db, "companies", user.uid), {
      ownerUid: user.uid,
      name: user.displayName || user.email,
      email: user.email,
      createdAt: firestoreSdk.serverTimestamp(),
      active: true,
    });
  }

  return { id: user.uid, email: user.email, name: user.displayName || "", role: safeRole };
}

export async function onAuth(callback) {
  const services = await getServices();
  if (!services) {
    callback(null, null);
    return () => {};
  }

  const { auth, authSdk } = services;
  return authSdk.onAuthStateChanged(auth, async (user) => {
    const profile = user ? await getUserProfile(user.uid) : null;
    callback(user, profile);
  });
}

export async function signUpWithEmail({ email, password, role, name }) {
  const services = await getServices();
  if (!services) throw new Error("Configure o Firebase antes de criar contas.");
  const { auth, authSdk, db, firestoreSdk } = services;
  const safeRole = safeAccountRole(role);
  const credential = await authSdk.createUserWithEmailAndPassword(auth, email, password);

  await firestoreSdk.setDoc(firestoreSdk.doc(db, "users", credential.user.uid), {
    email,
    name: name || "",
    role: safeRole,
    createdAt: firestoreSdk.serverTimestamp(),
  });

  authSdk.sendEmailVerification(credential.user).catch(() => {});

  if (safeRole === "company") {
    await firestoreSdk.setDoc(firestoreSdk.doc(db, "companies", credential.user.uid), {
      ownerUid: credential.user.uid,
      name: name || email,
      email,
      createdAt: firestoreSdk.serverTimestamp(),
      active: true,
    });
  }

  return credential.user;
}

export async function signInWithEmail(email, password) {
  const services = await getServices();
  if (!services) throw new Error("Configure o Firebase antes de entrar.");
  return services.authSdk.signInWithEmailAndPassword(services.auth, email, password);
}

export async function signInWithGoogle(role = "candidate") {
  const services = await getServices();
  if (!services) throw new Error("Configure o Firebase antes de entrar com Google.");
  const { auth, authSdk, db, firestoreSdk } = services;
  const provider = new authSdk.GoogleAuthProvider();
  const safeRole = safeAccountRole(role);

  try {
    const credential = await authSdk.signInWithPopup(auth, provider);
    await ensureUserProfile({ db, firestoreSdk }, credential.user, safeRole);
    return credential.user;
  } catch (error) {
    const code = error?.code || "";
    const shouldRedirect =
      code.includes("popup-blocked") ||
      code.includes("popup-blocked-by-browser") ||
      code.includes("operation-not-supported-in-this-environment");

    if (!shouldRedirect) throw error;

    try {
      window.sessionStorage.setItem("girassolGoogleRole", safeRole);
    } catch {}

    await authSdk.signInWithRedirect(auth, provider);
    return null;
  }
}

export async function completeGoogleRedirect() {
  const services = await getServices();
  if (!services) return null;
  const { auth, authSdk, db, firestoreSdk } = services;
  const credential = await authSdk.getRedirectResult(auth);

  if (!credential?.user) return null;

  let role = "candidate";
  try {
    role = window.sessionStorage.getItem("girassolGoogleRole") || "candidate";
    window.sessionStorage.removeItem("girassolGoogleRole");
  } catch {}

  await ensureUserProfile({ db, firestoreSdk }, credential.user, role);
  return credential.user;
}

export async function signOutUser() {
  const services = await getServices();
  if (!services) return;
  await services.authSdk.signOut(services.auth);
}

export async function listenApprovedJobs(callback) {
  const services = await getServices();
  if (!services) return () => {};
  const { db, firestoreSdk } = services;
  const q = firestoreSdk.query(
    firestoreSdk.collection(db, "jobs"),
    firestoreSdk.where("status", "==", "aprovada"),
    firestoreSdk.orderBy("publishedAt", "desc"),
  );

  return firestoreSdk.onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
  });
}

export async function listenSavedJobIds(uid, callback) {
  const services = await getServices();
  if (!services || !uid) return () => {};
  const { db, firestoreSdk } = services;
  const q = firestoreSdk.query(
    firestoreSdk.collection(db, "savedJobs"),
    firestoreSdk.where("userId", "==", uid),
  );

  return firestoreSdk.onSnapshot(q, (snapshot) => {
    callback(new Set(snapshot.docs.map((docSnap) => docSnap.data().jobId)));
  });
}

export async function saveJob(uid, jobId) {
  const services = await getServices();
  if (!services) throw new Error("Configure o Firebase para salvar vagas.");
  const { db, firestoreSdk } = services;
  const id = `${uid}_${jobId}`;
  await firestoreSdk.setDoc(firestoreSdk.doc(db, "savedJobs", id), {
    userId: uid,
    jobId,
    createdAt: firestoreSdk.serverTimestamp(),
  });
}

export async function unsaveJob(uid, jobId) {
  const services = await getServices();
  if (!services) throw new Error("Configure o Firebase para remover vagas salvas.");
  const { db, firestoreSdk } = services;
  await firestoreSdk.deleteDoc(firestoreSdk.doc(db, "savedJobs", `${uid}_${jobId}`));
}

export async function callFunction(name, payload = {}) {
  const services = await getServices();
  if (!services) throw new Error("Configure o Firebase Functions para concluir esta ação.");
  const fn = services.functionsSdk.httpsCallable(services.functions, name);
  const result = await fn(payload);
  return result.data;
}

export async function submitJobWithQuota(payload) {
  return callFunction("createJobDraft", payload);
}

export async function createCheckout(jobId) {
  return callFunction("createPublicationCheckout", { jobId });
}

export async function getCurrentUserWithProfile() {
  const services = await getServices();
  if (!services) return { user: null, profile: null };
  const user = services.auth.currentUser;
  return { user, profile: user ? await getUserProfile(user.uid) : null };
}
