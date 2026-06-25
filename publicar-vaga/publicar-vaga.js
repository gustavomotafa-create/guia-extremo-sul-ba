const form = document.querySelector("#publishForm");
const successCard = document.querySelector("#successCard");
const statusTitle = document.querySelector("#publishStatusTitle");
const statusText = document.querySelector("#publishStatusText");
const paymentActions = document.querySelector("#paymentActions");
const checkoutLink = document.querySelector("#checkoutLink");

let firebaseApi;
let currentUser;
let currentProfile;

function showStatus(title, text, checkoutUrl) {
  statusTitle.textContent = title;
  statusText.textContent = text;
  paymentActions.hidden = !checkoutUrl;
  if (checkoutUrl) checkoutLink.href = checkoutUrl;
  successCard.classList.add("is-visible");
  successCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

function normalizePayload(data) {
  const benefits = String(data.get("benefits") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    companyName: data.get("company"),
    title: data.get("title"),
    salaryLabel: data.get("salary") || "A combinar",
    city: data.get("city"),
    contract: data.get("contract"),
    modality: data.get("modality"),
    whatsapp: data.get("whatsapp"),
    description: data.get("description"),
    requirements: data.get("requirements"),
    benefits,
    category: "Serviços Gerais",
    status: "pendente",
    paymentStatus: "gratis",
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!firebaseApi?.isFirebaseConfigured()) {
    showStatus(
      "Firebase ainda não configurado.",
      "Adicione as chaves reais em js/firebase-config.js para publicar vagas com autenticação, limite diário e aprovação.",
    );
    return;
  }

  if (!currentUser) {
    window.location.href = "../login/?tipo=empresa&next=../publicar-vaga/";
    return;
  }

  if (!["company", "admin"].includes(currentProfile?.role)) {
    showStatus("Acesso restrito a empresas.", "Entre com uma conta de empresa para publicar vagas.");
    return;
  }

  try {
    const payload = normalizePayload(new FormData(form));
    const result = await firebaseApi.submitJobWithQuota(payload);

    if (result.requiresPayment) {
      showStatus(
        "Pagamento necessário para publicar mais vagas hoje.",
        "Você já usou as 3 vagas grátis do dia. Pague R$ 5,00 para liberar mais 3 publicações extras hoje.",
        result.checkoutUrl || "../precos/",
      );
      return;
    }

    form.reset();
    showStatus("Vaga enviada para aprovação.", "A vaga entrou como pendente e será analisada pelo admin do Girassol Vagas.");
  } catch (error) {
    showStatus("Não foi possível enviar a vaga.", error.message || "Tente novamente em alguns instantes.");
  }
});

async function init() {
  firebaseApi = await import("../js/firebase-client.js");
  await firebaseApi.onAuth((user, profile) => {
    currentUser = user;
    currentProfile = profile;
  });
}

init();
