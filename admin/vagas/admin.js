const adminGuard = document.querySelector("#adminGuard");
const adminList = document.querySelector("#adminList");

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

function renderGuard(title, text, actionHtml = "") {
  adminGuard.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p>${actionHtml}`;
  adminGuard.classList.add("is-visible");
}

function formatBenefits(benefits) {
  if (Array.isArray(benefits)) return benefits.join(", ");
  return benefits || "Não informado";
}

function renderJobs(jobs) {
  if (!jobs.length) {
    adminList.innerHTML = '<div class="empty-state">Nenhuma vaga pendente no momento.</div>';
    return;
  }

  adminList.innerHTML = jobs
    .map(
      (job) => `
        <article class="admin-card">
          <span class="tag">${escapeHtml(job.status || "pendente")}</span>
          <h3>${escapeHtml(job.title)}</h3>
          <p><strong>${escapeHtml(job.companyName)}</strong> · ${escapeHtml(job.city)} · ${escapeHtml(job.contract)} · ${escapeHtml(job.salaryLabel || "Salário a combinar")}</p>
          <p>${escapeHtml(job.description || "Sem descrição.")}</p>
          <p><strong>Requisitos:</strong> ${escapeHtml(job.requirements || "Não informado")}</p>
          <p><strong>Benefícios:</strong> ${escapeHtml(formatBenefits(job.benefits))}</p>
          <p><strong>Pagamento:</strong> ${escapeHtml(job.paymentStatus || "gratis")} · <strong>WhatsApp:</strong> ${escapeHtml(job.whatsapp || "Não informado")}</p>
          <div class="admin-actions">
            <button class="primary-button" type="button" data-action="approve" data-id="${escapeHtml(job.id)}">Aprovar</button>
            <button class="secondary-button" type="button" data-action="edit" data-id="${escapeHtml(job.id)}">Editar</button>
            <button class="secondary-button" type="button" data-action="reject" data-id="${escapeHtml(job.id)}">Rejeitar</button>
            <button class="danger-button" type="button" data-action="delete" data-id="${escapeHtml(job.id)}">Excluir</button>
          </div>
        </article>
      `,
    )
    .join("");
}

async function loadJobs() {
  const { db, firestoreSdk } = services;
  const q = firestoreSdk.query(
    firestoreSdk.collection(db, "jobs"),
    firestoreSdk.where("status", "in", ["pendente", "aguardando_pagamento", "aprovada", "rejeitada", "pausada"]),
    firestoreSdk.orderBy("createdAt", "desc"),
  );

  firestoreSdk.onSnapshot(q, (snapshot) => {
    renderJobs(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
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

async function editJob(id) {
  const title = window.prompt("Novo cargo/título da vaga:");
  if (!title) return;
  await updateJob(id, { title, updatedAt: services.firestoreSdk.serverTimestamp() });
}

adminList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  try {
    if (button.dataset.action === "approve") {
      await updateJob(button.dataset.id, {
        status: "aprovada",
        publishedAt: services.firestoreSdk.serverTimestamp(),
        updatedAt: services.firestoreSdk.serverTimestamp(),
      });
    }

    if (button.dataset.action === "reject") {
      await updateJob(button.dataset.id, {
        status: "rejeitada",
        updatedAt: services.firestoreSdk.serverTimestamp(),
      });
    }

    if (button.dataset.action === "edit") {
      await editJob(button.dataset.id);
    }

    if (button.dataset.action === "delete") {
      const confirmed = window.confirm("Excluir esta vaga definitivamente?");
      if (confirmed) await deleteJob(button.dataset.id);
    }
  } catch (error) {
    alert(error.message || "Não foi possível executar a ação.");
  }
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
      return;
    }

    adminGuard.hidden = true;
    loadJobs();
  });
}

init();
