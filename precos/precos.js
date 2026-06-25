const checkoutButton = document.querySelector("#checkoutButton");

let firebaseApi;

checkoutButton.addEventListener("click", async () => {
  if (!firebaseApi?.isFirebaseConfigured()) {
    alert("Configure Firebase Functions e Mercado Pago para ativar pagamento automático.");
    return;
  }

  try {
    const result = await firebaseApi.callFunction("createExtraPublicationPackCheckout", {});
    if (result.checkoutUrl) window.location.href = result.checkoutUrl;
  } catch (error) {
    alert(error.message || "Não foi possível iniciar o checkout.");
  }
});

async function init() {
  firebaseApi = await import("../js/firebase-client.js");
}

init();
