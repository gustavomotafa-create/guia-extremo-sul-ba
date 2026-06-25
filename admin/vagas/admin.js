const adminGuard = document.querySelector("#adminGuard");
const adminList = document.querySelector("#adminList");
const adminToolbar = document.querySelector("#adminToolbar");
const statusFilter = document.querySelector("#statusFilter");
const adminSearch = document.querySelector("#adminSearch");
const newJobButton = document.querySelector("#newJobButton");
const editDialog = document.querySelector("#editJobDialog");
const editDialogTitle = document.querySelector("#editDialogTitle");
const editForm = document.querySelector("#editJobForm");

let firebaseApi;
let services;
let allJobs = [];
let unsubscribeJobs;
let currentAdminUser;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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
  return benefits || "Não informado";
}

function originLabel(job) {
  const origin = job.origin || job.source || "company";
  return origin === "admin" ? "Admin" : "Empresa";
}

function renderGuard(title, text, actionHtml = "") {
  adminGuard.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p>${actionHtml}`;
  adminGuard.classList.add("is-visible");
}

function populateSelect(select, options, selectedValue) {
  select.innerHTML = options.map((option) => `<option>${escapeHtml(option)}</option>`).join("");
  if (selectedValue) select.value = selectedValue;
}

function fillSelects() {
  populateSelect(editForm.elements.city, window.GIRASSOL_CITIES || [], "");
  populateSelect(editForm.elements.category, window.GIRASSOL_CATEGORIES || [], "");
}

function visibleJobs() {
  const status = statusFilter.value;
  const query = normalize(adminSearch.value);

  return allJobs.filter((job) => {
    const statusOk = !status || job.status === status;
    const searchOk = !query || normalize(`${job.title} ${job.companyName} ${job.city}`).includes(query);
    return statusOk && searchOk;
  });
}

function renderJobs() {
  const jobs = visibleJobs();

  if (!jobs.length) {
    adminList.innerHTML = '<div class="empty-state">Nenhuma vaga encontrada com os filtros atuais.</div>';
    return;
  }

  adminList.innerHTML = jobs
    .map((job) => {
      const benefits = formatBenefits(job.benefits);
      const rejection = job.rejectionReason ? `<p><strong>Motivo:</strong> ${escapeHtml(job.rejectionReason)}</p>` : "";
      return `
        <article class="admin-card">
          <div class="admin-card-header">
            <span class="tag">${escapeHtml(job.status || "pendente")}</span>
            <span class="tag ${job.paymentStatus === "paga" ? "green" : ""}">${escapeHtml(job.paymentStatus || "gratis")}</span>
            <span class="tag blue">Origem: ${escapeHtml(originLabel(job))}</span>
          </div>
          <h3>${escapeHtml(job.title || "Vaga sem título")}</h3>
          <p><strong>${escapeHtml(job.companyName || "Empresa não informada")}</strong> · ${escapeHtml(job.city || "Cidade não informada")} · ${escapeHtml(job.contract || "Contrato não informado")} · ${escapeHtml(job.salaryLabel || "Salário a combinar")}</p>
          <p>${escapeHtml(job.description || "Sem descrição.")}</p>
          <p><strong>Requisitos:</strong> ${escapeHtml(job.requirements || "Não informado")}</p>
          <p><strong>Benefícios:</strong> ${escapeHtml(benefits)}</p>
          <p><strong>WhatsApp:</strong> ${escapeHtml(job.whatsapp || "Não informado")}</p>
          ${rejection}
          <div class="admin-actions">
            <button class="primary-button" type="button" data-action="approve" data-id="${escapeHtml(job.id)}">Aprovar</button>
            <button class="secondary-button" type="button" data-action="edit" data-id="${escapeHtml(job.id)}">Editar completa</button>
            <button class="secondary-button" type="button" data-action="reject" data-id="${escapeHtml(job.id)}">Rejeitar</button>
            <button class="danger-button" type="button" data-action="delete" data-id="${escapeHtml(job.id)}">Excluir</button>
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadJobs() {
  const { db, firestoreSdk } = services;
  const q = firestoreSdk.query(
    firestoreSdk.collection(db, "jobs"),
    firestoreSdk.where("status", "in", ["pendente", "aguardando_pagamento", "aprovada", "rejeitada", "pausada"]),
    firestoreSdk.orderBy("createdAt", "desc"),
  );

  unsubscribeJobs = firestoreSdk.onSnapshot(q, (snapshot) => {
    allJobs = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    renderJobs();
  });
}

async function updateJob(id, patch) {
  const { db, firestoreSdk } = services;
  await firestoreSdk.updateDoc(firestoreSdk.doc(db, "jobs", id), patch);
}

async function deleteJob(id) {
  const { db, firestoreSdk } = services;
  await firestoreSdk.deleteDoc(firestoreSdk.doc(db, "jobs", id));
}

async function createJob(payload) {
  const { db, firestoreSdk } = services;
  await firestoreSdk.addDoc(firestoreSdk.collection(db, "jobs"), payload);
}

function openCreateDialog() {
  fillSelects();
  editDialogTitle.textContent = "Cadastrar vaga manual";
  editForm.reset();
  editForm.elements.id.value = "";
  editForm.elements.category.value = "Serviços Gerais";
  editForm.elements.contract.value = "CLT";
  editForm.elements.modality.value = "Presencial";
  editForm.elements.level.value = "Júnior";
  editForm.elements.status.value = "aprovada";
  editForm.elements.salaryLabel.value = "A combinar";
  editDialog.showModal();
}

function openEditDialog(id) {
  const job = allJobs.find((item) => item.id === id);
  if (!job) return;

  fillSelects();
  editDialogTitle.textContent = "Editar vaga";
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
  editForm.elements.status.value = job.status || "pendente";
  editForm.elements.logoUrl.value = job.logoUrl || "";
  editForm.elements.description.value = job.description || "";
  editForm.elements.requirements.value = job.requirements || "";
  editForm.elements.benefits.value = formatBenefits(job.benefits) === "Não informado" ? "" : formatBenefits(job.benefits);
  editForm.elements.rejectionReason.value = job.rejectionReason || "";
  editDialog.showModal();
}

function collectEditPayload({ isCreate = false } = {}) {
  const formData = new FormData(editForm);
  const contract = String(formData.get("contract") || "").trim();
  const modality = String(formData.get("modality") || "").trim();
  const salaryLabel = String(formData.get("salaryLabel") || "A combinar").trim() || "A combinar";
  const status = String(formData.get("status") || "pendente");

  const payload = {
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
    status,
    logoUrl: String(formData.get("logoUrl") || "").trim(),
    description: String(formData.get("description") || "").trim(),
    requirements: String(formData.get("requirements") || "").trim(),
    benefits: splitBenefits(formData.get("benefits")),
    rejectionReason: String(formData.get("rejectionReason") || "").trim(),
    tags: [modality, contract].filter(Boolean),
    updatedAt: services.firestoreSdk.serverTimestamp(),
  };

  if (isCreate) {
    payload.createdAt = services.firestoreSdk.serverTimestamp();
    payload.companyId = currentAdminUser?.uid || "admin";
    payload.companyOwnerUid = currentAdminUser?.uid || "admin";
    payload.paymentStatus = "gratis";
    payload.quotaType = "manual";
    payload.origin = "admin";
    payload.source = "admin";
  }

  if (status === "aprovada") {
    payload.publishedAt = services.firestoreSdk.serverTimestamp();
    payload.rejectionReason = "";
  }

  return payload;
}

adminList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  try {
    if (button.dataset.action === "approve") {
      await updateJob(button.dataset.id, {
        status: "aprovada",
        rejectionReason: "",
        publishedAt: services.firestoreSdk.serverTimestamp(),
        updatedAt: services.firestoreSdk.serverTimestamp(),
      });
    }

    if (button.dataset.action === "reject") {
      const reason = window.prompt("Motivo da rejeição:");
      await updateJob(button.dataset.id, {
        status: "rejeitada",
        rejectionReason: reason || "Vaga rejeitada pelo admin.",
        updatedAt: services.firestoreSdk.serverTimestamp(),
      });
    }

    if (button.dataset.action === "edit") {
      openEditDialog(button.dataset.id);
    }

    if (button.dataset.action === "delete") {
      const confirmed = window.confirm("Excluir esta vaga definitivamente?");
      if (confirmed) await deleteJob(button.dataset.id);
    }
  } catch (error) {
    alert(error.message || "Não foi possível executar a ação.");
  }
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const id = editForm.elements.id.value;
    if (id) {
      await updateJob(id, collectEditPayload());
    } else {
      await createJob(collectEditPayload({ isCreate: true }));
    }
    editDialog.close();
  } catch (error) {
    alert(error.message || "Não foi possível salvar a vaga.");
  }
});

