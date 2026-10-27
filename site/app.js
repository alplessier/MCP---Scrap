// Recettes & macros — tout est calculé dans le navigateur à partir de data/catalogue.json
// (relevé hebdomadaire du Drive). Aucune requête vers Carrefour ou Firecrawl n'est faite ici.
"use strict";

const STOPWORDS = new Set(["de", "du", "des", "la", "le", "les", "au", "aux", "en", "et", "a", "d", "l"]);
const TO_GRAMS = { g: 1, kg: 1000, ml: 1, cl: 10, l: 1000 };
const LINE_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l|pcs?|pièces?|x)?\.?\s+(.+?)(?:\s+@\s*(\d+(?:[.,]\d+)?)\s*g)?(?:\s+#(\d{8,14}))?\s*$/i;
const MAX_CHOICES = 8;
const STORAGE_KEY = "recette-macros:recettes";
const CART_SETUP_KEY = "recette-macros:panier-installe";

const state = {
  products: [],
  generic: [],
  pins: {}, // nom d'ingrédient normalisé -> EAN choisi à la main
  strategy: "pertinence",
  magasin: { ref: "575", nom: "" },
  lastResults: [],
};

// ---------- Texte ----------

// « Œufs » s'écrit avec une ligature, que NFKD ne décompose pas
const normalize = (s) => s.toLowerCase().replace(/œ/g, "oe").replace(/æ/g, "ae").normalize("NFKD").replace(/[̀-ͯ]/g, "");
const words = (s) => normalize(s).match(/[a-z0-9]+/g) || [];
const stem = (t) => (t.length > 3 ? t.replace(/[sx]+$/, "") : t);
const queryTokens = (q) => words(q).filter((t) => !STOPWORDS.has(t)).map(stem);

// Position moyenne des mots de la requête dans le nom (plus c'est tôt, plus c'est pertinent), ou -1.
function relevance(tokens, nameWords) {
  let score = 0;
  for (const t of tokens) {
    const i = nameWords.findIndex((w) => w.startsWith(t));
    if (i < 0) return -1;
    score += i;
  }
  return score + nameWords.length * 0.05;
}

// ---------- Formatage ----------

const euro = (v) => (v == null ? "—" : v.toLocaleString("fr-FR", { style: "currency", currency: "EUR" }));
const num = (v, d = 0) => (v == null ? "—" : v.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d }));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function unitLabel(p) {
  if (p.prix_unite == null) return "";
  const u = { KG: "kg", L: "L", PIECE: "pièce" }[p.unite] || (p.unite || "").toLowerCase();
  return `${num(p.prix_unite, 2)} €/${u}`;
}

// ---------- Catalogue ----------

async function loadCatalogue() {
  const res = await fetch("data/catalogue.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`catalogue introuvable (${res.status})`);
  const data = await res.json();
  const cols = data.colonnes;
  state.products = data.produits.map((row) => {
    const p = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    p.words = words(`${p.nom} ${p.categorie || ""}`);
    p.nameWords = words(p.nom);
    p.categoryWords = words(p.categorie || "");
    return p;
  });
  state.magasin = data.magasin;
  state.generic = Object.entries(data.generique).map(([k, m]) => ({ tokens: queryTokens(k), macros: m }));
  const date = new Date(data.maj).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  document.getElementById("store-info").textContent =
    `${data.magasin.nom} · relevé du ${date} · ${state.products.length.toLocaleString("fr-FR")} produits`;
}

function search(query, { usableFor = null, sort = "pertinence" } = {}) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const hits = [];
  for (const p of state.products) {
    if (usableFor && !isUsable(usableFor, p)) continue;
    // le nom d'abord ; la catégorie seulement pour la recherche du catalogue
    let r = relevance(tokens, p.nameWords);
    if (r < 0 && !usableFor) {
      const inCategory = relevance(tokens, p.words);
      if (inCategory >= 0) r = inCategory + 5;
    }
    // bonus quand la catégorie correspond aussi : « oeufs » → catégorie Œufs, pas Kinder
    if (r >= 0) hits.push({ p, r: r - (relevance(tokens, p.categoryWords) >= 0 ? 1 : 0) });
  }
  const proteinPerEuro = (p) => (p.macros && p.prix_unite && p.unite !== "PIECE" ? (p.macros[1] * 10) / p.prix_unite : -1);
  const sorters = {
    pertinence: (a, b) => a.r - b.r || (a.p.prix_unite ?? 1e9) - (b.p.prix_unite ?? 1e9),
    "prix-kg": (a, b) => (a.p.prix_unite ?? 1e9) - (b.p.prix_unite ?? 1e9),
    "proteines-euro": (a, b) => proteinPerEuro(b.p) - proteinPerEuro(a.p),
    proteines: (a, b) => (b.p.macros?.[1] ?? -1) - (a.p.macros?.[1] ?? -1),
  };
  return hits.sort(sorters[sort] || sorters.pertinence).map((h) => h.p);
}

