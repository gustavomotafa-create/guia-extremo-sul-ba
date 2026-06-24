const form = document.querySelector("#publishForm");
const successCard = document.querySelector("#successCard");

function readPendingJobs() {
  return JSON.parse(localStorage.getItem("girassolPendingJobs") || "[]");
}

function savePendingJobs(jobs) {
  localStorage.setItem("girassolPendingJobs", JSON.stringify(jobs));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const job = Object.fromEntries(data.entries());

  job.id = globalThis.crypto?.randomUUID?.() || `vaga-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  job.status = "Pendente";
  job.createdAt = new Date().toISOString();

  const jobs = readPendingJobs();
  jobs.unshift(job);
  savePendingJobs(jobs);

  form.reset();
  successCard.classList.add("is-visible");
  successCard.scrollIntoView({ behavior: "smooth", block: "center" });
});
