const savedJobsList = document.querySelector("#savedJobsList");

let firebaseApi;
let services;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function renderMessage(title, text) {
  savedJobsList.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong><br>${escapeHtml(text)}</div>`;
}

function renderJobs(jobs) {
  if (!jobs.length) {
    renderMessage("Nenhuma vaga salva ainda.", "Quando você salvar uma vaga, ela aparecerá aqui.");
    return;
  }

  savedJobsList.innerHTML = jobs
    .map(
      (job) => {
        const whatsapp = String(job.whatsapp || "5527988492573").replace(/\D/g, "");
        return `
        <article class="admin-card">
          <span class="tag">${escapeHtml(job.contract || "Vaga")}</span>
          <h3>${escapeHtml(job.title)}</h3>
          <p><strong>${escapeHtml(job.companyName)}</strong> · ${escapeHtml(job.city)} · ${escapeHtml(job.salaryLabel || "A combinar")}</p>
          <p>${escapeHtml(job.description || "")}</p>
          <div class="admin-actions">
            <a class="primary-button" href="https://wa.me/${whatsapp}" target="_blank" rel="noreferrer">Candidatar-se</a>
          </div>
        </article>
      `;
      },
    )
    .join("");
}

async function loadSavedJobs(user) {
  const { db, firestoreSdk } = services;
  const savedQuery = firestoreSdk.query(
    firestoreSdk.collection(db, "savedJobs"),
    firestoreSdk.where("userId", "==", user.uid),
  );

  firestoreSdk.onSnapshot(savedQuery, async (snapshot) => {
    const jobs = [];
    for (const savedDoc of snapshot.docs) {
      const jobRef = firestoreSdk.doc(db, "jobs", savedDoc.data().jobId);
      const jobSnap = await firestoreSdk.getDoc(jobRef);
      if (jobSnap.exists()) jobs.push({ id: jobSnap.id, ...jobSnap.data() });
    }
    renderJobs(jobs);
  });
}

async function init() {
  firebaseApi = await import("../js/firebase-client.js");

  if (!firebaseApi.isFirebaseConfigured()) {
    renderMessage("Firebase ainda não configurado.", "Configure o Firebase para ativar vagas salvas por usuário.");
    return;
  }

  services = await firebaseApi.getServices();
  await firebaseApi.onAuth((user) => {
    if (!user) {
      window.location.href = "../login/?next=../minhas-vagas-salvas/";
      return;
    }
    loadSavedJobs(user);
  });
}

init();
