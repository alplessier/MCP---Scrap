// Recettes & macros : affichage et navigation. La logique (recherche, calculs, objectifs) est dans core.js.
// Tout est calculé dans le navigateur à partir du relevé hebdomadaire du Drive : aucune requête n'est payante.
"use strict";

const C = Core;
const STATE_KEY = "recette-macros:v2";
const OLD_SAVED_KEY = "recette-macros:recettes";
const CART_SETUP_KEY = "recette-macros:panier-installe";
const RAYONS = {
  "fruits-et-legumes": "Fruits et légumes", "viandes-et-poissons": "Viandes et poissons", cremerie: "Crèmerie",
  "charcuterie-traiteur": "Charcuterie et traiteur", surgeles: "Surgelés", "epicerie-salee": "Épicerie salée",
  "epicerie-sucree": "Épicerie sucrée", "pains-et-patisseries": "Pains", boissons: "Boissons",
  "vegetal-vegetarien": "Végétal", "dietetique-preferences-alimentaires": "Nutrition sportive",
};
const PERSO_COLORS = ["#ffe5df", "#e3f4dc", "#e7e2fb", "#fff1c7", "#dcecf7"];

// ---------- État (enregistré dans le navigateur) ----------
// menu : { id → { p: couverts, t: taille de portion } } ; pins : { clé d'ingrédient → EAN }
// members : les personnes du foyer (besoins + préférences) ; foyer : budget, temps et matériel communs

const DEFAULT_PREFS = { allergies: [], regimes: ["aucun"], petitdej: "les-deux", deteste: [] };
const AVATARS = ["🙂", "😎", "🧔", "👩", "👨", "🧒", "👧", "👦", "👵", "👴", "🏋️", "🧘"];
const state = loadState();
let cat = null;
let book = { tags: {}, recettes: [], byId: new Map() };
const ui = { tag: null, query: "", view: {}, cookStep: 0, showAll: false };

function loadState() {
  const base = { menu: {}, pins: {}, owned: [], members: [], foyer: { budget: "", temps: "", materiel: null }, rankFor: null,
    custom: [], strategy: "pertinence" };
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    if (saved) {
      const st = { ...base, ...saved, foyer: { ...base.foyer, ...(saved.foyer || {}) } };
      // version précédente : un seul profil → il devient le premier membre du foyer
      if (st.profile && !st.members.length) st.members = [newMember({ ...st.profile, nom: "Moi" })];
      delete st.profile;
      st.members = st.members.map((m) => newMember(m));
      if (!st.members.length) st.members = [newMember()];
      return st;
    }
    // anciennes recettes du mode libre (première version du site)
    const old = JSON.parse(localStorage.getItem(OLD_SAVED_KEY)) || [];
    base.custom = old.map((r, i) => customFromText(r.nom, r.portions, r.texte, i));
  } catch { /* stockage indisponible : on garde l'état vide */ }
  base.members = [newMember()];
  return base;
}
function save() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* navigation privée, etc. */ }
  updateCounts();
}

function customFromText(nom, portions, texte, i = 0) {
  return {
    id: `perso-${Date.now().toString(36)}-${i}`, nom: nom || "Ma recette", emoji: "🧑‍🍳",
    couleur: PERSO_COLORS[Math.abs(hash(nom || "")) % PERSO_COLORS.length], temps: null,
    portions: Math.max(1, +portions || 1), tags: ["perso"], ingredients: C.parseLines(texte || ""), etapes: [], perso: true,
  };
}
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);

// ---------- Outils ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const euro = (v) => (v == null ? "—" : v.toLocaleString("fr-FR", { style: "currency", currency: "EUR" }));
const num = (v, d = 0) => (v == null ? "—" : v.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d }));
const portionsLabel = (n) => `${num(n, n % 1 ? 1 : 0)} ${n > 1 ? "couverts" : "couvert"}`;

function unitLabel(p) {
  if (p.prix_unite == null) return "";
  const u = { KG: "kg", L: "L", PIECE: "pièce" }[p.unite] || (p.unite || "").toLowerCase();
  return `${num(p.prix_unite, 2)} €/${u}`;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2600);
}

function allRecipes() { return [...state.custom, ...book.recettes]; }

// ---------- Foyer ----------

