// Tests de site/core.js et de site/recettes.json : node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Core = require("../site/core.js");

const product = (o) => ({ ean: "1", nom: "x", prix: 1.35, prix_unite: 7.5, unite: "KG", categorie: "", macros: null, ...o });
const catalogue = (products) => Core.loadCatalogue({
  maj: "2026-10-27", magasin: { ref: "575", nom: "Drive Test" },
  colonnes: ["ean", "nom", "prix", "prix_unite", "unite", "categorie", "macros"],
  produits: products.map((p) => [p.ean, p.nom, p.prix, p.prix_unite, p.unite, p.categorie, p.macros]),
  generique: { "filet de poulet": [115, 24, 0, 2] },
});

test("parseLine et mise à l'échelle", () => {
  const ing = Core.parseLine("2 oeufs @60g");
  assert.equal(ing.pieces, 2);
  assert.equal(ing.grams, 120);
  const x3 = Core.scaleIngredient(Core.parseLine("150 g riz basmati"), 1.5);
  assert.equal(x3.grams, 225);
  assert.equal(x3.raw, "225 g riz basmati");
  assert.ok(Core.parseLine("du sel").error);
});

test("le produit pertinent passe avant le sponsorisé, la catégorie aide (« Œufs »)", () => {
  const cat = catalogue([
    product({ ean: "k", nom: "Oeufs Chocolat Lait KINDER", categorie: "Bonbons au chocolat", prix_unite: 59 }),
    product({ ean: "o", nom: "Œufs frais SIMPL", categorie: "Œufs", unite: "PIECE", prix: 1.79, prix_unite: 0.18 }),
  ]);
  assert.equal(Core.computeLines(cat, ["2 oeufs @60g"])[0].product.ean, "o");
});

test("listes de courses : même produit regroupé, paquets entiers, « j'en ai déjà »", () => {
  const cat = catalogue([product({ ean: "s", nom: "Skyr Nature", prix: 3.25, prix_unite: 4.06 })]);
  const lines = [...Core.computeLines(cat, ["200 g skyr"]), ...Core.computeLines(cat, ["100 g skyr"], { keyPrefix: "b:" })];
  const list = Core.shoppingList(lines);
  assert.equal(list.length, 1);
  assert.equal(list[0].packs, 1); // 300 g tiennent dans un pot de 800 g
  assert.equal(Core.shoppingList(lines, { exclude: new Set(["s"]) })[0].owned, true);
});

test("produit choisi à la main, puis repli si le code-barres a disparu", () => {
  const cat = catalogue([product({ ean: "a", nom: "Filet de poulet A" }), product({ ean: "b", nom: "Filet de poulet B", prix_unite: 12 })]);
  assert.equal(Core.computeLines(cat, ["300 g filet de poulet"], { pins: { "filet de poulet": "b" } })[0].product.ean, "b");
  assert.equal(Core.computeLines(cat, ["300 g filet de poulet"], { pins: { "filet de poulet": "zzz" } })[0].product.ean, "a");
});

test("objectifs : Mifflin-St Jeor, activité, objectif", () => {
  const t = Core.dailyTargets({ sexe: "homme", age: 30, poids: 75, taille: 180, activite: "modere", objectif: "maintien" });
  assert.equal(t.bmr, 1730); // 750 + 1125 - 150 + 5
  assert.equal(t.kcal, Math.round(1730 * 1.55));
  assert.equal(t.proteines, 135); // 1,8 g/kg
  assert.ok(Math.abs(t.proteines * 4 + t.glucides * 4 + t.lipides * 9 - t.kcal) < 10);
  const seche = Core.dailyTargets({ sexe: "femme", age: 30, poids: 60, taille: 165, activite: "leger", objectif: "seche" });
  assert.ok(seche.kcal < seche.tdee && seche.proteines === 132);
  assert.equal(Core.dailyTargets({ sexe: "homme", age: "", poids: 75, taille: 180 }), null);
  assert.equal(Core.portionsForTarget(500, { kcal: 750 }), 1.5);
  assert.equal(Core.portionsForTarget(100, { kcal: 2000 }), 2); // borné à ×2
  assert.equal(Core.tooLightForMeal(371, { kcal: 1120 }), true); // omelette en prise de masse
  assert.equal(Core.tooLightForMeal(554, { kcal: 1120 }), false);
});

