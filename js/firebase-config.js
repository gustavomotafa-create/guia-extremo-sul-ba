window.GIRASSOL_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBCucMF48mpdPa-odrANhrxom_zE1dZsMs",
  authDomain: "girassol-vagas.firebaseapp.com",
  projectId: "girassol-vagas",
  storageBucket: "girassol-vagas.firebasestorage.app",
  messagingSenderId: "768280099894",
  appId: "1:768280099894:web:739b3605697e9750422c97",
};

(() => {
  const { hostname, protocol } = window.location;
  const isLocal =
    protocol === "file:" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  if (!isLocal) return;

  const currentScript = document.currentScript;
  const localConfigUrl = new URL("firebase-config.local.js", currentScript?.src || window.location.href).href;

  if (document.readyState === "loading") {
    document.write(`<script src="${localConfigUrl}"><\/script>`);
    return;
  }

  const script = document.createElement("script");
  script.src = localConfigUrl;
  document.head.appendChild(script);
})();
