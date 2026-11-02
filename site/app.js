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
const ui = { tag: null, query: "", view: {}, cookStep: 0, showAll: false, folds: {} };

function loadState() {
  const base = { menu: {}, pins: {}, owned: [], members: [], foyer: { budget: "", temps: "", materiel: null }, rankFor: null, group: null,
    custom: [], strategy: "pertinence", pantryBuy: [], keepAwake: true, formatKeep: [],
    favs: [], fridge: [], plan: {} };
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
// Pour qui on cuisine : les personnes cochées sur l'accueil (par défaut, les membres présents du foyer).
// Le top 3, la compatibilité des recettes et le « Pour qui ? » des fiches en dépendent.
function group() {
  const g = (state.group || []).map((id) => state.members.find((m) => m.id === id)).filter(Boolean);
  return g.length ? g : present();
}
const groupLabel = (n) => (n <= 1 ? "Seul" : n === 2 ? "Couple" : "Famille");
function me() { return group().find((m) => C.dailyTargets(m)) || group()[0] || state.members[0] || null; }
function householdSize() { return Math.max(1, group().length); }
function prefs() { return C.householdPrefs(group(), state.foyer); }

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

// Jours de la semaine : 0 = lundi
const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const today = () => (new Date().getDay() + 6) % 7;
const isSportDay = (m, d = today()) => !!m && (m.sportDays || []).includes(d);

// Besoins d'un membre pour un jour (aujourd'hui par défaut : jour de sport ou de repos), ou en moyenne (day = null)
function targets(member = me(), day = today()) {
  const daily = member ? C.memberDaily(member, day) : null;
  return { daily, meal: daily ? C.mealTarget(daily, member.repas || 3) : null };
}

// Pour qui ? who : membres servis, chacun avec la portion de son objectif ; guests : portions standard en plus.
// Ce qui est enregistré (menu ou fiche) ; par défaut, les membres présents du foyer.
function storedServing(r) {
  return state.menu[r.id] || ui.view[r.id] || { who: group().map((m) => m.id), guests: 0 };
}

// Couverts (p) et taille moyenne des portions (t), recalculés à partir des profils actuels
function servingOf(r) {
  const s = storedServing(r);
  if (!s.who) return { p: s.p, t: s.t || 1, sizes: [], guests: 0 }; // anciens menus : couverts simples
  const members = s.who.map(memberById).filter(Boolean);
  const sizes = isSnack(r)
    ? members.map((m) => ({ id: m.id, nom: m.nom, size: 1, meal: targets(m).meal }))
    : C.memberPortions(stats(r).macros[0], members, today());
  const guests = s.guests || 0;
  const p = sizes.length + guests;
  if (!p) return { who: [], p: 1, t: 1, sizes: [], guests: 1 };
  return { who: s.who, guests, p, t: (sizes.reduce((a, x) => a + x.size, 0) + guests) / p, sizes };
}

// Ce qu'on enregistre : qui et combien d'invités, pas le résultat (il suit les profils)
const servingToStore = (s) => (s.who ? { who: [...s.who], guests: s.guests || 0 } : { p: s.p, t: s.t });

function compute(r, serving = servingOf(r)) {
  const factor = (serving.p * serving.t) / r.portions;
  const lines = C.computeLines(cat, r.ingredients, { factor, pins: state.pins, strategy: state.strategy, keyPrefix: `${r.id}:` });
  const t = C.totals(lines);
  return {
    lines, ...t, serving,
    perPortion: { cost: t.cost / serving.p, macros: t.macros.map((v) => v / serving.p), nutriments: t.nutriments.map((v) => v / serving.p), nutrientCoverage: t.nutrientCoverage },
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
// Note d'une personne : objectif et portion adaptée, ajustée au budget, au temps et au petit-déj préféré
function memberScore(r, m) {
  const { daily } = targets(m);
  if (!daily) return null;
  const key = `${r.id}|${r.ingredients.join("\n")}|${m.id}|${m.objectif}|${daily.kcal}|${m.prefs.petitdej}|${state.strategy}|${prefs().budget}|${prefs().temps}`;
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

// Note pour le groupe : moyenne des notes de chacun, tirée vers la plus basse pour qu'un plat
// convienne à tout le monde et pas seulement à l'un d'eux.
function scoreOf(r) {
  const per = group().map((m) => ({ m, sc: memberScore(r, m) })).filter((x) => x.sc);
  if (!per.length) return null;
  if (per.length === 1) return { ...per[0].sc, members: per };
  const scores = per.map((x) => x.sc.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    score: Math.round(0.6 * mean + 0.4 * Math.min(...scores)),
    flags: [...new Set(per.flatMap((x) => x.sc.flags))],
    members: per,
  };
}
const byScore = (a, b) => (scoreOf(b)?.score ?? -1) - (scoreOf(a)?.score ?? -1);

function fitLabel(r, kcalPP, meal) {
  const sc = scoreOf(r);
  if (sc && sc.members.length > 1 && kcalPP && !isSnack(r)) {
    return `<span class="fit" title="Portion conseillée pour chacun">${sc.members.map(({ m, sc: x }) => `${esc(m.emoji)} ×${num(x.size, x.size % 1 ? 2 : 0)}`).join(" · ")}</span>`;
  }
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

const isFav = (r) => state.favs.includes(r.id);
const favButton = (r, cls = "fav") => `<button type="button" class="${cls}" data-action="toggle-fav" data-id="${esc(r.id)}" aria-pressed="${isFav(r)}"
  aria-label="${isFav(r) ? "Retirer des favoris" : "Ajouter aux favoris"} : ${esc(r.nom)}">${isFav(r) ? "♥" : "♡"}${cls === "fav" ? "" : " Favori"}</button>`;

function cardHtml(r, meal, rank = null, extra = "") {
  const s = stats(r);
  const inMenu = !!state.menu[r.id];
  const sc = scoreOf(r);
  return `<article class="card">
    ${favButton(r)}
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
        ${extra}
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

const thumb = (p) => (p && p.image
  ? `<img class="ing-img" src="${esc(p.image)}" alt="" loading="lazy" width="56" height="56">`
  : `<span class="ing-img ph" aria-hidden="true">🛍️</span>`);

// Ingrédients en vignettes rondes, quantité et nom dessous (façon Jow)
function ingredientGrid(lines) {
  return `<ul class="ing-grid">${lines.map((x) => `<li${x.error || !x.product ? ' class="missing"' : ""}>
    <span class="ing-round">${x.product?.image ? `<img src="${esc(x.product.image)}" alt="" loading="lazy" width="64" height="64">` : "🛍️"}</span>
    ${x.ing.optional ? `<span class="badge-opt">Facultatif</span>` : ""}
    <b>${x.error ? "?" : esc(C.quantityLabel(x.ing))}</b><span>${esc(x.ing.name || x.ing.raw)}</span></li>`).join("")}</ul>`;
}

// Fibres, sucres, acides gras saturés, sel : quantités, et repères du jour si on les donne (targets)
function nutrientRows(values, targets = null, coverage = 1) {
  if (!values) return "";
  return `<div class="nutrients">${C.NUTRIENT_INFO.map((n, i) => {
    const v = values[i];
    const t = targets && targets[i];
    const state = !t ? "" : n.kind === "min" ? (v >= t ? "ok" : "low") : v > t ? "over" : "ok";
    return `<div class="nutrient ${state}"><span>${n.label}</span>
      ${t ? `<div class="bar n" role="img" aria-label="${n.label} : ${num(v, 1)} g, repère ${n.kind === "min" ? "au moins" : "au plus"} ${num(t)} g"><i style="width:${Math.min(100, (v / t) * 100)}%"></i></div>` : ""}
      <small>${num(v, v < 10 ? 1 : 0)} g${t ? ` / ${n.kind === "min" ? "≥" : "≤"} ${num(t)}` : ""}</small></div>`;
  }).join("")}${coverage < 0.9 ? `<p class="hint">Nutriments connus pour ${num(coverage * 100)} % des calories : valeurs minimales.</p>` : ""}</div>`;
}

function ingredientsHtml(lines) {
  return `<ul class="ingredients">${lines.map((x) => {
    if (x.error) return `<li>${thumb(null)}<div><div class="ing-head"><span>${esc(x.ing.raw)}</span></div><div class="error">${esc(x.error)}</div></div></li>`;
    if (!x.product) {
      return `<li>${thumb(null)}<div><div class="ing-head"><span>${esc(x.ing.raw)}</span><span class="price">—</span></div>
        <div class="error">Aucun produit trouvé au Drive${x.ing.pieces != null && x.ing.grams == null ? " (indiquez un poids : « 2 oeufs @60g »)" : ""}</div></div></li>`;
    }
    const options = x.choices.map((p) =>
      `<option value="${esc(p.ean)}"${p === x.product ? " selected" : ""}>${esc(p.nom)} — ${euro(p.prix)} (${esc(unitLabel(p))})${p.promo ? " · " + esc(p.promo) : ""}</option>`).join("");
    return `<li>${thumb(x.product)}<div>
      <div class="ing-head"><span>${esc(x.ing.raw)}</span><span class="price">${euro(x.cost)}</span></div>
      <select class="product-select" data-action="pin" data-key="${esc(x.key)}" aria-label="Produit pour ${esc(x.ing.name)}">${options}</select>
      <div class="ing-note">${x.macros ? `${num(x.macros[0])} kcal · P ${num(x.macros[1], 1)} g` : "macros inconnues"}${x.generic ? " · valeurs moyennes *" : ""}${x.product.promo ? ` · <span class="promo">${esc(x.product.promo)}</span>` : ""}</div>
    </div></li>`;
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
    if (ui.tag === "favoris") { if (!isFav(r)) return false; }
    else if (ui.tag && !(r.tags || []).includes(ui.tag)) return false;
    if (!q.length) return true;
    const w = C.words(`${r.nom} ${r.ingredients.join(" ")} ${(r.tags || []).map((t) => book.tags[t] || t).join(" ")}`);
    return q.every((t) => w.some((x) => x.startsWith(t)));
  });
  const tags = Object.entries({ ...(state.favs.length ? { favoris: "♥ Favoris" } : {}), ...book.tags, ...(state.custom.length ? { perso: "Mes recettes" } : {}) });
  if (daily) {
    // mêmes règles que les rangées « top 3 » : dans un filtre de repas, les plats passent avant les collations
    list.sort((a, b) => (ui.tag && ui.tag !== "favoris" ? eligibleForTop(b, ui.tag) - eligibleForTop(a, ui.tag) : 0) || byScore(a, b));
  }
  const showTops = daily && !ui.tag && !q.length;
  const favs = allRecipes().filter(isFav);
  const favRow = !ui.tag && !q.length && favs.length ? `<div class="top-row">
      <div class="top-head"><h3>♥ Vos favoris</h3><button class="link-btn" data-action="tag" data-tag="favoris">Tout voir →</button></div>
      <div class="top-cards">${favs.slice(0, 6).map((r) => cardHtml(r, meal)).join("")}</div>
    </div>` : "";
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
          ? `<a class="goal-pill" href="#/profil">${group().length > 1 ? `👥 ${groupLabel(group().length)} : ${esc(listNames(group()))}` : `${isSportDay(m) ? "🏋️ Jour de sport" : "🎯"} ${esc(m.nom)} : ${C.GOALS[m.objectif]?.label || "Objectif"} · ${num(daily.kcal)} kcal · ${num(daily.proteines)} g de protéines aujourd'hui`}</a>`
          : `<a class="goal-pill" href="#/profil">💪 Créer mon profil et calculer mes besoins →</a>`}
      </div>
      <div class="hero-art" aria-hidden="true">🥗</div>
    </section>
    <div class="toolbar">
      <label class="sr-only" for="recipe-search">Rechercher une recette</label>
      <input id="recipe-search" class="search" type="search" placeholder="Poulet, pâtes, petit-déj…" value="${esc(ui.query)}" autocomplete="off">
      <div class="suggestions">
        ${ui.query ? "" : `<span class="muted">Suggestions</span>${searchSuggestions().map((x) => `<button class="chip small" data-action="suggest" data-q="${esc(x)}">${esc(x)}</button>`).join("")}`}
        <a class="chip small fridge-link" href="#/frigo">🧊 Avec ce que j'ai${state.fridge.length ? ` (${state.fridge.length})` : ""}</a>
      </div>
      <div class="chips" role="group" aria-label="Filtrer">
        <button class="chip" data-action="tag" data-tag="" aria-pressed="${!ui.tag}">Toutes</button>
        ${tags.map(([k, v]) => `<button class="chip" data-action="tag" data-tag="${esc(k)}" aria-pressed="${ui.tag === k}">${esc(v)}</button>`).join("")}
      </div>
    </div>
    ${favRow && !showTops ? `<section class="for-you">${favRow}</section>` : ""}
    ${showTops ? `<section class="for-you" aria-labelledby="for-you-title">
      <div class="for-you-head">
        <h2 id="for-you-title">Le top 3 ${group().length > 1 ? `en ${groupLabel(group().length).toLowerCase()}` : "pour vous"}</h2>
      </div>
      ${groupPicker()}
      <p class="muted">${group().length > 1
        ? `Classé pour ${esc(listNames(group()))} : chaque recette est notée pour l'objectif de chacun (protéines, portion adaptée, lipides, prix${prefs().budget || prefs().temps ? ", budget et temps" : ""}), et la note retenue favorise les plats qui conviennent à tous. Seules les recettes compatibles avec les allergies, régimes et dégoûts de ces personnes sont proposées.`
        : `Classé pour l'objectif « ${esc(C.GOALS[m.objectif]?.label || "")} » de ${esc(m.nom)} : protéines, portion adaptée au repas idéal, lipides et prix${prefs().budget || prefs().temps ? ", budget et temps" : ""}.`}
        <a href="#/profil">Modifier le foyer</a></p>
      ${favRow}${tops}
    </section><h2 class="all-title">Toutes les recettes</h2>` : ""}
    <div class="grid">
      ${list.map((r, i) => cardHtml(r, meal, daily && ui.tag && ui.tag !== "favoris" && !q.length && eligibleForTop(r, ui.tag) ? i : null)).join("")}
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

const listNames = (ms) => ms.length <= 1 ? (ms[0]?.nom || "") : `${ms.slice(0, -1).map((x) => x.nom).join(", ")} et ${ms[ms.length - 1].nom}`;

// Choix des personnes à table, sur l'accueil
function groupPicker() {
  if (state.members.length < 2) return "";
  const ids = new Set(group().map((m) => m.id));
  return `<div class="group-picker" role="group" aria-label="Pour qui cuisinez-vous ?">
    <span class="muted">Pour :</span>
    ${state.members.map((x) => `<button type="button" class="who-chip small" data-action="group-member" data-member="${esc(x.id)}" aria-pressed="${ids.has(x.id)}">
      <span class="avatar" aria-hidden="true">${esc(x.emoji)}</span><b>${esc(x.nom)}</b></button>`).join("")}
    <span class="group-label">${groupLabel(ids.size)}</span>
  </div>`;
}

// Suggestions sous la recherche : des ingrédients clés pour le sport, gardés s'ils donnent au moins 3 recettes
const SUGGESTIONS = ["poulet", "skyr", "oeufs", "saumon", "thon", "boeuf", "dinde", "riz", "pâtes", "avoine", "patate douce", "tofu", "lentilles", "wrap", "fromage blanc"];
let suggestionCache = null;
function searchSuggestions() {
  if (!suggestionCache) {
    const texts = book.recettes.map((r) => C.words(`${r.nom} ${r.ingredients.join(" ")}`));
    suggestionCache = SUGGESTIONS.filter((x) => {
      const q = C.queryTokens(x);
      return texts.filter((w) => q.every((t) => w.some((y) => y.startsWith(t)))).length >= 3;
    }).slice(0, 8);
  }
  return suggestionCache;
}

const FRIDGE_QUICK = ["oeufs", "poulet", "riz", "pâtes", "thon", "skyr", "fromage blanc", "avoine", "banane", "tomates", "courgette", "pommes de terre"];

function viewFridge() {
  const items = state.fridge;
  const results = items.length ? allRecipes().filter((r) => compatOf(r).ok)
    .map((r) => ({ r, m: C.fridgeMatch(r.ingredients, items) }))
    .filter((x) => x.m.have.length)
    .sort((a, b) => a.m.missing.length - b.m.missing.length || b.m.ratio - a.m.ratio || byScore(a.r, b.r)) : [];
  const { meal } = targets();
  const complete = results.filter((x) => !x.m.missing.length).length;
  return `<a class="back" href="#/">← Recettes</a>
    <div class="page-head"><h1>Avec ce que j'ai</h1></div>
    <p class="muted">Dites-nous ce qu'il y a dans votre frigo et vos placards : les recettes qui en utilisent le plus passent en premier. Huile, sel et épices sont supposés déjà là.</p>
    <div class="panel fridge-panel">
      <input id="fridge-input" class="search" type="search" list="fridge-options" data-action="fridge-input" placeholder="Ajoutez un ingrédient : poulet, œufs, riz…" autocomplete="off">
      <datalist id="fridge-options">${dislikeOptions().map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
      ${items.length ? `<div class="chips-select" style="margin-top:12px">${items.map((x) =>
        `<button type="button" class="chip removable" data-action="fridge-remove" data-value="${esc(x)}" aria-label="Retirer ${esc(x)}">${esc(x)} ✕</button>`).join("")}
        <button type="button" class="link-btn" data-action="fridge-clear">Tout effacer</button></div>` : ""}
      <div class="chips-select quick" style="margin-top:12px">${FRIDGE_QUICK.filter((x) => !items.includes(x)).map((x) =>
        `<button type="button" class="chip small" data-action="fridge-add" data-value="${esc(x)}">+ ${esc(x)}</button>`).join("")}</div>
    </div>
    ${items.length ? `<p class="muted">${results.length ? `${results.length} recette${results.length > 1 ? "s" : ""} compatible${results.length > 1 ? "s" : ""} avec votre foyer${complete ? `, dont ${complete} sans rien acheter` : ""}.` : "Aucune recette n'utilise ces ingrédients."}</p>
      <div class="grid">${results.slice(0, 36).map(({ r, m }) => cardHtml(r, meal, null,
        `<div class="card-meta fridge-meta"><span class="ok">✓ ${m.have.length}/${m.have.length + m.missing.length}</span>${m.missing.length ? `<span>il manque : ${esc(m.missing.join(", "))}</span>` : `<span class="ok">rien à acheter</span>`}</div>`)).join("")}</div>`
    : `<div class="empty"><div class="big-emoji">🧊</div><p>Ajoutez au moins un ingrédient.</p></div>`}`;
}

function addFridge(value) {
  const v = (value || "").trim().toLowerCase();
  if (!v || state.fridge.includes(v)) return;
  state.fridge = [...state.fridge, v];
  save();
}

// Volets repliables de la fiche : ouverts par défaut sur ordinateur, fermés sur mobile ; on retient le choix
function foldOpen(key, desktopDefault = true) {
  if (key in ui.folds) return ui.folds[key];
  return desktopDefault && window.matchMedia("(min-width: 861px)").matches;
}

function viewRecipe(id) {
  const r = recipeById(id);
  if (!r) return notFound();
  const { meal } = targets();
  const res = compute(r);
  const s = res.serving;
  const inMenu = !!state.menu[r.id];
  const kcalStd = stats(r).macros[0];
  const traits = traitsOf(r);
  const compat = compatOf(r);
  // une portion standard de la recette, telle que calculée pour ces quantités
  const total = s.p * s.t;
  const unit = { cost: res.cost / total, macros: res.macros.map((v) => v / total) };
  const who = new Set(s.who || []);
  // même doublée (portion plafonnée à ×2), la recette reste trop légère pour ces personnes
  const light = isSnack(r) ? [] : s.sizes.filter((x) => x.meal && C.tooLightForMeal(kcalStd, x.meal));
  const main = res.lines.filter((x) => !isSkippable(x) || x.ing.optional);
  const pantry = res.lines.filter((x) => isSkippable(x) && !x.ing.optional);
  const stepIng = C.stepIngredients(r.etapes || [], res.lines.map((x) => x.ing.name || ""));
  const perPerson = res.macros.map((v) => v / s.p);
  return `
    <a class="back" href="#/">← Recettes</a>
    <div class="detail">
      <div>
        ${tileHtml(r, "big rec-tile")}
        <div class="panel rec-ingredients" style="margin-top:16px">
          <h2>Ingrédients <small class="muted">· ${portionsLabel(s.p)}</small></h2>
          ${ingredientGrid(main)}
          ${pantry.length ? `<div class="pantry-box"><b>Vous avez sûrement déjà…</b>
            <div class="chips-select">${pantry.map((x) => pantryChip({ key: pantryKey(x), name: `${x.ing.name} (${C.quantityLabel(x.ing)})`, optional: x.ing.optional, buy: !skippedInCart(x) })).join("")}</div>
            <p class="hint">Comptés dans les macros, mais pas ajoutés au panier. Touchez-en un s'il vous manque.</p></div>` : ""}
          <p class="hint">Quantités pour ${s.sizes.length ? "les personnes choisies, chacune selon son objectif" : `${portionsLabel(s.p)}`}.</p>
          <details class="drive-products fold" data-fold="drive"${foldOpen("drive", false) ? " open" : ""}><summary>🛒 Produits du Drive et prix (${res.lines.filter((x) => x.product).length})</summary>
            ${ingredientsHtml(res.lines)}
            <p class="hint">Produits et prix du ${esc(cat.magasin.nom)} ; changez de produit dans la liste si besoin.</p>
          </details>
        </div>
        ${r.etapes && r.etapes.length ? `<div class="panel rec-steps">
          <h2>Recette</h2>
          <ol class="steps">${r.etapes.map((st, i) => {
            const x = res.lines[(stepIng[i] || []).find((j) => res.lines[j].product?.image) ?? -1];
            return `<li>${x ? `<img class="step-img" src="${esc(x.product.image)}" alt="" loading="lazy" width="40" height="40">` : `<span class="step-img ph" aria-hidden="true">${i + 1}</span>`}
              <div><small>Étape ${i + 1}</small><p>${esc(st)}</p></div></li>`;
          }).join("")}</ol>
          <a class="btn primary" href="#/cuisine/${encodeURIComponent(r.id)}">👩‍🍳 Passer en cuisine</a>
        </div>` : ""}
      </div>
      <div>
        <div class="rec-head">
        <div class="tags">${(r.tags || []).map((t) => `<span class="tag">${esc(book.tags[t] || (t === "perso" ? "Ma recette" : t))}</span>`).join("")}</div>
        <h1>${esc(r.nom)}</h1>
        <p class="muted">${r.temps ? `⏱ ${r.temps} min · ` : ""}${euro(res.cost)} au total · ${euro(res.cost / s.p)} par personne</p>
        ${compat.ok ? "" : `<div class="warning" role="note">⚠️ Pas adaptée à votre foyer : ${esc(compat.reasons.join(", "))}.</div>`}
        <details class="fold" data-fold="infos"${foldOpen("infos", false) ? " open" : ""}>
          <summary>ℹ️ Allergènes et matériel <small class="muted">· ${traits.allergens.length ? `${traits.allergens.length} allergène${traits.allergens.length > 1 ? "s" : ""}` : "sans allergène majeur"}</small></summary>
          <p class="traits">${traits.allergens.length ? `<span>Contient : ${esc(traits.allergens.map((a) => C.ALLERGENS[a].label.toLowerCase()).join(", "))}</span>` : `<span>Sans allergène majeur détecté</span>`}
            ${traits.equipment.length ? `<span>Matériel : ${esc(traits.equipment.map((e) => C.EQUIPMENT[e].label.toLowerCase()).join(", "))}</span>` : `<span>Sans cuisson</span>`}
            <span>${traits.vegetal ? "Végétalien" : traits.meat ? (traits.pork ? "Contient de la viande (porc)" : "Contient de la viande") : traits.fish ? "Pescétarien" : "Végétarien"}</span></p>
          <p class="hint">Détection d'après les noms des ingrédients : vérifiez toujours les étiquettes.</p>
        </details>
        <div class="band" role="list">
          <div role="listitem"><span aria-hidden="true">⏱</span><b>${r.temps ? `${r.temps} min` : "—"}</b><small>en tout</small></div>
          <div role="listitem"><span aria-hidden="true">🔥</span><b>${num(perPerson[0])} kcal</b><small>par personne${s.sizes.length > 1 || s.guests ? " (moy.)" : ""}</small></div>
          <div role="listitem"><span aria-hidden="true">💪</span><b>${num(perPerson[1])} g</b><small>protéines</small></div>
          <div role="listitem"><span aria-hidden="true">💶</span><b>${euro(res.cost / s.p)}</b><small>par personne</small></div>
        </div>
        <div class="actions top-actions">
          <button class="btn primary" data-action="toggle-menu" data-id="${esc(r.id)}">${inMenu ? "✓ Dans mon menu" : "+ Ajouter au menu"}</button>
          <button class="btn" data-action="send-recipe" data-id="${esc(r.id)}">🛒 Panier Carrefour</button>
          ${favButton(r, "btn fav-btn")}
        </div>
        </div>
        <div class="panel rec-who">
          <h2>Pour qui ?</h2>
          ${s.who ? `<div class="who" role="group" aria-label="Personnes servies">${state.members.map((m) => {
            const x = s.sizes.find((z) => z.id === m.id);
            return `<button type="button" class="who-chip" data-action="serve-member" data-id="${esc(r.id)}" data-member="${esc(m.id)}" aria-pressed="${who.has(m.id)}">
              <span class="avatar" aria-hidden="true">${esc(m.emoji)}</span><span><b>${esc(m.nom)}</b><small>${x ? (x.meal ? `portion ×${num(x.size, 2)}` : "portion standard") : "pas servi"}</small></span></button>`;
          }).join("")}
            <div class="guests">${stepperHtml("guests", r.id, `${s.guests} invité${s.guests > 1 ? "s" : ""}`, "small")}</div>
          </div>`
          : `<div class="row">${stepperHtml("servings", r.id, portionsLabel(s.p))}<button class="btn small" data-action="serve-household" data-id="${esc(r.id)}">👥 Servir le foyer</button></div>`}
          <p class="hint">${isSnack(r) ? "Collation : une portion standard chacun, en plus des repas." : "Chaque personne cochée reçoit la portion qui correspond à son repas idéal ; les invités, une portion standard. Les quantités et le panier suivent."}</p>
          <div class="kpis">
            <div class="kpi"><b>${num(s.p)}</b><span>${s.p > 1 ? "personnes" : "personne"}</span></div>
            <div class="kpi"><b>${num(res.macros[0])}</b><span>kcal au total</span></div>
            <div class="kpi"><b>${euro(res.cost)}</b><span>pour le repas</span></div>
          </div>
          <details class="fold" data-fold="apports"${foldOpen("apports") ? " open" : ""}>
          <summary>📊 Apports de chacun <small class="muted">· macros, fibres, sucres, AG saturés, sel</small></summary>
          ${s.sizes.map((x) => {
            const m = memberById(x.id);
            const mac = unit.macros.map((v) => v * x.size);
            return `<div class="member-intake">
              <div class="mi-head"><span><span aria-hidden="true">${esc(m.emoji)}</span> <b>${esc(m.nom)}</b></span>
                <span>${num(mac[0])} kcal${x.meal ? ` / ${num(x.meal.kcal)}` : ""} · ${euro(unit.cost * x.size)}</span></div>
              ${macroBars(mac, isSnack(r) ? null : x.meal)}
              ${nutrientRows(res.nutriments.map((v) => (v / total) * x.size), null, res.nutrientCoverage)}
              ${x.meal ? "" : `<p class="hint"><a href="#/profil/${encodeURIComponent(m.id)}">Complétez le profil de ${esc(m.nom)}</a> pour adapter sa portion.</p>`}
            </div>`;
          }).join("")}
          ${!s.sizes.length || s.guests ? `<div class="member-intake">
              <div class="mi-head"><span><b>${s.sizes.length ? `${s.guests} invité${s.guests > 1 ? "s" : ""}` : "Par portion"}</b></span><span>${num(unit.macros[0])} kcal · ${euro(unit.cost)} chacun</span></div>
              ${macroBars(unit.macros, null)}
              ${nutrientRows(res.nutriments.map((v) => v / total), null, res.nutrientCoverage)}
            </div>` : ""}
          </details>
          ${light.length ? `<p class="hint">Même doublée, cette recette reste légère pour ${esc(light.map((x) => x.nom).join(", "))} : ajoutez un accompagnement (riz, pain, fruit…) ou une collation.</p>` : ""}
          ${res.missingMacros.length ? `<p class="hint">Macros inconnues pour : ${esc(res.missingMacros.join(", "))}.</p>` : ""}
        </div>
        ${r.perso ? `<div class="actions rec-edit" style="margin-top:16px"><a class="btn ghost" href="#/creer/${encodeURIComponent(r.id)}">Modifier ma recette</a></div>` : ""}
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
        ${ingredientGrid(res.lines)}</div>`
    : `<div class="cook-step"><div class="num">Étape ${i} sur ${total - 1}</div><p>${esc(r.etapes[i - 1])}</p>
        ${(() => {
          const used = C.stepIngredients([r.etapes[i - 1]], res.lines.map((x) => x.ing.name || ""))[0].map((j) => res.lines[j]).filter((x) => !x.error);
          return used.length ? ingredientGrid(used) : "";
        })()}</div>`;
  return `<div class="cook" role="dialog" aria-label="Passer en cuisine : ${esc(r.nom)}">
    <div class="cook-top"><strong>${esc(r.emoji)} ${esc(r.nom)}</strong>
      ${"wakeLock" in navigator ? `<label class="awake"><input type="checkbox" data-action="keep-awake"${state.keepAwake !== false ? " checked" : ""}> Écran toujours allumé</label>` : ""}
      <a class="btn small" href="#/recette/${encodeURIComponent(r.id)}">Fermer</a></div>
    <div class="cook-body">${body}</div>
    <div class="dots" aria-hidden="true">${Array.from({ length: total }, (_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>
    <div class="cook-nav">
      <button class="btn" data-action="cook-step" data-delta="-1" ${i === 0 ? "disabled" : ""}>← Précédent</button>
      ${i < total - 1 ? `<button class="btn primary" data-action="cook-step" data-delta="1">Suivant →</button>`
                      : `<a class="btn primary" href="#/recette/${encodeURIComponent(r.id)}">Bon appétit ! 🎉</a>`}
    </div>
  </div>`;
}

// ---------- Planning de la semaine ----------
// state.plan[jour][créneau] = { id: recette, who: [membres] } ; jour 0 = lundi.

const slotEntry = (d, slot) => (state.plan[d] || {})[slot] || null;

// Taille de portion de chacun pour une recette, calée sur son repas idéal de ce jour-là
function entrySizes(r, who, d) {
  const members = who.map(memberById).filter(Boolean);
  return C.memberPortions(stats(r).macros[0], members, d).map((x) => ({ ...x, size: isSnack(r) ? 1 : x.size }));
}

// Créneaux à afficher pour un jour : ceux des personnes du planning, plus ceux déjà remplis
function daySlots(d) {
  const used = new Set(group().flatMap((m) => C.slotsFor(m.repas || 3)));
  Object.keys(state.plan[d] || {}).forEach((k) => used.add(k));
  return Object.keys(C.SLOTS).filter((k) => used.has(k));
}

// Apports d'un membre sur une journée
function dayIntake(m, d) {
  const total = [0, 0, 0, 0];
  const nutr = [0, 0, 0, 0];
  let cost = 0, covered = 0;
  for (const slot of Object.keys(state.plan[d] || {})) {
    const e = slotEntry(d, slot);
    const r = e && recipeById(e.id);
    if (!r || !e.who.includes(m.id)) continue;
    const size = entrySizes(r, [m.id], d)[0].size;
    const st = stats(r);
    st.macros.forEach((v, i) => (total[i] += v * size));
    st.nutriments.forEach((v, i) => (nutr[i] += v * size));
    covered += st.macros[0] * size * st.nutrientCoverage;
    cost += st.cost * size;
  }
  return { macros: total, nutriments: nutr, coverage: total[0] ? covered / total[0] : 1, cost };
}

function planEntries() {
  const out = [];
  for (const [d, slots] of Object.entries(state.plan)) {
    for (const [slot, e] of Object.entries(slots)) {
      const r = recipeById(e.id);
      const who = e.who.filter(memberById);
      if (!r || !who.length) continue;
      const sizes = entrySizes(r, who, +d);
      const sum = sizes.reduce((a, x) => a + x.size, 0);
      out.push({ r, d: +d, slot, res: compute(r, { p: who.length, t: sum / who.length, sizes: [], guests: 0 }) });
    }
  }
  return out;
}

function slotKind(slot) { return slot === "petit-dej" ? "petit-dej" : slot === "collation" || slot === "soir" ? "collation" : "repas"; }

// Recettes proposées pour un créneau : celles du menu d'abord, puis les mieux notées et compatibles avec ces personnes
function pickerHtml(d, slot) {
  const who = (slotEntry(d, slot)?.who || defaultWho(d, slot)).map(memberById).filter(Boolean);
  const pr = C.householdPrefs(who, state.foyer);
  const q = C.queryTokens(ui.pickQuery || "");
  const kind = slotKind(slot);
  const fits = (r) => {
    if (q.length) {
      const w = C.words(`${r.nom} ${r.ingredients.join(" ")}`);
      return q.every((t) => w.some((x) => x.startsWith(t)));
    }
    const tags = r.tags || [];
    return kind === "petit-dej" ? tags.includes("petit-dej") : kind === "collation" ? tags.includes("collation") : !tags.includes("collation") && !tags.includes("petit-dej");
  };
  const mean = (r) => {
    const sc = who.map((m) => memberScore(r, m)?.score).filter((x) => x != null);
    return sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : 0;
  };
  const ok = allRecipes().filter((r) => C.recipeCompat(r, pr, traitsOf(r)).ok);
  const fromMenu = ok.filter((r) => state.menu[r.id]);
  const best = ok.filter((r) => !state.menu[r.id] && fits(r)).sort((a, b) => mean(b) - mean(a)).slice(0, 6);
  const row = (r) => `<li><button type="button" data-action="plan-set" data-day="${d}" data-slot="${slot}" data-id="${esc(r.id)}">
      ${tileHtml(r, "mini")}<span><b>${esc(r.nom)}</b><small>${num(stats(r).macros[0])} kcal · ${num(stats(r).macros[1])} g prot. / portion${r.temps ? ` · ⏱ ${r.temps} min` : ""}</small></span><span class="plus" aria-hidden="true">+</span></button></li>`;
  return `<div class="picker">
    <input id="pick-search" class="search" type="search" data-action="pick-query" value="${esc(ui.pickQuery || "")}" placeholder="Chercher une recette…" autocomplete="off">
    ${fromMenu.length ? `<p class="picker-title">Dans mon menu</p><ul class="suggest">${fromMenu.map(row).join("")}</ul>` : ""}
    <p class="picker-title">${q.length ? "Résultats" : `Suggestions pour ${esc(listNames(who) || "vous")}`}</p>
    <ul class="suggest">${best.map(row).join("") || `<li class="muted">Aucune recette.</li>`}</ul>
    <button type="button" class="link-btn" data-action="plan-cancel">Fermer</button>
  </div>`;
}

// Par défaut, une recette d'un créneau est pour les personnes du planning qui ont ce repas
function defaultWho(d, slot) {
  const ids = group().filter((m) => C.slotsFor(m.repas || 3).includes(slot)).map((m) => m.id);
  return ids.length ? ids : group().map((m) => m.id);
}

function slotHtml(d, slot) {
  const e = slotEntry(d, slot);
  const r = e && recipeById(e.id);
  const meta = C.SLOTS[slot];
  const need = group().filter((m) => C.slotsFor(m.repas || 3).includes(slot));
  const picking = ui.pick === `${d}|${slot}`;
  if (!r) {
    return `<div class="slot empty">
      <div class="slot-head"><span>${meta.icon} <b>${meta.label}</b></span><span class="muted">${need.map((m) => esc(m.emoji)).join("")}</span></div>
      ${picking ? pickerHtml(d, slot) : `<button type="button" class="btn small" data-action="plan-pick" data-day="${d}" data-slot="${slot}">+ Choisir une recette</button>`}
    </div>`;
  }
  const sizes = entrySizes(r, e.who.filter(memberById), d);
  return `<div class="slot">
    <div class="slot-head"><span>${meta.icon} <b>${meta.label}</b></span>
      <span class="slot-actions">
        <button type="button" class="link-btn" data-action="plan-pick" data-day="${d}" data-slot="${slot}">Changer</button>
        ${d < 6 ? `<button type="button" class="link-btn" data-action="plan-copy" data-day="${d}" data-slot="${slot}" title="Même recette le lendemain (meal prep)">Copier à ${DAYS[d + 1].toLowerCase()}</button>` : ""}
        <button type="button" class="link-btn" data-action="plan-clear" data-day="${d}" data-slot="${slot}">Retirer</button>
      </span></div>
    <div class="slot-body">
      <a href="#/recette/${encodeURIComponent(r.id)}">${tileHtml(r, "mini")}</a>
      <div><a href="#/recette/${encodeURIComponent(r.id)}" class="slot-name">${esc(r.nom)}</a>
        <div class="slot-who">${group().concat(state.members.filter((m) => !group().includes(m) && e.who.includes(m.id))).map((m) => {
          const x = sizes.find((z) => z.id === m.id);
          return `<button type="button" class="who-chip small" data-action="plan-who" data-day="${d}" data-slot="${slot}" data-member="${esc(m.id)}" aria-pressed="${!!x}">
            <span class="avatar" aria-hidden="true">${esc(m.emoji)}</span><b>${x ? `×${num(x.size, x.size % 1 ? 2 : 0)} · ${num(stats(r).macros[0] * x.size)} kcal` : esc(m.nom)}</b></button>`;
        }).join("")}</div>
      </div>
    </div>
    ${picking ? pickerHtml(d, slot) : ""}
  </div>`;
}

function viewWeek() {
  const members = group();
  const d = ui.planDay ?? today();
  const gaps = C.planGaps(state.plan, members);
  const missing = Object.values(gaps).reduce((a, b) => a + b, 0);
  const required = members.reduce((a, m) => a + C.slotsFor(m.repas || 3).length * 7, 0);
  const planned = Object.values(state.plan).reduce((a, x) => a + Object.keys(x).length, 0);
  const menuList = menuEntries();
  return `<div class="page-head"><h1>Ma semaine</h1><span class="muted">${planned} repas planifié${planned > 1 ? "s" : ""}</span></div>
    ${groupPicker()}
    <div class="week-summary">
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${required}" aria-valuenow="${required - missing}"><i style="width:${required ? ((required - missing) / required) * 100 : 0}%"></i></div>
      <p><b>${missing ? `Il manque ${missing} repas pour remplir la semaine` : "✓ Tous les repas de la semaine sont prévus"}</b>
        ${members.length > 1 && missing ? ` · ${members.map((m) => `${esc(m.emoji)} ${esc(m.nom)} : ${gaps[m.id]}`).join(" · ")}` : ""}</p>
    </div>
    <div class="week-strip" role="tablist" aria-label="Jours de la semaine">${DAYS.map((name, i) => {
      const need = members.reduce((a, m) => a + C.slotsFor(m.repas || 3).length, 0);
      const have = members.reduce((a, m) => a + C.slotsFor(m.repas || 3).filter((s) => slotEntry(i, s)?.who.includes(m.id)).length, 0);
      const sporty = members.filter((m) => isSportDay(m, i));
      return `<button type="button" role="tab" class="day-tab${i === today() ? " today" : ""}" data-action="plan-day" data-day="${i}" aria-selected="${i === d}">
        <b>${name.slice(0, 3)}</b><span class="day-sport">${sporty.length ? `🏋️${sporty.length > 1 ? sporty.length : ""}` : "&nbsp;"}</span>
        <span class="day-fill"><i style="width:${need ? (have / need) * 100 : 0}%"></i></span></button>`;
    }).join("")}</div>
    <div class="two-cols week-cols">
      <div>
        <h2 class="day-title">${DAYS[d]}${d === today() ? " · aujourd'hui" : ""} ${members.filter((m) => isSportDay(m, d)).map((m) => `<span class="sport-badge">🏋️ ${esc(m.nom)}</span>`).join("")}</h2>
        ${daySlots(d).map((slot) => slotHtml(d, slot)).join("")}
      </div>
      <aside class="panel sticky">
        <h2>Apports du ${DAYS[d].toLowerCase()}</h2>
        ${members.map((m) => {
          const t = targets(m, d).daily;
          const it = dayIntake(m, d);
          const left = C.slotsFor(m.repas || 3).filter((s) => !slotEntry(d, s)?.who.includes(m.id)).length;
          return `<div class="member-intake">
            <div class="mi-head"><span>${esc(m.emoji)} <b>${esc(m.nom)}</b> ${t ? `<small class="muted">${isSportDay(m, d) ? "· sport" : "· repos"}</small>` : ""}</span>
              <span>${num(it.macros[0])}${t ? ` / ${num(t.kcal)}` : ""} kcal</span></div>
            ${t ? `<div class="bar kcal" role="img" aria-label="Énergie : ${num(it.macros[0])} sur ${num(t.kcal)} kcal"><i style="width:${Math.min(100, (it.macros[0] / t.kcal) * 100)}%"></i></div>` : ""}
            ${macroBars(it.macros, t)}
            ${it.macros[0] ? nutrientRows(it.nutriments, C.nutrientTargets(t), it.coverage) : ""}
            <p class="hint">${left ? `${left} repas à prévoir ce jour-là` : "✓ Journée complète"} · ${euro(it.cost)}${t ? "" : ` · <a href="#/profil/${encodeURIComponent(m.id)}">compléter le profil</a>`}</p>
          </div>`;
        }).join("")}
        <a class="btn primary block" href="#/courses" style="margin-top:12px">Faire les courses de la semaine →</a>
        ${planned ? `<button type="button" class="link-btn" data-action="plan-reset" style="margin-top:8px">Vider la semaine</button>` : ""}
      </aside>
    </div>
    ${menuList.length ? menuListHtml(menuList) : ""}`;
}

function menuEntries() {
  return Object.keys(state.menu).map((id) => recipeById(id)).filter(Boolean).map((r) => ({ r, res: compute(r) }));
}

// Recettes ajoutées avec + mais pas encore placées dans la semaine : elles comptent aussi dans les courses
function menuListHtml(entries) {
  return `<section class="menu-extra">
    <h2>Recettes hors planning <small class="muted">· ${entries.length}</small></h2>
    <p class="muted">Ajoutées avec <b>+</b> : placez-les dans un repas (« + Choisir une recette » les propose en premier), ou gardez-les telles quelles : elles sont comptées dans les courses.</p>
    <div class="menu-list">${entries.map(({ r, res }) => `
      <article class="menu-item">
        <a href="#/recette/${encodeURIComponent(r.id)}">${tileHtml(r)}</a>
        <div>
          <a href="#/recette/${encodeURIComponent(r.id)}"><div class="card-title">${esc(r.nom)}</div></a>
          <div class="card-meta"><span>${euro(res.perPortion.cost)}/pers.</span><span class="prot">💪 ${num(res.perPortion.macros[1])} g</span><span>${num(res.perPortion.macros[0])} kcal</span>${res.serving.sizes.length ? `<span title="Personnes servies">${res.serving.sizes.map((x) => esc(memberById(x.id).emoji)).join("")}${res.serving.guests ? ` +${res.serving.guests}` : ""}</span>` : ""}</div>
        </div>
        <div class="menu-side">
          ${stepperHtml(res.serving.who ? "guests" : "servings", r.id, portionsLabel(res.serving.p), "small")}
          <button class="link-btn" data-action="toggle-menu" data-id="${esc(r.id)}">Retirer</button>
        </div>
      </article>`).join("")}
    </div>
  </section>`;
}

// Placard (huile, sel, épices…) et ingrédients facultatifs : comptés dans la recette, mais hors panier
// sauf si on demande à les acheter.
const pantryKey = (x) => C.normalize(x.ing.name);
const isSkippable = (x) => !x.error && (x.ing.optional || C.isPantry(x.ing.name));
const skippedInCart = (x) => isSkippable(x) && !state.pantryBuy.includes(pantryKey(x));
const cartLines = (lines) => lines.filter((x) => !skippedInCart(x));

function menuShopping() {
  const entries = [...planEntries(), ...menuEntries()];
  const lines = entries.flatMap(({ res }) => res.lines);
  // ce qui reste au placard, regroupé par nom
  const pantry = new Map();
  for (const x of lines.filter(isSkippable)) {
    const k = pantryKey(x);
    if (!pantry.has(k)) pantry.set(k, { key: k, name: x.ing.name, optional: x.ing.optional, buy: !skippedInCart(x) });
  }
  return { entries, pantry: [...pantry.values()], list: shopping(cartLines(lines)) };
}

// Liste de courses : produits additionnés sur tout le menu, puis formats optimisés (sauf ceux qu'on garde)
const shopping = (lines) => C.shoppingList(lines, { exclude: new Set(state.owned), cat, keep: new Set(state.formatKeep) });

function pantryChip(item) {
  return `<button type="button" class="chip pantry-chip" data-action="pantry-buy" data-key="${esc(item.key)}" aria-pressed="${item.buy}"
    title="${item.buy ? "Sera ajouté au panier" : "Pas ajouté au panier"}">${item.buy ? "🛒" : "✓"} ${esc(item.name)}${item.optional ? " · facultatif" : ""}</button>`;
}

function viewCourses() {
  const { entries, list, pantry } = menuShopping();
  if (!entries.length) {
    return `<div class="page-head"><h1>Courses</h1></div>
      <div class="empty"><div class="big-emoji">🛒</div><p>Planifiez votre semaine ou ajoutez des recettes avec <b>+</b> : la liste de courses se fait toute seule.</p>
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
  const saved = list.reduce((s, e) => s + (e.optimized ? e.optimized.saving : 0), 0);
  return `<div class="page-head"><h1>Courses</h1><span class="muted">${entries.length} repas et recettes · ${list.length} produits</span></div>
    <div class="two-cols">
      <div>
        <p class="muted">Cochez ce que vous avez déjà : ce ne sera pas ajouté au panier.</p>
        ${pantry.length ? `<div class="pantry-box"><b>Vous avez sûrement déjà…</b>
          <div class="chips-select">${pantry.map(pantryChip).join("")}</div>
          <p class="hint">Pas ajoutés au panier. Touchez-en un s'il vous manque.</p></div>` : ""}
        ${[...groups].map(([g, items]) => `<div class="shop-group"><h3>${esc(g)}</h3>${items.map((e) => `
          <label class="shop-item${e.owned ? " owned" : ""}">
            <input type="checkbox" data-action="owned" data-ean="${esc(e.product.ean)}" ${e.owned ? "checked" : ""} aria-label="J'ai déjà : ${esc(e.product.nom)}">
            ${e.product.image ? `<img src="${esc(e.product.image)}" alt="" loading="lazy" width="44" height="44">` : `<span class="ph" aria-hidden="true">🛍️</span>`}
            <span><span class="name">${esc(e.product.nom)}</span><br><span class="sub">${e.packs} × ${esc(e.product.conditionnement || "paquet")} · pour ${esc([...new Set(e.uses)].join(", "))}</span>
              ${e.optimized && !e.optimized.part ? `<br><span class="format-note">💡 Format optimisé au lieu de ${esc(e.optimized.before)} · −${euro(e.optimized.saving)}
                <button type="button" class="link-btn" data-action="format-keep" data-key="${esc(e.optimized.key)}">Garder mon format</button></span>` : ""}</span>
            <span class="price">${euro(e.price)}</span>
          </label>`).join("")}</div>`).join("")}
      </div>
      <aside class="panel sticky checkout">
        <h2>Mon panier</h2>
        <div class="total-line big"><span>${toBuy.length} produit${toBuy.length > 1 ? "s" : ""}</span><span>${euro(total)}</span></div>
        ${saved > 0.005 ? `<div class="total-line saved"><span>💡 Économie sur les formats</span><span>−${euro(saved)}</span></div>` : ""}
        ${state.formatKeep.length ? `<button type="button" class="link-btn" data-action="format-reset">Réoptimiser tous les formats</button>` : ""}
        <p class="hint">Paquets entiers, aux prix du relevé du ${new Date(cat.maj).toLocaleDateString("fr-FR")}. Les promotions fidélité ne sont pas déduites.</p>
        <button class="btn primary block" data-action="send-menu" ${toBuy.length ? "" : "disabled"} style="margin-top:12px">🛒 Envoyer au panier Carrefour</button>
        <button class="btn block" data-action="guide-menu" ${toBuy.length ? "" : "disabled"} style="margin-top:8px">📋 Liste guidée, sans installation</button>
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
  const { daily, meal } = targets(p, null);
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
          <h2>Jours de sport</h2>
          <div class="chips-select">${DAYS.map((d, i) => `<button type="button" class="chip" data-action="member-sport" data-id="${esc(p.id)}" data-value="${i}" aria-pressed="${(p.sportDays || []).includes(i)}">${d.slice(0, 3)}</button>`).join("")}</div>
          <p class="hint">Les jours de sport, l'énergie (surtout les glucides) monte un peu ; les jours de repos, elle baisse d'autant : le total de la semaine ne change pas. Les protéines restent les mêmes chaque jour.</p>
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
          ${(p.sportDays || []).length && p.sportDays.length < 7 ? (() => {
            const sp = C.memberDaily(p, p.sportDays[0]);
            const rest = C.memberDaily(p, [0, 1, 2, 3, 4, 5, 6].find((d) => !p.sportDays.includes(d)));
            return `<div class="total-line"><span>🏋️ Jour de sport</span><span>${num(sp.kcal)} kcal · ${num(sp.glucides)} g gluc.</span></div>
              <div class="total-line"><span>🛋️ Jour de repos</span><span>${num(rest.kcal)} kcal · ${num(rest.glucides)} g gluc.</span></div>`;
          })() : ""}
          <h3 style="font-size:1rem;margin:16px 0 4px">Par repas (${p.repas || 3} par jour, en moyenne)</h3>
          <div class="total-line"><span>Énergie</span><span>${num(meal.kcal)} kcal</span></div>
          <div class="total-line"><span>Protéines</span><span>${num(meal.proteines)} g</span></div>
          <p class="hint">Métabolisme de base ${num(daily.bmr)} kcal (formule de Mifflin-St Jeor), dépense estimée ${num(daily.tdee)} kcal.
            Protéines : ${num(C.GOALS[p.objectif].proteines, 1)} g par kg ; lipides : au moins 25 % des calories. Ce sont des repères pour adultes, pas un avis médical.</p>`
        : `<p class="muted">Renseignez l'âge, le poids et la taille pour calculer les besoins.</p>`}
        <a class="btn primary block" href="#/profil" style="margin-top:12px">✓ Terminé</a>
      </aside>
    </div>`;
}

// Le brouillon est gardé (et enregistré) tant qu'il n'est pas validé : on peut aller chercher
// des produits dans « Produits du Drive » et revenir.
function draftFor(id) {
  const editing = id ? state.custom.find((r) => r.id === id) : null;
  if (!state.draft || (state.draft.id || null) !== (editing ? editing.id : null)) {
    state.draft = editing
      ? { id: editing.id, nom: editing.nom, portions: editing.portions, texte: editing.ingredients.join("\n") }
      : { id: null, nom: "", portions: 1, texte: "" };
  }
  return { draft: state.draft, editing };
}
const draftLines = (d) => (d.texte || "").split("\n").map((l) => l.trim()).filter(Boolean);
const draftRecipe = (d) => ({ id: d.id || "brouillon", portions: Math.max(1, +d.portions || 1), ingredients: draftLines(d) });

// Ligne d'ingrédient pour un produit du Drive : nom lisible (sans la marque), épinglé par son code-barres
function lineForProduct(p) {
  let name = p.nom;
  if (p.marque) name = name.replace(new RegExp(`\\s*${p.marque.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "");
  name = name.replace(/[@#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48).toLowerCase();
  return p.unite === "PIECE" ? `1 ${name} #${p.ean}` : `100 g ${name} #${p.ean}`;
}

function addToDraft(ean) {
  const p = cat.byEan.get(ean);
  if (!p) return;
  const d = state.draft || draftFor(null).draft;
  d.texte = [...draftLines(d), lineForProduct(p)].join("\n");
  save();
  return d;
}

const QTY_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l|pcs?|pièces?|x)?\.?\s+/i;

function builderHtml(d) {
  const r = draftRecipe(d);
  if (!r.ingredients.length) return `<p class="muted">Aucun ingrédient : cherchez un produit ci-dessous.</p>`;
  const res = compute(r, { p: r.portions, t: 1 });
  return `<ul class="ingredients builder">${res.lines.map((x, i) => {
    const m = r.ingredients[i].match(QTY_RE);
    const qty = m ? m[1].replace(",", ".") : "";
    const unitText = m ? ((m[2] || "").toLowerCase() || "pièce(s)") : "";
    const options = x.product ? x.choices.slice(0, 12).map((p) =>
      `<option value="${esc(p.ean)}"${p === x.product ? " selected" : ""}>${esc(p.nom)} — ${euro(p.prix)}</option>`).join("") : "";
    return `<li>${thumb(x.product)}<div>
      <div class="ing-head"><span>${esc(x.ing.name || x.ing.raw)}</span><span class="price">${x.product ? euro(x.cost) : "—"}</span></div>
      <div class="builder-row">
        ${m ? `<label class="qty"><input type="number" inputmode="decimal" min="0" step="any" data-action="ing-qty" data-index="${i}" value="${esc(qty)}" aria-label="Quantité de ${esc(x.ing.name)}"><span>${esc(unitText)}</span></label>` : ""}
        ${x.product ? `<select class="product-select" data-action="ing-product" data-index="${i}" aria-label="Produit pour ${esc(x.ing.name)}">${options}</select>` : `<span class="error">${esc(x.error || "Aucun produit trouvé au Drive")}</span>`}
        <button type="button" class="icon-btn" data-action="ing-remove" data-index="${i}" aria-label="Retirer ${esc(x.ing.name || "")}">✕</button>
      </div>
      ${x.macros ? `<div class="ing-note">${num(x.macros[0])} kcal · P ${num(x.macros[1], 1)} g · G ${num(x.macros[2], 1)} g · L ${num(x.macros[3], 1)} g${x.generic ? " · valeurs moyennes *" : ""}</div>` : ""}
    </div></li>`;
  }).join("")}</ul>`;
}

function suggestHtml(q) {
  if (!C.queryTokens(q).length) return "";
  const hits = C.search(cat, q).slice(0, 8);
  if (!hits.length) return `<p class="muted">Aucun produit trouvé.</p>`;
  return `<ul class="suggest">${hits.map((p) => `<li><button type="button" data-action="add-ing" data-ean="${esc(p.ean)}">
    ${thumb(p)}<span><b>${esc(p.nom)}</b><small>${euro(p.prix)} · ${esc(unitLabel(p))}${p.macros ? ` · ${num(p.macros[0])} kcal · P ${num(p.macros[1], 1)} g / 100 g` : ""}</small></span>
    <span class="plus" aria-hidden="true">+</span></button></li>`).join("")}</ul>`;
}

function viewCreate(id) {
  const { draft, editing } = draftFor(id);
  return `<div class="page-head"><h1>${editing ? "Modifier ma recette" : "Créer ma recette"}</h1></div>
    <div class="two-cols free">
      <div class="panel">
        <div class="form-grid">
          <label class="field">Nom<input type="text" data-action="draft" data-field="nom" value="${esc(draft.nom)}" placeholder="Mon bowl du dimanche"></label>
          <label class="field">Portions de la recette<input type="number" min="1" max="20" data-action="draft" data-field="portions" value="${esc(draft.portions)}"></label>
        </div>
        <h2 style="margin-top:18px">Ingrédients</h2>
        <div id="builder">${builderHtml(draft)}</div>
        <div class="ing-search">
          <input id="ing-search" class="search" type="search" data-action="ing-query" value="${esc(ui.ingQuery || "")}" placeholder="➕ Ajouter : poulet, riz, skyr…" autocomplete="off" aria-label="Chercher un produit à ajouter">
          <div id="ing-suggest">${suggestHtml(ui.ingQuery || "")}</div>
          <p class="hint">Ou parcourez <a href="#/produits">tous les produits du Drive</a> (tri par protéines, par rayon…) et ajoutez-les avec <b>+ Ma recette</b>.</p>
        </div>
        <details class="syntax"><summary>Saisie en texte</summary>
          <textarea data-action="draft" data-field="texte" spellcheck="false" placeholder="300 g filet de poulet&#10;150 g riz basmati&#10;2 oeufs @60g">${esc(draft.texte)}</textarea>
          <p><code>200 g blanc de poulet</code> — unités : g, kg, ml, cl, l.<br><code>2 oeufs @60g</code> — pièces, avec le poids d'une pièce.<br>
          Comptez le riz et les pâtes en poids sec.</p></details>
        <div class="actions" style="margin-top:14px">
          <button class="btn primary" data-action="save-draft">${editing ? "Enregistrer" : "Ajouter à mes recettes"}</button>
          <button class="btn" data-action="share-draft">Copier le lien</button>
          ${editing ? `<button class="btn ghost" data-action="delete-custom" data-id="${esc(editing.id)}">Supprimer</button>`
            : draftLines(draft).length ? `<button class="btn ghost" data-action="reset-draft">Tout effacer</button>` : ""}
        </div>
      </div>
      <div id="draft-preview">${draftPreview(draft)}</div>
    </div>`;
}

function draftPreview(draft) {
  const r = draftRecipe(draft);
  if (!r.ingredients.length) return `<div class="panel"><p class="muted">Ajoutez vos ingrédients : le coût et les macros par portion s'affichent ici.</p></div>`;
  const res = compute(r, { p: r.portions, t: 1 });
  const { meal } = targets();
  return `<div class="panel sticky">
    <h2>Par portion</h2>
    <div class="kpis">
      <div class="kpi"><b>${num(res.perPortion.macros[0])}</b><span>kcal</span></div>
      <div class="kpi"><b>${num(res.perPortion.macros[1])} g</b><span>protéines</span></div>
      <div class="kpi"><b>${euro(res.perPortion.cost)}</b><span>par personne</span></div>
    </div>
    ${macroBars(res.perPortion.macros, meal)}
    ${meal ? `<p class="hint">Comparé au repas idéal de ${esc(me().nom)} (${num(meal.kcal)} kcal). Une fois enregistrée, la recette s'adapte à chaque profil.</p>` : ""}
    <p class="hint">${portionsLabel(r.portions)} · ${euro(res.cost)} au total.</p>
  </div>`;
}

const PRODUCT_SORTS = [["pertinence", "Pertinence"], ["proteines", "Protéines / 100 g"], ["proteines-kcal", "Protéines / 100 kcal"],
  ["proteines-euro", "Protéines par euro"], ["prix-kg", "Prix au kilo"]];
const RAYON_LABELS = {
  "viandes-et-poissons": "Viandes et poissons", cremerie: "Crèmerie", "charcuterie-traiteur": "Charcuterie et traiteur",
  "epicerie-salee": "Épicerie salée", "epicerie-sucree": "Épicerie sucrée", "fruits-et-legumes": "Fruits et légumes",
  "vegetal-vegetarien": "Végétal et végétarien", "dietetique-preferences-alimentaires": "Diététique et protéines",
  surgeles: "Surgelés", boissons: "Boissons", "pains-et-patisseries": "Pains et pâtisseries",
};

function viewProducts() {
  const q = ui.productQuery || "";
  const searching = C.queryTokens(q).length > 0;
  // sans recherche, « Pertinence » n'a pas de sens : un tri ou un rayon choisi parcourt le catalogue
  let sort = ui.productSort || "pertinence";
  if (!searching && sort === "pertinence" && ui.productRayon) sort = "proteines";
  const rayon = ui.productRayon || "";
  const hits = C.search(cat, q, { sort, rayon: rayon || null });
  const rayons = [...new Set(cat.products.map((p) => p.rayon).filter(Boolean))]
    .sort((a, b) => (RAYON_LABELS[a] || a).localeCompare(RAYON_LABELS[b] || b, "fr"));
  const withMacros = cat.products.filter((p) => p.macros && (!rayon || p.rayon === rayon)).length;
  const count = hits.length.toLocaleString("fr-FR");
  const more = hits.length > 60 ? " — 60 premiers affichés" : "";
  return `<a class="back" href="#/">← Recettes</a>
    <div class="page-head"><h1>Produits du Drive</h1></div>
    <div class="toolbar">
      <input id="product-search" class="search" type="search" data-action="product-query" placeholder="Skyr, thon, flocons d'avoine… ou choisissez un tri" value="${esc(q)}" autocomplete="off" aria-label="Rechercher un produit">
      <div class="chips" role="group" aria-label="Trier">${PRODUCT_SORTS.filter(([v]) => searching || v !== "pertinence")
        .map(([v, l]) => `<button class="chip" data-action="product-sort" data-sort="${v}" aria-pressed="${sort === v}">${l}</button>`).join("")}</div>
      <select class="rank-select" data-action="product-rayon" aria-label="Rayon">
        <option value="">Tous les rayons</option>
        ${rayons.map((r) => `<option value="${esc(r)}"${r === rayon ? " selected" : ""}>${esc(RAYON_LABELS[r] || r)}</option>`).join("")}
      </select>
    </div>
    <p class="muted">${searching ? `${count} produits${more}`
      : sort !== "pertinence" ? `${count} produits${rayon ? ` du rayon ${esc(RAYON_LABELS[rayon] || rayon)}` : ""} classés par ${esc(PRODUCT_SORTS.find(([v]) => v === sort)[1].toLowerCase())}${more}.
        ${sort === "prix-kg" ? "" : `Seuls les ${withMacros.toLocaleString("fr-FR")} produits dont les valeurs nutritionnelles sont connues sont classés ; le relevé hebdomadaire en ajoute chaque semaine.`}`
      : `${cat.products.length.toLocaleString("fr-FR")} produits relevés au ${esc(cat.magasin.nom)}. Recherchez un produit, ou choisissez un tri pour parcourir tout le catalogue.`}</p>
    <div class="products">${hits.slice(0, 60).map((p) => {
      const m = p.macros;
      const ppe = C.proteinPerEuro(p);
      const density = C.proteinPer100kcal(p);
      return `<article class="product">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" width="56" height="56">` : "<span></span>"}
        <div><h3>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.nom)}</a>` : esc(p.nom)}</h3>
          <div><strong>${euro(p.prix)}</strong> <span class="muted">${esc(unitLabel(p))}</span></div>
          <div class="muted" style="font-size:.8rem">${esc(p.conditionnement)}${p.promo ? ` · <span style="color:var(--brand);font-weight:800">${esc(p.promo)}</span>` : ""}</div></div>
        <button type="button" class="btn small add-ing" data-action="add-ing" data-ean="${esc(p.ean)}">+ Ma recette</button>
        <div class="nutri">${m ? `<span>${num(m[0])} kcal</span><span>P ${num(m[1], 1)}</span><span>G ${num(m[2], 1)}</span><span>L ${num(m[3], 1)}</span><span>/ 100 g</span>
          ${p.nutriments ? C.NUTRIENT_INFO.map((n, i) => (p.nutriments[i] == null ? "" : `<span>${n.label} ${num(p.nutriments[i], 1)}</span>`)).join("") : ""}
          ${density > 0 ? `<span class="ratio" title="Grammes de protéines pour 100 kcal">${num(density, 1)} g prot. / 100 kcal</span>` : ""}
          ${ppe > 0 ? `<span>${num(ppe)} g prot. / €</span>` : ""}` : "<span>macros non renseignées</span>"}</div>
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
  [/^#\/menu$/, () => viewWeek(), "menu"],
  [/^#\/courses$/, () => viewCourses(), "courses"],
  [/^#\/profil$/, () => viewProfil(), "profil"],
  [/^#\/profil\/(.+)$/, (m) => viewMember(decodeURIComponent(m[1])), "profil"],
  [/^#\/creer(?:\/(.+))?$/, (m) => viewCreate(m[1] && decodeURIComponent(m[1])), "creer"],
  [/^#\/produits$/, () => viewProducts(), "recettes"],
  [/^#\/frigo$/, () => viewFridge(), "recettes"],
  [/^#\/panier-guide$/, () => viewCartGuide(), "courses"],
];

// En cuisine, l'écran reste allumé (comme « Désactiver la veille » chez Jow), si le navigateur le permet
let wakeLock = null, wakePending = false;
async function syncWakeLock() {
  const want = /^#\/cuisine\//.test(location.hash) && state.keepAwake !== false && document.visibilityState === "visible";
  if (!("wakeLock" in navigator) || wakePending) return;
  wakePending = true;
  try {
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; /* refusé (batterie faible, onglet masqué…) : sans effet */ }
  wakePending = false;
}
document.addEventListener("visibilitychange", syncWakeLock);

let lastHash = null;
function render({ keepScroll = false } = {}) {
  const hash = location.hash || "#/";
  // anciens liens partagés : #r=<recette du mode libre>
  const legacy = hash.match(/^#r=(.+)$/);
  if (legacy) {
    try {
      const r = C.decode(legacy[1]);
      state.draft = { id: null, nom: r.nom || "", portions: r.portions || 2, texte: r.texte || "" };
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
  syncWakeLock();
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
  const n = Object.keys(state.menu).length + Object.values(state.plan || {}).reduce((a, x) => a + Object.keys(x).length, 0);
  $("#menu-count").textContent = n || "";
}

// ---------- Actions ----------

function toggleMenu(id) {
  const r = recipeById(id);
  if (!r) return;
  if (state.menu[id]) {
    delete state.menu[id];
    toast(`Retiré du menu : ${r.nom}`);
  } else {
    state.menu[id] = servingToStore(servingOf(r));
    toast(`Ajouté au menu : ${r.nom}`);
  }
  save();
  render({ keepScroll: true });
}

function setServing(id, change) {
  const r = recipeById(id);
  const s = servingToStore({ ...storedServing(r), ...change(storedServing(r)) });
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

// Le script installé (extension) s'annonce sur ce site : on ouvre alors Carrefour directement
const scriptInstalled = () => document.documentElement.dataset.panierCarrefour === "installe";

function device() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

const SCRIPT_LINK = `<a href="carrefour-panier.user.js" target="_blank" rel="noopener">Installer le script « Panier Carrefour »</a>`;
const SETUP_STEPS = {
  desktop: `<ol>
      <li>Ajoutez l'extension gratuite <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener">Tampermonkey</a>
        ou <a href="https://violentmonkey.github.io/get-it/" target="_blank" rel="noopener">Violentmonkey</a> à votre navigateur (Chrome, Edge, Firefox, Safari).</li>
      <li>${SCRIPT_LINK}, puis confirmez « Installer » dans l'extension.</li>
      <li>Revenez ici et rechargez la page.</li></ol>`,
  android: `<ol>
      <li>Ouvrez ce site dans <a href="https://play.google.com/store/apps/details?id=org.mozilla.firefox" target="_blank" rel="noopener">Firefox</a> (Chrome sur Android n'accepte pas les extensions).</li>
      <li>Dans Firefox : menu ⋮ → Extensions → ajoutez <b>Tampermonkey</b> ou <b>Violentmonkey</b>.</li>
      <li>${SCRIPT_LINK}, puis confirmez « Installer ».</li>
      <li>Revenez ici et rechargez la page.</li></ol>`,
  ios: `<ol>
      <li>Installez l'app gratuite <a href="https://apps.apple.com/app/userscripts/id1463298887" target="_blank" rel="noopener">Userscripts</a>.</li>
      <li>Réglages → Apps → Safari → Extensions → Userscripts : activez-la et autorisez-la sur <b>carrefour.fr</b> et <b>alplessier.github.io</b>.</li>
      <li>Dans Safari, ${SCRIPT_LINK.replace("Installer", "ouvrez")} puis touchez l'icône Userscripts (barre d'adresse) → Installer.</li>
      <li>Revenez ici et rechargez la page.</li></ol>`,
};

// Fenêtre d'envoi, construite ici plutôt que dans index.html : une page HTML restée en cache
// ne peut plus être en décalage avec ce script.
const CART_DIALOG_HTML = `
<form method="dialog">
    <h2 id="cart-dialog-title">Envoyer au panier Carrefour</h2>
    <p>Deux façons de faire. Le panier est celui de votre compte : il apparaît aussi dans l'<strong>application Carrefour</strong>.</p>
    <div class="option">
      <h3>📋 Liste guidée — sans rien installer</h3>
      <p class="muted">Chaque produit s'ouvre sur carrefour.fr (ou dans l'application sur mobile) : vous l'ajoutez d'un geste et le cochez.</p>
      <button class="btn primary" value="guide" type="submit">Ouvrir la liste guidée</button>
    </div>
    <div class="option">
      <h3>⚡ Tout ajouter en un clic — à installer une seule fois</h3>
      <div id="cart-setup-steps"></div>
      <p class="muted">Une fois installé, le site le détecte : le bouton ouvre directement Carrefour et remplit le panier, sans cette fenêtre.</p>
      <button class="btn" value="reload" type="submit">🔄 C'est installé : recharger la page</button>
    </div>
    <details class="option desktop-only">
      <summary>Autre option sur ordinateur : un favori, sans extension</summary>
      <p>Glissez ce bouton dans votre barre de favoris :
        <a id="bookmarklet" class="bookmarklet" href="#" title="Glissez-moi dans la barre de favoris">🛒 Panier recette</a></p>
      <p class="muted">Après chaque envoi, cliquez sur ce favori une fois la page Carrefour ouverte.</p>
      <button class="btn small" value="send" type="submit">Ouvrir Carrefour</button>
    </details>
    <div class="actions">
      <button class="btn ghost" value="cancel" type="submit">Annuler</button>
    </div>
  </form>`;

// Garde la dernière liste envoyée, pour la liste guidée
function rememberCart(nom, list) {
  const items = list.filter((e) => !e.owned && e.packs).map((e) => [e.product.ean, e.packs]);
  const prev = state.lastCart;
  const same = prev && JSON.stringify(prev.items) === JSON.stringify(items);
  state.lastCart = { nom, items, done: same ? prev.done : [], date: new Date().toISOString() };
  save();
}

function sendToCart(nom, list) {
  if (!list.some((e) => !e.owned && e.packs)) return toast("Rien à ajouter au panier.");
  rememberCart(nom, list);
  const url = C.cartUrl(cat, nom, list);
  if (scriptInstalled() || setupDone()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  let dialog = $("#cart-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "cart-dialog";
    dialog.className = "dialog";
    document.body.append(dialog);
  }
  dialog.innerHTML = CART_DIALOG_HTML;
  $("#cart-setup-steps").innerHTML = SETUP_STEPS[device()];
  dialog.querySelector(".desktop-only").hidden = device() !== "desktop";
  if (device() === "desktop") prepareBookmarklet();
  dialog.addEventListener("close", function onClose() {
    dialog.removeEventListener("close", onClose);
    if (dialog.returnValue === "send") window.open(url, "_blank", "noopener");
    else if (dialog.returnValue === "guide") location.hash = "#/panier-guide";
    else if (dialog.returnValue === "reload") location.reload();
  });
  dialog.showModal();
}

// Liste guidée : chaque produit s'ouvre sur carrefour.fr (ou dans l'application Carrefour sur mobile)
function viewCartGuide() {
  const lc = state.lastCart;
  if (!lc || !lc.items.length) {
    return `<div class="page-head"><h1>Liste guidée</h1></div>
      <div class="empty"><div class="big-emoji">📋</div><p>Envoyez d'abord une recette ou votre menu au panier.</p>
      <a class="btn primary" href="#/courses">Mes courses</a></div>`;
  }
  const rows = lc.items.map(([ean, packs]) => ({ p: cat.byEan.get(ean), ean, packs, done: lc.done.includes(ean) })).filter((x) => x.p);
  const done = rows.filter((x) => x.done).length;
  const total = rows.reduce((a, x) => a + (x.p.prix || 0) * x.packs, 0);
  const mobile = device() !== "desktop";
  return `<a class="back" href="#/courses">← Courses</a>
    <div class="page-head"><h1>Liste guidée</h1><span class="muted">${esc(lc.nom)}</span></div>
    <div class="two-cols guide-page">
      <div>
        <div class="panel guide-store">
          <b>1. Choisissez votre Drive</b>
          <p class="muted">${mobile ? "Dans l'application Carrefour ou sur carrefour.fr, le magasin" : "Sur carrefour.fr, le magasin"} doit être le <b>${esc(cat.magasin.nom)}</b>, sinon les prix et la disponibilité diffèrent.</p>
          <a class="btn small" href="https://www.carrefour.fr/set-store/${encodeURIComponent(cat.magasin.ref)}" target="_blank" rel="noopener">Choisir ce Drive sur carrefour.fr</a>
        </div>
        <h2 class="guide-title">2. Ajoutez chaque produit</h2>
        <ul class="guide">${rows.map((x) => `<li class="${x.done ? "done" : ""}">
          <label class="guide-check"><input type="checkbox" data-action="guide-done" data-ean="${esc(x.ean)}"${x.done ? " checked" : ""} aria-label="Ajouté : ${esc(x.p.nom)}"></label>
          ${thumb(x.p)}
          <div><b>${esc(x.p.nom)}</b><small>${x.packs} × ${esc(x.p.conditionnement || "article")} · ${euro((x.p.prix || 0) * x.packs)}</small></div>
          ${x.p.url ? `<a class="btn small${x.done ? " ghost" : " primary"}" href="${esc(x.p.url)}" target="_blank" rel="noopener" data-action="guide-open" data-ean="${esc(x.ean)}">${x.done ? "Revoir" : "Ouvrir"}</a>` : ""}
        </li>`).join("")}</ul>
      </div>
      <aside class="panel sticky">
        <h2>Progression</h2>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${rows.length}" aria-valuenow="${done}"><i style="width:${rows.length ? (done / rows.length) * 100 : 0}%"></i></div>
        <div class="total-line big"><span>${done} / ${rows.length} ajoutés</span><span>${euro(total)}</span></div>
        <p class="hint">« Ouvrir » affiche le produit sur carrefour.fr${mobile ? ", ou dans l'application Carrefour si elle est installée" : ""}. Ajoutez la quantité indiquée, revenez ici : le produit est coché automatiquement.</p>
        ${done ? `<button class="link-btn" data-action="guide-reset">Tout décocher</button>` : ""}
        ${scriptInstalled() ? "" : `<p class="hint">Plus rapide : le script « Panier Carrefour » ajoute tout en un clic (bouton « Envoyer au panier », option ⚡).</p>`}
      </aside>
    </div>`;
}

function setGuideDone(ean, value) {
  const set = new Set(state.lastCart.done);
  if (value) set.add(ean); else set.delete(ean);
  state.lastCart.done = [...set];
  save();
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
  state.group = null;
  changed();
}

function saveDraft() {
  const d = state.draft;
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
  state.draft = null;
  ui.ingQuery = "";
  save();
  location.hash = `#/recette/${encodeURIComponent(r.id)}`;
  toast("Recette enregistrée.");
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#bookmarklet")) {
    e.preventDefault();
    return toast("Glissez ce bouton dans la barre de favoris.");
  }
  const el = e.target.closest("[data-action]");
  if (!el || ["SELECT", "INPUT", "TEXTAREA"].includes(el.tagName)) return;
  const { action, id } = el.dataset;
  switch (action) {
    case "toggle-menu": e.preventDefault(); toggleMenu(id); break;
    case "servings": {
      // dans le menu : avec des profils, le − / + règle les invités
      const d = +el.dataset.delta;
      setServing(id, (s) => (s.who ? { guests: Math.min(20, Math.max(s.who.length ? 0 : 1, (s.guests || 0) + d)) }
        : { p: Math.min(20, Math.max(1, s.p + d)) }));
      break;
    }
    case "guests": {
      const d = +el.dataset.delta;
      setServing(id, (s) => ({ guests: Math.min(20, Math.max(s.who.length ? 0 : 1, (s.guests || 0) + d)) }));
      break;
    }
    case "serve-member": {
      const mid = el.dataset.member;
      setServing(id, (s) => {
        const set = new Set(s.who);
        if (set.has(mid)) set.delete(mid); else set.add(mid);
        if (!set.size && !s.guests) { toast("Au moins une personne à table."); return {}; }
        return { who: state.members.map((m) => m.id).filter((x) => set.has(x)) };
      });
      break;
    }
    case "serve-household": setServing(id, () => ({ who: group().map((m) => m.id), guests: 0, p: undefined, t: undefined })); break;
    case "tag": ui.tag = el.dataset.tag || null; render({ keepScroll: true }); break;
    case "cook-step": ui.cookStep = Math.max(0, ui.cookStep + +el.dataset.delta); render(); break;
    case "member": updateMember(id, el.dataset.field, el.dataset.value); render({ keepScroll: true }); break;
    case "member-sport": {
      const m = memberById(id);
      const d = +el.dataset.value;
      const set = new Set(m.sportDays || []);
      if (set.has(d)) set.delete(d); else set.add(d);
      m.sportDays = [...set].sort();
      changed();
      render({ keepScroll: true });
      break;
    }
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
      sendToCart(r.nom, shopping(cartLines(compute(r).lines)));
      break;
    }
    case "guide-menu": {
      const { entries, list } = menuShopping();
      rememberCart(entries.length === 1 ? entries[0].r.nom : `Ma semaine (${entries.length} repas)`, list);
      location.hash = "#/panier-guide";
      break;
    }
    case "send-menu": {
      const { entries, list } = menuShopping();
      sendToCart(entries.length === 1 ? entries[0].r.nom : `Ma semaine (${entries.length} repas)`, list);
      break;
    }
    case "save-draft": saveDraft(); break;
    case "format-keep":
      e.preventDefault();
      state.formatKeep = [...new Set([...state.formatKeep, el.dataset.key])];
      save();
      render({ keepScroll: true });
      break;
    case "format-reset": state.formatKeep = []; save(); render({ keepScroll: true }); break;
    case "toggle-fav": {
      e.preventDefault();
      const r = recipeById(id);
      state.favs = isFav(r) ? state.favs.filter((x) => x !== id) : [id, ...state.favs];
      save();
      toast(isFav(r) ? `♥ Ajouté aux favoris : ${r.nom}` : `Retiré des favoris : ${r.nom}`);
      if (ui.tag === "favoris" && !state.favs.length) ui.tag = null;
      render({ keepScroll: true });
      break;
    }
    case "plan-day": ui.planDay = +el.dataset.day; ui.pick = null; render({ keepScroll: true }); break;
    case "plan-pick": ui.pick = `${el.dataset.day}|${el.dataset.slot}`; ui.pickQuery = ""; render({ keepScroll: true }); $("#pick-search")?.focus(); break;
    case "plan-cancel": ui.pick = null; render({ keepScroll: true }); break;
    case "plan-set": {
      const d = +el.dataset.day, slot = el.dataset.slot;
      const prev = slotEntry(d, slot);
      state.plan[d] = { ...(state.plan[d] || {}), [slot]: { id, who: prev ? prev.who : defaultWho(d, slot) } };
      if (state.menu[id]) delete state.menu[id]; // placée : elle n'est plus « hors planning »
      ui.pick = null;
      save();
      render({ keepScroll: true });
      break;
    }
    case "plan-clear": {
      const d = +el.dataset.day;
      delete state.plan[d][el.dataset.slot];
      save();
      render({ keepScroll: true });
      break;
    }
    case "plan-copy": {
      const d = +el.dataset.day, slot = el.dataset.slot;
      state.plan[d + 1] = { ...(state.plan[d + 1] || {}), [slot]: { ...slotEntry(d, slot), who: [...slotEntry(d, slot).who] } };
      save();
      toast(`Copié à ${DAYS[d + 1].toLowerCase()}.`);
      render({ keepScroll: true });
      break;
    }
    case "plan-who": {
      const e = slotEntry(+el.dataset.day, el.dataset.slot);
      const mid = el.dataset.member;
      const next = e.who.includes(mid) ? e.who.filter((x) => x !== mid) : [...e.who, mid];
      if (!next.length) { toast("Au moins une personne pour ce repas."); break; }
      e.who = state.members.map((m) => m.id).filter((x) => next.includes(x));
      save();
      render({ keepScroll: true });
      break;
    }
    case "plan-reset":
      if (confirm("Vider tous les repas de la semaine ?")) { state.plan = {}; save(); render(); }
      break;
    case "group-member": {
      const set = new Set(group().map((m) => m.id));
      const mid = el.dataset.member;
      if (set.has(mid)) set.delete(mid); else set.add(mid);
      if (!set.size) { toast("Choisissez au moins une personne."); break; }
      state.group = state.members.map((m) => m.id).filter((x) => set.has(x));
      ui.view = {}; // les fiches reprennent ce choix pour « Pour qui ? »
      changed();
      render({ keepScroll: true });
      break;
    }
    case "suggest":
      ui.query = el.dataset.q;
      render({ keepScroll: true });
      $("#recipe-search")?.focus();
      break;
    case "fridge-add": addFridge(el.dataset.value); render({ keepScroll: true }); break;
    case "fridge-remove": state.fridge = state.fridge.filter((x) => x !== el.dataset.value); save(); render({ keepScroll: true }); break;
    case "fridge-clear": state.fridge = []; save(); render({ keepScroll: true }); break;
    case "guide-open":
      // le lien s'ouvre normalement ; au retour sur l'onglet, le produit est déjà coché
      setGuideDone(el.dataset.ean, true);
      setTimeout(() => render({ keepScroll: true }), 300);
      break;
    case "guide-reset": state.lastCart.done = []; save(); render({ keepScroll: true }); break;
    case "pantry-buy": {
      const set = new Set(state.pantryBuy);
      if (set.has(el.dataset.key)) set.delete(el.dataset.key); else set.add(el.dataset.key);
      state.pantryBuy = [...set];
      save();
      render({ keepScroll: true });
      break;
    }
    case "reset-draft": state.draft = null; ui.ingQuery = ""; save(); render(); break;
    case "add-ing": {
      const d = addToDraft(el.dataset.ean);
      if (!d) break;
      if (/^#\/creer/.test(location.hash)) {
        ui.ingQuery = "";
        render({ keepScroll: true });
        $("#ing-search")?.focus();
      } else {
        toast(`Ajouté à ${d.nom ? `« ${d.nom} »` : "votre recette"} (${draftLines(d).length} ingrédient${draftLines(d).length > 1 ? "s" : ""}).`);
      }
      break;
    }
    case "ing-remove": {
      const lines = draftLines(state.draft);
      lines.splice(+el.dataset.index, 1);
      state.draft.texte = lines.join("\n");
      save();
      render({ keepScroll: true });
      break;
    }
    case "share-draft": {
      const url = `${location.origin}${location.pathname}#r=${C.encode(state.draft)}`;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast("Lien copié."), () => toast("Copie impossible."));
      break;
    }
    case "delete-custom":
      state.custom = state.custom.filter((r) => r.id !== id);
      delete state.menu[id];
      state.draft = null;
      save();
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
    render({ keepScroll: true });
  } else if (el.dataset.action === "member-present") {
    const m = memberById(el.dataset.id);
    m.present = el.checked;
    if (!present().length) { m.present = true; toast("Au moins une personne doit être présente."); }
    changed();
    render({ keepScroll: true });
  } else if (el.dataset.action === "member-dislike") {
    if (el.value) toggleMemberPref(el.dataset.id, "deteste", el.value);
    render({ keepScroll: true });
  } else if (el.dataset.action === "ing-product") {
    const lines = draftLines(state.draft);
    const i = +el.dataset.index;
    lines[i] = `${lines[i].replace(/\s+#\d{8,14}\s*$/, "")} #${el.value}`;
    state.draft.texte = lines.join("\n");
    save();
    render({ keepScroll: true });
  } else if (el.dataset.action === "ing-qty") {
    render({ keepScroll: true });
  } else if (el.dataset.action === "fridge-input") {
    // choix dans la liste déroulante ou validation au clavier
    addFridge(el.value);
    render({ keepScroll: true });
    $("#fridge-input")?.focus();
  } else if (el.dataset.action === "guide-done") {
    setGuideDone(el.dataset.ean, el.checked);
    render({ keepScroll: true });
  } else if (el.dataset.action === "keep-awake") {
    state.keepAwake = el.checked;
    save();
    syncWakeLock();
  } else if (el.dataset.action === "product-rayon") {
    ui.productRayon = el.value;
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
const previewSoon = debounce(() => { const el = $("#draft-preview"); if (el && state.draft) el.innerHTML = draftPreview(state.draft); }, 250);
const suggestSoon = debounce(() => { const el = $("#ing-suggest"); if (el) el.innerHTML = suggestHtml(ui.ingQuery || ""); }, 200);

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "recipe-search") { ui.query = el.value; rerenderSoon(); }
  else if (el.dataset.action === "product-query") { ui.productQuery = el.value; rerenderSoon(); }
  else if (el.dataset.action === "member-input") { updateMember(el.dataset.id, el.dataset.field, el.value); rerenderSoon(); }
  else if (el.dataset.action === "foyer-input") { state.foyer[el.dataset.field] = el.value; changed(); rerenderSoon(); }
  else if (el.dataset.action === "draft") { state.draft[el.dataset.field] = el.value; save(); previewSoon(); }
  else if (el.dataset.action === "ing-query") { ui.ingQuery = el.value; suggestSoon(); }
  else if (el.dataset.action === "pick-query") { ui.pickQuery = el.value; rerenderSoon(); }
  else if (el.dataset.action === "ing-qty") {
    // la quantité remplace le nombre en tête de ligne ; on garde l'unité, le nom et le produit choisi
    const lines = draftLines(state.draft);
    const i = +el.dataset.index;
    const v = el.value.replace(",", ".");
    if (!(+v > 0)) return;
    lines[i] = lines[i].replace(/^\s*\d+(?:[.,]\d+)?/, v);
    state.draft.texte = lines.join("\n");
    save();
    previewSoon();
  }
});

document.addEventListener("keydown", (e) => {
  if (!/^#\/cuisine/.test(location.hash)) return;
  if (e.key === "ArrowRight") { ui.cookStep++; render(); }
  if (e.key === "ArrowLeft") { ui.cookStep = Math.max(0, ui.cookStep - 1); render(); }
});


// mémorise l'ouverture des volets repliables de la fiche (l'événement « toggle » ne remonte pas : on écoute en capture)
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.dataset && d.dataset.fold) ui.folds[d.dataset.fold] = d.open;
}, true);

window.addEventListener("hashchange", () => {
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