test("adresse du panier : ancre décodable, produits déjà possédés exclus", () => {
  const cat = catalogue([product({ ean: "s", nom: "Skyr Nature" })]);
  const list = [{ product: cat.byEan.get("s"), packs: 2, owned: false }, { product: cat.byEan.get("s"), packs: 1, owned: true }];
  const url = Core.cartUrl(cat, "Bowl é", list);
  assert.match(url, /^https:\/\/www\.carrefour\.fr\/set-store\/575#recette-macros=/);
  const order = Core.decode(url.split("#recette-macros=")[1]);
  assert.deepEqual(order.articles, [["s", 2, "Skyr Nature"]]);
  assert.equal(order.nom, "Bowl é");
});

// Les recettes du site face au vrai catalogue (si les données ont été construites : python -m recette_macros.site)
const catalogPath = path.join(__dirname, "..", "site", "data", "catalogue.json");
test("chaque ingrédient des recettes trouve un produit du Drive, avec des macros", { skip: !fs.existsSync(catalogPath) }, () => {
  const cat = Core.loadCatalogue(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
  const { recettes, tags } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "site", "recettes.json"), "utf8"));
  const problems = [];
  const ids = new Set();
  for (const r of recettes) {
    assert.ok(!ids.has(r.id), `id en double : ${r.id}`);
    ids.add(r.id);
    for (const t of r.tags) assert.ok(tags[t], `${r.id} : étiquette inconnue ${t}`);
    assert.ok(r.etapes.length && r.portions > 0 && r.emoji && r.couleur, `${r.id} : fiche incomplète`);
    for (const x of Core.computeLines(cat, r.ingredients)) {
      if (x.error || !x.product) problems.push(`${r.nom} : « ${x.ing.raw} » sans produit`);
      else if (!x.macros) problems.push(`${r.nom} : « ${x.ing.raw} » sans macros (${x.product.nom})`);
    }
  }
  assert.deepEqual(problems, []);
});

test("note de pertinence : protéinée et bien dosée devant grasse ou trop légère", () => {
  const daily = Core.dailyTargets({ sexe: "homme", age: 25, poids: 75, taille: 178, activite: "modere", objectif: "recompo" });
  assert.equal(daily.proteines, 165); // 2,2 g/kg
  const opts = { daily, meals: 3, goal: "recompo" };
  const bowl = Core.recipeScore({ macros: [550, 47, 66, 8], cost: 2.4 }, opts);
  const gras = Core.recipeScore({ macros: [700, 20, 40, 50], cost: 2.4 }, opts);
  const leger = Core.recipeScore({ macros: [150, 15, 10, 5], cost: 2.4 }, opts);
  assert.ok(bowl.score > gras.score && bowl.score > leger.score, `${bowl.score} ${gras.score} ${leger.score}`);
  assert.equal(Core.recipeScore({ macros: [550, 47, 66, 8], cost: 2.4 }, { daily: null }), null);
  // une collation est jugée face à une collation, pas à un repas
  const snack = Core.recipeScore({ macros: [250, 20, 25, 6], cost: 1 }, { ...opts, snack: true });
  assert.equal(snack.size, 1.25);
});

test("allergènes, régime et matériel déduits des ingrédients et des étapes", () => {
  const omelette = { ingredients: ["3 oeufs", "40 g feta", "100 g épinards"], etapes: ["Faites cuire à la poêle 4 minutes."] };
  const t = Core.recipeTraits(omelette);
  assert.deepEqual(t.allergens.sort(), ["lait", "oeufs"]);
  assert.equal(t.meat, false);
  assert.equal(t.vegetal, false);
  assert.deepEqual(t.equipment, ["plaques"]);
  const mug = Core.recipeTraits({ ingredients: ["30 g flocons d'avoine", "100 ml lait de coco"], etapes: ["Faites cuire 1 minute au micro-ondes."] });
  assert.deepEqual(mug.allergens, ["gluten"]);
  assert.deepEqual(mug.equipment, ["micro-ondes"]);
  assert.equal(Core.recipeTraits({ ingredients: ["2 c. à soupe beurre de cacahuète"] }).allergens.join(), "arachides");
  assert.equal(Core.recipeTraits({ ingredients: ["150 g lardons"] }).pork, true);
});

test("compatibilité avec le foyer : allergies, régimes, dégoûts, matériel", () => {
  const chili = { ingredients: ["300 g boeuf haché", "1 boîte haricots rouges", "1 oignon"], etapes: ["Faites revenir à la poêle."] };
  assert.equal(Core.recipeCompat(chili, {}).ok, true);
  const veg = Core.recipeCompat(chili, { regimes: ["vegetarien"] });
  assert.equal(veg.ok, false);
  assert.match(veg.reasons.join(), /végétarien/);
  assert.equal(Core.recipeCompat(chili, { regimes: ["pescetarien"] }).ok, false);
  assert.match(Core.recipeCompat(chili, { deteste: ["oignon"] }).reasons.join(), /oignon/);
  assert.equal(Core.recipeCompat(chili, { deteste: ["courgette"] }).ok, true);
  assert.equal(Core.recipeCompat(chili, { materiel: ["four"] }).ok, false);
  assert.equal(Core.recipeCompat(chili, { materiel: ["plaques"] }).ok, true);
  assert.equal(Core.recipeCompat({ ingredients: ["100 g tofu"] }, { allergies: ["soja"] }).ok, false);
});

