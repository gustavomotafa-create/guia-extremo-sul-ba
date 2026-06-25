const companyJobsList = document.querySelector("#companyJobsList");
const paymentsList = document.querySelector("#paymentsList");
const quotaTitle = document.querySelector("#quotaTitle");
const quotaText = document.querySelector("#quotaText");

let firebaseApi;
let services;
let currentUser;
let currentProfile;

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
  companyJobsList.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong><br>${escapeHtml(text)}</div>`;
}

function renderJobs(jobs) {
  if (!jobs.length) {
    renderMessage("Nenhuma vaga publicada ainda.", "Use o botão Publicar Vaga para cadastrar sua primeira oportunidade.");
    return;
  }

  companyJobsList.innerHTML = jobs
    .map((job) => {
      const paymentPending = job.paymentStatus === "aguardando_pagamento";
      return `
        <article class="admin-card">
          <span class="tag">${escapeHtml(job.status || "pendente")}</span>
          <h3>${escapeHtml(job.title)}</h3>
          <p><strong>${escapeHtml(job.companyName)}</strong> · ${escapeHtml(job.city)} · ${escapeHtml(job.contract)} · ${escapeHtml(job.modality || "Presencial")}</p>
          <p><strong>Pagamento:</strong> ${escapeHtml(job.paymentStatus || "gratis")}</p>
          <div class="admin-actions">
            ${paymentPending ? `<button class="primary-button" type="button" data-action="pay" data-id="${escapeHtml(job.id)}">Pagar R$ 5,00</button>` : ""}
            <button class="secondary-button" type="button" data-action="pause" data-id="${escapeHtml(job.id)}">Pausar</button>
            <button class="secondary-button" type="button" data-action="edit" data-id="${escapeHtml(job.id)}">Editar título</button>
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

async function listenCompanyData() {
  const { db, firestoreSdk } = services;
  const jobsQuery = firestoreSdk.query(
    firestoreSdk.collection(db, "jobs"),
    firestoreSdk.where("companyId", "==", currentUser.uid),
    firestoreSdk.orderBy("createdAt", "desc"),
  );

  firestoreSdk.onSnapshot(jobsQuery, (snapshot) => {
    renderJobs(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
  });

  const paymentsQuery = firestoreSdk.query(
    firestoreSdk.collection(db, "payments"),
    firestoreSdk.where("companyId", "==", currentUser.uid),
    firestoreSdk.orderBy("createdAt", "desc"),
  );

  firestoreSdk.onSnapshot(paymentsQuery, (snapshot) => {
    renderPayments(snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
  });
}

async function updateJob(id, patch) {
  const { db, firestoreSdk } = services;
  await firestoreSdk.updateDoc(firestoreSdk.doc(db, "jobs", id), patch);
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
      const title = window.prompt("Novo cargo/título da vaga:");
      if (title) {
        await updateJob(button.dataset.id, {
          title,
          status: "pendente",
          updatedAt: services.firestoreSdk.serverTimestamp(),
        });
      }
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

async function init() {
  firebaseApi = await import("../js/firebase-client.js");

  if (!firebaseApi.isFirebaseConfigured()) {
    renderMessage("Firebase ainda não configurado.", "Configure o Firebase para ativar a área da empresa.");
    paymentsList.textContent = "Firebase pendente.";
    return;
  }

  services = await firebaseApi.getServices();
  await firebaseApi.onAuth((user, profile) => {
    if (!user) {
      window.location.href = "../login/?tipo=empresa&next=../empresa/";
      return;
    }

    if (!["company", "admin"].includes(profile?.role)) {
      renderMessage("Acesso restrito.", "Entre com uma conta de empresa para gerenciar vagas.");
      return;
    }

    currentUser = user;
    currentProfile = profile;
    quotaTitle.textContent = "3 vagas grátis por dia";
    quotaText.textContent = "Ao ultrapassar o limite diário, cada pagamento de R$ 5,00 libera mais 3 publicações extras no mesmo dia.";
    listenCompanyData();
  });
}

init();
