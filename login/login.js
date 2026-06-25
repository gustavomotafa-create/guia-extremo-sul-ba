const params = new URLSearchParams(window.location.search);
const nextUrl = params.get("next") || "../index.html";
const suggestedType = params.get("tipo");

const roleSelect = document.querySelector("#roleSelect");
const nameInput = document.querySelector("#nameInput");
const emailInput = document.querySelector("#emailInput");
const passwordInput = document.querySelector("#passwordInput");
const signInButton = document.querySelector("#signInButton");
const signUpButton = document.querySelector("#signUpButton");
const googleButton = document.querySelector("#googleButton");
const authMessage = document.querySelector("#authMessage");

let firebaseApi;

if (suggestedType === "empresa") roleSelect.value = "company";

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

function goNext() {
  window.location.href = nextUrl;
}

async function runAuth(action) {
  try {
    if (!firebaseApi?.isFirebaseConfigured()) {
      setMessage("Firebase ainda não configurado", "Configure o Firebase para ativar login real, cadastro e permissões.");
      return;
    }

    await action();
    goNext();
  } catch (error) {
    setMessage("Não foi possível concluir", error.message || "Verifique os dados e tente novamente.");
  }
}

signInButton.addEventListener("click", () => {
  runAuth(() => firebaseApi.signInWithEmail(emailInput.value, passwordInput.value));
});

signUpButton.addEventListener("click", () => {
  runAuth(() =>
    firebaseApi.signUpWithEmail({
      email: emailInput.value,
      password: passwordInput.value,
      role: roleSelect.value,
      name: nameInput.value,
    }),
  );
});

googleButton.addEventListener("click", () => {
  runAuth(() => firebaseApi.signInWithGoogle(roleSelect.value));
});

async function init() {
  firebaseApi = await import("../js/firebase-client.js");
  if (firebaseApi.isFirebaseConfigured()) {
    setMessage("Login pronto", "Entre com e-mail/senha ou Google para acessar sua conta.");
  }
}

init();