test("foyer : contraintes réunies, portion de chacun, budget et temps", () => {
  const a = { id: "a", nom: "A", sexe: "homme", age: 25, poids: 75, taille: 178, activite: "modere", objectif: "recompo", repas: 3,
    prefs: { allergies: ["lait"], regimes: ["aucun"], deteste: ["olive"] } };
  const b = { id: "b", nom: "B", sexe: "femme", age: 30, poids: 58, taille: 165, activite: "leger", objectif: "seche", repas: 3,
    prefs: { allergies: ["lait", "soja"], regimes: ["vegetarien"], deteste: [] } };
  const hp = Core.householdPrefs([a, b], { budget: "9", temps: "40", materiel: ["plaques"] });
  assert.deepEqual(hp.allergies, ["lait", "soja"]);
  assert.deepEqual(hp.regimes, ["vegetarien"]);
  assert.deepEqual(hp.deteste, ["olive"]);
  assert.equal(hp.budget, 9);
  const [pa, pb] = Core.memberPortions(450, [a, b]);
  assert.ok(pa.size > pb.size, "le sportif en recompo mange plus que la personne en sèche");
  assert.equal(Core.memberPortions(450, [{ id: "c", nom: "C" }])[0].size, 1);
  assert.equal(Core.budgetTimePenalty(2, 15, hp).factor, 1);
  const pen = Core.budgetTimePenalty(4, 30, hp);
  assert.deepEqual(pen.flags, ["budget", "temps"]);
  assert.ok(pen.factor < 0.75);
});

test("produits : protéines pour 100 kcal, et parcours du catalogue sans recherche", () => {
  const cat = catalogue([
    product({ ean: "1", nom: "Filet de poulet", macros: [110, 23, 0, 1.5] }),
    product({ ean: "2", nom: "Pain de mie", macros: [270, 8, 48, 4] }),
    product({ ean: "3", nom: "Eau minérale", macros: [0, 0, 0, 0] }),
    product({ ean: "4", nom: "Biscuit mystère", macros: null }),
    product({ ean: "5", nom: "Fond de veau", macros: [15, 6.1, 3, 3.9] }),
  ]);
  const [poulet, pain, eau] = cat.products;
  assert.equal(Math.round(Core.proteinPer100kcal(poulet) * 10) / 10, 20.9);
  assert.equal(Core.proteinPer100kcal(eau), -1);
  assert.deepEqual(Core.search(cat, "", { sort: "proteines-kcal" }).map((p) => p.ean), ["1", "2"]);
  assert.deepEqual(Core.search(cat, "", { sort: "proteines" }).map((p) => p.ean), ["1", "2", "5", "3"]);
  assert.deepEqual(Core.search(cat, ""), [], "sans recherche ni tri : rien");
  assert.equal(pain.nom, "Pain de mie");
});

test("placard, ingrédients facultatifs et ingrédients de chaque étape", () => {
  const opt = Core.parseLine("1 bouquet coriandre (facultatif)");
  assert.equal(opt.optional, true);
  assert.equal(opt.name, "bouquet coriandre");
  assert.equal(Core.parseLine("200 g riz basmati").optional, false);
  assert.equal(Core.scaleIngredient(opt, 2).optional, true);
  for (const n of ["huile d'olive", "sel", "sauce soja", "paprika fumé"]) assert.equal(Core.isPantry(n), true, n);
  for (const n of ["poivron rouge", "gingembre frais", "filet de poulet", "selle d'agneau"]) assert.equal(Core.isPantry(n), false, n);
  const steps = ["Faites cuire le riz.", "Saisissez le poulet dans l'huile d'olive.", "Servez."];
  assert.deepEqual(Core.stepIngredients(steps, ["filet de poulet", "riz basmati", "huile d'olive"]), [[1], [0, 2], []]);
});

