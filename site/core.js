// Logique du site, sans affichage : recherche dans le catalogue, recettes, courses, objectifs sportifs.
// Chargé par le navigateur (window.Core) et par Node pour les tests (tests/site_core.test.js).
"use strict";

const Core = (() => {
  const STOPWORDS = new Set(["de", "du", "des", "la", "le", "les", "au", "aux", "en", "et", "a", "d", "l"]);
  const TO_GRAMS = { g: 1, kg: 1000, ml: 1, cl: 10, l: 1000 };
  const LINE_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l|pcs?|pièces?|x)?\.?\s+(.+?)(?:\s+@\s*(\d+(?:[.,]\d+)?)\s*g)?(?:\s+#(\d{8,14}))?\s*$/i;

  // ---------- Texte ----------

  // « Œufs » s'écrit avec une ligature, que NFKD ne décompose pas
  const normalize = (s) => s.toLowerCase().replace(/œ/g, "oe").replace(/æ/g, "ae").normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const words = (s) => normalize(s).match(/[a-z0-9]+/g) || [];
  const stem = (t) => (t.length > 3 ? t.replace(/[sx]+$/, "") : t);
  const queryTokens = (q) => words(q).filter((t) => !STOPWORDS.has(t)).map(stem);

  // Position des mots de la requête dans le nom (plus c'est tôt, plus c'est pertinent), ou -1.
  function relevance(tokens, nameWords) {
    let score = 0;
    for (const t of tokens) {
      const i = nameWords.findIndex((w) => w.startsWith(t));
      if (i < 0) return -1;
      score += i;
    }
    return score + nameWords.length * 0.05;
  }

  // ---------- Catalogue ----------

  function loadCatalogue(data) {
    const cols = data.colonnes;
    const products = data.produits.map((row) => {
      const p = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
      p.words = words(`${p.nom} ${p.categorie || ""}`);
      p.nameWords = words(p.nom);
      p.categoryWords = words(p.categorie || "");
      return p;
    });
    const byEan = new Map(products.map((p) => [p.ean, p]));
    const generic = Object.entries(data.generique).map(([k, m]) => ({ tokens: queryTokens(k), macros: m }));
    return { maj: data.maj, magasin: data.magasin, products, byEan, generic };
  }

  function search(cat, query, { usableFor = null, sort = "pertinence" } = {}) {
    const tokens = queryTokens(query);
    if (!tokens.length) return [];
    const hits = [];
    for (const p of cat.products) {
      if (usableFor && !isUsable(usableFor, p)) continue;
      let r = relevance(tokens, p.nameWords);
      if (r < 0 && !usableFor) {
        const inCategory = relevance(tokens, p.words);
        if (inCategory >= 0) r = inCategory + 5;
      }
      // bonus quand la catégorie correspond aussi : « oeufs » → catégorie Œufs, pas Kinder
      if (r >= 0) hits.push({ p, r: r - (relevance(tokens, p.categoryWords) >= 0 ? 1 : 0) });
    }
    const sorters = {
      pertinence: (a, b) => a.r - b.r || (a.p.prix_unite ?? 1e9) - (b.p.prix_unite ?? 1e9),
      "prix-kg": (a, b) => (a.p.prix_unite ?? 1e9) - (b.p.prix_unite ?? 1e9),
      "proteines-euro": (a, b) => proteinPerEuro(b.p) - proteinPerEuro(a.p),
      proteines: (a, b) => (b.p.macros?.[1] ?? -1) - (a.p.macros?.[1] ?? -1),
    };
    return hits.sort(sorters[sort] || sorters.pertinence).map((h) => h.p);
  }

  const proteinPerEuro = (p) => (p.macros && p.prix_unite && p.unite !== "PIECE" ? (p.macros[1] * 10) / p.prix_unite : -1);

  function genericMacros(cat, name) {
    const nameWords = words(name);
    const hit = cat.generic.find((g) => g.tokens.every((t) => nameWords.some((w) => w.startsWith(t))));
    return hit ? hit.macros : null;
  }

  // ---------- Ingrédients ----------

  function parseLine(raw) {
    const m = raw.match(LINE_RE);
    if (!m) return { raw, error: "Ligne non comprise — exemple : « 200 g blanc de poulet »" };
    const qty = parseFloat(m[1].replace(",", "."));
    const unit = (m[2] || "").toLowerCase();
    const pieceWeight = m[4] ? parseFloat(m[4].replace(",", ".")) : null;
    const ing = { raw, name: m[3].trim(), ean: m[5] || null, grams: null, pieces: null, pieceWeight };
    if (unit in TO_GRAMS) ing.grams = qty * TO_GRAMS[unit];
    else {
      ing.pieces = qty;
      if (pieceWeight) ing.grams = qty * pieceWeight;
    }
    return ing;
  }

  const parseLines = (text) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));

  // Quantité multipliée (portions) ; le libellé suit, arrondi lisiblement
  function scaleIngredient(ing, factor) {
    if (ing.error || factor === 1) return ing;
    const out = { ...ing };
    if (ing.grams != null) out.grams = ing.grams * factor;
    if (ing.pieces != null) out.pieces = ing.pieces * factor;
    out.raw = `${quantityLabel(out)} ${ing.name}`;
    return out;
  }

  function quantityLabel(ing) {
    const round = (v) => (v >= 100 ? Math.round(v / 5) * 5 : v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
    if (ing.pieces != null) return String(round(ing.pieces)).replace(".", ",");
    if (ing.grams >= 1000) return `${String(Math.round(ing.grams / 100) / 10).replace(".", ",")} kg`;
    return `${String(round(ing.grams)).replace(".", ",")} g`;
  }

  function isUsable(ing, p) {
    if (p.prix_unite == null) return false;
    if (p.unite === "PIECE") return ing.pieces != null;
    return ing.grams != null && (p.unite === "KG" || p.unite === "L");
  }

  function candidatesFor(cat, ing, strategy = "pertinence", max = 8) {
    const top = search(cat, ing.name, { usableFor: ing }).slice(0, max);
    // « moins cher » : les moins chers parmi les produits pertinents, pas parmi tout le rayon
    if (strategy === "moins-cher") top.sort((a, b) => a.prix_unite - b.prix_unite);
    return top;
  }

  // Paquets entiers à acheter (tolérance de 2 % pour les arrondis du prix au kilo affiché)
  function packsFor(p, used) {
    const pack = p.prix / p.prix_unite;
    return pack > 0 ? Math.max(1, Math.ceil(used / pack - 0.02)) : null;
  }

  function costLine(cat, ing, p) {
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
      per100 = genericMacros(cat, ing.name);
      out.generic = !!per100;
    }
    if (per100 && ing.grams != null) out.macros = per100.map((v) => (v * ing.grams) / 100);
    return out;
  }

  // Une recette : liste de lignes, multipliée par `factor`, avec le produit choisi pour chaque ligne.
  // pins : { clé de ligne → EAN choisi à la main }
  function computeLines(cat, lines, { factor = 1, pins = {}, strategy = "pertinence", keyPrefix = "" } = {}) {
    return lines.map((raw, i) => {
      const parsed = parseLine(raw);
      if (parsed.error) return { ing: parsed, error: parsed.error, key: `${keyPrefix}${i}` };
      const ing = scaleIngredient(parsed, factor);
      const key = `${keyPrefix}${normalize(parsed.name)}`;
      const choices = candidatesFor(cat, ing, strategy);
      const pinned = ing.ean || pins[key];
      let product = pinned ? cat.byEan.get(pinned) : null;
      if (product && !choices.includes(product)) choices.unshift(product);
      product = product || choices[0] || null;
      return { ...costLine(cat, ing, product), choices, key };
    });
  }

  function totals(results) {
    const macros = [0, 0, 0, 0];
    let cost = 0;
    const missingPrice = [], missingMacros = [];
    for (const r of results) {
      if (r.error) continue;
      if (r.cost != null) cost += r.cost; else missingPrice.push(r.ing.raw);
      if (r.macros) r.macros.forEach((v, i) => (macros[i] += v)); else missingMacros.push(r.ing.raw);
    }
    return { cost, macros, missingPrice, missingMacros };
  }

  // Un même produit sur plusieurs lignes ou recettes : on additionne avant de compter les paquets
  // (200 g + 100 g de skyr tiennent dans un seul pot de 800 g).
  function shoppingList(results, { exclude = new Set() } = {}) {
    const byEan = new Map();
    for (const r of results) {
      if (!r.product || r.used == null) continue;
      const entry = byEan.get(r.product.ean) || { product: r.product, used: 0, uses: [] };
      entry.used += r.used;
      entry.uses.push(r.ing.raw);
      byEan.set(r.product.ean, entry);
    }
    return [...byEan.values()].map((e) => {
      const packs = packsFor(e.product, e.used);
      return { ...e, packs, price: packs * e.product.prix, owned: exclude.has(e.product.ean) };
    });
  }

  // ---------- Objectifs sportifs ----------

  const ACTIVITY = {
    sedentaire: { label: "Sédentaire", hint: "peu ou pas de sport", factor: 1.2 },
    leger: { label: "Léger", hint: "1 à 2 séances par semaine", factor: 1.375 },
    modere: { label: "Modéré", hint: "3 à 4 séances par semaine", factor: 1.55 },
    intense: { label: "Intense", hint: "5 à 6 séances par semaine", factor: 1.725 },
    athlete: { label: "Très intense", hint: "2 séances par jour", factor: 1.9 },
  };
  // kcal : ajustement de la dépense ; proteines : g par kg de poids de corps
  const GOALS = {
    seche: { label: "Sèche", hint: "perdre du gras en gardant le muscle", kcal: 0.85, proteines: 2.2 },
    maintien: { label: "Maintien", hint: "garder sa forme", kcal: 1, proteines: 1.8 },
    recompo: { label: "Recomposition", hint: "perdre du gras et prendre du muscle", kcal: 0.9, proteines: 2.2 },
    masse: { label: "Prise de masse", hint: "gagner du muscle", kcal: 1.1, proteines: 2.0 },
  };

  // Note de 0 à 100 : à quel point une recette sert l'objectif, une fois la portion adaptée au repas idéal.
  // - protéines : part des kcal venant des protéines (on vise 30 à 35 % en sèche ou recomposition) ;
  // - adéquation : kcal de la portion adaptée (au plus ×2) comparées au repas idéal ;
  // - lipides : pénalité au-delà de 35 % des kcal ;
  // - coût : moins cher, mieux c'est (à 4 € la portion adaptée, ce critère vaut la moitié).
  // Collations et desserts sont comparés à une collation (12 % des besoins du jour), pas à un repas.
  const SCORE_WEIGHTS = {
    seche: { proteines: 0.45, fit: 0.2, lipides: 0.15, cout: 0.2 },
    recompo: { proteines: 0.45, fit: 0.25, lipides: 0.1, cout: 0.2 },
    maintien: { proteines: 0.3, fit: 0.3, lipides: 0.15, cout: 0.25 },
    masse: { proteines: 0.3, fit: 0.4, lipides: 0.1, cout: 0.2 },
  };
  function recipeScore(perPortion, { daily, meals = 3, goal = "maintien", snack = false }) {
    const [kcal, p, , l] = perPortion.macros;
    if (!daily || !(kcal > 0)) return null;
    const target = snack ? { kcal: daily.kcal * 0.12 } : mealTarget(daily, meals);
    const size = portionsForTarget(kcal, target);
    const proteinShare = (p * 4) / kcal;
    const fatShare = (l * 9) / kcal;
    const parts = {
      proteines: Math.min(1, proteinShare / (goal === "masse" ? 0.28 : 0.35)),
      fit: Math.max(0, 1 - Math.abs(1 - (kcal * size) / target.kcal)),
      lipides: Math.max(0, 1 - Math.max(0, fatShare - 0.35) * 3),
      cout: 1 / (1 + (perPortion.cost * size) / 4),
    };
    const w = SCORE_WEIGHTS[goal] || SCORE_WEIGHTS.maintien;
    const score = Object.keys(w).reduce((sum, k) => sum + w[k] * parts[k], 0);
    return { score: Math.round(score * 100), size, parts, proteinesAdaptees: p * size, kcalAdaptees: kcal * size };
  }

  // Mifflin-St Jeor, puis niveau d'activité et objectif. Lipides : au moins 0,8 g/kg et 25 % des kcal ;
  // glucides : le reste.
  function dailyTargets(profile) {
    const { sexe, age, poids, taille, activite, objectif } = profile;
    if (!(poids > 0 && taille > 0 && age > 0)) return null;
    const bmr = 10 * poids + 6.25 * taille - 5 * age + (sexe === "femme" ? -161 : 5);
    const tdee = bmr * (ACTIVITY[activite] || ACTIVITY.modere).factor;
    const goal = GOALS[objectif] || GOALS.maintien;
    const kcal = Math.round(tdee * goal.kcal);
    const proteines = Math.round(poids * goal.proteines);
    const lipides = Math.round(Math.max(poids * 0.8, (kcal * 0.25) / 9));
    const glucides = Math.max(0, Math.round((kcal - proteines * 4 - lipides * 9) / 4));
    return { bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, proteines, glucides, lipides };
  }

  function mealTarget(daily, meals = 3) {
    if (!daily) return null;
    return { kcal: daily.kcal / meals, proteines: daily.proteines / meals, glucides: daily.glucides / meals, lipides: daily.lipides / meals };
  }

  // Portions pour atteindre les kcal d'un repas, au quart de portion près. Au-delà de ×2, la recette est
  // trop légère pour faire un repas seule : mieux vaut l'accompagner que de la tripler (18 œufs…).
  const MAX_SIZE = 2;
  function portionsForTarget(kcalPerPortion, target) {
    if (!target || !(kcalPerPortion > 0)) return 1;
    return Math.min(MAX_SIZE, Math.max(0.5, Math.round((target.kcal / kcalPerPortion) * 4) / 4));
  }
  const tooLightForMeal = (kcalPerPortion, target) => !!target && kcalPerPortion > 0 && target.kcal / kcalPerPortion > MAX_SIZE + 0.25;

  // ---------- Caractéristiques déduites des recettes ----------
  // Déduites des noms d'ingrédients et des étapes, pour ne pas annoter 123 recettes à la main.
  // Chaque entrée : mots à chercher (début de mot, sans accents) ; « sauf » : mots qui annulent (lait de coco ≠ lait).

  const ALLERGENS = {
    gluten: { label: "Gluten", mots: ["pate", "spaghetti", "penne", "macaroni", "lasagne", "pain", "wrap", "farine", "chapelure", "semoule", "boulgour", "muesli", "biscuit", "speculoos", "gnocchi", "avoine", "corn flake", "pizza", "couscous", "galette"], sauf: ["pate a tartiner"] },
    lait: { label: "Lait / lactose", mots: ["lait", "skyr", "fromage", "yaourt", "creme", "beurre", "feta", "mozzarella", "parmesan", "emmental", "cheddar", "cottage", "ricotta", "chevre", "whey"], sauf: ["lait de coco", "beurre de cacahuete", "lait de soja", "lait d amande", "creme de coco"] },
    oeufs: { label: "Œufs", mots: ["oeuf", "blanc d oeuf", "blancs d oeuf"] },
    arachides: { label: "Arachides", mots: ["cacahuete", "arachide"] },
    "fruits-coque": { label: "Fruits à coque", mots: ["amande", "noix", "noisette", "pesto", "cajou", "pistache"], sauf: ["noix de coco"] },
    poisson: { label: "Poisson", mots: ["saumon", "thon", "cabillaud", "sardine", "maquereau", "colin", "poisson"] },
    crustaces: { label: "Crustacés", mots: ["crevette", "crabe", "gambas"] },
    soja: { label: "Soja", mots: ["soja", "tofu", "edamame"] },
    sesame: { label: "Sésame", mots: ["sesame", "tahin"] },
    moutarde: { label: "Moutarde", mots: ["moutarde"] },
  };
  const MEAT = ["poulet", "dinde", "boeuf", "steak", "jambon", "lardon", "porc", "veau", "agneau", "merguez", "saucisse", "chorizo", "bacon", "viande"];
  const PORK = ["jambon", "lardon", "porc", "chorizo", "bacon", "saucisson"];
  const ANIMAL_OTHER = ["miel", "gelatine"]; // ni viande ni poisson, mais pas végétalien

  const DIETS = {
    aucun: { label: "Aucun" },
    vegetarien: { label: "Végétarien", hint: "ni viande ni poisson" },
    pescetarien: { label: "Pescétarien", hint: "poisson oui, viande non" },
    vegetalien: { label: "Végétalien", hint: "aucun produit animal" },
    "sans-porc": { label: "Sans porc" },
  };

  const EQUIPMENT = {
    four: { label: "Four", mots: ["four", "enfourn", "gratin", "rotiss"] },
    "micro-ondes": { label: "Micro-ondes", mots: ["micro onde"] },
    mixeur: { label: "Mixeur / blender", mots: ["mix", "blender"] },
    plaques: { label: "Plaques de cuisson", mots: ["poele", "casserole", "wok", "faites cuire", "faites revenir", "faites dorer", "saisi", "mijot", "bouill", "faites chauffer", "faites tomber", "faites fondre", "faites sauter", "faites le", "faites la", "griller", "toast", "brouill"] },
    gaufrier: { label: "Gaufrier", mots: ["gaufrier"] },
  };

  const SWEET = ["banane", "miel", "fruits rouges", "myrtille", "framboise", "pomme", "cacao", "chocolat", "sirop", "datte", "confiture", "speculoos", "raisin", "fraise"];

  // « mots » correspond si le texte contient ce mot en début de mot (après normalisation)
  const hasAny = (text, mots) => mots.some((m) => new RegExp(`(^|[^a-z])${m.replace(/ /g, "[^a-z]*")}`).test(text));
  const clean = (s) => normalize(s).replace(/[^a-z0-9]+/g, " ");

  function recipeTraits(r) {
    const ingredientNames = (r.ingredients || []).map((l) => clean(parseLine(l).name || l));
    const ingText = ingredientNames.join(" | ");
    const steps = (r.etapes || []).map(clean);
    const allergens = Object.entries(ALLERGENS)
      .filter(([, a]) => ingredientNames.some((n) => hasAny(n, a.mots) && !(a.sauf && hasAny(n, a.sauf))))
      .map(([k]) => k);
    const meat = hasAny(ingText, MEAT);
    const fish = allergens.includes("poisson") || allergens.includes("crustaces");
    // étape par étape : « faites cuire 1 minute au micro-ondes » ne demande pas de plaques de cuisson
    const STOVE = ["poele", "casserole", "wok", "plaque"];
    const equipment = Object.keys(EQUIPMENT).filter((k) => steps.some((st) => {
      if (k !== "plaques") return hasAny(st, EQUIPMENT[k].mots);
      const elsewhere = hasAny(st, EQUIPMENT.four.mots) || hasAny(st, EQUIPMENT["micro-ondes"].mots);
      return elsewhere ? hasAny(st, STOVE) : hasAny(st, EQUIPMENT.plaques.mots);
    }));
    const vegetal = !meat && !fish && !allergens.includes("oeufs") && !allergens.includes("lait") && !hasAny(ingText, ANIMAL_OTHER);
    return {
      allergens, meat, fish, pork: hasAny(ingText, PORK), vegetal, equipment: r.materiel || equipment,
      sweet: hasAny(ingText, SWEET), ingredientNames,
    };
  }

  // prefs : contraintes réunies du foyer { allergies:[], regimes:[], deteste:[], materiel:[] | null }
  function recipeCompat(r, prefs, traits = recipeTraits(r)) {
    const reasons = [];
    for (const a of prefs.allergies || []) if (traits.allergens.includes(a)) reasons.push(`contient : ${ALLERGENS[a].label.toLowerCase()}`);
    for (const d of prefs.regimes || []) {
      if (d === "vegetarien" && (traits.meat || traits.fish)) reasons.push("pas végétarien");
      if (d === "pescetarien" && traits.meat) reasons.push("contient de la viande");
      if (d === "vegetalien" && !traits.vegetal) reasons.push("pas végétalien");
      if (d === "sans-porc" && traits.pork) reasons.push("contient du porc");
    }
    for (const x of prefs.deteste || []) {
      const tokens = queryTokens(x);
      if (tokens.length && traits.ingredientNames.some((n) => relevance(tokens, words(n)) >= 0)) reasons.push(`contient : ${x}`);
    }
    if (prefs.materiel) {
      for (const e of traits.equipment) if (!prefs.materiel.includes(e)) reasons.push(`demande : ${EQUIPMENT[e].label.toLowerCase()}`);
    }
    return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  // Le foyer : contraintes réunies des membres présents (allergies, régimes, dégoûts) + réglages communs
  function householdPrefs(members, foyer = {}) {
    const union = (k) => [...new Set(members.flatMap((m) => (m.prefs && m.prefs[k]) || []))];
    return {
      allergies: union("allergies"), regimes: union("regimes").filter((d) => d !== "aucun"), deteste: union("deteste"),
      materiel: foyer.materiel || null, budget: +foyer.budget || null, temps: +foyer.temps || null,
    };
  }

  // Portion de chaque membre pour une recette : calée sur son repas idéal (ou standard sans objectif)
  function memberPortions(kcalPerPortion, members) {
    return members.map((m) => {
      const daily = dailyTargets(m);
      const meal = daily ? mealTarget(daily, m.repas || 3) : null;
      return { id: m.id, nom: m.nom, size: meal ? portionsForTarget(kcalPerPortion, meal) : 1, meal };
    });
  }

  // Budget (€ par jour et par personne) et temps (minutes de cuisine par jour) : pas d'exclusion, mais
  // la note baisse quand une portion dépasse le budget d'un repas ou la recette le temps d'un repas
  // (on compte deux repas cuisinés par jour).
  function budgetTimePenalty(costPerPortion, temps, prefs, meals = 3) {
    let factor = 1;
    const flags = [];
    if (prefs.budget && costPerPortion > prefs.budget / meals) { factor *= 0.85; flags.push("budget"); }
    if (prefs.temps && temps && temps > prefs.temps / 2) { factor *= 0.85; flags.push("temps"); }
    return { factor, flags };
  }

  // ---------- Partage ----------

  function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decode(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  }

  function cartUrl(cat, nom, list) {
    const order = {
      v: 1, nom, magasin: cat.magasin.ref, nomMagasin: cat.magasin.nom,
      articles: list.filter((e) => !e.owned && e.packs).map((e) => [e.product.ean, e.packs, e.product.nom]),
    };
    // set-store choisit d'abord le bon Drive ; l'ancre est conservée après la redirection
    return `https://www.carrefour.fr/set-store/${encodeURIComponent(cat.magasin.ref)}#recette-macros=${encode(order)}`;
  }

  return {
    normalize, words, queryTokens, relevance, loadCatalogue, search, proteinPerEuro, genericMacros,
    parseLine, parseLines, scaleIngredient, quantityLabel, isUsable, candidatesFor, packsFor, costLine,
    computeLines, totals, shoppingList, ACTIVITY, GOALS, dailyTargets, mealTarget, portionsForTarget, tooLightForMeal, recipeScore,
    ALLERGENS, DIETS, EQUIPMENT, recipeTraits, recipeCompat, householdPrefs, memberPortions, budgetTimePenalty,
    encode, decode, cartUrl,
  };
})();

if (typeof module !== "undefined") module.exports = Core;
