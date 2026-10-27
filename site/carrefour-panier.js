// Ajoute au panier Carrefour les produits d'une recette envoyée par le site « Recettes & macros ».
//
// S'exécute sur www.carrefour.fr : automatiquement via l'extension (carrefour-panier.user.js),
// ou en cliquant sur le favori. La recette arrive dans l'adresse : #recette-macros=<données>.
// Le panier étant lié au compte Carrefour, les produits apparaissent aussi dans l'application.
(function () {
  "use strict";
  const MARK = "#recette-macros=";
  if (!location.hash.startsWith(MARK)) {
    if (window.__recetteMacrosBookmarklet) {
      alert("Aucune recette à ajouter : utilisez le bouton « Ajouter au panier Carrefour » du site Recettes & macros.");
    }
    return;
  }

  let order;
  try {
    const b64 = location.hash.slice(MARK.length).replace(/-/g, "+").replace(/_/g, "/");
    order = JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (e) {
    return;
  }
  // Retire la recette de l'adresse : recharger la page ne doit pas l'ajouter une seconde fois.
  history.replaceState(null, "", location.pathname + location.search);

  // ---------- Fenêtre d'information ----------

  const box = document.createElement("div");
  box.id = "recette-macros-panier";
  box.setAttribute("role", "status");
  box.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:min(380px,calc(100vw - 32px));" +
    "background:#fff;color:#1c2318;border:1px solid #dde2d6;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);" +
    "padding:16px 18px;font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-height:70vh;overflow:auto";
  document.body.appendChild(box);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const button = "background:none;border:1px solid #dde2d6;padding:7px 12px;border-radius:8px;cursor:pointer;font:inherit;color:inherit";
  const show = (title, body = "", done = false, retry = null) => {
    box.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${esc(title)}</div>${body}` +
      (done ? `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <a href="/mon-panier" style="background:#2f7d32;color:#fff;padding:7px 12px;border-radius:8px;text-decoration:none;font-weight:600">Voir mon panier</a>
        ${retry ? `<button type="button" data-action="retry" style="${button}">Réessayer</button>` : ""}
        <button type="button" data-action="close" style="${button}">Fermer</button></div>` : "");
    const close = box.querySelector('[data-action="close"]');
    if (close) close.onclick = () => box.remove();
    const again = box.querySelector('[data-action="retry"]');
    if (again) again.onclick = () => retry().catch(fail);
  };
  const fail = (e) => show("L'ajout au panier a échoué", esc(e.message || e), true, () => (before ? addItems() : run()));

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = (url) => fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" }, credentials: "include" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

  // Quantités déjà au panier, par code-barres
  async function cartQuantities() {
    const data = await api("/api/cart");
    const quantities = {};
    for (const group of (data.cart && data.cart.items) || []) {
      for (const line of group.products || []) {
        const ean = line.product && line.product.attributes && line.product.attributes.ean;
        if (ean) quantities[ean] = (quantities[ean] || 0) + (line.counter || 0);
      }
    }
    return quantities;
  }

  let items, service, ref, before;

  async function run() {
    items = (order.articles || []).filter((a) => a[0] && a[1] > 0);
    show(`Ajout de « ${order.nom || "la recette"} » au panier…`, `${items.length} produit${items.length > 1 ? "s" : ""}`);

    for (let i = 0; i < 60 && !(window.ONECF && window.ONECF.addToCart); i++) await wait(250);
    if (!(window.ONECF && window.ONECF.addToCart)) {
      show("Le site Carrefour n'est pas prêt", "Patientez quelques secondes, puis réessayez.", true, run);
      return;
    }

    // Le panier doit être celui du magasin de la recette (Drive Jaude : 575)
    ref = String(order.magasin || "575");
    service = (document.documentElement.innerHTML.match(new RegExp(`"basketServiceId":"([^"]*-${ref})"`)) || [])[1];
    if (!service) {
      show("Mauvais magasin sélectionné",
        `La recette utilise les prix du ${esc(order.nomMagasin || "magasin " + ref)}. ` +
        `<a href="/set-store/${encodeURIComponent(ref)}">Choisir ce magasin</a>, puis relancez l'envoi depuis le site.`, true);
      return;
    }
    // Quantités de départ, lues une seule fois : les quantités envoyées sont absolues (départ + recette),
    // si bien que réessayer ne peut jamais ajouter un produit deux fois.
    before = await cartQuantities();
    await addItems();
  }

  async function addItems() {
    const entry = ([ean, qty]) => ({ ean, counter: (before[ean] || 0) + qty, lastCounter: before[ean] || 0, basketServiceId: service });
    const missingNow = async () => {
      const cart = await cartQuantities();
      return items.filter(([ean, qty]) => (cart[ean] || 0) < (before[ean] || 0) + qty);
    };
    show(`Ajout de « ${order.nom || "la recette"} » au panier…`, `${items.length} produit${items.length > 1 ? "s" : ""}`);

    let todo = await missingNow();
    if (todo.length) {
      try {
        await window.ONECF.addToCart(todo.map(entry));
      } catch (e) { /* selon les cas, Carrefour renvoie l'erreur ou la lève (HTTP 400) */ }
    }
    // Un produit indisponible fait échouer tout le lot, et Carrefour refuse parfois un premier ajout :
    // les manquants sont repris un par un, deux fois.
    for (let round = 0; round < 2; round++) {
      await wait(round ? 1500 : 600);
      todo = await missingNow();
      if (!todo.length) break;
      for (const item of todo) {
        try { await window.ONECF.addToCart([entry(item)]); } catch (e) { /* signalé plus bas */ }
      }
    }

    await wait(600);
    const missing = await missingNow();
    const added = items.length - missing.length;
    const list = missing.length
      ? `<div style="margin-top:8px;color:#9a5b00">Non ajouté${missing.length > 1 ? "s" : ""} (indisponible${missing.length > 1 ? "s" : ""} aujourd'hui ?) :</div>
         <ul style="margin:4px 0 0;padding-left:18px">${missing.map((m) => `<li>${esc(m[2] || m[0])}</li>`).join("")}</ul>`
      : "";
    show(missing.length ? `${added} produit${added > 1 ? "s" : ""} sur ${items.length} ajouté${added > 1 ? "s" : ""}` : `✓ ${added} produit${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""} au panier`,
      `<div>« ${esc(order.nom || "Recette")} » — ${esc(order.nomMagasin || "magasin " + ref)}.</div>${list}` +
      `<div style="margin-top:8px;color:#5d6857;font-size:12px">Connecté à votre compte, le panier est aussi dans l'application Carrefour.</div>`,
      true, missing.length ? addItems : null);
  }

  run().catch(fail);
})();
