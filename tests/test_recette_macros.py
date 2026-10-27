from pathlib import Path

import pytest

from recette_macros.carrefour import Product, _parse_number, parse_search_html, store_is_applied
from recette_macros.nutrition import Macros, generic_per_100g, macros_from_off
from recette_macros.recipe import choose_product, cost_line, parse_line, parse_recipe
from recette_macros.text import matches

FIXTURE = (Path(__file__).parent / "fixtures" / "recherche_jaude.html").read_text(encoding="utf-8")


def product(**kw):
    base = dict(ean="1", name="x", brand="", price=1.35, unit_price=7.5, unit="KG", url="")
    return Product(**{**base, **kw})


def test_parse_search_html():
    products = parse_search_html(FIXTURE)
    assert [p.ean for p in products] == ["3270190203414", "3560070945252"]
    simpl = products[1]
    assert simpl.name == "Blanc de poulet SIMPL"
    assert simpl.brand == "SIMPL"
    assert simpl.price == 1.35
    assert (simpl.unit_price, simpl.unit) == (7.5, "KG")
    assert simpl.pack_quantity == pytest.approx(0.18)
    assert simpl.url == "https://www.carrefour.fr/p/blanc-de-poulet-simpl-3560070945252"
    assert products[0].promo == "-15% Mardi PASS"


def test_store_is_applied():
    assert store_is_applied(FIXTURE, "575")
    assert not store_is_applied(FIXTURE, "57")


@pytest.mark.parametrize("line, grams, pieces, name", [
    ("200 g blanc de poulet", 200, None, "blanc de poulet"),
    ("200g riz basmati", 200, None, "riz basmati"),
    ("1,5 kg pommes de terre", 1500, None, "pommes de terre"),
    ("15 ml huile d'olive", 15, None, "huile d'olive"),
    ("2 oeufs @60g", 120, 2, "oeufs"),
    ("3 citrons", None, 3, "citrons"),
])
def test_parse_line(line, grams, pieces, name):
    ing = parse_line(line)
    assert (ing.grams, ing.pieces, ing.name) == (grams, pieces, name)


def test_parse_line_pinned_ean_and_errors():
    assert parse_line("100 g skyr #3560070945252").ean == "3560070945252"
    with pytest.raises(ValueError):
        parse_line("du sel")
    assert len(parse_recipe("200 g poulet\n\n// commentaire\n100 g riz\n")) == 2


def test_matches():
    assert matches("filet de poulet", "Filets de Poulet Blanc LE GAULOIS")
    assert matches("brocolis", "Brocoli en fleurettes CARREFOUR")
    assert matches("pâtes", "Pates Penne Rigate BARILLA")
    assert not matches("filet de poulet", "Wraps De Blé Nature OLD EL PASO")
    assert not matches("riz basmati", "Riz Long Grain CARREFOUR")


def test_choose_product():
    ing = parse_line("200 g poulet")
    a = product(ean="11111111", unit_price=12.0, name="Blanc de poulet")
    b = product(ean="22222222", unit_price=7.5, name="Filets de poulet")
    wrap = product(ean="33333333", unit_price=1.0, name="Wraps de blé")
    assert choose_product(ing, [wrap, a, b], strategy="moins-cher") is b
    liquid_only = product(ean="c", unit=None, unit_price=None)
    assert choose_product(ing, [liquid_only, a, b]) is a
    assert choose_product(ing, [a, b], strategy="moins-cher") is b
    assert choose_product(parse_line("200 g poulet #22222222"), [a, b]) is b
    assert choose_product(parse_line("2 oeufs"), [a, b]) is None


def test_cost_line():
    line = cost_line(parse_line("200 g blanc de poulet"), product(), Macros(107, 16, 1.7, 3.8))
    assert line.cost_used == pytest.approx(1.5)
    assert line.packs == 2  # paquets de 180 g
    assert line.cost_bought == pytest.approx(2.70)
    assert line.macros.proteines == pytest.approx(32)
    assert line.macros.kcal == pytest.approx(214)


