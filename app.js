const jobs = [
  {
    title: "Desenvolvedor(a) Front-end",
    company: "Sunflower Tech",
    city: "Teixeira de Freitas",
    state: "BA",
    time: "Publicado há 2 horas",
    category: "TI",
    contract: "Freelancer",
    mode: "Presencial",
    level: "Pleno",
    salary: 6500,
    benefits: ["Home Office", "Horário Flexível"],
    tags: ["Destaque", "Presencial"],
    mark: "light",
  },
  {
    title: "Designer Gráfico",
    company: "Agência Girassol",
    city: "Remoto",
    state: "",
    time: "Publicado há 5 horas",
    category: "Marketing",
    contract: "Freelancer",
    mode: "Remoto",
    level: "Júnior",
    salary: 3200,
    benefits: ["Home Office"],
    tags: ["Remoto", "Freelancer"],
    mark: "dark",
  },
  {
    title: "Assistente Administrativo",
    company: "Comércio Bom Preço",
    city: "Eunápolis",
    state: "BA",
    time: "Publicado há 1 dia",
    category: "Administração",
    contract: "CLT",
    mode: "Presencial",
    level: "Júnior",
    salary: 2100,
    benefits: ["Vale Alimentação", "Vale Transporte"],
    tags: ["Presencial"],
    mark: "light",
  },
  {
    title: "Analista de Marketing",
    company: "Sunflower Marketing",
    city: "Teixeira de Freitas",
    state: "BA",
    time: "Publicado há 1 dia",
    category: "Marketing",
    contract: "CLT",
    mode: "Híbrido",
    level: "Pleno",
    salary: 4300,
    benefits: ["Vale Alimentação", "Plano de Saúde", "Home Office"],
    tags: ["Híbrido", "CLT"],
    mark: "dark",
  },
  {
    title: "Técnico em Enfermagem",
    company: "Clínica Vida Sul",
    city: "Nova Viçosa",
    state: "BA",
    time: "Publicado há 2 dias",
    category: "Saúde",
    contract: "CLT",
    mode: "Presencial",
    level: "Júnior",
    salary: 2800,
    benefits: ["Vale Transporte", "Plano de Saúde"],
    tags: ["Presencial", "CLT"],
    mark: "light",
  },
];

const state = {
  advancedOpen: false,
};

const keywordInput = document.querySelector("#keywordInput");
const categorySelect = document.querySelector("#categorySelect");
const citySelect = document.querySelector("#citySelect");
const sideCitySelect = document.querySelector("#sideCitySelect");
const sortSelect = document.querySelector("#sortSelect");
const searchForm = document.querySelector("#searchForm");
const advancedToggle = document.querySelector("#advancedToggle");
const advancedSearch = document.querySelector("#advancedSearch");
const clearFilters = document.querySelector("#clearFilters");
const applyFilters = document.querySelector("#applyFilters");
const jobList = document.querySelector("#jobList");

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function checkedValues(selector) {
  return [...document.querySelectorAll(`${selector}:checked`)].map((input) => input.value);
}

function hasAnyValue(values, current) {
  return !values.length || values.includes(current);
}

function hasAnyBenefit(values, benefits) {
  return !values.length || values.some((value) => benefits.includes(value));
}

function tagClass(tag) {
  const value = normalize(tag);
  if (value.includes("remoto")) return "remote";
  if (value.includes("clt") || value.includes("freelancer")) return "green";
  if (value.includes("hibrido")) return "blue";
  return "";
}

function getFilteredJobs() {
  const keyword = normalize(keywordInput.value);
  const category = categorySelect.value;
  const city = citySelect.value || sideCitySelect.value;
  const contracts = checkedValues("[data-filter='contract']");
  const modes = checkedValues("[data-filter='mode']");
  const levels = checkedValues("[data-filter='level']");
  const benefits = checkedValues("[data-filter='benefits']");

  const advancedContracts = checkedValues("[name='contract']");
  const advancedModes = checkedValues("[name='mode']");
  const advancedLevels = checkedValues("[name='level']");
  const minSalary = Number(document.querySelector("#salaryMin").value || 0);
  const maxSalary = Number(document.querySelector("#salaryMax").value || 999999);

  let filtered = jobs.filter((job) => {
    const haystack = normalize(`${job.title} ${job.company} ${job.city} ${job.category}`);
    const matchesKeyword = !keyword || haystack.includes(keyword);
    const matchesCategory = !category || job.category === category;
    const matchesCity = !city || job.city === city;
    const matchesContracts = hasAnyValue([...contracts, ...advancedContracts], job.contract);
    const matchesModes = hasAnyValue([...modes, ...advancedModes], job.mode);
    const matchesLevels = hasAnyValue([...levels, ...advancedLevels], job.level);
    const matchesBenefits = hasAnyBenefit(benefits, job.benefits);
    const matchesSalary = job.salary >= minSalary && job.salary <= maxSalary;

    return (
      matchesKeyword &&
      matchesCategory &&
      matchesCity &&
      matchesContracts &&
      matchesModes &&
      matchesLevels &&
      matchesBenefits &&
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
    .map(
      (job) => `
        <article class="job-card">
          <div class="company-mark ${job.mark === "dark" ? "dark" : ""}">
            <img src="./assets/sunflower-logo.svg" alt="" />
          </div>
          <div>
            <div class="job-tags">
              ${job.tags.map((tag) => `<span class="tag ${tagClass(tag)}">${tag}</span>`).join("")}
            </div>
            <h3>${job.title}</h3>
            <p>${job.company}</p>
            <div class="job-meta">
              <span>${job.city}${job.state ? `, ${job.state}` : ""}</span>
              <span>${job.time}</span>
            </div>
          </div>
          <div class="job-actions">
            <a class="details-button" href="https://wa.me/5500000000000?text=Tenho%20interesse%20na%20vaga%20${encodeURIComponent(
              job.title,
            )}" target="_blank" rel="noreferrer">Ver Detalhes</a>
            <button class="save-button" type="button" aria-label="Salvar vaga">□</button>
          </div>
        </article>
      `,
    )
    .join("");
}

function syncCityFilters(source) {
  if (source === "top") {
    sideCitySelect.value = citySelect.value;
  } else {
    citySelect.value = sideCitySelect.value;
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  renderJobs();
  document.querySelector("#vagas").scrollIntoView({ behavior: "smooth", block: "start" });
});

advancedToggle.addEventListener("click", () => {
  state.advancedOpen = !state.advancedOpen;
  advancedSearch.hidden = !state.advancedOpen;
  advancedToggle.setAttribute("aria-expanded", String(state.advancedOpen));
});

[keywordInput, categorySelect, sortSelect].forEach((field) => field.addEventListener("input", renderJobs));

citySelect.addEventListener("input", () => {
  syncCityFilters("top");
  renderJobs();
});

sideCitySelect.addEventListener("input", () => {
  syncCityFilters("side");
  renderJobs();
});

[...document.querySelectorAll("input[type='checkbox'], #salaryMin, #salaryMax")].forEach((field) => {
  field.addEventListener("input", renderJobs);
});

applyFilters.addEventListener("click", renderJobs);

clearFilters.addEventListener("click", () => {
  document.querySelectorAll(".filter-panel input[type='checkbox']").forEach((input) => {
    input.checked = false;
  });
  sideCitySelect.value = "";
  citySelect.value = "";
  renderJobs();
});

renderJobs();
