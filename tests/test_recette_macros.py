from pathlib import Path

import pytest

from recette_macros.carrefour import Product, parse_search_html, store_is_applied
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