def test_cost_line_pieces():
    line = cost_line(parse_line("2 avocats"), product(unit="PIECE", unit_price=0.99, price=0.99), None)
    assert line.cost_used == pytest.approx(1.98)
    assert line.packs == 2
    assert line.macros is None


def test_macros_from_off():
    payload = {"status": 1, "product": {"nutriments": {
        "energy-kcal_100g": 107, "proteins_100g": 16, "carbohydrates_100g": 1.7, "fat_100g": 3.8}}}
    assert macros_from_off(payload) == Macros(107, 16, 1.7, 3.8)
    assert macros_from_off({"status": 0}) is None


def test_generic_macros_fallback():
    assert generic_per_100g("pommes de terre") == generic_per_100g("pomme de terre") != generic_per_100g("pomme")
    assert generic_per_100g("Filets de poulet") == Macros(115, 24, 0, 2)
    assert generic_per_100g("chocolat") is None
    line = cost_line(parse_line("200 g filet de poulet"), product(), None)
    assert line.macros_generic and line.macros.proteines == pytest.approx(48)


def test_parse_number():
    assert _parse_number("1,35") == 1.35
    assert _parse_number("7.50") == 7.5
    assert _parse_number("1.500.00") == 1500.0
    assert _parse_number("12") == 12.0


# ---------- Relevé hebdomadaire ----------

import json
from datetime import date, timedelta

from recette_macros import catalogue as cat
from recette_macros import nutrition as nut


def api_item(ean, price, per_unit=10.0, unit="KG", store="575", kind="product", purchasable=True):
    return {"type": kind, "ean": ean, "title": f"Produit {ean}", "brand": "MARQUE", "slug": f"produit-{ean}",
            "packaging": "le sachet de 500g", "image": "https://media.carrefour.fr/x/p_FORMAT/a.jpg",
            "categories": ["Rayon", "Sous-rayon"],
            "offers": {ean: {f"7631-150-{store}": {"attributes": {
                "availability": {"purchasable": purchasable},
                "price": {"price": price, "perUnit": per_unit, "unitOfMeasure": unit},
                "promotions": [{"label": "-15% Mardi PASS"}]}}}}}


def test_normalize_item():
    p = cat.normalize_item(api_item("111", 2.5, unit="U"), "575", "cremerie")
    assert p["prix"] == 2.5 and p["unite"] == "PIECE" and p["promo"] == "-15% Mardi PASS"
    assert p["image"].endswith("p_200x200/a.jpg")
    assert p["url"] == "https://www.carrefour.fr/p/produit-111-111"
    assert cat.normalize_item(api_item("111", 2.5, kind="marketplace"), "575", "x") is None
    assert cat.normalize_item(api_item("111", 2.5, store="999"), "575", "x") is None
    assert cat.normalize_item(api_item("111", 2.5, purchasable=False), "575", "x") is None


def test_update_catalogue_keeps_other_rayons_and_logs_price_changes(tmp_path, monkeypatch):
    week = {"cremerie": [api_item("1", 1.0), api_item("2", 2.0)], "surgeles": [api_item("3", 3.0)]}
    monkeypatch.setattr(cat, "scrape_rayon", lambda fc, rayon, store: (
        [cat.normalize_item(i, store, rayon) for i in week[rayon]],
        {"annonces": len(week[rayon]), "lus": len(week[rayon]), "pages_en_echec": [], "drive": len(week[rayon])}))
    cat.update_catalogue(object(), "575", ["cremerie", "surgeles"], tmp_path, log=lambda *_: None)

    week["cremerie"] = [api_item("1", 1.2), api_item("4", 4.0)]  # 1 change de prix, 2 disparaît, 4 arrive
    result = cat.update_catalogue(object(), "575", ["cremerie"], tmp_path, log=lambda *_: None)

    eans = {p["ean"] for p in json.loads((tmp_path / "produits.json").read_text())["produits"]}
    assert eans == {"1", "3", "4"}  # le rayon surgelés, non relevé, est conservé
    assert (result["nouveaux"], result["retires"]) == (1, 1)
    history = (tmp_path / "historique_prix.csv").read_text().splitlines()
    assert len(history) == 1 + 3 + 2  # en-tête, premier relevé, puis seulement les différences
    assert history[-2:] == [f"{date.today()},1,1.2", f"{date.today()},4,4.0"]