function newMember(fields = {}) {
  return {
    id: `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, nom: "Moi", emoji: "🙂",
    sexe: "homme", age: "", poids: "", taille: "", activite: "modere", objectif: "maintien", repas: 3, present: true,
    ...fields, prefs: { ...DEFAULT_PREFS, ...(fields.prefs || {}) },
  };
}
const present = () => state.members.filter((m) => m.present);
// la personne pour qui l'accueil classe les recettes (« Le top 3 pour … »)
function me() { return state.members.find((m) => m.id === state.rankFor && m.present) || present()[0] || null; }
function householdSize() { return Math.max(1, present().length); }
function prefs() { return C.householdPrefs(present(), state.foyer); }

const traitsCache = new Map();
function traitsOf(r) {
  const key = `${r.id}|${r.ingredients.join("\n")}|${(r.etapes || []).join("\n")}`;
  if (!traitsCache.has(key)) traitsCache.set(key, C.recipeTraits(r));
  return traitsCache.get(key);
}
const compatOf = (r) => C.recipeCompat(r, prefs(), traitsOf(r));
function clearScores() { scoreCache.clear(); }
function recipeById(id) { return state.custom.find((r) => r.id === id) || book.byId.get(id); }

// ---------- Calculs ----------

function targets(member = me()) {
  const daily = member ? C.dailyTargets(member) : null;
  return { daily, meal: daily ? C.mealTarget(daily, member.repas || 3) : null };
}

// Couverts et taille de portion : ceux du menu si la recette y est, sinon ceux de la fiche
function servingOf(r) {
  return state.menu[r.id] || ui.view[r.id] || { p: r.portions, t: 1 };
}

function compute(r, serving = servingOf(r)) {
  const factor = (serving.p * serving.t) / r.portions;
  const lines = C.computeLines(cat, r.ingredients, { factor, pins: state.pins, strategy: state.strategy, keyPrefix: `${r.id}:` });
  const t = C.totals(lines);
  return {
    lines, ...t, serving,
    perPortion: { cost: t.cost / serving.p, macros: t.macros.map((v) => v / serving.p) },
  };
}

// Valeurs d'une portion standard, pour les cartes (mises en cache : le catalogue ne change pas)
const statsCache = new Map();
function stats(r) {
  const key = `${r.id}|${r.ingredients.join("\n")}|${state.strategy}`;
  if (!statsCache.has(key)) statsCache.set(key, compute(r, { p: r.portions, t: 1 }).perPortion);
  return statsCache.get(key);
}

// Une collation ne remplace pas un repas : pas de conseil de portion. Un petit-déj compte comme un repas,
// même s'il peut aussi servir de collation.
const isSnack = (r) => (r.tags || []).includes("collation") && !(r.tags || []).includes("petit-dej");
// Les rangées de repas ne proposent que des plats : pas de collation ni de petit-déj en « Perte de gras »
const MEAL_ONLY_EXCLUDES = ["collation", "petit-dej"];
const eligibleForTop = (r, filter) => MEAL_ONLY_EXCLUDES.includes(filter) || !(r.tags || []).some((t) => MEAL_ONLY_EXCLUDES.includes(t));

// Filtres présentés dans « Le top 3 pour vous », dans cet ordre
const TOP_FILTERS = ["seche", "masse", "gourmand", "petit-dej", "collation", "meal-prep", "vegetarien"];
const MEDALS = ["🥇", "🥈", "🥉"];
const FLAG_LABELS = { budget: "💶 au-dessus du budget", temps: "⏱ un peu long", sucre: "🍯 petit-déj sucré", sale: "🧂 petit-déj salé" };

const scoreCache = new Map();
// Note de la recette pour la personne classée, ajustée au budget, au temps et au petit-déj préféré
function scoreOf(r) {
  const m = me();
  const { daily } = targets(m);
  if (!daily) return null;
  const key = `${r.id}|${r.ingredients.join("\n")}|${m.id}|${state.strategy}`;
  if (!scoreCache.has(key)) {
    const base = C.recipeScore(stats(r), { daily, meals: m.repas || 3, goal: m.objectif, snack: isSnack(r) });
    const pen = C.budgetTimePenalty(stats(r).cost * base.size, r.temps, prefs(), m.repas || 3);
    let factor = pen.factor;
    const pd = m.prefs.petitdej;
    if ((r.tags || []).includes("petit-dej") && pd !== "les-deux" && traitsOf(r).sweet !== (pd === "sucre")) {
      factor *= 0.7;
      pen.flags.push(pd === "sucre" ? "sale" : "sucre");
    }
    scoreCache.set(key, { ...base, score: Math.round(base.score * factor), flags: pen.flags });
  }
  return scoreCache.get(key);
}
const byScore = (a, b) => (scoreOf(b)?.score ?? -1) - (scoreOf(a)?.score ?? -1);

function fitLabel(r, kcalPP, meal) {
  if (!meal || !kcalPP || isSnack(r)) return "";
  if (C.tooLightForMeal(kcalPP, meal)) return `<span class="fit">Léger : à accompagner</span>`;
  const t = C.portionsForTarget(kcalPP, meal);
  if (t === 1) return `<span class="fit ok">✓ Parfait pour 1 repas</span>`;
  return `<span class="fit">Portion conseillée ×${num(t, 2)}</span>`;
}

// ---------- Rendu commun ----------

function tileHtml(r, cls = "") {
  return `<div class="tile ${cls}" style="background:${esc(r.couleur)}" aria-hidden="true">${esc(r.emoji)}</div>`;
}

function cardHtml(r, meal, rank = null) {
  const s = stats(r);
  const inMenu = !!state.menu[r.id];
  const sc = scoreOf(r);
  return `<article class="card">
    ${rank != null && rank < 3 ? `<span class="medal" aria-label="Numéro ${rank + 1} pour vous">${MEDALS[rank]}</span>` : ""}
    <button class="add" data-action="toggle-menu" data-id="${esc(r.id)}" aria-pressed="${inMenu}"
      aria-label="${inMenu ? "Retirer du menu" : "Ajouter au menu"} : ${esc(r.nom)}">${inMenu ? "✓" : "+"}</button>
    <a href="#/recette/${encodeURIComponent(r.id)}" style="color:inherit;text-decoration:none;display:contents">
      ${tileHtml(r)}
      <div class="card-body">
        <div class="card-title">${compatOf(r).ok ? "" : `<span title="${esc(compatOf(r).reasons.join(", "))}">⚠️ </span>`}${esc(r.nom)}</div>
        <div class="card-meta">
          ${r.temps ? `<span>⏱ ${r.temps} min</span>` : ""}
          <span>${euro(s.cost)}/pers.</span>
        </div>
        <div class="card-meta"><span class="prot">💪 ${num(s.macros[1])} g prot.</span><span>${num(s.macros[0])} kcal</span></div>
        <div class="card-meta">${sc ? `<span class="score" title="Pertinence pour votre objectif">🎯 ${sc.score}/100</span>` : ""}${fitLabel(r, s.macros[0], meal)}</div>
        ${sc && sc.flags.length ? `<div class="card-meta flags">${sc.flags.map((f) => `<span>${FLAG_LABELS[f]}</span>`).join("")}</div>` : ""}
      </div>
    </a>
  </article>`;
}

function stepperHtml(action, id, label, cls = "") {
  return `<div class="stepper ${cls}" role="group" aria-label="Nombre de couverts">
    <button type="button" data-action="${action}" data-id="${esc(id)}" data-delta="-1" aria-label="Un couvert de moins">−</button>
    <output aria-live="polite">${label}</output>
    <button type="button" data-action="${action}" data-id="${esc(id)}" data-delta="1" aria-label="Un couvert de plus">+</button>
  </div>`;
}

function macroBars(macros, meal) {
  const rows = [["Protéines", "p", 1], ["Glucides", "g", 2], ["Lipides", "l", 3]];
  return rows.map(([label, cls, i]) => {
    const target = meal ? [null, meal.proteines, meal.glucides, meal.lipides][i] : null;
    const pct = target ? Math.min(100, (macros[i] / target) * 100) : Math.min(100, macros[i]);
    return `<div class="macro"><span>${label}</span>
      <div class="bar ${cls}" role="img" aria-label="${label} : ${num(macros[i])} g${target ? ` sur ${num(target)} g visés` : ""}"><i style="width:${pct}%"></i></div>
      <small>${num(macros[i])} g${target ? ` / ${num(target)}` : ""}</small></div>`;
  }).join("");
}

function ingredientsHtml(lines) {
  return `<ul class="ingredients">${lines.map((x) => {
    if (x.error) return `<li><div class="ing-head"><span>${esc(x.ing.raw)}</span></div><div class="error">${esc(x.error)}</div></li>`;
    if (!x.product) {
      return `<li><div class="ing-head"><span>${esc(x.ing.raw)}</span><span class="price">—</span></div>
        <div class="error">Aucun produit trouvé au Drive${x.ing.pieces != null && x.ing.grams == null ? " (indiquez un poids : « 2 oeufs @60g »)" : ""}</div></li>`;
    }
    const options = x.choices.map((p) =>
      `<option value="${esc(p.ean)}"${p === x.product ? " selected" : ""}>${esc(p.nom)} — ${euro(p.prix)} (${esc(unitLabel(p))})${p.promo ? " · " + esc(p.promo) : ""}</option>`).join("");
    return `<li>
      <div class="ing-head"><span>${esc(x.ing.raw)}</span><span class="price">${euro(x.cost)}</span></div>
      <select class="product-select" data-action="pin" data-key="${esc(x.key)}" aria-label="Produit pour ${esc(x.ing.name)}">${options}</select>
      <div class="ing-note">${x.macros ? `${num(x.macros[0])} kcal · P ${num(x.macros[1], 1)} g` : "macros inconnues"}${x.generic ? " · valeurs moyennes *" : ""}${x.product.promo ? ` · <span class="promo">${esc(x.product.promo)}</span>` : ""}</div>
    </li>`;
  }).join("")}</ul>`;
}

// ---------- Pages ----------

function viewRecipes() {
  const { daily, meal } = targets();
  const q = C.queryTokens(ui.query);
  const m = me();
  // recettes incompatibles avec le foyer (allergies, régimes, ingrédients détestés, matériel) : masquées
  const compatible = allRecipes().filter((r) => compatOf(r).ok);
  const hidden = allRecipes().length - compatible.length;
  const list = (ui.showAll ? allRecipes() : compatible).filter((r) => {
    if (ui.tag && !(r.tags || []).includes(ui.tag)) return false;
    if (!q.length) return true;
    const w = C.words(`${r.nom} ${r.ingredients.join(" ")} ${(r.tags || []).map((t) => book.tags[t] || t).join(" ")}`);
    return q.every((t) => w.some((x) => x.startsWith(t)));
  });
  const tags = Object.entries({ ...book.tags, ...(state.custom.length ? { perso: "Mes recettes" } : {}) });
  if (daily) {
    // mêmes règles que les rangées « top 3 » : dans un filtre de repas, les plats passent avant les collations
    list.sort((a, b) => (ui.tag ? eligibleForTop(b, ui.tag) - eligibleForTop(a, ui.tag) : 0) || byScore(a, b));
  }
  const showTops = daily && !ui.tag && !q.length;
  const tops = showTops ? TOP_FILTERS.map((t) => {
    const best = compatible.filter((r) => (r.tags || []).includes(t) && eligibleForTop(r, t)).sort(byScore).slice(0, 3);
    if (!best.length) return "";
    return `<div class="top-row">
      <div class="top-head"><h3>${esc(book.tags[t])}</h3><button class="link-btn" data-action="tag" data-tag="${esc(t)}">Tout voir →</button></div>
      <div class="top-cards">${best.map((r, i) => cardHtml(r, meal, i)).join("")}</div>
    </div>`;
  }).join("") : "";
  return `
    <section class="hero">
      <div>
        <h1>On mange quoi ce soir ?</h1>
        <p>Des recettes pensées pour vos objectifs, au prix du Drive Jaude, et votre panier rempli en un clic.</p>
        ${daily
          ? `<a class="goal-pill" href="#/profil">${householdSize() > 1 ? `👥 Foyer de ${householdSize()} · ` : ""}🎯 ${esc(m.nom)} : ${C.GOALS[m.objectif]?.label || "Objectif"} · ${num(daily.kcal)} kcal · ${num(daily.proteines)} g de protéines / jour</a>`
          : `<a class="goal-pill" href="#/profil">💪 Créer mon profil et calculer mes besoins →</a>`}
      </div>
      <div class="hero-art" aria-hidden="true">🥗</div>
    </section>
    <div class="toolbar">
      <label class="sr-only" for="recipe-search">Rechercher une recette</label>
      <input id="recipe-search" class="search" type="search" placeholder="Poulet, pâtes, petit-déj…" value="${esc(ui.query)}" autocomplete="off">
      <div class="chips" role="group" aria-label="Filtrer">
        <button class="chip" data-action="tag" data-tag="" aria-pressed="${!ui.tag}">Toutes</button>
        ${tags.map(([k, v]) => `<button class="chip" data-action="tag" data-tag="${esc(k)}" aria-pressed="${ui.tag === k}">${esc(v)}</button>`).join("")}
      </div>
    </div>
    ${showTops ? `<section class="for-you" aria-labelledby="for-you-title">
      <div class="for-you-head">
        <h2 id="for-you-title">Le top 3 pour ${present().length > 1 ? "" : "vous"}</h2>
        ${present().length > 1 ? `<select class="rank-select" data-action="rank-for" aria-label="Classer les recettes pour">${present().map((x) =>
          `<option value="${esc(x.id)}"${x.id === m.id ? " selected" : ""}>${esc(x.emoji)} ${esc(x.nom)}</option>`).join("")}</select>` : ""}
      </div>
      <p class="muted">Classé pour l'objectif « ${esc(C.GOALS[m.objectif]?.label || "")} » de ${esc(m.nom)} : protéines, portion adaptée au repas idéal, lipides et prix${prefs().budget || prefs().temps ? ", budget et temps" : ""}. Seules les recettes compatibles avec tout le foyer sont proposées. <a href="#/profil">Modifier le foyer</a></p>
      ${tops}
    </section><h2 class="all-title">Toutes les recettes</h2>` : ""}
    <div class="grid">
      ${list.map((r, i) => cardHtml(r, meal, daily && ui.tag && !q.length && eligibleForTop(r, ui.tag) ? i : null)).join("")}
      <a class="card create" href="#/creer">
        <div class="tile" aria-hidden="true">✍️</div>
        <div class="card-body"><div class="card-title">Créer ma recette</div><div class="card-meta"><span>Mode libre : vos ingrédients, chiffrés au Drive</span></div></div>
      </a>
    </div>
    ${list.length ? "" : `<div class="empty"><div class="big-emoji">🔍</div><p>Aucune recette ne correspond.</p></div>`}
    ${hidden ? `<p class="muted hidden-note">${ui.showAll ? `Les ${hidden} recettes incompatibles avec votre foyer sont affichées (signalées par ⚠️).`
      : `${hidden} recette${hidden > 1 ? "s masquées" : " masquée"} : incompatible${hidden > 1 ? "s" : ""} avec les allergies, régimes, ingrédients détestés ou le matériel de votre foyer.`}
      <button class="link-btn" data-action="show-all">${ui.showAll ? "Les masquer" : "Les afficher"}</button></p>` : ""}`;
}

function viewRecipe(id) {
  const r = recipeById(id);
  if (!r) return notFound();
  const { meal } = targets();
  const res = compute(r);
  const s = res.serving;
  const inMenu = !!state.menu[r.id];
  const per = res.perPortion;
  const kcalStd = stats(r).macros[0];
  const traits = traitsOf(r);
  const compat = compatOf(r);
  // portions de chaque membre présent, calées sur son repas idéal
  const members = present().filter((x) => C.dailyTargets(x));
  const portions = isSnack(r) ? [] : C.memberPortions(kcalStd, members);
  const adapt = portions.length ? Math.round((portions.reduce((a, x) => a + x.size, 0) / portions.length) * 4) / 4 : null;
  const people = Math.max(1, members.length);
  const adapted = adapt !== null && s.t === adapt && s.p === people && !(adapt === 1 && people === r.portions);
  const light = meal && !isSnack(r) && C.tooLightForMeal(kcalStd, meal);
  const solo = members.length <= 1;
  return `
    <a class="back" href="#/">← Recettes</a>
    <div class="detail">
      <div>
        ${tileHtml(r, "big")}
        <div class="panel" style="margin-top:16px">
          <h2>Ingrédients</h2>
          ${ingredientsHtml(res.lines)}
          <p class="hint">Produits et prix du ${esc(cat.magasin.nom)}. Changez de produit dans la liste si besoin.</p>
        </div>
      </div>
      <div>
        <div class="tags">${(r.tags || []).map((t) => `<span class="tag">${esc(book.tags[t] || (t === "perso" ? "Ma recette" : t))}</span>`).join("")}</div>
        <h1>${esc(r.nom)}</h1>
        <p class="muted">${r.temps ? `⏱ ${r.temps} min · ` : ""}${euro(per.cost)} par personne · ${euro(res.cost)} au total</p>
        ${compat.ok ? "" : `<div class="warning" role="note">⚠️ Pas adaptée à votre foyer : ${esc(compat.reasons.join(", "))}.</div>`}
        <p class="traits">${traits.allergens.length ? `<span>Contient : ${esc(traits.allergens.map((a) => C.ALLERGENS[a].label.toLowerCase()).join(", "))}</span>` : `<span>Sans allergène majeur détecté</span>`}
          ${traits.equipment.length ? `<span>Matériel : ${esc(traits.equipment.map((e) => C.EQUIPMENT[e].label.toLowerCase()).join(", "))}</span>` : `<span>Sans cuisson</span>`}</p>
        <div class="panel">
          <div class="row">
            ${stepperHtml("servings", r.id, portionsLabel(s.p))}
            ${isSnack(r) && meal ? `<span class="fit">Collation : en plus des repas</span>`
              : adapt === null ? `<a class="btn small" href="#/profil">🎯 Définir les objectifs du foyer</a>`
              : adapt === 1 && s.t === 1 && (solo || s.p === people) ? `<span class="fit ok">✓ Portion idéale ${solo ? "pour votre objectif" : "pour le foyer"}</span>`
              : `<button class="btn small" data-action="adapt" data-id="${esc(r.id)}" data-size="${adapted ? 1 : adapt}" data-people="${adapted ? s.p : people}">${adapted ? "↺ Portion standard"
                : solo ? `🎯 Adapter à mon objectif (×${num(adapt, 2)})` : `👥 Adapter au foyer (${people} pers.)`}</button>`}
          </div>
          ${s.t !== 1 ? `<p class="hint">Portions ×${num(s.t, 2)} en moyenne, adaptées ${solo ? "à votre objectif" : "aux objectifs du foyer"}.</p>` : ""}
          ${!solo && portions.length ? `<ul class="per-member">${portions.map((x) => `<li><span>${esc(state.members.find((mm) => mm.id === x.id)?.emoji || "🙂")} ${esc(x.nom)}</span>
            <span>portion ×${num(x.size, 2)} · ${num(kcalStd * x.size)} kcal · ${num(stats(r).macros[1] * x.size)} g prot.</span></li>`).join("")}</ul>
            <p class="hint">Servez à chacun sa portion : les quantités et les courses couvrent tout le foyer.</p>` : ""}
          ${light ? `<p class="hint">Même doublée, cette recette reste légère pour votre objectif : ajoutez un accompagnement (riz, pain, fruit…) ou une collation.</p>` : ""}
          <div class="kpis">
            <div class="kpi"><b>${num(per.macros[0])}</b><span>kcal / portion</span></div>
            <div class="kpi"><b>${num(per.macros[1])} g</b><span>protéines</span></div>
            <div class="kpi"><b>${euro(per.cost)}</b><span>par personne</span></div>
          </div>
          ${macroBars(per.macros, meal)}
          ${meal ? `<p class="hint">Barres : part d'un repas idéal pour ${esc(me().nom)} (${num(meal.kcal)} kcal, ${num(meal.proteines)} g de protéines).</p>`
                 : `<p class="hint">Renseignez votre profil pour comparer à vos besoins.</p>`}
          ${res.missingMacros.length ? `<p class="hint">Macros inconnues pour : ${esc(res.missingMacros.join(", "))}.</p>` : ""}
        </div>
        <div class="actions" style="margin-top:16px">
          <button class="btn primary" data-action="toggle-menu" data-id="${esc(r.id)}">${inMenu ? "✓ Dans mon menu" : "+ Ajouter au menu"}</button>
          ${r.etapes && r.etapes.length ? `<a class="btn" href="#/cuisine/${encodeURIComponent(r.id)}">👩‍🍳 Passer en cuisine</a>` : ""}
          <button class="btn" data-action="send-recipe" data-id="${esc(r.id)}">🛒 Panier Carrefour</button>
          ${r.perso ? `<a class="btn ghost" href="#/creer/${encodeURIComponent(r.id)}">Modifier</a>` : ""}
        </div>
      </div>
    </div>`;
}

function viewCook(id) {
  const r = recipeById(id);
  if (!r || !r.etapes?.length) return notFound();
  const res = compute(r);
  const total = r.etapes.length + 1;
  const i = (ui.cookStep = Math.min(ui.cookStep, total - 1));
  const body = i === 0
    ? `<div class="cook-step"><div class="num">Avant de commencer · ${portionsLabel(res.serving.p)}</div>
        <ul class="ingredients" style="text-align:left;margin-top:12px">${res.lines.map((x) => `<li><div class="ing-head"><span>${esc(x.ing.raw)}</span></div></li>`).join("")}</ul></div>`
    : `<div class="cook-step"><div class="num">Étape ${i} sur ${total - 1}</div><p>${esc(r.etapes[i - 1])}</p></div>`;
  return `<div class="cook" role="dialog" aria-label="Passer en cuisine : ${esc(r.nom)}">
    <div class="cook-top"><strong>${esc(r.emoji)} ${esc(r.nom)}</strong><a class="btn small" href="#/recette/${encodeURIComponent(r.id)}">Fermer</a></div>
    <div class="cook-body">${body}</div>
    <div class="dots" aria-hidden="true">${Array.from({ length: total }, (_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>
    <div class="cook-nav">
      <button class="btn" data-action="cook-step" data-delta="-1" ${i === 0 ? "disabled" : ""}>← Précédent</button>
      ${i < total - 1 ? `<button class="btn primary" data-action="cook-step" data-delta="1">Suivant →</button>`
                      : `<a class="btn primary" href="#/recette/${encodeURIComponent(r.id)}">Bon appétit ! 🎉</a>`}
    </div>
  </div>`;
}

function menuEntries() {
  return Object.keys(state.menu).map((id) => recipeById(id)).filter(Boolean).map((r) => ({ r, res: compute(r) }));
}

function viewMenu() {
  const entries = menuEntries();
  const { meal } = targets();
  if (!entries.length) {
    return `<div class="page-head"><h1>Mon menu</h1></div>
      <div class="empty"><div class="big-emoji">📅</div><p>Votre menu est vide. Ajoutez des recettes avec le bouton <strong>+</strong>.</p>
      <a class="btn primary" href="#/">Choisir des recettes</a></div>`;
  }
  let cost = 0, portions = 0;
  const macros = [0, 0, 0, 0];
  for (const { res } of entries) {
    cost += res.cost;
    portions += res.serving.p;
    res.macros.forEach((v, i) => (macros[i] += v));
  }
  const avg = macros.map((v) => v / portions);
  return `<div class="page-head"><h1>Mon menu</h1><span class="muted">${entries.length} recette${entries.length > 1 ? "s" : ""} · ${portionsLabel(portions)}</span></div>
    <div class="two-cols">
      <div class="menu-list">${entries.map(({ r, res }) => `
        <article class="menu-item">
          <a href="#/recette/${encodeURIComponent(r.id)}">${tileHtml(r)}</a>
          <div>
            <a href="#/recette/${encodeURIComponent(r.id)}"><div class="card-title">${esc(r.nom)}</div></a>
            <div class="card-meta"><span>${euro(res.perPortion.cost)}/pers.</span><span class="prot">💪 ${num(res.perPortion.macros[1])} g</span><span>${num(res.perPortion.macros[0])} kcal</span>${res.serving.t !== 1 ? `<span>portions ×${num(res.serving.t, 2)}</span>` : ""}</div>
          </div>
          <div class="menu-side">
            ${stepperHtml("servings", r.id, portionsLabel(res.serving.p), "small")}
            <button class="link-btn" data-action="toggle-menu" data-id="${esc(r.id)}">Retirer</button>
          </div>
        </article>`).join("")}
      </div>
      <aside class="panel sticky">
        <h2>Bilan du menu</h2>
        <div class="total-line big"><span>Total</span><span>${euro(cost)}</span></div>
        <div class="total-line"><span>Par personne et par repas</span><span>${euro(cost / portions)}</span></div>
        <h3 style="font-size:1rem;margin:14px 0 4px">En moyenne, par repas</h3>
        <div class="total-line"><span>Énergie</span><span>${num(avg[0])} kcal${meal ? ` / ${num(meal.kcal)}` : ""}</span></div>
        ${macroBars(avg, meal)}
        ${meal ? "" : `<p class="hint"><a href="#/profil">Renseignez votre profil</a> pour comparer à vos besoins.</p>`}
        <a class="btn primary block" href="#/courses" style="margin-top:14px">Faire les courses →</a>
      </aside>
    </div>`;
}

function menuShopping() {
  const entries = menuEntries();
  const lines = entries.flatMap(({ res }) => res.lines);
  return { entries, list: C.shoppingList(lines, { exclude: new Set(state.owned) }) };
}

function viewCourses() {
  const { entries, list } = menuShopping();
  if (!entries.length) {
    return `<div class="page-head"><h1>Courses</h1></div>
      <div class="empty"><div class="big-emoji">🛒</div><p>Ajoutez des recettes à votre menu : la liste de courses se fait toute seule.</p>
      <a class="btn primary" href="#/">Choisir des recettes</a></div>`;
  }
  const groups = new Map();
  for (const item of list) {
    const g = RAYONS[item.product.rayon] || "Autres";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(item);
  }
  const toBuy = list.filter((e) => !e.owned);
  const total = toBuy.reduce((s, e) => s + e.price, 0);
  return `<div class="page-head"><h1>Courses</h1><span class="muted">${entries.length} recette${entries.length > 1 ? "s" : ""} · ${list.length} produits</span></div>
    <div class="two-cols">
      <div>
        <p class="muted">Cochez ce que vous avez déjà : ce ne sera pas ajouté au panier.</p>
        ${[...groups].map(([g, items]) => `<div class="shop-group"><h3>${esc(g)}</h3>${items.map((e) => `
          <label class="shop-item${e.owned ? " owned" : ""}">
            <input type="checkbox" data-action="owned" data-ean="${esc(e.product.ean)}" ${e.owned ? "checked" : ""} aria-label="J'ai déjà : ${esc(e.product.nom)}">
            ${e.product.image ? `<img src="${esc(e.product.image)}" alt="" loading="lazy" width="44" height="44">` : `<span class="ph" aria-hidden="true">🛍️</span>`}
            <span><span class="name">${esc(e.product.nom)}</span><br><span class="sub">${e.packs} × ${esc(e.product.conditionnement || "paquet")} · pour ${esc(e.uses.join(", "))}</span></span>
            <span class="price">${euro(e.price)}</span>
          </label>`).join("")}</div>`).join("")}
      </div>
      <aside class="panel sticky checkout">
        <h2>Mon panier</h2>
        <div class="total-line big"><span>${toBuy.length} produit${toBuy.length > 1 ? "s" : ""}</span><span>${euro(total)}</span></div>
        <p class="hint">Paquets entiers, aux prix du relevé du ${new Date(cat.maj).toLocaleDateString("fr-FR")}. Les promotions fidélité ne sont pas déduites.</p>
        <button class="btn primary block" data-action="send-menu" ${toBuy.length ? "" : "disabled"} style="margin-top:12px">🛒 Envoyer au panier Carrefour</button>
        <p class="hint">Ouvre carrefour.fr sur le Drive Jaude et ajoute ces produits à votre panier, aussi visible dans l'application.</p>
      </aside>
    </div>`;
}

const MODES = { seul: ["🙂", "Seul", 1], couple: ["💑", "En couple", 2], famille: ["👨‍👩‍👧", "En famille", 3] };

function viewProfil() {
  const members = state.members;
  const n = present().length;
  const mode = n <= 1 ? "seul" : n === 2 ? "couple" : "famille";
  const f = state.foyer;
  const mat = f.materiel || Object.keys(C.EQUIPMENT);
  const hp = prefs();
  const shown = allRecipes().filter((r) => compatOf(r).ok).length;
  return `<div class="page-head"><h1>Mon foyer</h1></div>
    <div class="two-cols">
      <div>
        <div class="panel">
          <h2>Pour combien cuisinez-vous ?</h2>
          <div class="choices cols-3">${Object.entries(MODES).map(([k, [e, l, size]]) =>
            `<button type="button" class="choice" data-action="household-mode" data-value="${k}" aria-pressed="${mode === k}"><span class="emoji" aria-hidden="true">${e}</span><b>${l}</b><span>${size === 1 ? "1 personne" : size === 2 ? "2 personnes" : "3 personnes ou plus"}</span></button>`).join("")}</div>
          <p class="hint">Les courses et les couverts du menu couvrent les membres présents ; chacun garde sa portion selon son objectif.</p>
        </div>
        <div class="panel">
          <h2>Membres</h2>
          ${members.length ? `<ul class="members">${members.map((x) => {
            const d = C.dailyTargets(x);
            return `<li class="member${x.present ? "" : " absent"}">
              <label class="present" title="Mange à la maison"><input type="checkbox" data-action="member-present" data-id="${esc(x.id)}"${x.present ? " checked" : ""}><span class="sr-only">Présent</span></label>
              <a class="member-main" href="#/profil/${encodeURIComponent(x.id)}">
                <span class="avatar" aria-hidden="true">${esc(x.emoji)}</span>
                <span><b>${esc(x.nom)}</b><span class="muted">${d ? `${C.GOALS[x.objectif]?.label} · ${num(d.kcal)} kcal · ${num(d.proteines)} g prot.` : "Profil à compléter"}${memberPrefsSummary(x)}</span></span>
              </a>
              <a class="btn small ghost" href="#/profil/${encodeURIComponent(x.id)}">Modifier</a>
            </li>`;
          }).join("")}</ul>` : `<p class="muted">Aucun profil pour l'instant.</p>`}
          <button class="btn" data-action="add-member" style="margin-top:12px">+ Ajouter un membre</button>
        </div>
        <div class="panel">
          <h2>Budget et temps</h2>
          <div class="form-grid">
            <label class="field">Budget par jour et par personne (€)<input id="foyer-budget" type="number" inputmode="decimal" min="1" max="100" step="0.5" data-action="foyer-input" data-field="budget" value="${esc(f.budget)}" placeholder="Pas de limite"></label>
            <label class="field">Temps de cuisine par jour (min)<input id="foyer-temps" type="number" inputmode="numeric" min="5" max="240" step="5" data-action="foyer-input" data-field="temps" value="${esc(f.temps)}" placeholder="Pas de limite"></label>
          </div>
          <p class="hint">Les recettes plus chères qu'un repas de votre budget ou plus longues que la moitié de votre temps du jour descendent dans le classement (sans être masquées).</p>
        </div>
        <div class="panel">
          <h2>Matériel disponible</h2>
          <div class="chips-select">${Object.entries(C.EQUIPMENT).map(([k, e]) =>
            `<button type="button" class="chip" data-action="foyer-materiel" data-value="${k}" aria-pressed="${mat.includes(k)}">${esc(e.label)}</button>`).join("")}</div>
          <p class="hint">Les recettes qui demandent un appareil absent sont masquées.</p>
        </div>
      </div>
      <aside class="panel sticky">
        <h2>Le foyer en bref</h2>
        <div class="targets">
          <div class="kpi"><b>${n}</b><span>${n > 1 ? "personnes" : "personne"} à table</span></div>
          <div class="kpi"><b>${shown}</b><span>recettes compatibles</span></div>
        </div>
        ${hp.allergies.length ? `<div class="total-line"><span>Allergies</span><span>${esc(hp.allergies.map((a) => C.ALLERGENS[a].label).join(", "))}</span></div>` : ""}
        ${hp.regimes.length ? `<div class="total-line"><span>Régimes</span><span>${esc(hp.regimes.map((d) => C.DIETS[d].label).join(", "))}</span></div>` : ""}
        ${hp.deteste.length ? `<div class="total-line"><span>Évités</span><span>${esc(hp.deteste.join(", "))}</span></div>` : ""}
        <p class="hint">Les contraintes de tous les membres présents s'additionnent : une recette doit convenir à tout le monde.</p>
        <a class="btn primary block" href="#/" style="margin-top:12px">Voir les recettes adaptées →</a>
      </aside>
    </div>`;
}

function memberPrefsSummary(x) {
  const p = x.prefs;
  const bits = [
    ...p.allergies.map((a) => C.ALLERGENS[a].label),
    ...p.regimes.filter((d) => d !== "aucun").map((d) => C.DIETS[d].label),
    p.deteste.length ? `${p.deteste.length} ingrédient${p.deteste.length > 1 ? "s" : ""} évité${p.deteste.length > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  return bits.length ? ` · ${esc(bits.join(", "))}` : "";
}

// Ingrédients des recettes, pour la liste déroulante des ingrédients détestés
let ingredientChoices = null;
function dislikeOptions() {
  if (!ingredientChoices) {
    const names = new Map();
    for (const r of book.recettes) for (const l of r.ingredients) {
      const name = (C.parseLine(l).name || "").trim().toLowerCase();
      if (name && name.length < 40) names.set(name, (names.get(name) || 0) + 1);
    }
    ingredientChoices = [...names.keys()].sort((a, b) => a.localeCompare(b, "fr"));
  }
  return ingredientChoices;
}

function viewMember(id) {
  const p = state.members.find((x) => x.id === id);
  if (!p) return notFound();
  const { daily, meal } = targets(p);
  const seg = (field, options) => `<div class="segmented" role="group">${options.map(([v, l]) =>
    `<button type="button" data-action="member" data-id="${esc(p.id)}" data-field="${field}" data-value="${v}" aria-pressed="${String(p[field]) === String(v)}">${l}</button>`).join("")}</div>`;
  const pr = p.prefs;
  const pref = (field, v, label, pressed) =>
    `<button type="button" class="chip" data-action="member-pref" data-id="${esc(p.id)}" data-field="${field}" data-value="${esc(v)}" aria-pressed="${pressed}">${label}</button>`;
  const options = dislikeOptions().filter((x) => !pr.deteste.includes(x));
  return `<a class="back" href="#/profil">← Mon foyer</a>
    <div class="page-head"><h1>${esc(p.emoji)} ${esc(p.nom)}</h1></div>
    <div class="two-cols">
      <div>
        <div class="panel">
          <h2>Profil</h2>
          <div class="form-grid">
            <label class="field">Prénom<input id="member-nom" type="text" maxlength="24" data-action="member-input" data-id="${esc(p.id)}" data-field="nom" value="${esc(p.nom)}"></label>
            <div class="field span-all">Avatar<div class="avatars" role="group">${AVATARS.map((e) =>
              `<button type="button" data-action="member" data-id="${esc(p.id)}" data-field="emoji" data-value="${e}" aria-pressed="${p.emoji === e}" aria-label="Avatar ${e}">${e}</button>`).join("")}</div></div>
          </div>
          <div class="field" style="margin:14px 0">Sexe ${seg("sexe", [["homme", "Homme"], ["femme", "Femme"]])}</div>
          <div class="form-grid">
            <label class="field">Âge<input id="profil-age" type="number" inputmode="numeric" min="3" max="99" data-action="member-input" data-id="${esc(p.id)}" data-field="age" value="${esc(p.age)}" placeholder="30"></label>
            <label class="field">Poids (kg)<input id="profil-poids" type="number" inputmode="decimal" min="10" max="250" step="0.5" data-action="member-input" data-id="${esc(p.id)}" data-field="poids" value="${esc(p.poids)}" placeholder="75"></label>
            <label class="field">Taille (cm)<input id="profil-taille" type="number" inputmode="numeric" min="80" max="230" data-action="member-input" data-id="${esc(p.id)}" data-field="taille" value="${esc(p.taille)}" placeholder="178"></label>
            <div class="field">Repas par jour ${seg("repas", [[2, "2"], [3, "3"], [4, "4"], [5, "5"]])}</div>
          </div>
        </div>
        <div class="panel">
          <h2>Activité</h2>
          <div class="choices">${Object.entries(C.ACTIVITY).map(([k, a]) =>
            `<button type="button" class="choice" data-action="member" data-id="${esc(p.id)}" data-field="activite" data-value="${k}" aria-pressed="${p.activite === k}"><b>${a.label}</b><span>${a.hint}</span></button>`).join("")}</div>
        </div>
        <div class="panel">
          <h2>Objectif</h2>
          <div class="choices cols-2">${Object.entries(C.GOALS).map(([k, g]) =>
            `<button type="button" class="choice" data-action="member" data-id="${esc(p.id)}" data-field="objectif" data-value="${k}" aria-pressed="${p.objectif === k}"><span class="emoji" aria-hidden="true">${{ seche: "🔥", recompo: "🔄", maintien: "⚖️", masse: "🏋️" }[k]}</span><b>${g.label}</b><span>${g.hint}</span></button>`).join("")}</div>
        </div>
        <div class="panel">
          <h2>Allergies et intolérances</h2>
          <div class="chips-select">${Object.entries(C.ALLERGENS).map(([k, a]) => pref("allergies", k, esc(a.label), pr.allergies.includes(k))).join("")}</div>
          <p class="hint">Détection d'après les noms des ingrédients : vérifiez toujours les étiquettes des produits.</p>
        </div>
        <div class="panel">
          <h2>Régime</h2>
          <div class="chips-select">${Object.entries(C.DIETS).map(([k, d]) => pref("regimes", k, `${esc(d.label)}${d.hint ? `<small> · ${esc(d.hint)}</small>` : ""}`, pr.regimes.includes(k))).join("")}</div>
        </div>
        <div class="panel">
          <h2>Petit-déjeuner</h2>
          <div class="segmented" role="group">${[["sucre", "🍯 Sucré"], ["sale", "🧂 Salé"], ["les-deux", "Les deux"]].map(([v, l]) =>
            pref("petitdej", v, l, pr.petitdej === v).replace('class="chip"', "")).join("")}</div>
        </div>
        <div class="panel">
          <h2>Ingrédients détestés</h2>
          <select id="member-deteste" data-action="member-dislike" data-id="${esc(p.id)}" aria-label="Ajouter un ingrédient détesté">
            <option value="">Choisir un ingrédient…</option>
            ${options.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}
          </select>
          ${pr.deteste.length ? `<div class="chips-select" style="margin-top:12px">${pr.deteste.map((x) =>
            `<button type="button" class="chip removable" data-action="member-undislike" data-id="${esc(p.id)}" data-value="${esc(x)}" aria-label="Retirer ${esc(x)}">${esc(x)} ✕</button>`).join("")}</div>`
            : `<p class="hint">Les recettes qui en contiennent seront masquées.</p>`}
        </div>
        ${state.members.length > 1 ? `<button class="btn ghost danger" data-action="delete-member" data-id="${esc(p.id)}">Supprimer ce profil</button>` : ""}
      </div>
      <aside class="panel sticky">
        <h2>Besoins de ${esc(p.nom)} par jour</h2>
        ${daily ? `
          <div class="targets">
            <div class="kpi"><b>${num(daily.kcal)}</b><span>kcal</span></div>
            <div class="kpi"><b>${num(daily.proteines)} g</b><span>protéines</span></div>
            <div class="kpi"><b>${num(daily.glucides)} g</b><span>glucides</span></div>
            <div class="kpi"><b>${num(daily.lipides)} g</b><span>lipides</span></div>
          </div>
          <h3 style="font-size:1rem;margin:16px 0 4px">Par repas (${p.repas || 3} par jour)</h3>
          <div class="total-line"><span>Énergie</span><span>${num(meal.kcal)} kcal</span></div>
          <div class="total-line"><span>Protéines</span><span>${num(meal.proteines)} g</span></div>
          <p class="hint">Métabolisme de base ${num(daily.bmr)} kcal (formule de Mifflin-St Jeor), dépense estimée ${num(daily.tdee)} kcal.
            Protéines : ${num(C.GOALS[p.objectif].proteines, 1)} g par kg ; lipides : au moins 25 % des calories. Ce sont des repères pour adultes, pas un avis médical.</p>`
        : `<p class="muted">Renseignez l'âge, le poids et la taille pour calculer les besoins.</p>`}
        <a class="btn primary block" href="#/profil" style="margin-top:12px">✓ Terminé</a>
      </aside>
    </div>`;
}

function viewCreate(id) {
  const editing = id ? state.custom.find((r) => r.id === id) : null;
  const draft = ui.draft || (ui.draft = editing
    ? { id: editing.id, nom: editing.nom, portions: editing.portions, texte: editing.ingredients.join("\n") }
    : { id: null, nom: "", portions: 2, texte: "" });
  return `<a class="back" href="#/">← Recettes</a>
    <div class="page-head"><h1>${editing ? "Modifier ma recette" : "Créer ma recette"}</h1></div>
    <div class="two-cols free">
      <div class="panel">
        <label class="field" style="margin-bottom:12px">Nom<input type="text" data-action="draft" data-field="nom" value="${esc(draft.nom)}" placeholder="Mon bowl du dimanche"></label>
        <label class="field" style="margin-bottom:12px">Couverts<input type="number" min="1" max="20" data-action="draft" data-field="portions" value="${esc(draft.portions)}"></label>
        <label class="field">Ingrédients — un par ligne
          <textarea data-action="draft" data-field="texte" spellcheck="false" placeholder="300 g filet de poulet&#10;150 g riz basmati&#10;200 g brocolis&#10;2 oeufs @60g">${esc(draft.texte)}</textarea></label>
        <details class="syntax"><summary>Format des lignes</summary>
          <p><code>200 g blanc de poulet</code> — unités : g, kg, ml, cl, l.<br><code>2 oeufs @60g</code> — pièces, avec le poids d'une pièce.<br>
          Comptez le riz et les pâtes en poids sec.</p></details>
        <div class="actions" style="margin-top:14px">
          <button class="btn primary" data-action="save-draft">${editing ? "Enregistrer" : "Ajouter à mes recettes"}</button>
          <button class="btn" data-action="share-draft">Copier le lien</button>
          ${editing ? `<button class="btn ghost" data-action="delete-custom" data-id="${esc(editing.id)}">Supprimer</button>` : ""}
        </div>
      </div>
      <div id="draft-preview">${draftPreview(draft)}</div>
    </div>`;
}

function draftPreview(draft) {
  const r = { id: draft.id || "brouillon", portions: Math.max(1, +draft.portions || 1), ingredients: C.parseLines(draft.texte) };
  if (!r.ingredients.length) return `<div class="panel"><p class="muted">Tapez vos ingrédients : le coût et les macros s'affichent ici.</p></div>`;
  const res = compute(r, { p: r.portions, t: 1 });
  const { meal } = targets();
  return `<div class="panel">
    <div class="kpis">
      <div class="kpi"><b>${num(res.perPortion.macros[0])}</b><span>kcal / portion</span></div>
      <div class="kpi"><b>${num(res.perPortion.macros[1])} g</b><span>protéines</span></div>
      <div class="kpi"><b>${euro(res.perPortion.cost)}</b><span>par personne</span></div>
    </div>
    ${macroBars(res.perPortion.macros, meal)}
  </div>
  <div class="panel"><h2>Produits du Drive</h2>${ingredientsHtml(res.lines)}</div>`;
}

function viewProducts() {
  const q = ui.productQuery || "";
  const sort = ui.productSort || "pertinence";
  const hits = C.queryTokens(q).length ? C.search(cat, q, { sort }) : [];
  return `<a class="back" href="#/">← Recettes</a>
    <div class="page-head"><h1>Produits du Drive</h1></div>
    <div class="toolbar">
      <input id="product-search" class="search" type="search" data-action="product-query" placeholder="Skyr, thon, flocons d'avoine…" value="${esc(q)}" autocomplete="off" aria-label="Rechercher un produit">
      <div class="chips" role="group" aria-label="Trier">${[["pertinence", "Pertinence"], ["prix-kg", "Prix au kilo"], ["proteines-euro", "Protéines par euro"], ["proteines", "Protéines / 100 g"]]
        .map(([v, l]) => `<button class="chip" data-action="product-sort" data-sort="${v}" aria-pressed="${sort === v}">${l}</button>`).join("")}</div>
    </div>
    <p class="muted">${q ? `${hits.length.toLocaleString("fr-FR")} produits${hits.length > 60 ? " — 60 premiers affichés" : ""}` : `${cat.products.length.toLocaleString("fr-FR")} produits relevés au ${esc(cat.magasin.nom)}.`}</p>
    <div class="products">${hits.slice(0, 60).map((p) => {
      const m = p.macros;
      const ppe = C.proteinPerEuro(p);
      return `<article class="product">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" width="56" height="56">` : "<span></span>"}
        <div><h3>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.nom)}</a>` : esc(p.nom)}</h3>
          <div><strong>${euro(p.prix)}</strong> <span class="muted">${esc(unitLabel(p))}</span></div>
          <div class="muted" style="font-size:.8rem">${esc(p.conditionnement)}${p.promo ? ` · <span style="color:var(--brand);font-weight:800">${esc(p.promo)}</span>` : ""}</div></div>
        <div class="nutri">${m ? `<span>${num(m[0])} kcal</span><span>P ${num(m[1], 1)}</span><span>G ${num(m[2], 1)}</span><span>L ${num(m[3], 1)}</span>${ppe > 0 ? `<span>${num(ppe)} g prot./€</span>` : ""}` : "<span>macros non renseignées</span>"}<span>/ 100 g</span></div>
      </article>`;
    }).join("")}</div>`;
}

function notFound() {
  return `<div class="empty"><div class="big-emoji">🤔</div><p>Cette page n'existe pas (ou plus).</p><a class="btn primary" href="#/">Retour aux recettes</a></div>`;
}