test("avec ce que j'ai : ingrédients présents et manquants, placard ignoré", () => {
  const m = Core.fridgeMatch(["200 g filet de poulet", "100 g riz basmati", "200 g brocolis", "10 g huile d'olive", "1 bouquet persil (facultatif)"], ["Poulet", "riz"]);
  assert.deepEqual(m.have, ["filet de poulet", "riz basmati"]);
  assert.deepEqual(m.missing, ["brocolis"]);
  assert.equal(Math.round(m.ratio * 100), 67);
  assert.deepEqual(Core.fridgeMatch(["3 oeufs"], ["œufs"]).missing, []);
  assert.equal(Core.fridgeMatch(["3 oeufs"], []).ratio, 0);
});

test("jours de sport : plus d'énergie à l'entraînement, moins au repos, même total sur la semaine", () => {
  const daily = { kcal: 2400, proteines: 165, lipides: 70, glucides: 0 };
  const sport = Core.dayTargets(daily, 3, true);
  const rest = Core.dayTargets(daily, 3, false);
  assert.ok(sport.kcal > 2400 && rest.kcal < 2400);
  assert.ok(Math.abs(sport.kcal * 3 + rest.kcal * 4 - 2400 * 7) <= 7, "même total sur la semaine (aux arrondis près)");
  assert.equal(sport.proteines, 165);
  assert.ok(sport.glucides > rest.glucides);
  assert.equal(Core.dayTargets(daily, 0, false), daily);
  const m = { id: "a", sexe: "homme", age: 25, poids: 75, taille: 178, activite: "modere", objectif: "recompo", repas: 3, sportDays: [0, 2, 4] };
  assert.ok(Core.memberDaily(m, 0).kcal > Core.memberDaily(m, 1).kcal);
  assert.equal(Core.memberDaily(m).kcal, Core.dailyTargets(m).kcal);
  assert.ok(Core.memberPortions(400, [m], 0)[0].size >= Core.memberPortions(400, [m], 1)[0].size);
});

test("planning : créneaux selon le nombre de repas et repas manquants", () => {
  assert.deepEqual(Core.slotsFor(3), ["petit-dej", "dejeuner", "diner"]);
  assert.deepEqual(Core.slotsFor(2), ["dejeuner", "diner"]);
  const members = [{ id: "a", repas: 3 }, { id: "b", repas: 2 }];
  const plan = { 0: { dejeuner: { id: "x", who: ["a", "b"] }, "petit-dej": { id: "y", who: ["a"] } } };
  assert.deepEqual(Core.planGaps(plan, members), { a: 21 - 2, b: 14 - 1 });
});

test("nutriments : ceux du produit, sinon les valeurs moyennes, et repères du jour", () => {
  const cat = Core.loadCatalogue({
    maj: "2026-11-03", magasin: { ref: "575", nom: "Drive Test" },
    colonnes: ["ean", "nom", "prix", "prix_unite", "unite", "categorie", "macros", "nutriments"],
    produits: [["30000001", "Skyr nature", 2, 4, "KG", "", [60, 10, 4, 0.2], [0, 3.5, 0.1, 0.1]], ["30000002", "Riz basmati", 2, 2, "KG", "", null, null]],
    generique: { riz: [350, 7.5, 78, 0.6, 1.4, 0.3, 0.2, 0], "filet de poulet": [115, 24, 0, 2] },
  });
  const lines = Core.computeLines(cat, ["200 g skyr nature #30000001", "100 g riz basmati #30000002", "100 g filet de poulet"]);
  assert.deepEqual(lines[0].nutriments, [0, 7, 0.2, 0.2]);           // fiche du produit
  assert.deepEqual(lines[1].nutriments.map((v) => Math.round(v * 10) / 10), [1.4, 0.3, 0.2, 0]); // valeurs moyennes
  assert.equal(lines[2].nutriments, null);                             // inconnus
  const t = Core.totals(lines);
  assert.equal(Math.round(t.nutriments[1] * 10) / 10, 7.3);
  assert.equal(Math.round(t.nutrientCoverage * 100), 80);           // le poulet (115 kcal sur 585) n'est pas couvert
  assert.deepEqual(Core.nutrientTargets({ kcal: 2400 }), [30, 100, 32, 6]);
});