function genericMacros(name) {
  const nameWords = words(name);
  const hit = state.generic.find((g) => g.tokens.every((t) => nameWords.some((w) => w.startsWith(t))));
  return hit ? hit.macros : null;
}

// ---------- Recette ----------

function parseLine(raw) {
  const m = raw.match(LINE_RE);
  if (!m) return { raw, error: "Ligne non comprise — exemple : « 200 g blanc de poulet »" };
  const qty = parseFloat(m[1].replace(",", "."));
  const unit = (m[2] || "").toLowerCase();
  const pieceWeight = m[4] ? parseFloat(m[4].replace(",", ".")) : null;
  const ing = { raw, name: m[3].trim(), ean: m[5] || null, grams: null, pieces: null };
  if (unit in TO_GRAMS) ing.grams = qty * TO_GRAMS[unit];
  else {
    ing.pieces = qty;
    if (pieceWeight) ing.grams = qty * pieceWeight;
  }
  return ing;
}

function isUsable(ing, p) {
  if (p.prix_unite == null) return false;
  if (p.unite === "PIECE") return ing.pieces != null;
  return ing.grams != null && (p.unite === "KG" || p.unite === "L");
}

function candidatesFor(ing) {
  const ranked = search(ing.name, { usableFor: ing }).slice(0, 30);
  const top = ranked.slice(0, MAX_CHOICES);
  if (state.strategy === "moins-cher") {
    // les moins chers parmi les produits pertinents (pas parmi tout le rayon)
    top.sort((a, b) => a.prix_unite - b.prix_unite);
  }
  return top;
}

// Paquets entiers à acheter (tolérance de 2 % pour les arrondis du prix au kilo affiché)
function packsFor(p, used) {
  const pack = p.prix / p.prix_unite;
  return pack > 0 ? Math.max(1, Math.ceil(used / pack - 0.02)) : null;
}

function costLine(ing, p) {
  const out = { ing, product: p, cost: null, used: null, packs: null, macros: null, generic: false };
  if (p) {
    // quantité utilisée dans l'unité du prix (kg, L ou pièces)
    out.used = p.unite === "PIECE" ? ing.pieces : ing.grams != null ? ing.grams / 1000 : null;
    if (out.used != null) {
      out.cost = out.used * p.prix_unite;
      out.packs = packsFor(p, out.used);
    }
  }
  let per100 = p && p.macros;
  if (!per100) {
    per100 = genericMacros(ing.name);
    out.generic = !!per100;
  }
  if (per100 && ing.grams != null) out.macros = per100.map((v) => (v * ing.grams) / 100);
  return out;
}

function computeRecipe(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  return lines.map((raw) => {
    const ing = parseLine(raw);
    if (ing.error) return { ing, error: ing.error };
    const choices = candidatesFor(ing);
    const pinned = ing.ean || state.pins[normalize(ing.name)];
    let product = pinned ? state.products.find((p) => p.ean === pinned) : null;
    if (product && !choices.includes(product)) choices.unshift(product);
    product = product || choices[0] || null;
    return { ...costLine(ing, product), choices };
  });
}

// ---------- Rendu de la recette ----------

const $ = (id) => document.getElementById(id);

