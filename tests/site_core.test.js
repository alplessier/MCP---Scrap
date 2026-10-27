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
