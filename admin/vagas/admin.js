const adminGuard = document.querySelector("#adminGuard");
const adminList = document.querySelector("#adminList");
const adminToolbar = document.querySelector("#adminToolbar");
const statusFilter = document.querySelector("#statusFilter");
const adminSearch = document.querySelector("#adminSearch");
const newJobButton = document.querySelector("#newJobButton");
const adminTabs = document.querySelector("#adminTabs");
const jobsPanel = document.querySelector("#jobsPanel");
const automatedLeadsPanel = document.querySelector("#automatedLeadsPanel");
const companiesPanel = document.querySelector("#companiesPanel");
const jobsTab = document.querySelector("#jobsTab");
const automatedLeadsTab = document.querySelector("#automatedLeadsTab");
const companiesTab = document.querySelector("#companiesTab");
const pendingLeadCount = document.querySelector("#pendingLeadCount");
const leadStatusFilter = document.querySelector("#leadStatusFilter");
const leadSearch = document.querySelector("#leadSearch");
const automatedLeadList = document.querySelector("#automatedLeadList");
const companySearch = document.querySelector("#companySearch");
const companyList = document.querySelector("#companyList");
const companyListNote = document.querySelector("#companyListNote");
const editDialog = document.querySelector("#editJobDialog");
const editDialogTitle = document.querySelector("#editDialogTitle");
const editForm = document.querySelector("#editJobForm");
const automatedLeadDialog = document.querySelector("#automatedLeadDialog");
const leadDialogSource = document.querySelector("#leadDialogSource");
const automatedLeadForm = document.querySelector("#automatedLeadForm");

let firebaseApi;
let services;
let allJobs = [];
let allAutomatedLeads = [];
let allCompanies = [];
let unsubscribeJobs;
let unsubscribeAutomatedLeads;
let currentAdminUser;
const PENDING_LEAD_STATUSES = new Set([
  "",
  "new",
  "pending",
  "pending_review",
  "pending-review",
  "lead_pending_review",
  "aguardando_revisao",
  "aguardando revisao",
]);

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
  return origin === "admin" ? "Admin" : "Anunciante";
}

