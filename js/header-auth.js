(async () => {
  const scriptUrl = document.currentScript?.src || "";
  const links = [...document.querySelectorAll("[data-auth-link]")];
  if (!links.length) return;

  function setLinks({ label, href }) {
    links.forEach((link) => {
      link.textContent = label;
      link.href = href;
    });
  }

  const fallback = links[0];
  setLinks({ label: "Entrar", href: fallback.dataset.loginUrl || "./login/" });

  try {
    const firebaseApi = await import(new URL("./firebase-client.js", scriptUrl).href);
    if (!firebaseApi.isFirebaseConfigured()) return;

    await firebaseApi.onAuth((user, profile) => {
      if (!user) {
        setLinks({ label: "Entrar", href: fallback.dataset.loginUrl || "./login/" });
        return;
      }

      const adminEmails = window.GIRASSOL_ADMIN_EMAILS || [];
      const isAdmin = profile?.role === "admin" || (user.emailVerified && adminEmails.includes(user.email));

      if (isAdmin) {
        setLinks({ label: "Admin", href: fallback.dataset.adminUrl || "./admin/vagas/" });
        return;
      }

      if (profile?.role === "company") {
        setLinks({ label: "Área da Empresa", href: fallback.dataset.companyUrl || "./empresa/" });
        return;
      }

      setLinks({ label: "Minha Conta", href: fallback.dataset.accountUrl || "./minhas-vagas-salvas/" });
    });
  } catch {
    setLinks({ label: "Entrar", href: fallback.dataset.loginUrl || "./login/" });
  }
})();
