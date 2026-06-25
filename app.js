const demoJobs = [
  {
    id: "demo-front-end",
    title: "Desenvolvedor(a) Front-end",
    companyName: "Sunflower Tech",
    city: "Teixeira de Freitas",
    state: "BA",
    category: "TI",
    contract: "Freelancer",
    modality: "Presencial",
    level: "Pleno",
    salary: 6500,
    salaryLabel: "R$ 6.500",
    benefits: ["Home Office", "Horário Flexível"],
    requirements: "Experiência com HTML, CSS, JavaScript e criação de interfaces responsivas.",
    description: "Atuar no desenvolvimento de páginas, melhorias visuais e interfaces para empresas locais.",
    whatsapp: "5527988492573",
    publishedAtLabel: "Publicado há 2 horas",
    tags: ["Destaque", "Presencial"],
    mark: "light",
    status: "aprovada",
  },
  {
    id: "demo-designer",
    title: "Designer Gráfico",
    companyName: "Agência Girassol",
    city: "Itabatã",
    state: "BA",
    category: "Marketing",
    contract: "Freelancer",
    modality: "Remoto",
    level: "Júnior",
    salary: 3200,
    salaryLabel: "R$ 3.200",
    benefits: ["Home Office"],
    requirements: "Portfólio com peças para redes sociais e domínio básico de ferramentas de design.",
    description: "Criação de artes para Instagram, campanhas locais e materiais promocionais.",
    whatsapp: "5527988492573",
    publishedAtLabel: "Publicado há 5 horas",
    tags: ["Remoto", "Freelancer"],
    mark: "dark",
    status: "aprovada",
  },
  {
    id: "demo-assistente",
    title: "Assistente Administrativo",
    companyName: "Comércio Bom Preço",
    city: "Eunápolis",
    state: "BA",
    category: "Administração",
    contract: "CLT",
    modality: "Presencial",
    level: "Júnior",
    salary: 2100,
    salaryLabel: "R$ 2.100",
    benefits: ["Vale Alimentação", "Vale Transporte"],
    requirements: "Boa comunicação, organização e conhecimento básico de planilhas.",
    description: "Apoio em atendimento, emissão de documentos, organização de rotina e suporte financeiro.",
    whatsapp: "5527988492573",
    publishedAtLabel: "Publicado há 1 dia",
    tags: ["Presencial"],
    mark: "light",
    status: "aprovada",
  },
  {
    id: "demo-marketing",
    title: "Analista de Marketing",
    companyName: "Sunflower Marketing",
    city: "Teixeira de Freitas",
    state: "BA",
    category: "Marketing",
    contract: "CLT",
    modality: "Híbrido",
    level: "Pleno",
    salary: 4300,
    salaryLabel: "R$ 4.300",
    benefits: ["Vale Alimentação", "Plano de Saúde", "Home Office"],
    requirements: "Experiência com tráfego pago, conteúdo e análise de métricas.",
    description: "Planejamento de campanhas, gestão de conteúdo e acompanhamento de resultados para clientes regionais.",
    whatsapp: "5527988492573",
    publishedAtLabel: "Publicado há 1 dia",
    tags: ["Híbrido", "CLT"],
    mark: "dark",
    status: "aprovada",
  },
  {
    id: "demo-enfermagem",
    title: "Técnico em Enfermagem",
    companyName: "Clínica Vida Sul",
    city: "Nova Viçosa",
    state: "BA",
    category: "Saúde",
    contract: "CLT",
    modality: "Presencial",
    level: "Júnior",
    salary: 2800,
    salaryLabel: "R$ 2.800",
    benefits: ["Vale Transporte", "Plano de Saúde"],
    requirements: "Curso técnico completo, COREN ativo e disponibilidade para escala.",
    description: "Atendimento aos pacientes, apoio em procedimentos e organização de materiais clínicos.",
    whatsapp: "5527988492573",
    publishedAtLabel: "Publicado há 2 dias",
    tags: ["Presencial", "CLT"],
    mark: "light",
    status: "aprovada",
  },
];

let jobs = demoJobs;
let currentUser = null;
let currentProfile = null;
let savedJobIds = new Set();
let firebaseApi = null;
let unsubscribeJobs = null;
let unsubscribeSaved = null;