function moderationReviewDetails(job) {
  const flags = Array.isArray(job.moderationFlags) ? job.moderationFlags.filter(Boolean) : [];
  const reasons = Array.isArray(job.moderationReasons)
    ? job.moderationReasons
      .map((reason) => typeof reason === "string" ? reason : reason?.message)
      .filter(Boolean)
    : [];
  if (job.moderationStatus !== "review" && !flags.length && !reasons.length) return "";
  const details = [
    flags.length ? `<p><strong>Sinais:</strong> ${escapeHtml(flags.join(", "))}</p>` : "",
    reasons.length ? `<p><strong>Motivos:</strong> ${escapeHtml(reasons.join(" · "))}</p>` : "",
  ].join("");
  return `<aside class="moderation-review-note"><strong>Revisão excepcional</strong>${details}</aside>`;
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

  function formatCompanyVerificationDate(value) {
    const milliseconds = timestampMillis(value);
    return milliseconds
      ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(milliseconds))
      : "Não registrada";
  }

  function visibleCompanies() {
    const query = normalize(companySearch.value);
    return allCompanies
      .filter((company) => !query || normalize([
        company.name,
        company.email,
        company.ownerUid,
        company.tradeName,
        company.cnpj,
      ].join(" ")).includes(query))
      .sort((left, right) => (
        Number(left.verifiedByAdmin === true) - Number(right.verifiedByAdmin === true)
        || normalize(left.name || "").localeCompare(normalize(right.name || ""), "pt-BR")
      ));
  }

  function renderCompanies() {
    const companies = visibleCompanies();
    if (!companies.length) {
      companyList.innerHTML = '<div class="empty-state">Nenhuma empresa encontrada.</div>';
      return;
    }

    companyList.innerHTML = companies.map((company) => {
      const verified = company.verifiedByAdmin === true;
      const active = company.active === true;
      const verifiedAt = verified ? formatCompanyVerificationDate(company.verifiedAt) : "";
      const verifiedBy = verified ? company.verifiedByEmail || company.verifiedByUid || "Administrador" : "";
      const inconsistent = active !== verified;
      return `
        <article class="admin-card company-verification-card">
          <div class="admin-card-header">
            <span class="tag ${verified ? "green" : "blue"}">${verified ? "Verificada" : "Não verificada"}</span>
            <span class="tag ${active ? "green" : ""}">${active ? "Ativa" : "Inativa"}</span>
          </div>
          <div>
            <h3>${escapeHtml(company.name || company.tradeName || "Empresa sem nome")}</h3>
            <p><strong>E-mail:</strong> ${escapeHtml(company.email || "Não informado")}</p>
            <p><strong>Responsável:</strong> ${escapeHtml(company.ownerUid || company.id || "Não informado")}</p>
            ${company.cnpj ? `<p><strong>CNPJ:</strong> ${escapeHtml(company.cnpj)}</p>` : ""}
            ${verified ? `<p><strong>Verificada em:</strong> ${escapeHtml(verifiedAt)} · <strong>Por:</strong> ${escapeHtml(verifiedBy)}</p>` : ""}
            ${inconsistent ? '<p class="lead-completion-note">O estado de ativação não corresponde à verificação administrativa. Use a ação para sincronizar.</p>' : ""}
          </div>
          <div class="admin-actions">
            <button class="${verified ? "danger-button" : "primary-button"}" type="button" data-company-verification="${verified ? "false" : "true"}" data-company-id="${escapeHtml(company.id)}">
              ${verified ? "Remover verificação e desativar" : "Verificar e ativar"}
            </button>
          </div>
        </article>
      `;
    }).join("");
  }

  adminList.innerHTML = jobs
    .map((job) => {
      const benefits = formatBenefits(job.benefits);
      const rejection = job.rejectionReason ? `<p><strong>Motivo:</strong> ${escapeHtml(job.rejectionReason)}</p>` : "";
      const moderationDetails = moderationReviewDetails(job);
      return `
        <article class="admin-card">
          <div class="admin-card-header">
            <span class="tag">${escapeHtml(job.status || "pendente")}</span>
            <span class="tag ${job.paymentStatus === "paga" ? "green" : ""}">${escapeHtml(job.paymentStatus || "gratis")}</span>
            <span class="tag blue">Origem: ${escapeHtml(originLabel(job))}</span>
          </div>
          <h3>${escapeHtml(job.title || "Vaga sem título")}</h3>
          <p><strong>${escapeHtml(job.companyName || "Anunciante não informado")}</strong> · ${escapeHtml(job.city || "Cidade não informada")} · ${escapeHtml(job.contract || "Contrato não informado")} · ${escapeHtml(job.salaryLabel || "Salário a combinar")}</p>
          <p>${escapeHtml(job.description || "Sem descrição.")}</p>
          <p><strong>Requisitos:</strong> ${escapeHtml(job.requirements || "Não informado")}</p>
          <p><strong>Benefícios:</strong> ${escapeHtml(benefits)}</p>
          <p><strong>WhatsApp:</strong> ${escapeHtml(job.whatsapp || "Não informado")}</p>
          ${moderationDetails}
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

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLeadDate(value) {
  const milliseconds = timestampMillis(value);
  return milliseconds
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(new Date(milliseconds))
    : "Não informada";
}

function leadReviewState(lead) {
  const statuses = [lead.reviewStatus, lead.triageStatus, lead.status]
    .map((status) => normalize(status).replace(/\s+/g, "_"))
    .filter(Boolean);
  if (statuses.some((status) => ["approved", "aprovada", "aprovado"].includes(status))) return "approved";
  if (statuses.some((status) => ["rejected", "rejeitada", "rejeitado"].includes(status))) return "rejected";
  return statuses.every((status) => PENDING_LEAD_STATUSES.has(status)) ? "pending" : "other";
}

function leadIsExpired(lead) {
  const expiration = timestampMillis(lead.expiresAt || lead.validThrough);
  return lead.validityStatus === "expired" || Boolean(expiration && expiration <= Date.now());
}

function leadGeoPriority(lead) {
  if (lead.locationScope === "municipality" && lead.region === "extremo_sul_ba") return 0;
  if (lead.locationScope === "municipality" && /^\d{7}$/.test(String(lead.ibgeCode || ""))) return 1;
  if (lead.locationScope === "remote" && lead.countryEligibility === "Brazil") return 2;
  return 3;
}

function leadRegionLabel(lead) {
  if (lead.locationScope === "municipality" && lead.region === "extremo_sul_ba") {
    return "Extremo Sul da Bahia";
  }
  if (lead.locationScope === "municipality" && lead.ibgeCode) return "Município validado pelo IBGE";
  if (lead.locationScope === "remote") {
    return lead.countryEligibility === "Brazil" ? "Remoto elegível no Brasil" : "Remoto";
  }
  if (lead.locationScope === "statewide_ba") return "Bahia";
  return "Local não confirmado";
}

function leadSource(lead) {
  const source = lead.source && typeof lead.source === "object" ? lead.source : {};
  const sourceUrl = lead.sourceUrl || source.url || "";
  const attributionUrl = lead.attributionUrl || source.attributionUrl || lead.termsUrl || source.termsUrl || "";
  const sourceName = lead.sourceName || source.name || lead.sourceId || source.id || "Fonte não informada";
  return {
    sourceName,
    sourceUrl: safeExternalUrl(sourceUrl),
    attributionUrl: safeExternalUrl(attributionUrl),
  };
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function leadDraft(lead) {
  const draft = lead.reviewDraft && typeof lead.reviewDraft === "object" ? lead.reviewDraft : {};
  const field = (name, fallback = "") => draft[name] ?? lead[name] ?? fallback;
  const salary = lead.salaryLabel ?? lead.salary ?? "";
  const benefits = field("benefits", []);
  return {
    companyName: field("companyName"),
    title: field("title"),
    city: field("city", lead.locationLabel || ""),
    category: field("category", "Serviços Gerais"),
    salaryLabel: draft.salaryLabel ?? salary ?? "A combinar",
    contract: field("contract"),
    modality: field("modality"),
    level: field("level", "Júnior"),
    whatsapp: field("whatsapp"),
    description: field("description"),
    requirements: field("requirements"),
    benefits: Array.isArray(benefits) ? benefits.join(", ") : benefits,
    logoUrl: field("logoUrl"),
  };
}

function leadReadyToApprove(lead) {
  if (leadReviewState(lead) !== "pending" || leadIsExpired(lead) || lead.availability === "unavailable") {
    return false;
  }
  const draft = leadDraft(lead);
  const source = leadSource(lead);
  return Boolean(
    draft.companyName
      && draft.title
      && draft.city
      && draft.contract
      && draft.modality
      && draft.whatsapp
      && draft.description
      && draft.requirements
      && source.sourceUrl
      && (lead.sourceId || lead.source?.id)
      && (lead.sourceName || lead.source?.name),
  );
}

function visibleAutomatedLeads() {
  const status = leadStatusFilter.value;
  const query = normalize(leadSearch.value);
  return allAutomatedLeads
    .filter((lead) => {
      const state = leadReviewState(lead);
      const statusMatches = status === "all"
        || (status === "pending" && state === "pending")
        || (status === "approved" && state === "approved")
        || (status === "rejected" && state === "rejected")
        || (status === "expired" && leadIsExpired(lead));
      const haystack = normalize([
        lead.title,
        lead.companyName,
        lead.city,
        lead.locationLabel,
        lead.sourceName,
        lead.source?.name,
      ].join(" "));
      return statusMatches && (!query || haystack.includes(query));
    })
    .sort((left, right) => (
      Number(leadReviewState(left) !== "pending") - Number(leadReviewState(right) !== "pending")
      || leadGeoPriority(left) - leadGeoPriority(right)
      || timestampMillis(right.createdAt) - timestampMillis(left.createdAt)
    ));
}

function renderAutomatedLeads() {
  pendingLeadCount.textContent = String(
    allAutomatedLeads.filter((lead) => leadReviewState(lead) === "pending").length,
  );
  const leads = visibleAutomatedLeads();
  if (!leads.length) {
    automatedLeadList.innerHTML = '<div class="empty-state">Nenhum lead encontrado com os filtros atuais.</div>';
    return;
  }

  automatedLeadList.innerHTML = leads.map((lead) => {
    const state = leadReviewState(lead);
    const expired = leadIsExpired(lead);
    const source = leadSource(lead);
    const location = lead.locationLabel || lead.city || "Local não informado";
    const validity = expired ? "Expirada" : (lead.validityStatus || "Não verificada");
    const availability = lead.availability || "unknown";
    const sourceLink = source.sourceUrl
      ? `<a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">Abrir vaga na fonte</a>`
      : "";
    const attributionLink = source.attributionUrl
      ? `<a href="${escapeHtml(source.attributionUrl)}" target="_blank" rel="noopener noreferrer">Atribuição / termos</a>`
      : "";
    const statusClass = state === "approved" ? "green" : state === "pending" ? "blue" : "";
    const canApprove = leadReadyToApprove(lead);
    const actions = state === "pending"
      ? `
        <button class="primary-button" type="button" data-lead-action="approve" data-id="${escapeHtml(lead.id)}" ${canApprove ? "" : "disabled"}>
          Aprovar e publicar
        </button>
        <button class="secondary-button" type="button" data-lead-action="edit" data-id="${escapeHtml(lead.id)}">Editar campos</button>
        <button class="danger-button" type="button" data-lead-action="reject" data-id="${escapeHtml(lead.id)}">Rejeitar</button>
      `
      : lead.jobId
        ? `<span class="lead-job-reference">Publicado: ${escapeHtml(lead.jobId)}</span>`
        : "";

    return `
      <article class="admin-card automated-lead-card">
        <div class="admin-card-header">
          <span class="tag ${statusClass}">${state === "pending" ? "Pendente de revisão" : state === "approved" ? "Aprovado" : state === "rejected" ? "Rejeitado" : "Status não reconhecido"}</span>
          <span class="tag ${expired ? "" : "green"}">Validade: ${escapeHtml(validity)}</span>
          <span class="tag ${availability === "available" ? "green" : ""}">Disponibilidade: ${escapeHtml(availability)}</span>
          <span class="tag blue">${escapeHtml(leadRegionLabel(lead))}</span>
        </div>
        <div>
          <h3>${escapeHtml(lead.title || "Vaga sem título")}</h3>
          <p><strong>${escapeHtml(lead.companyName || "Empresa não informada")}</strong> · ${escapeHtml(location)} · ${escapeHtml(lead.modality || "Modalidade não informada")}</p>
        </div>
        <p>${escapeHtml(lead.description || "Descrição não informada.")}</p>
        <div class="lead-source-details">
          <span><strong>Fonte:</strong> ${escapeHtml(source.sourceName)}</span>
          ${sourceLink}
          ${attributionLink}
          <span><strong>Válida até:</strong> ${escapeHtml(formatLeadDate(lead.expiresAt || lead.validThrough))}</span>
        </div>
        ${lead.rejectionReason ? `<p><strong>Motivo da rejeição:</strong> ${escapeHtml(lead.rejectionReason)}</p>` : ""}
        ${state === "pending" && !canApprove
          ? `<p class="lead-completion-note">${expired ? "A validade desta vaga expirou." : availability === "unavailable" ? "A fonte marcou esta vaga como indisponível." : "Complete os campos obrigatórios e confirme os dados antes de publicar."}</p>`
          : ""}
        <div class="admin-actions">${actions}</div>
      </article>
    `;
  }).join("");
}