[statusFilter, adminSearch].forEach((field) => {
  field.addEventListener("input", renderJobs);
});

newJobButton.addEventListener("click", openCreateDialog);

editDialog.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-dialog]")) editDialog.close();
});

window.addEventListener("beforeunload", () => {
  if (unsubscribeJobs) unsubscribeJobs();
});

async function init() {
  firebaseApi = await import("../../js/firebase-client.js");

  if (!firebaseApi.isFirebaseConfigured()) {
    renderGuard(
      "Firebase ainda não configurado.",
      "Adicione as chaves reais em js/firebase-config.js e publique as regras do Firestore para proteger o painel.",
      '<div class="dialog-actions"><a class="primary-button" href="../../login/">Ir para login</a></div>',
    );
    return;
  }

  services = await firebaseApi.getServices();
  await firebaseApi.onAuth(async (user, profile) => {
    if (!user) {
      window.location.href = "../../login/?next=../admin/vagas/";
      return;
    }

    const adminEmails = window.GIRASSOL_ADMIN_EMAILS || [];
    const isAdmin = profile?.role === "admin" || (user.emailVerified && adminEmails.includes(user.email));

    if (!isAdmin) {
      renderGuard("Acesso negado.", "Somente administradores podem acessar este painel.");
      adminList.innerHTML = "";
      adminToolbar.hidden = true;
      return;
    }

    adminGuard.hidden = true;
    adminToolbar.hidden = false;
    currentAdminUser = user;
    loadJobs();
  });
}

init();