def test_update_nutrition_only_fetches_new_products(tmp_path, monkeypatch):
    (tmp_path / "produits.json").write_text(json.dumps({"produits": [{"ean": e} for e in ("a", "b", "c", "d")]}))
    old = (date.today() - timedelta(days=60)).isoformat()
    recent = date.today().isoformat()
    (tmp_path / "nutrition.json").write_text(json.dumps({
        "a": {"m": [100, 10, 10, 1], "vu": old},  # connu : jamais réinterrogé
        "b": {"m": None, "vu": recent},          # sans fiche, vérifié récemment : on attend
        "c": {"m": None, "vu": old},             # sans fiche depuis longtemps : on retente
    }))
    asked = []
    monkeypatch.setattr(nut, "fetch_batch", lambda eans, fc: asked.extend(eans) or {e: Macros(1, 2, 3, 4) for e in eans})
    monkeypatch.setattr(nut, "SEARCH_DELAY", 0)
    nut.update_nutrition(tmp_path, log=lambda *_: None)
    assert sorted(asked) == ["c", "d"]
    known = json.loads((tmp_path / "nutrition.json").read_text())
    assert known["a"]["m"] == [100, 10, 10, 1] and known["d"]["m"] == [1, 2, 3, 4]


def test_macros_recomputes_missing_kcal():
    m = nut.macros_from_nutriments({"energy-kcal_100g": 0, "proteins_100g": 23, "fat_100g": 11})
    assert m.kcal == 4 * 23 + 9 * 11


def test_build_userscript(tmp_path):
    import re

    from recette_macros.site import build_userscript

    (tmp_path / "carrefour-panier.js").write_text("console.log(1);\n", encoding="utf-8")
    script = build_userscript(tmp_path).read_text(encoding="utf-8")
    assert script.startswith("// ==UserScript==") and "@match        https://www.carrefour.fr/*" in script
    assert script.endswith("console.log(1);\n")
    # version datée, toujours croissante : les extensions ne mettent à jour que vers une version supérieure
    assert re.search(r"@version      1\.\d{8}\.\d{4}\n", script)


def test_suspicious_rayon_keeps_previous_products(tmp_path, monkeypatch):
    rayon_items = {"pains": [api_item(str(i), 1.0) for i in range(60)]}
    def fake(fc, rayon, store):
        items = [p for p in (cat.normalize_item(i, store, rayon) for i in rayon_items[rayon]) if p]
        return items, {"annonces": 1987, "lus": 1987, "pages_en_echec": [], "drive": len(items)}
    monkeypatch.setattr(cat, "scrape_rayon", fake)
    cat.update_catalogue(object(), "575", ["pains"], tmp_path, log=lambda *_: None)

    # Carrefour renvoie le catalogue sans le magasin : aucune offre Drive
    rayon_items["pains"] = [api_item(str(i), 1.0, store="999") for i in range(60)]
    result = cat.update_catalogue(object(), "575", ["pains"], tmp_path, log=lambda *_: None)
    assert result["rayons_en_echec"] == ["pains"] and result["retires"] == 0
    assert len(json.loads((tmp_path / "produits.json").read_text())["produits"]) == 60

    # Chute brutale (10 produits au lieu de 60) : même traitement
    rayon_items["pains"] = [api_item(str(i), 1.0) for i in range(10)]
    assert cat.update_catalogue(object(), "575", ["pains"], tmp_path, log=lambda *_: None)["retires"] == 0