const keywordInput = document.querySelector("#keywordInput");
const categorySelect = document.querySelector("#categorySelect");
const citySelect = document.querySelector("#citySelect");
const sortSelect = document.querySelector("#sortSelect");
const searchForm = document.querySelector("#searchForm");
const advancedToggle = document.querySelector("#advancedToggle");
const advancedSearch = document.querySelector("#advancedSearch");
const clearFilters = document.querySelector("#clearFilters");
const applyFilters = document.querySelector("#applyFilters");
const jobList = document.querySelector("#jobList");
const detailsDialog = document.querySelector("#jobDetailsDialog");
const detailsBody = document.querySelector("#jobDetailsBody");
const loginDialog = document.querySelector("#loginRequiredDialog");

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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

function escapeAttr(value) {
  return escapeHtml(value);
}

function safeLogoUrl(value) {
  const url = String(value || "");
  if (url.startsWith("https://") || url.startsWith("http://") || url.startsWith("./assets/")) return url;
  return "./assets/sunflower-logo.svg";
}

function currencyValue(value) {
  return Number(value || 0);
}

function checkedValues(selector) {
  return [...document.querySelectorAll(`${selector}:checked`)].map((input) => input.value);
}

function hasAnyValue(values, current) {
  return !values.length || values.includes(current);
}

function hasAnyBenefit(values, benefits = []) {
  return !values.length || values.some((value) => benefits.includes(value));
}

function tagClass(tag) {
  const value = normalize(tag);
  if (value.includes("remoto")) return "remote";
  if (value.includes("clt") || value.includes("freelancer")) return "green";
  if (value.includes("hibrido")) return "blue";
  return "";
}

function formatJob(rawJob) {
  const companyName = rawJob.companyName || rawJob.company || "Empresa não informada";
  const modality = rawJob.modality || rawJob.mode || "Presencial";
  const salary = currencyValue(rawJob.salary);
  const city = rawJob.city || "Extremo Sul da Bahia";

  return {
    id: rawJob.id,
    title: rawJob.title || rawJob.cargo || "Vaga sem título",
    companyName,
    city,
    state: rawJob.state || "BA",
    category: rawJob.category || "Serviços Gerais",
    contract: rawJob.contract || "CLT",
    modality,
    level: rawJob.level || "Júnior",
    salary,
    salaryLabel: rawJob.salaryLabel || (salary ? salary.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "A combinar"),
    benefits: Array.isArray(rawJob.benefits) ? rawJob.benefits : String(rawJob.benefits || "").split(",").map((item) => item.trim()).filter(Boolean),
    requirements: rawJob.requirements || "Requisitos não informados.",
    description: rawJob.description || "Descrição não informada.",
    whatsapp: rawJob.whatsapp || window.GIRASSOL_CONTACTS?.whatsapp || "5527988492573",
    publishedAtLabel: rawJob.publishedAtLabel || "Publicado recentemente",
    tags: rawJob.tags || [modality, rawJob.contract || "Vaga"],
    mark: rawJob.mark || "light",
    logoUrl: rawJob.logoUrl || "./assets/sunflower-logo.svg",
    status: rawJob.status || "aprovada",
  };
}