test("formats : quantités additionnées puis paquets les moins chers parmi les formats du même produit", () => {
  const cat = Core.loadCatalogue({
    maj: "2026-11-03", magasin: { ref: "575", nom: "Drive Test" },
    colonnes: ["ean", "nom", "marque", "prix", "prix_unite", "unite", "conditionnement", "macros"],
    produits: [
      ["30000006", "Œufs Bio CARREFOUR BIO", "CARREFOUR BIO", 2.39, 0.398, "PIECE", "la boite de 6", null],
      ["30000012", "Œufs Bio CARREFOUR BIO", "CARREFOUR BIO", 3.99, 0.3325, "PIECE", "la boite de 12", null],
      ["30000250", "Haricots rouges CARREFOUR CLASSIC'", "CARREFOUR CLASSIC'", 0.75, 3, "KG", "la boite de 250g", null],
      ["30000500", "Haricots rouges CARREFOUR CLASSIC'", "CARREFOUR CLASSIC'", 1.45, 2.9, "KG", "la boite de 500g", null],
      ["30001000", "Haricots rouges CARREFOUR CLASSIC'", "CARREFOUR CLASSIC'", 2.4, 2.4, "KG", "la boite de 1kg", null],
      ["30009999", "Haricots rouges D'AUCY", "D'AUCY", 1.99, 3.98, "KG", "la boite de 500g", null],
    ],
    generique: {},
  });
  // deux recettes : 6 œufs puis 6 œufs (boîte de 6 choisie), 400 g puis 400 g de haricots (boîte de 500 g)
  const lines = Core.computeLines(cat, ["6 oeufs #30000006", "6 oeufs #30000006", "400 g haricots rouges #30000500", "400 g haricots rouges #30000500"]);
  const plainList = Core.shoppingList(lines);
  assert.deepEqual(plainList.map((e) => [e.product.ean, e.packs]), [["30000006", 2], ["30000500", 2]]); // sans optimisation
  const list = Core.shoppingList(lines, { cat });
  assert.deepEqual(list.map((e) => [e.product.ean, e.packs]), [["30000012", 1], ["30001000", 1]]);
  assert.equal(list[0].optimized.before, "2 × la boite de 6");
  assert.equal(Math.round(list[1].optimized.saving * 100), 50); // 2 × 1,45 → 2,40
  // un autre produit (autre marque) n'est jamais proposé ; garder son format désactive l'optimisation
  const kept = Core.shoppingList(lines, { cat, keep: new Set([Core.formatKey(cat.byEan.get("30000006"))]) });
  assert.deepEqual(kept.map((e) => [e.product.ean, e.packs]), [["30000006", 2], ["30001000", 1]]);
  // 13 œufs : une boîte de 12 + une de 6 coûte moins que 3 boîtes de 6
  const mix = Core.cheapestPacks(cat.formats.get(Core.formatKey(cat.byEan.get("30000006"))), 13);
  assert.deepEqual(mix.map((x) => [x.product.ean, x.packs]).sort(), [["30000006", 1], ["30000012", 1]]);
});

test("formats : « 5 % MG » et « 15 % MG » ne sont pas le même produit", () => {
  const p = (nom, cond) => ({ nom, marque: "CHARAL", unite: "KG", conditionnement: cond });
  assert.notEqual(Core.formatKey(p("Steaks Hachés Bœuf 5% MG CHARAL")), Core.formatKey(p("Steaks Hachés Bœuf 15% MG CHARAL")));
  assert.equal(Core.formatKey(p("Haricots rouges CHARAL", "250g")), Core.formatKey(p("Haricots rouges  CHARAL", "500g")));
});

test("vertus santé : atouts et points de vigilance d'après les ingrédients et les nutriments", () => {
  const bowl = { portions: 2, ingredients: ["200 g pois chiches", "120 g quinoa", "300 g brocolis", "10 g huile d'olive", "100 g skyr"] };
  const h = Core.healthProfile(bowl, { nutriments: [9, 4, 1, 0.8], nutrientCoverage: 0.9 });
  assert.deepEqual(h.pros.sort(), ["cereales", "fermentes", "fibres", "legumineuses", "olive", "vegetaux"]);
  assert.deepEqual(h.cons, []);
  assert.equal(h.score, 6);
  const croque = { portions: 1, ingredients: ["2 tranches pain de mie complet @25g", "60 g jambon blanc", "20 g emmental"] };
  const c = Core.healthProfile(croque, { nutriments: [3, 2, 6, 2.6], nutrientCoverage: 0.9 });
  assert.deepEqual(c.pros, ["cereales"]);
  assert.deepEqual(c.cons, ["charcuterie", "sel"]);
  assert.equal(c.score, 0);
  // noix de coco n'est pas un fruit à coque ; pomme de terre n'est pas compté comme légume ; nutriments trop incomplets : ignorés
  const coco = Core.healthProfile({ portions: 1, ingredients: ["200 ml lait de coco", "300 g pommes de terre"] }, { nutriments: [10, 0, 0, 5], nutrientCoverage: 0.3 });
  assert.deepEqual([coco.pros, coco.cons], [[], []]);
});