// ---------- Navigation ----------

const ROUTES = [
  [/^#?\/?$/, () => viewRecipes(), "recettes"],
  [/^#\/recette\/(.+)$/, (m) => viewRecipe(decodeURIComponent(m[1])), "recettes"],
  [/^#\/cuisine\/(.+)$/, (m) => viewCook(decodeURIComponent(m[1])), "recettes"],
  [/^#\/menu$/, () => viewMenu(), "menu"],
  [/^#\/courses$/, () => viewCourses(), "courses"],
  [/^#\/profil$/, () => viewProfil(), "profil"],
  [/^#\/profil\/(.+)$/, (m) => viewMember(decodeURIComponent(m[1])), "profil"],
  [/^#\/creer(?:\/(.+))?$/, (m) => viewCreate(m[1] && decodeURIComponent(m[1])), "recettes"],
  [/^#\/produits$/, () => viewProducts(), "recettes"],
];

let lastHash = null;
function render({ keepScroll = false } = {}) {
  const hash = location.hash || "#/";
  // anciens liens partagés : #r=<recette du mode libre>
  const legacy = hash.match(/^#r=(.+)$/);
  if (legacy) {
    try {
      const r = C.decode(legacy[1]);
      ui.draft = { id: null, nom: r.nom || "", portions: r.portions || 2, texte: r.texte || "" };
    } catch { /* lien abîmé */ }
    location.replace("#/creer");
    return;
  }
  const route = ROUTES.find(([re]) => re.test(hash));
  const view = $("#view");
  const active = document.activeElement;
  const focusId = active && view.contains(active) ? active.id : null;
  const caret = focusId ? active.selectionStart : null;
  view.innerHTML = route ? route[1](hash.match(route[0])) : notFound();
  document.querySelectorAll(".nav a").forEach((a) => {
    if (route && a.dataset.route === route[2]) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (hash !== lastHash) {
    if (!keepScroll) window.scrollTo(0, 0);
    if (!/^#\/cuisine/.test(hash)) ui.cookStep = 0;
    lastHash = hash;
  } else if (focusId) {
    // re-rendu pendant une saisie : on garde le champ actif et la position du curseur
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (caret != null) try { el.setSelectionRange(caret, caret); } catch { /* champ numérique */ }
    }
  }
}

function updateCounts() {
  $("#menu-count").textContent = Object.keys(state.menu).length || "";
}

// ---------- Actions ----------

function toggleMenu(id) {
  const r = recipeById(id);
  if (!r) return;
  if (state.menu[id]) {
    delete state.menu[id];
    toast(`Retiré du menu : ${r.nom}`);
  } else {
    state.menu[id] = { ...(ui.view[id] || { p: present().length > 1 ? householdSize() : r.portions, t: 1 }) };
    toast(`Ajouté au menu : ${r.nom}`);
  }
  save();
  render({ keepScroll: true });
}

function setServing(id, change) {
  const r = recipeById(id);
  const s = { ...servingOf(r), ...change(servingOf(r)) };
  if (state.menu[id]) state.menu[id] = s; else ui.view[id] = s;
  save();
  render({ keepScroll: true });
}

function setupDone() {
  try { return localStorage.getItem(CART_SETUP_KEY) === "1"; } catch { return false; }
}

async function prepareBookmarklet() {
  try {
    const code = await (await fetch("carrefour-panier.js", { cache: "no-cache" })).text();
    $("#bookmarklet").href = "javascript:" + encodeURIComponent(`window.__recetteMacrosBookmarklet=1;${code}`);
  } catch { /* le favori reste inactif, l'option 1 fonctionne toujours */ }
}

function sendToCart(nom, list) {
  if (!list.some((e) => !e.owned && e.packs)) return toast("Rien à ajouter au panier.");
  const url = C.cartUrl(cat, nom, list);
  if (setupDone()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const dialog = $("#cart-dialog");
  prepareBookmarklet();
  dialog.addEventListener("close", function onClose() {
    dialog.removeEventListener("close", onClose);
    if (dialog.returnValue !== "send") return;
    if ($("#cart-dialog-skip").checked) {
      try { localStorage.setItem(CART_SETUP_KEY, "1"); } catch { /* sans effet */ }
    }
    window.open(url, "_blank", "noopener");
  });
  dialog.showModal();
}

function changed() {
  scoreCache.clear();
  save();
}

function memberById(id) { return state.members.find((x) => x.id === id); }

function updateMember(id, field, value) {
  const m = memberById(id);
  if (!m) return;
  m[field] = ["age", "poids", "taille", "repas"].includes(field) ? (value === "" ? "" : +value) : value;
  changed();
}

function toggleMemberPref(id, field, value) {
  const p = memberById(id)?.prefs;
  if (!p) return;
  if (field === "petitdej") p.petitdej = value;
  else if (field === "regimes") {
    // « Aucun » exclut les autres régimes ; végétalien inclut végétarien, etc. : on laisse cumuler
    const set = new Set(p.regimes.filter((d) => d !== "aucun"));
    if (value === "aucun") set.clear(); else if (set.has(value)) set.delete(value); else set.add(value);
    p.regimes = set.size ? [...set] : ["aucun"];
  } else {
    p[field] = p[field].includes(value) ? p[field].filter((x) => x !== value) : [...p[field], value];
  }
  changed();
}

function addMember(fields = {}) {
  const n = state.members.length;
  const m = newMember({ nom: n ? `Membre ${n + 1}` : "Moi", emoji: AVATARS[n % AVATARS.length], ...fields });
  state.members.push(m);
  changed();
  return m;
}

// Seul / couple / famille : ajuste le nombre de membres présents (sans supprimer de profil)
function setHouseholdMode(mode) {
  const want = MODES[mode][2];
  if (!state.members.length) addMember();
  state.members.forEach((m, i) => { m.present = mode === "famille" ? m.present || i < want : i < want; });
  while (present().length < want) addMember({ present: true });
  if (mode === "seul" && !present().length) state.members[0].present = true;
  if (!present().some((m) => m.id === state.rankFor)) state.rankFor = null;
  changed();
}

function saveDraft() {
  const d = ui.draft;
  const lines = C.parseLines(d.texte);
  if (!lines.length) return toast("Ajoutez au moins un ingrédient.");
  let r = d.id && state.custom.find((x) => x.id === d.id);
  if (r) {
    Object.assign(r, { nom: d.nom || "Ma recette", portions: Math.max(1, +d.portions || 1), ingredients: lines });
  } else {
    r = customFromText(d.nom, d.portions, d.texte);
    state.custom.unshift(r);
  }
  statsCache.clear();
  save();
  ui.draft = null;
  location.hash = `#/recette/${encodeURIComponent(r.id)}`;
  toast("Recette enregistrée.");
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || ["SELECT", "INPUT", "TEXTAREA"].includes(el.tagName)) return;
  const { action, id } = el.dataset;
  switch (action) {
    case "toggle-menu": e.preventDefault(); toggleMenu(id); break;
    case "servings": setServing(id, (s) => ({ p: Math.min(20, Math.max(1, s.p + +el.dataset.delta)) })); break;
    case "adapt": {
      const t = +el.dataset.size;
      const p = +el.dataset.people || servingOf(recipeById(id)).p;
      setServing(id, () => ({ t, p }));
      toast(t === 1 && !el.dataset.people ? "Portion standard" : present().length > 1 ? `Adaptée au foyer : ${p} couverts` : `Portions ×${num(t, 2)} pour votre objectif`);
      break;
    }
    case "tag": ui.tag = el.dataset.tag || null; render({ keepScroll: true }); break;
    case "cook-step": ui.cookStep = Math.max(0, ui.cookStep + +el.dataset.delta); render(); break;
    case "member": updateMember(id, el.dataset.field, el.dataset.value); render({ keepScroll: true }); break;
    case "member-pref": toggleMemberPref(id, el.dataset.field, el.dataset.value); render({ keepScroll: true }); break;
    case "member-undislike": toggleMemberPref(id, "deteste", el.dataset.value); render({ keepScroll: true }); break;
    case "add-member": location.hash = `#/profil/${encodeURIComponent(addMember().id)}`; break;
    case "delete-member":
      state.members = state.members.filter((m) => m.id !== id);
      if (!present().length && state.members[0]) state.members[0].present = true;
      changed();
      location.hash = "#/profil";
      toast("Profil supprimé.");
      break;
    case "household-mode": setHouseholdMode(el.dataset.value); render({ keepScroll: true }); break;
    case "foyer-materiel": {
      const set = new Set(state.foyer.materiel || Object.keys(C.EQUIPMENT));
      if (set.has(el.dataset.value)) set.delete(el.dataset.value); else set.add(el.dataset.value);
      state.foyer.materiel = set.size === Object.keys(C.EQUIPMENT).length ? null : [...set];
      changed();
      render({ keepScroll: true });
      break;
    }
    case "show-all": ui.showAll = !ui.showAll; render({ keepScroll: true }); break;
    case "send-recipe": {
      const r = recipeById(id);
      sendToCart(r.nom, C.shoppingList(compute(r).lines, { exclude: new Set(state.owned) }));
      break;
    }
    case "send-menu": {
      const { entries, list } = menuShopping();
      sendToCart(entries.length === 1 ? entries[0].r.nom : `Menu de ${entries.length} recettes`, list);
      break;
    }
    case "save-draft": saveDraft(); break;
    case "share-draft": {
      const url = `${location.origin}${location.pathname}#r=${C.encode(ui.draft)}`;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast("Lien copié."), () => toast("Copie impossible."));
      break;
    }
    case "delete-custom":
      state.custom = state.custom.filter((r) => r.id !== id);
      delete state.menu[id];
      save();
      ui.draft = null;
      location.hash = "#/";
      toast("Recette supprimée.");
      break;
    case "product-sort": ui.productSort = el.dataset.sort; render({ keepScroll: true }); break;
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.action === "pin") {
    state.pins[el.dataset.key] = el.value;
    statsCache.clear();
    save();
    if (ui.draft) $("#draft-preview").innerHTML = draftPreview(ui.draft);
    else render({ keepScroll: true });
  } else if (el.dataset.action === "member-present") {
    const m = memberById(el.dataset.id);
    m.present = el.checked;
    if (!present().length) { m.present = true; toast("Au moins une personne doit être présente."); }
    changed();
    render({ keepScroll: true });
  } else if (el.dataset.action === "member-dislike") {
    if (el.value) toggleMemberPref(el.dataset.id, "deteste", el.value);
    render({ keepScroll: true });
  } else if (el.dataset.action === "rank-for") {
    state.rankFor = el.value;
    changed();
    render({ keepScroll: true });
  } else if (el.dataset.action === "owned") {
    const set = new Set(state.owned);
    if (el.checked) set.add(el.dataset.ean); else set.delete(el.dataset.ean);
    state.owned = [...set];
    save();
    render({ keepScroll: true });
  }
});

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const rerenderSoon = debounce(() => render({ keepScroll: true }), 220);
const previewSoon = debounce(() => { const el = $("#draft-preview"); if (el && ui.draft) el.innerHTML = draftPreview(ui.draft); }, 250);

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "recipe-search") { ui.query = el.value; rerenderSoon(); }
  else if (el.dataset.action === "product-query") { ui.productQuery = el.value; rerenderSoon(); }
  else if (el.dataset.action === "member-input") { updateMember(el.dataset.id, el.dataset.field, el.value); rerenderSoon(); }
  else if (el.dataset.action === "foyer-input") { state.foyer[el.dataset.field] = el.value; changed(); rerenderSoon(); }
  else if (el.dataset.action === "draft") { ui.draft[el.dataset.field] = el.value; previewSoon(); }
});

document.addEventListener("keydown", (e) => {
  if (!/^#\/cuisine/.test(location.hash)) return;
  if (e.key === "ArrowRight") { ui.cookStep++; render(); }
  if (e.key === "ArrowLeft") { ui.cookStep = Math.max(0, ui.cookStep - 1); render(); }
});

$("#bookmarklet").addEventListener("click", (e) => {
  e.preventDefault();
  toast("Glissez ce bouton dans la barre de favoris.");
});

window.addEventListener("hashchange", () => {
  if (!/^#\/creer/.test(location.hash)) ui.draft = null;
  render();
});

async function init() {
  updateCounts();
  try {
    const [catalogue, recettes] = await Promise.all([
      fetch("data/catalogue.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`catalogue (${r.status})`); return r.json(); }),
      fetch("recettes.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`recettes (${r.status})`); return r.json(); }),
    ]);
    cat = C.loadCatalogue(catalogue);
    book = { tags: recettes.tags, recettes: recettes.recettes, byId: new Map(recettes.recettes.map((r) => [r.id, r])) };
  } catch (e) {
    $("#view").innerHTML = `<div class="empty"><div class="big-emoji">😕</div><p>Impossible de charger le site : ${esc(e.message)}</p></div>`;
    return;
  }
  // une recette retirée du catalogue ne doit pas rester dans le menu
  for (const id of Object.keys(state.menu)) if (!recipeById(id)) delete state.menu[id];
  save();
  $("#footer").innerHTML = `Prix relevés chaque semaine au ${esc(cat.magasin.nom)} (relevé du ${new Date(cat.maj).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}, ${cat.products.length.toLocaleString("fr-FR")} produits).
    Macros : Open Food Facts ou valeurs moyennes Ciqual (*). <a href="#/produits">Chercher un produit</a>.`;
  render();
}

init();