function getFilteredJobs() {
  const keyword = normalize(keywordInput.value);
  const category = categorySelect.value;
  const city = citySelect.value;
  const advancedContracts = checkedValues("[name='contract']");
  const advancedModes = checkedValues("[name='modality']");
  const advancedLevels = checkedValues("[name='level']");
  const benefits = checkedValues("[data-filter='benefits']");
  const featuredOnly = document.querySelector("[data-filter='featured']")?.checked;
  const withSalaryOnly = document.querySelector("[data-filter='withSalary']")?.checked;
  const minSalary = Number(document.querySelector("#salaryMin").value || 0);
  const maxSalary = Number(document.querySelector("#salaryMax").value || 999999);

  let filtered = jobs.map(formatJob).filter((job) => {
    const haystack = normalize(`${job.title} ${job.companyName} ${job.city} ${job.category}`);
    const matchesKeyword = !keyword || haystack.includes(keyword);
    const matchesCategory = !category || job.category === category;
    const matchesCity = !city || job.city === city;
    const matchesContracts = hasAnyValue(advancedContracts, job.contract);
    const matchesModes = hasAnyValue(advancedModes, job.modality);
    const matchesLevels = hasAnyValue(advancedLevels, job.level);
    const matchesBenefits = hasAnyBenefit(benefits, job.benefits);
    const matchesFeatured = !featuredOnly || job.tags.includes("Destaque");
    const matchesSalaryPresence = !withSalaryOnly || job.salary > 0;
    const matchesSalary = job.salary === 0 || (job.salary >= minSalary && job.salary <= maxSalary);

    return (
      matchesKeyword &&
      matchesCategory &&
      matchesCity &&
      matchesContracts &&
      matchesModes &&
      matchesLevels &&
      matchesBenefits &&
      matchesFeatured &&
      matchesSalaryPresence &&
      matchesSalary
    );
  });

  if (sortSelect.value === "salario") {
    filtered = filtered.sort((a, b) => b.salary - a.salary);
  }

  if (sortSelect.value === "destaque") {
    filtered = filtered.sort((a, b) => Number(b.tags.includes("Destaque")) - Number(a.tags.includes("Destaque")));
  }

  return filtered;
}

function renderJobs() {
  const filtered = getFilteredJobs();

  if (!filtered.length) {
    jobList.innerHTML = '<div class="empty-state">Nenhuma vaga encontrada com esses filtros.</div>';
    return;
  }

  jobList.innerHTML = filtered
    .map((job) => {
      const isSaved = savedJobIds.has(job.id);
      const jobId = escapeAttr(job.id);
      const tags = job.tags.map((tag) => `<span class="tag ${tagClass(tag)}">${escapeHtml(tag)}</span>`).join("");
      return `
        <article class="job-card">
          <div class="company-mark ${job.mark === "dark" ? "dark" : ""}">
            <img src="${escapeAttr(safeLogoUrl(job.logoUrl))}" alt="" />
          </div>
          <div>
            <div class="job-tags">
              ${tags}
            </div>
            <h3>${escapeHtml(job.title)}</h3>
            <p>${escapeHtml(job.companyName)}</p>
            <div class="job-meta">
              <span class="meta-item">${escapeHtml(job.city)}${job.state ? `, ${escapeHtml(job.state)}` : ""}</span>
              <span class="meta-item">${escapeHtml(job.publishedAtLabel)}</span>
            </div>
          </div>
          <div class="job-actions">
            <button class="details-button" type="button" data-action="details" data-job-id="${jobId}">Ver Detalhes</button>
            <button
              class="save-button ${isSaved ? "is-saved" : ""}"
              type="button"
              data-action="save"
              data-job-id="${jobId}"
              aria-label="${isSaved ? "Remover vaga salva" : "Salvar vaga"}"
            ></button>
          </div>
        </article>
      `;
    })
    .join("");
}

function showDetails(jobId) {
  const job = jobs.map(formatJob).find((item) => item.id === jobId);
  if (!job) return;

  const whatsappText = encodeURIComponent(`Olá! Tenho interesse na vaga ${job.title} da empresa ${job.companyName}.`);
  const whatsapp = String(job.whatsapp || "").replace(/\D/g, "") || "5527988492573";
  const statusLabel = job.status === "aprovada" ? "Vaga aprovada" : job.status;
  detailsBody.innerHTML = `
    <div class="details-header">
      <div class="company-mark ${job.mark === "dark" ? "dark" : ""}">
        <img src="${escapeAttr(safeLogoUrl(job.logoUrl))}" alt="" />
      </div>
      <div>
        <span class="tag">${escapeHtml(statusLabel)}</span>
        <h2>${escapeHtml(job.title)}</h2>
        <p>${escapeHtml(job.companyName)}</p>
      </div>
    </div>
    <dl class="details-grid">
      <div><dt>Cidade</dt><dd>${escapeHtml(job.city)}${job.state ? `, ${escapeHtml(job.state)}` : ""}</dd></div>
      <div><dt>Salário</dt><dd>${escapeHtml(job.salaryLabel)}</dd></div>
      <div><dt>Contrato</dt><dd>${escapeHtml(job.contract)}</dd></div>
      <div><dt>Modalidade</dt><dd>${escapeHtml(job.modality)}</dd></div>
      <div><dt>Nível</dt><dd>${escapeHtml(job.level)}</dd></div>
      <div><dt>Publicação</dt><dd>${escapeHtml(job.publishedAtLabel)}</dd></div>
    </dl>
    <section>
      <h3>Descrição</h3>
      <p>${escapeHtml(job.description)}</p>
    </section>
    <section>
      <h3>Requisitos</h3>
      <p>${escapeHtml(job.requirements)}</p>
    </section>
    <section>
      <h3>Benefícios</h3>
      <p>${job.benefits.length ? escapeHtml(job.benefits.join(", ")) : "Não informado"}</p>
    </section>
    <div class="details-actions">
      <a class="primary-button" href="https://wa.me/${whatsapp}?text=${whatsappText}" target="_blank" rel="noreferrer">
        Candidatar-se pelo WhatsApp
      </a>
    </div>
  `;

  detailsDialog.showModal();
}