async function loadAutomatedLeads() {
  const { db, firestoreSdk } = services;
  const leads = firestoreSdk.collection(db, "automatedJobLeads");
  unsubscribeAutomatedLeads = firestoreSdk.onSnapshot(leads, (snapshot) => {
    allAutomatedLeads = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    renderAutomatedLeads();
  }, (error) => {
    automatedLeadList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Não foi possível carregar os leads.")}</div>`;
  });
}

async function loadCompanies() {
  companyList.innerHTML = '<div class="empty-state">Carregando empresas...</div>';
  try {
    const result = await firebaseApi.callFunction("listCompaniesForAdmin");
    allCompanies = Array.isArray(result.companies) ? result.companies : [];
    companyListNote.hidden = !result.hasMore;
    companyListNote.textContent = result.hasMore
      ? "Exibindo as primeiras 200 empresas. A listagem será paginada em uma etapa futura."
      : "";
    renderCompanies();
  } catch (error) {
    companyList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Não foi possível carregar as empresas.")}</div>`;
  }
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

function setAdminView(view) {
  const activeView = ["jobs", "leads", "companies"].includes(view) ? view : "jobs";
  const tabPanels = [
    [jobsTab, jobsPanel, "jobs"],
    [automatedLeadsTab, automatedLeadsPanel, "leads"],
    [companiesTab, companiesPanel, "companies"],
  ];
  for (const [tab, panel, name] of tabPanels) {
    const active = activeView === name;
    panel.hidden = !active;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
}

function openAutomatedLeadDialog(leadId) {
  const lead = allAutomatedLeads.find((item) => item.id === leadId);
  if (!lead || leadReviewState(lead) !== "pending") return;
  const draft = leadDraft(lead);
  automatedLeadForm.reset();
  automatedLeadForm.elements.leadId.value = lead.id;
  Object.entries(draft).forEach(([field, value]) => {
    automatedLeadForm.elements[field].value = value ?? "";
  });

  const source = leadSource(lead);
  const sourceLink = source.sourceUrl
    ? `<a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">Abrir vaga original</a>`
    : "";
  const attributionLink = source.attributionUrl
    ? `<a href="${escapeHtml(source.attributionUrl)}" target="_blank" rel="noopener noreferrer">Atribuição e termos</a>`
    : "";
  leadDialogSource.innerHTML = `
    <strong>Fonte: ${escapeHtml(source.sourceName)}</strong>
    <span>${sourceLink}${attributionLink ? ` · ${attributionLink}` : ""}</span>
    <span>Localidade normalizada: ${escapeHtml(lead.locationLabel || lead.city || "Não confirmada")}</span>
  `;
  automatedLeadDialog.showModal();
}

function collectAutomatedLeadEdits() {
  const formData = new FormData(automatedLeadForm);
  return {
    companyName: String(formData.get("companyName") || "").trim(),
    title: String(formData.get("title") || "").trim(),
    city: String(formData.get("city") || "").trim(),
    category: String(formData.get("category") || "").trim(),
    salaryLabel: String(formData.get("salaryLabel") || "").trim(),
    contract: String(formData.get("contract") || "").trim(),
    modality: String(formData.get("modality") || "").trim(),
    level: String(formData.get("level") || "").trim(),
    whatsapp: String(formData.get("whatsapp") || "").replace(/\D/g, ""),
    description: String(formData.get("description") || "").trim(),
    requirements: String(formData.get("requirements") || "").trim(),
    benefits: String(formData.get("benefits") || "").trim(),
    logoUrl: String(formData.get("logoUrl") || "").trim(),
  };
}

automatedLeadList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-lead-action]");
  if (!button) return;
  const lead = allAutomatedLeads.find((item) => item.id === button.dataset.id);
  if (!lead) return;

  if (button.dataset.leadAction === "edit") {
    openAutomatedLeadDialog(lead.id);
    return;
  }

  const action = button.dataset.leadAction;
  let reason = "";
  if (action === "approve" && !window.confirm(`Aprovar e publicar “${lead.title || "esta vaga"}” no site?`)) {
    return;
  }
  if (action === "reject") {
    reason = window.prompt("Motivo da rejeição (opcional):");
    if (reason === null) return;
  }

  button.disabled = true;
  try {
    const result = await firebaseApi.callFunction("reviewAutomatedJobLead", {
      leadId: lead.id,
      action,
      reason,
    });
    if (action === "approve") {
      window.alert(result.alreadyProcessed
        ? `Esta vaga já foi publicada (${result.jobId}).`
        : `Vaga aprovada e publicada (${result.jobId}).`);
    } else {
      window.alert("Lead rejeitado. Nenhuma vaga foi publicada.");
    }
  } catch (error) {
    window.alert(error.message || "Não foi possível concluir a triagem.");
  } finally {
    button.disabled = false;
  }
});

