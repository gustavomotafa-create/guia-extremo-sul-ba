const jobs = [
  {
    title: "Auxiliar Administrativo",
    company: "Mercado Central",
    city: "Posto da Mata",
    type: "CLT",
    mode: "Presencial",
    posted: "Hoje",
    description: "Atendimento, organização de documentos e apoio ao setor financeiro.",
    tags: ["nova", "clt"],
  },
  {
    title: "Atendente de Loja",
    company: "Drogaria Popular",
    city: "Teixeira de Freitas",
    type: "CLT",
    mode: "Presencial",
    posted: "Hoje",
    description: "Vaga para atendimento ao cliente, reposição de produtos e caixa.",
    tags: ["urgente", "clt"],
  },
  {
    title: "Estágio em Marketing",
    company: "Sunflower Solutions",
    city: "Nova Viçosa",
    type: "Estágio",
    mode: "Híbrido",
    posted: "Ontem",
    description: "Apoio em redes sociais, criação de conteúdo e atendimento a clientes locais.",
    tags: ["estagio"],
  },
  {
    title: "Ajudante de Carga e Descarga",
    company: "Transportes Costa Sul",
    city: "Mucuri",
    type: "Diária",
    mode: "Presencial",
    posted: "Ontem",
    description: "Serviço por diária para apoio em entregas na região.",
    tags: ["diaria", "urgente"],
  },
  {
    title: "Vendedor Externo",
    company: "Conecta Fibra",
    city: "Teixeira de Freitas",
    type: "PJ",
    mode: "Rua",
    posted: "2 dias atrás",
    description: "Prospecção de clientes e venda de planos de internet.",
    tags: ["pj"],
  },
];

const services = [
  {
    title: "Fretes e pequenas mudanças",
    city: "Posto da Mata",
    description: "Carretos rápidos para casas, lojas e entregas comerciais.",
    leads: "12 profissionais",
  },
  {
    title: "Manutenção de ar-condicionado",
    city: "Teixeira de Freitas",
    description: "Instalação, limpeza e reparo com atendimento agendado.",
    leads: "8 profissionais",
  },
  {
    title: "Energia solar",
    city: "Nova Viçosa",
    description: "Orçamento para residências, fazendas e comércios.",
    leads: "5 empresas",
  },
  {
    title: "Cursos profissionalizantes",
    city: "Região",
    description: "Capacitação para atendimento, vendas, informática e gestão.",
    leads: "6 opções",
  },
];

const companies = [
  {
    name: "Mercado Central",
    initials: "MC",
    category: "Supermercado",
    city: "Posto da Mata",
    description: "Vagas, ofertas semanais e atendimento para moradores da região.",
  },
  {
    name: "Conecta Fibra",
    initials: "CF",
    category: "Internet",
    city: "Teixeira de Freitas",
    description: "Planos residenciais e empresariais com suporte local.",
  },
  {
    name: "Clínica Vida Sul",
    initials: "VS",
    category: "Saúde",
    city: "Nova Viçosa",
    description: "Especialidades médicas, exames e campanhas de atendimento.",
  },
];

const promotions = [
  {
    title: "Banner de lançamento",
    text: "Espaço reservado para empresas patrocinadas por cidade.",
  },
  {
    title: "Curso em destaque",
    text: "Divulgação de turmas, eventos e capacitações profissionais.",
  },
  {
    title: "Oferta local",
    text: "Promoções com validade, WhatsApp direto e cidade visível.",
  },
];

const jobsList = document.querySelector("#jobsList");
const servicesList = document.querySelector("#servicesList");
const companiesList = document.querySelector("#companiesList");
const promotionsList = document.querySelector("#promotionsList");
const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#searchInput");
const citySelect = document.querySelector("#citySelect");
const typeSelect = document.querySelector("#typeSelect");
const tabs = document.querySelectorAll(".tab");

let activeJobFilter = "todas";

function normalize(value) {
  return value
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getBadge(tags) {
  if (tags.includes("urgente")) return '<span class="badge hot">Urgente</span>';
  if (tags.includes("nova")) return '<span class="badge">Nova</span>';
  return '<span class="badge">Verificada</span>';
}

function renderJobs(items = jobs) {
  const query = normalize(searchInput.value.trim());
  const city = normalize(citySelect.value);
  const selectedType = normalize(typeSelect.value);

  const filtered = items.filter((job) => {
    const haystack = normalize(`${job.title} ${job.company} ${job.city} ${job.type} ${job.description}`);
    const matchesQuery = !query || haystack.includes(query);
    const matchesCity = !city || normalize(job.city).includes(city);
    const matchesSearchType = !selectedType || selectedType === "vagas";
    const matchesTab = activeJobFilter === "todas" || job.tags.includes(activeJobFilter);

    return matchesQuery && matchesCity && matchesSearchType && matchesTab;
  });

  if (!filtered.length) {
    jobsList.innerHTML = '<div class="empty-state">Nenhuma vaga encontrada com esses filtros.</div>';
    return;
  }

  jobsList.innerHTML = filtered
    .map(
      (job) => `
        <article class="job-card">
          <div>
            ${getBadge(job.tags)}
            <h3>${job.title}</h3>
            <div class="job-meta">
              <span>${job.company}</span>
              <span>${job.city}</span>
              <span>${job.type}</span>
              <span>${job.mode}</span>
              <span>${job.posted}</span>
            </div>
            <p>${job.description}</p>
          </div>
          <div class="job-actions">
            <a class="whatsapp-link" href="https://wa.me/5500000000000" target="_blank" rel="noreferrer">
              Candidatar
            </a>
            <a class="details-link" href="#anunciar">Detalhes</a>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderServices() {
  servicesList.innerHTML = services
    .map(
      (service) => `
        <article class="service-card">
          <span class="verified">${service.city}</span>
          <h3>${service.title}</h3>
          <p>${service.description}</p>
          <strong>${service.leads}</strong>
        </article>
      `,
    )
    .join("");
}

function renderCompanies() {
  companiesList.innerHTML = companies
    .map(
      (company) => `
        <article class="company-card">
          <span class="company-logo">${company.initials}</span>
          <h3>${company.name}</h3>
          <div class="card-meta">
            <span>${company.category}</span>
            <span>${company.city}</span>
            <span>Verificada</span>
          </div>
          <p>${company.description}</p>
        </article>
      `,
    )
    .join("");
}

function renderPromotions() {
  promotionsList.innerHTML = promotions
    .map(
      (promotion) => `
        <article class="promo-card">
          <strong>${promotion.title}</strong>
          <span>${promotion.text}</span>
        </article>
      `,
    )
    .join("");
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((item) => item.classList.remove("is-active"));
    tab.classList.add("is-active");
    activeJobFilter = tab.dataset.filter;
    renderJobs();
  });
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  renderJobs();
  document.querySelector("#vagas").scrollIntoView({ behavior: "smooth", block: "start" });
});

[searchInput, citySelect, typeSelect].forEach((field) => {
  field.addEventListener("input", renderJobs);
});

renderJobs();
renderServices();
renderCompanies();
renderPromotions();