function showLoginRequired() {
  loginDialog.showModal();
}

async function toggleSave(jobId) {
  if (!firebaseApi || !currentUser) {
    showLoginRequired();
    return;
  }

  try {
    if (savedJobIds.has(jobId)) {
      await firebaseApi.unsaveJob(currentUser.uid, jobId);
      savedJobIds.delete(jobId);
    } else {
      await firebaseApi.saveJob(currentUser.uid, jobId);
      savedJobIds.add(jobId);
    }
    renderJobs();
  } catch (error) {
    alert(error.message || "Não foi possível salvar a vaga agora.");
  }
}

function closeDialogOnClick(event) {
  if (event.target.matches("[data-close-dialog]")) {
    event.target.closest("dialog")?.close();
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  renderJobs();
  document.querySelector("#vagas").scrollIntoView({ behavior: "smooth", block: "start" });
});

advancedToggle.addEventListener("click", () => {
  const isOpen = advancedToggle.getAttribute("aria-expanded") === "true";
  advancedSearch.hidden = isOpen;
  advancedToggle.setAttribute("aria-expanded", String(!isOpen));
});

[keywordInput, categorySelect, citySelect, sortSelect].forEach((field) => field.addEventListener("input", renderJobs));

[...document.querySelectorAll("input[type='checkbox'], #salaryMin, #salaryMax")].forEach((field) => {
  field.addEventListener("input", renderJobs);
});

applyFilters.addEventListener("click", renderJobs);

clearFilters.addEventListener("click", () => {
  document.querySelectorAll(".filter-panel input[type='checkbox']").forEach((input) => {
    input.checked = false;
  });
  renderJobs();
});

jobList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  if (button.dataset.action === "details") {
    showDetails(button.dataset.jobId);
  }

  if (button.dataset.action === "save") {
    toggleSave(button.dataset.jobId);
  }
});

detailsDialog.addEventListener("click", closeDialogOnClick);
loginDialog.addEventListener("click", closeDialogOnClick);

async function initFirebase() {
  const module = await import("./js/firebase-client.js");
  firebaseApi = module;

  if (!module.isFirebaseConfigured()) {
    renderJobs();
    return;
  }

  unsubscribeJobs = await module.listenApprovedJobs((remoteJobs) => {
    jobs = remoteJobs.length ? remoteJobs : demoJobs;
    renderJobs();
  });

  await module.onAuth(async (user, profile) => {
    currentUser = user;
    currentProfile = profile;

    if (unsubscribeSaved) unsubscribeSaved();
    savedJobIds = new Set();

    if (user) {
      unsubscribeSaved = await module.listenSavedJobIds(user.uid, (ids) => {
        savedJobIds = ids;
        renderJobs();
      });
    }

    renderJobs();
  });
}

window.addEventListener("beforeunload", () => {
  if (unsubscribeJobs) unsubscribeJobs();
  if (unsubscribeSaved) unsubscribeSaved();
});

renderJobs();
initFirebase().catch(() => renderJobs());
