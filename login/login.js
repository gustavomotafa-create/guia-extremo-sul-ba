const params = new URLSearchParams(window.location.search);
const nextUrl = params.get("next") || "../index.html";
const suggestedType = params.get("tipo");

const loginTab = document.querySelector("#loginTab");
const signupTab = document.querySelector("#signupTab");
const loginForm = document.querySelector("#loginForm");
const signupForm = document.querySelector("#signupForm");
const roleSelect = document.querySelector("#roleSelect");
const nameInput = document.querySelector("#nameInput");
const loginEmail = document.querySelector("#loginEmail");
const loginPassword = document.querySelector("#loginPassword");
const signupEmail = document.querySelector("#signupEmail");
const signupPassword = document.querySelector("#signupPassword");
const googleLoginButton = document.querySelector("#googleLoginButton");
const googleSignupButton = document.querySelector("#googleSignupButton");
const authMessage = document.querySelector("#authMessage");

let firebaseApi;

if (suggestedType === "empresa") {
  roleSelect.value = "company";
  setTab("signup");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function setMessage(title, text) {
  authMessage.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p>`;
  authMessage.classList.add("is-visible");
}

function friendlyError(error) {
  const code = error?.code || "";
  if (code.includes("invalid-email")) return "Digite um e-mail válido.";
  if (code.includes("missing-password")) return "Digite sua senha.";
  if (code.includes("weak-password")) return "Use uma senha com pelo menos 6 caracteres.";
  if (code.includes("email-already-in-use")) return "Este e-mail já tem uma conta. Use Entrar.";
  if (code.includes("user-not-found") || code.includes("wrong-password") || code.includes("invalid-credential")) {
    return "E-mail ou senha incorretos.";
  }
  if (code.includes("popup-closed-by-user")) return "Login com Google cancelado.";
  return error?.message || "Verifique os dados e tente novamente.";
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function validateEmailPassword(email, password, mode) {
  if (!isEmail(email)) return "Digite um e-mail válido.";
  if (!password) return "Digite sua senha.";
  if (mode === "signup" && password.length < 6) return "A senha precisa ter pelo menos 6 caracteres.";
  return "";
}

function setTab(tab) {
  const isSignup = tab === "signup";
  loginForm.hidden = isSignup;
  signupForm.hidden = !isSignup;
  loginTab.classList.toggle("is-active", !isSignup);
  signupTab.classList.toggle("is-active", isSignup);
}

function goNext() {
  window.location.href = nextUrl;
}

async function runAuth(action) {
  try {
    if (!firebaseApi?.isFirebaseConfigured()) {
      setMessage(
        "Firebase aguardando configuração local",
        "Crie o arquivo js/firebase-config.local.js com as chaves do Firebase ou faça o deploy pelo Firebase Hosting com esse arquivo local.",
      );
      return;
    }

    await action();
    goNext();
  } catch (error) {
    setMessage("Não foi possível concluir", friendlyError(error));
  }
}

loginTab.addEventListener("click", () => setTab("login"));
signupTab.addEventListener("click", () => setTab("signup"));

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  const validation = validateEmailPassword(email, password, "login");
  if (validation) {
    setMessage("Revise os dados", validation);
    return;
  }
  runAuth(() => firebaseApi.signInWithEmail(email, password));
});

signupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = signupEmail.value.trim();
  const password = signupPassword.value;
  const validation = validateEmailPassword(email, password, "signup");
  if (validation) {
    setMessage("Revise os dados", validation);
    return;
  }
  runAuth(() =>
    firebaseApi.signUpWithEmail({
      email,
      password,
      role: roleSelect.value,
      name: nameInput.value.trim(),
    }),
  );
});

googleLoginButton.addEventListener("click", () => {
  runAuth(() => firebaseApi.signInWithGoogle("candidate"));
});

googleSignupButton.addEventListener("click", () => {
  runAuth(() => firebaseApi.signInWithGoogle(roleSelect.value));
});

async function init() {
  firebaseApi = await import("../js/firebase-client.js");
  if (firebaseApi.isFirebaseConfigured()) {
    setMessage("Login pronto", "Entre com e-mail e senha ou use sua conta Google.");
  }
}

init();
