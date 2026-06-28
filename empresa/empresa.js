const companyJobsList = document.querySelector("#companyJobsList");
const paymentsList = document.querySelector("#paymentsList");
const quotaTitle = document.querySelector("#quotaTitle");
const quotaText = document.querySelector("#quotaText");
const quotaFree = document.querySelector("#quotaFree");
const quotaPaid = document.querySelector("#quotaPaid");
const editDialog = document.querySelector("#companyEditDialog");
const editForm = document.querySelector("#companyEditForm");

let firebaseApi;
let services;
let currentUser;
let currentProfile;
let companyJobs = [];
let unsubscribeJobs;
let unsubscribePayments;
let unsubscribeUsage;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function parseSalary(value) {
  const number = Number(String(value || "").replace(/[^\d,.-]/g, "").replace(".", "").replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function splitBenefits(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatBenefits(benefits) {
  if (Array.isArray(benefits)) return benefits.join(", ");
  return benefits || "";
}

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

function renderMessage(title, text) {
  companyJobsList.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong><br>${escapeHtml(text)}</div>`;
}

function populateSelect(select, options, selectedValue) {
  select.innerHTML = options.map((option) => `<option>${escapeHtml(option)}</option>`).join("");
  if (selectedValue) select.value = selectedValue;
}

function fillSelects() {
  populateSelect(editForm.elements.city, window.GIRASSOL_CITIES || [], "");
  populateSelect(editForm.elements.category, window.GIRASSOL_CATEGORIES || [], "");
}

function renderJobs(jobs) {
  companyJobs = jobs;

  if (!jobs.length) {
    renderMessage("Nenhuma publicação criada ainda.", "Use o botão Publicar Oportunidade para cadastrar sua primeira oportunidade.");
    return;
  }

  companyJobsList.innerHTML = jobs
    .map((job) => {
      const paymentPending = job.paymentStatus === "aguardando_pagamento";
      const rejection = job.rejectionReason ? `<p><strong>Motivo:</strong> ${escapeHtml(job.rejectionReason)}</p>` : "";
      return `
        <article class="admin-card">
          <div class="admin-card-header">
            <span class="tag">${escapeHtml(job.status || "pendente")}</span>
            <span class="tag ${job.paymentStatus === "paga" ? "green" : ""}">${escapeHtml(job.paymentStatus || "gratis")}</span>
          </div>
          <h3>${escapeHtml(job.title || "Vaga sem título")}</h3>
          <p><strong>${escapeHtml(job.companyName || "Anunciante")}</strong> · ${escapeHtml(job.city || "Cidade")} · ${escapeHtml(job.contract || "Contrato")} · ${escapeHtml(job.modality || "Presencial")}</p>
          <p><strong>Salário:</strong> ${escapeHtml(job.salaryLabel || "A combinar")}</p>
          ${rejection}
          <div class="admin-actions">
            ${paymentPending ? `<button class="primary-button" type="button" data-action="pay" data-id="${escapeHtml(job.id)}">Pagar R$ 5,00</button>` : ""}
            <button class="secondary-button" type="button" data-action="pause" data-id="${escapeHtml(job.id)}">Pausar</button>
            <button class="secondary-button" type="button" data-action="edit" data-id="${escapeHtml(job.id)}">Editar completa</button>
            <button class="danger-button" type="button" data-action="delete" data-id="${escapeHtml(job.id)}">Excluir</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderPayments(payments) {
  if (!payments.length) {
    paymentsList.textContent = "Nenhum pagamento registrado.";
    return;
  }

  paymentsList.innerHTML = payments
    .map((payment) => {
      const amount = Number(payment.amount || 5).toFixed(2).replace(".", ",");
      return `<p><strong>R$ ${amount}</strong> · ${escapeHtml(payment.status || "pending")}</p>`;
    })
    .join("");
}

function renderUsage(usage = {}) {
  const freeUsed = Number(usage.freeUsed || 0);
  const paidCredits = Number(usage.paidCredits || 0);
  const paidUsed = Number(usage.paidUsed || 0);
  quotaFree.textContent = `Grátis usadas: ${freeUsed}/2`;
  quotaPaid.textContent = `Créditos pagos: ${paidCredits} disponíveis · ${paidUsed} usados`;
}

async function listenCompanyData() {
  const { db, firestoreSdk } = services;
  const jobsQuery = firestoreSdk.query(
    firestoreSdk.collection(db, "jobs"),
    firestoreSdk.where("companyId", "==", currentUser.uid),
    firestoreSdk.orderBy("createdAt", "desc"),
  );

  unsubscribeJobs = firestoreSdk.onSnapshot(jobsQuery, (snapshot) => {
    renderJobs(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
  });

  const paymentsQuery = firestoreSdk.query(
    firestoreSdk.collection(db, "payments"),
    firestoreSdk.where("companyId", "==", currentUser.uid),
    firestoreSdk.orderBy("createdAt", "desc"),
  );

  unsubscribePayments = firestoreSdk.onSnapshot(paymentsQuery, (snapshot) => {
    renderPayments(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
  });

  const usageRef = firestoreSdk.doc(db, "companyDailyUsage", `${currentUser.uid}_${todayInBahia()}`);
  unsubscribeUsage = firestoreSdk.onSnapshot(usageRef, (snapshot) => {
    renderUsage(snapshot.exists() ? snapshot.data() : {});
  });
}

async function updateJob(id, patch) {
  const { db, firestoreSdk } = services;
  await firestoreSdk.updateDoc(firestoreSdk.doc(db, "jobs", id), patch);
}

function openEditDialog(id) {
  const job = companyJobs.find((item) => item.id === id);
  if (!job) return;

  fillSelects();
  editForm.elements.id.value = job.id;
  editForm.elements.companyName.value = job.companyName || "";
  editForm.elements.title.value = job.title || "";
  editForm.elements.city.value = job.city || "";
  editForm.elements.category.value = job.category || "Serviços Gerais";
  editForm.elements.salaryLabel.value = job.salaryLabel || "";
  editForm.elements.contract.value = job.contract || "CLT";
  editForm.elements.modality.value = job.modality || "Presencial";
  editForm.elements.level.value = job.level || "Júnior";
  editForm.elements.whatsapp.value = job.whatsapp || "";
  editForm.elements.logoUrl.value = job.logoUrl || "";
  editForm.elements.description.value = job.description || "";
  editForm.elements.requirements.value = job.requirements || "";
  editForm.elements.benefits.value = formatBenefits(job.benefits);
  editDialog.showModal();
}

function collectEditPayload(id) {
  const original = companyJobs.find((job) => job.id === id) || {};
  const formData = new FormData(editForm);
  const contract = String(formData.get("contract") || "").trim();
  const modality = String(formData.get("modality") || "").trim();
  const salaryLabel = String(formData.get("salaryLabel") || "A combinar").trim() || "A combinar";
  const paymentPending = original.paymentStatus === "aguardando_pagamento";

  return {
    companyName: String(formData.get("companyName") || "").trim(),
    title: String(formData.get("title") || "").trim(),
    city: String(formData.get("city") || "").trim(),
    category: String(formData.get("category") || "Serviços Gerais").trim(),
    salary: parseSalary(salaryLabel),
    salaryLabel,
    contract,
    modality,
    level: String(formData.get("level") || "Júnior").trim(),
    whatsapp: String(formData.get("whatsapp") || "").replace(/\D/g, ""),
    logoUrl: String(formData.get("logoUrl") || "").trim(),
    description: String(formData.get("description") || "").trim(),
    requirements: String(formData.get("requirements") || "").trim(),
    benefits: splitBenefits(formData.get("benefits")),
    tags: [modality, contract].filter(Boolean),
    status: paymentPending ? "aguardando_pagamento" : "pendente",
    rejectionReason: "",
    updatedAt: services.firestoreSdk.serverTimestamp(),
  };
}

companyJobsList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  try {
    if (button.dataset.action === "pay") {
      const result = await firebaseApi.createCheckout(button.dataset.id);
      if (result.checkoutUrl) window.location.href = result.checkoutUrl;
      return;
    }

    if (button.dataset.action === "pause") {
      await updateJob(button.dataset.id, { status: "pausada", updatedAt: services.firestoreSdk.serverTimestamp() });
    }

    if (button.dataset.action === "edit") {
      openEditDialog(button.dataset.id);
    }

    if (button.dataset.action === "delete") {
      const confirmed = window.confirm("Excluir esta vaga?");
      if (confirmed) {
        await services.firestoreSdk.deleteDoc(services.firestoreSdk.doc(services.db, "jobs", button.dataset.id));
      }
    }
  } catch (error) {
    alert(error.message || "Não foi possível atualizar a vaga.");
  }
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const id = editForm.elements.id.value;
    await updateJob(id, collectEditPayload(id));
    editDialog.close();
  } catch (error) {
    alert(error.message || "Não foi possível salvar a vaga.");
  }
});

editDialog.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-dialog]")) editDialog.close();
});

window.addEventListener("beforeunload", () => {
  if (unsubscribeJobs) unsubscribeJobs();
  if (unsubscribePayments) unsubscribePayments();
  if (unsubscribeUsage) unsubscribeUsage();
});

async function init() {
  firebaseApi = await import("../js/firebase-client.js");

  if (!firebaseApi.isFirebaseConfigured()) {
    renderMessage("Firebase ainda não configurado.", "Configure o Firebase para ativar sua conta.");
    paymentsList.textContent = "Firebase pendente.";
    renderUsage();
    return;
  }

  services = await firebaseApi.getServices();
  await firebaseApi.onAuth((user, profile) => {
    if (!user) {
      window.location.href = "../login/?next=../empresa/";
      return;
    }

    currentUser = user;
    currentProfile = profile;
    quotaTitle.textContent = "2 publicações gratuitas";
    quotaText.textContent = "Após usar as duas publicações gratuitas, cada pagamento de R$ 5,00 libera mais 2 publicações extras.";
    listenCompanyData();
  });
}

init();