function renderRecipe() {
  const text = $("recipe-text").value;
  const portions = Math.max(1, parseInt($("recipe-portions").value, 10) || 1);
  const results = computeRecipe(text);
  const container = $("lines");
  container.replaceChildren();
  const tpl = $("line-template");

  let cost = 0;
  const total = [0, 0, 0, 0];
  const missingPrice = [], missingMacros = [];

  for (const r of results) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".line-ingredient").textContent = r.ing.raw;
    const select = node.querySelector(".line-product");
    const meta = node.querySelector(".line-meta");

    if (r.error) {
      node.classList.add("missing");
      select.remove();
      meta.innerHTML = `<span class="line-error">${esc(r.error)}</span>`;
      container.append(node);
      continue;
    }
    if (!r.product) {
      node.classList.add("missing");
      select.remove();
      meta.innerHTML = `<span class="line-error">Aucun produit trouvé au Drive pour « ${esc(r.ing.name)} »` +
        (r.ing.pieces != null && r.ing.grams == null ? " vendu à la pièce — essayez d'indiquer un poids (ex. @60g)" : "") + "</span>";
    } else {
      for (const p of r.choices) {
        const opt = new Option(`${p.nom} — ${euro(p.prix)} (${unitLabel(p)})${p.promo ? " · " + p.promo : ""}`, p.ean);
        opt.selected = p === r.product;
        select.append(opt);
      }
      select.addEventListener("change", () => {
        state.pins[normalize(r.ing.name)] = select.value;
        renderRecipe();
      });
      const m = r.macros;
      meta.innerHTML = [
        r.packs ? `${r.packs} × ${esc(r.product.conditionnement || "paquet")}` : "",
        m ? `${num(m[0])} kcal` : "macros inconnues",
        m ? `P ${num(m[1], 1)} g · G ${num(m[2], 1)} g · L ${num(m[3], 1)} g` : "",
        r.generic ? `<span class="badge generic" title="Produit sans fiche Open Food Facts : valeurs moyennes Ciqual">* générique</span>` : "",
        r.product.promo ? `<span class="badge promo">${esc(r.product.promo)}</span>` : "",
        r.product.url ? `<a href="${esc(r.product.url)}" target="_blank" rel="noopener">voir sur carrefour.fr</a>` : "",
      ].filter(Boolean).map((s) => `<span>${s}</span>`).join("");
    }
    node.querySelector(".line-cost").textContent = r.cost != null ? euro(r.cost) : "prix inconnu";

    if (r.cost != null) cost += r.cost; else missingPrice.push(r.ing.raw);
    if (r.macros) r.macros.forEach((v, i) => (total[i] += v)); else missingMacros.push(r.ing.raw);
    container.append(node);
  }

  const has = results.some((r) => !r.error);
  $("summary").hidden = !has;
  if (has) {
    const per = total.map((v) => v / portions);
    $("s-cost").textContent = euro(cost / portions);
    $("s-cost-total").textContent = `${euro(cost)} pour ${portions} portion${portions > 1 ? "s" : ""}`;
    $("s-kcal").textContent = `${num(per[0])} kcal`;
    $("s-kcal-total").textContent = `${num(total[0])} kcal au total`;
    $("s-p").textContent = `${num(per[1])} g`;
    $("s-g").textContent = `${num(per[2])} g`;
    $("s-l").textContent = `${num(per[3])} g`;
    const kcalFromMacros = [per[1] * 4, per[2] * 4, per[3] * 9];
    const sum = kcalFromMacros.reduce((a, b) => a + b, 0) || 1;
    $("s-bar").querySelectorAll("i").forEach((el, i) => (el.style.width = `${(kcalFromMacros[i] / sum) * 100}%`));
  }

  state.lastResults = results;
  const items = cartItems(results);
  $("send-cart").disabled = !items.length;
  if (has) {
    const prices = new Map(results.filter((r) => r.product).map((r) => [r.product.ean, r.product.prix]));
    $("s-bought").textContent = euro(items.reduce((sum, [ean, packs]) => sum + packs * prices.get(ean), 0));
  }

  const notes = [];
  if (missingPrice.length) notes.push(`Prix non calculé pour : ${missingPrice.join(", ")}.`);
  if (missingMacros.length) notes.push(`Macros manquantes pour : ${missingMacros.join(", ")}.`);
  $("notes").textContent = notes.join(" ");
  return { cost, total, portions };
}

// ---------- Catalogue (onglet Produits) ----------