companyList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-company-verification]");
  if (!button) return;
  const verified = button.dataset.companyVerification === "true";
  const company = allCompanies.find((item) => item.id === button.dataset.companyId);
  if (!company) return;

  const companyName = company.name || company.tradeName || company.email || company.id;
  const prompt = verified
    ? `Verificar ${companyName} e ativar publicação automática para vagas limpas?`
    : `Remover a verificação de ${companyName} e desativar a empresa?`;
  if (!window.confirm(prompt)) return;

  button.disabled = true;
  try {
    await firebaseApi.callFunction("setCompanyVerification", {
      companyId: company.id,
      verified,
    });
    await loadCompanies();
  } catch (error) {
    window.alert(error.message || "Não foi possível atualizar a verificação da empresa.");
  } finally {
    button.disabled = false;
  }
});

automatedLeadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitAction = event.submitter?.dataset.leadSubmit || "save";
  const leadId = automatedLeadForm.elements.leadId.value;
  if (submitAction === "approve" && !window.confirm("Salvar as edições, aprovar e publicar esta vaga no site?")) {
    return;
  }

  const submitter = event.submitter;
  if (submitter) submitter.disabled = true;
  try {
    const result = await firebaseApi.callFunction("reviewAutomatedJobLead", {
      leadId,
      action: submitAction,
      edits: collectAutomatedLeadEdits(),
    });
    automatedLeadDialog.close();
    window.alert(submitAction === "approve"
      ? result.alreadyProcessed
        ? `Esta vaga já foi publicada (${result.jobId}).`
        : `Edições salvas e vaga publicada (${result.jobId}).`
      : "Edições salvas no lead. A vaga ainda não foi publicada.");
  } catch (error) {
    window.alert(error.message || "Não foi possível salvar as alterações do lead.");
  } finally {
    if (submitter) submitter.disabled = false;
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

[leadStatusFilter, leadSearch].forEach((field) => {
  field.addEventListener("input", renderAutomatedLeads);
  field.addEventListener("change", renderAutomatedLeads);
});

companySearch.addEventListener("input", renderCompanies);

adminTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-admin-view]");
  if (button) setAdminView(button.dataset.adminView);
});

newJobButton.addEventListener("click", openCreateDialog);

editDialog.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-dialog]")) editDialog.close();
});

automatedLeadDialog.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-dialog]")) automatedLeadDialog.close();
});

window.addEventListener("beforeunload", () => {
  if (unsubscribeJobs) unsubscribeJobs();
  if (unsubscribeAutomatedLeads) unsubscribeAutomatedLeads();
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
    adminTabs.hidden = false;
    adminToolbar.hidden = false;
    currentAdminUser = user;
    loadJobs();
    loadAutomatedLeads();
    loadCompanies();
  });
}

init();
