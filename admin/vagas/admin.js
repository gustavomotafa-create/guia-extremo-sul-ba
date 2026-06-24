const adminList = document.querySelector("#adminList");

const sampleJobs = [
  {
    id: "sample-1",
    company: "Mercado Girassol",
    title: "Operador(a) de Caixa",
    salary: "R$ 1.650",
    city: "Posto da Mata",
    whatsapp: "73999999999",
    contract: "CLT",
    status: "Pendente",
    description: "Atendimento ao cliente, abertura e fechamento de caixa.",
    benefits: "Vale Transporte, Vale Alimentação",
  },
];

function readPendingJobs() {
  const saved = localStorage.getItem("girassolPendingJobs");
  return saved ? JSON.parse(saved) : sampleJobs;
}

function savePendingJobs(jobs) {
  localStorage.setItem("girassolPendingJobs", JSON.stringify(jobs));
}

function updateStatus(id, status) {
  const jobs = readPendingJobs().map((job) => (job.id === id ? { ...job, status } : job));
  savePendingJobs(jobs);
  renderJobs();
}

function removeJob(id) {
  const jobs = readPendingJobs().filter((job) => job.id !== id);
  savePendingJobs(jobs);
  renderJobs();
}

function renderJobs() {
  const jobs = readPendingJobs();

  if (!jobs.length) {
    adminList.innerHTML = '<div class="empty-state">Nenhuma vaga pendente no momento.</div>';
    return;
  }

  adminList.innerHTML = jobs
    .map(
      (job) => `
        <article class="admin-card">
          <span class="tag">${job.status}</span>
          <h3>${job.title}</h3>
          <p><strong>${job.company}</strong> · ${job.city} · ${job.contract} · ${job.salary || "Salário a combinar"}</p>
          <p>${job.description}</p>
          <p><strong>Benefícios:</strong> ${job.benefits || "Não informado"}</p>
          <p><strong>WhatsApp:</strong> ${job.whatsapp}</p>
          <div class="admin-actions">
            <button class="primary-button" type="button" data-action="Aprovada" data-id="${job.id}">Aprovar</button>
            <button class="secondary-button" type="button" data-action="Pausada" data-id="${job.id}">Pausar</button>
            <button class="danger-button" type="button" data-remove="${job.id}">Rejeitar</button>
          </div>
        </article>
      `,
    )
    .join("");
}

adminList.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-action]");
  const removeButton = event.target.closest("[data-remove]");

  if (actionButton) {
    updateStatus(actionButton.dataset.id, actionButton.dataset.action);
  }

  if (removeButton) {
    removeJob(removeButton.dataset.remove);
  }
});

renderJobs();