function renderProducts() {
  const q = $("product-query").value;
  const sort = $("product-sort").value;
  const list = $("products");
  if (!queryTokens(q).length) {
    list.replaceChildren();
    $("product-count").textContent = "Tapez un nom de produit.";
    return;
  }
  const hits = search(q, { sort });
  $("product-count").textContent = `${hits.length.toLocaleString("fr-FR")} produit${hits.length > 1 ? "s" : ""}` +
    (hits.length > 60 ? " — 60 premiers affichés" : "");
  list.innerHTML = hits.slice(0, 60).map((p) => {
    const m = p.macros;
    const ppe = m && p.prix_unite && p.unite !== "PIECE" ? (m[1] * 10) / p.prix_unite : null;
    return `<article class="product">
      ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" width="56" height="56">` : "<span></span>"}
      <div>
        <h3>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.nom)}</a>` : esc(p.nom)}</h3>
        <div><span class="price">${euro(p.prix)}</span> <span class="per-unit">${esc(unitLabel(p))}</span></div>
        <div class="pack">${esc(p.conditionnement)}</div>
        ${p.promo ? `<span class="badge promo">${esc(p.promo)}</span>` : ""}
      </div>
      <div class="nutri">${m
        ? `<span>${num(m[0])} kcal</span><span>P ${num(m[1], 1)}</span><span>G ${num(m[2], 1)}</span><span>L ${num(m[3], 1)}</span>` +
          (ppe != null ? `<span title="grammes de protéines pour 1 €">${num(ppe, 0)} g prot./€</span>` : "")
        : "<span>macros non renseignées</span>"} <span>/ 100 g</span></div>
    </article>`;
  }).join("");
}

// ---------- Recettes enregistrées & partage ----------

function readSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}
function writeSaved(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

function currentRecipe() {
  return {
    nom: $("recipe-name").value.trim() || "Recette sans nom",
    portions: Math.max(1, parseInt($("recipe-portions").value, 10) || 1),
    texte: $("recipe-text").value,
    choix: state.pins,
  };
}

function loadRecipe(r) {
  $("recipe-name").value = r.nom || "";
  $("recipe-portions").value = r.portions || 1;
  $("recipe-text").value = r.texte || "";
  state.pins = { ...(r.choix || {}) };
  renderRecipe();
}

function toast(msg) {
  $("toast").textContent = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($("toast").textContent = ""), 3000);
}

function encodeRecipe(r) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(r)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeRecipe(s) {
  return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))));
}

function renderSaved() {
  const saved = readSaved();
  $("saved-count").textContent = saved.length || "";
  const box = $("saved");
  if (!saved.length) {
    box.innerHTML = `<p class="muted">Aucune recette enregistrée pour l'instant.</p>`;
    return;
  }
  // recalcul avec les prix du dernier relevé
  const pinsBackup = state.pins;
  box.innerHTML = saved.map((r, i) => {
    state.pins = r.choix || {};
    const results = computeRecipe(r.texte);
    const cost = results.reduce((a, x) => a + (x.cost || 0), 0);
    const kcal = results.reduce((a, x) => a + (x.macros ? x.macros[0] : 0), 0);
    const prot = results.reduce((a, x) => a + (x.macros ? x.macros[1] : 0), 0);
    const n = r.portions || 1;
    return `<article class="saved-card">
      <h3>${esc(r.nom)}</h3>
      <div class="figures">${n} portion${n > 1 ? "s" : ""} · ${euro(cost / n)} / portion<br>
        ${num(kcal / n)} kcal · ${num(prot / n)} g de protéines / portion</div>
      <div class="row">
        <button class="btn small primary" data-open="${i}">Ouvrir</button>
        <button class="btn small ghost" data-delete="${i}">Supprimer</button>
      </div>
    </article>`;
  }).join("");
  state.pins = pinsBackup;
}

// ---------- Envoi au panier Carrefour ----------
// Le panier ne peut être rempli que depuis carrefour.fr : on y ouvre la recette (#recette-macros=…),
// et site/carrefour-panier.js, installé comme userscript ou favori, fait l'ajout.

// Un même produit sur plusieurs lignes : on additionne les quantités avant de compter les paquets
// (200 g + 100 g de skyr tiennent dans un seul pot de 800 g).
function cartItems(results) {
  const byEan = new Map();
  for (const r of results) {
    if (!r.product || !r.packs) continue;
    const entry = byEan.get(r.product.ean) || { p: r.product, used: 0 };
    entry.used += r.used;
    byEan.set(r.product.ean, entry);
  }
  return [...byEan.values()].map(({ p, used }) => [p.ean, packsFor(p, used), p.nom]);
}

function cartUrl() {
  const order = {
    v: 1,
    nom: $("recipe-name").value.trim() || "Recette",
    magasin: state.magasin.ref,
    nomMagasin: state.magasin.nom,
    articles: cartItems(state.lastResults),
  };
  // set-store choisit d'abord le bon Drive ; l'ancre est conservée après la redirection
  return `https://www.carrefour.fr/set-store/${encodeURIComponent(state.magasin.ref)}#recette-macros=${encodeRecipe(order)}`;
}

function setupDone() {
  try { return localStorage.getItem(CART_SETUP_KEY) === "1"; } catch { return false; }
}

async function prepareBookmarklet() {
  try {
    const code = await (await fetch("carrefour-panier.js", { cache: "no-cache" })).text();
    $("bookmarklet").href = "javascript:" + encodeURIComponent(`window.__recetteMacrosBookmarklet=1;${code}`);
  } catch { /* le favori reste inactif, l'option 1 fonctionne toujours */ }
}

function sendToCart() {
  if (setupDone()) {
    window.open(cartUrl(), "_blank", "noopener");
    return;
  }
  const dialog = $("cart-dialog");
  prepareBookmarklet();
  dialog.addEventListener("close", function onClose() {
    dialog.removeEventListener("close", onClose);
    if (dialog.returnValue !== "send") return;
    if ($("cart-dialog-skip").checked) {
      try { localStorage.setItem(CART_SETUP_KEY, "1"); } catch { /* sans effet */ }
    }
    window.open(cartUrl(), "_blank", "noopener");
  });
  dialog.showModal();
}

// ---------- Interface ----------

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === "mes-recettes") renderSaved();
  if (name === "produits") $("product-query").focus();
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function bind() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  const rerender = debounce(renderRecipe, 200);
  $("recipe-text").addEventListener("input", rerender);
  $("recipe-portions").addEventListener("input", rerender);
  document.querySelectorAll('input[name="strategy"]').forEach((el) =>
    el.addEventListener("change", () => { state.strategy = el.value; renderRecipe(); }));

  $("save-recipe").addEventListener("click", () => {
    const r = currentRecipe();
    if (!r.texte.trim()) return toast("Ajoutez d'abord des ingrédients.");
    const saved = readSaved().filter((s) => s.nom !== r.nom);
    saved.unshift(r);
    toast(writeSaved(saved) ? `« ${r.nom} » enregistrée.` : "Impossible d'enregistrer dans ce navigateur.");
    $("saved-count").textContent = saved.length;
  });
  $("share-recipe").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}#r=${encodeRecipe(currentRecipe())}`;
    history.replaceState(null, "", url);
    try { await navigator.clipboard.writeText(url); toast("Lien copié."); } catch { toast("Lien prêt dans la barre d'adresse."); }
  });
  $("send-cart").addEventListener("click", sendToCart);
  $("bookmarklet").addEventListener("click", (e) => {
    e.preventDefault();
    toast("Glissez ce bouton dans la barre de favoris, ne cliquez pas dessus ici.");
  });
  $("clear-recipe").addEventListener("click", () => loadRecipe({ nom: "", portions: 2, texte: "", choix: {} }));

  $("saved").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    const del = e.target.closest("[data-delete]");
    const saved = readSaved();
    if (open) { loadRecipe(saved[+open.dataset.open]); showTab("recette"); }
    if (del) { saved.splice(+del.dataset.delete, 1); writeSaved(saved); renderSaved(); }
  });

  const rerenderProducts = debounce(renderProducts, 150);
  $("product-query").addEventListener("input", rerenderProducts);
  $("product-sort").addEventListener("change", renderProducts);
}

async function init() {
  bind();
  $("saved-count").textContent = readSaved().length || "";
  try {
    await loadCatalogue();
  } catch (e) {
    $("store-info").textContent = `Impossible de charger le catalogue : ${e.message}`;
    return;
  }
  const shared = location.hash.match(/^#r=(.+)$/);
  if (shared) {
    try { loadRecipe(decodeRecipe(shared[1])); return; } catch { /* lien abîmé : recette d'exemple */ }
  }
  if (!$("recipe-text").value) {
    loadRecipe({ nom: "Bowl poulet riz brocolis", portions: 2, choix: {},
      texte: "300 g filet de poulet\n150 g riz basmati\n200 g brocolis\n10 ml huile d'olive" });
  }
}

init();
