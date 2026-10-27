"""Mode libre : une recette saisie en texte libre, chiffrée en euros et en macros."""

import math
import re
from dataclasses import dataclass, field

from .carrefour import Product
from .nutrition import Macros, generic_per_100g
from .text import matches

# quantité, unité optionnelle, nom, poids unitaire optionnel (@60g), EAN imposé optionnel (#356...)
LINE_RE = re.compile(
    r"^\s*(?P<qty>\d+(?:[.,]\d+)?)\s*(?P<unit>kg|g|cl|ml|l|pcs?|pièces?|x)?\.?\s+"
    r"(?P<name>.+?)"
    r"(?:\s+@\s*(?P<piece>\d+(?:[.,]\d+)?)\s*g)?"
    r"(?:\s+#(?P<ean>\d{8,14}))?\s*$",
    re.IGNORECASE,
)
TO_GRAMS = {"g": 1, "kg": 1000, "ml": 1, "cl": 10, "l": 1000}


@dataclass
class Ingredient:
    name: str
    grams: float | None  # poids (ou volume en ml, assimilé à des grammes)
    pieces: float | None = None
    ean: str | None = None
    raw: str = ""


def parse_line(line: str) -> Ingredient:
    m = LINE_RE.match(line)
    if not m:
        raise ValueError(
            f"Ligne non comprise : {line!r}. Exemples : '200 g blanc de poulet', '2 oeufs @60g', '15 ml huile d'olive'"
        )
    qty = float(m["qty"].replace(",", "."))
    unit = (m["unit"] or "").lower()
    piece_weight = float(m["piece"].replace(",", ".")) if m["piece"] else None
    if unit in TO_GRAMS:
        grams, pieces = qty * TO_GRAMS[unit], None
    else:  # pièces : le poids n'est connu que si l'utilisateur l'a donné avec @
        pieces = qty
        grams = qty * piece_weight if piece_weight else None
    return Ingredient(name=m["name"].strip(), grams=grams, pieces=pieces, ean=m["ean"], raw=line.strip())


def parse_recipe(text: str) -> list[Ingredient]:
    lines = [l for l in text.splitlines() if l.strip() and not l.lstrip().startswith("//")]
    return [parse_line(l) for l in lines]


def is_usable(ing: Ingredient, product: Product) -> bool:
    if product.unit_price is None:
        return False
    if product.unit == "PIECE":
        return ing.pieces is not None
    return ing.grams is not None and product.unit in ("KG", "L")


def choose_product(ing: Ingredient, products: list[Product], strategy: str = "pertinence", top: int = 5) -> Product | None:
    if ing.ean:
        return next((p for p in products if p.ean == ing.ean), None)
    usable = [p for p in products if is_usable(ing, p)]
    # les résultats Carrefour contiennent des produits sponsorisés sans rapport (des wraps pour « poulet »)
    candidates = [p for p in usable if matches(ing.name, p.name)][:top]
    if not candidates:
        return None
    if strategy == "moins-cher":
        return min(candidates, key=lambda p: p.unit_price)
    return candidates[0]


@dataclass
class Line:
    ingredient: Ingredient
    product: Product | None
    cost_used: float | None = None  # coût de la quantité utilisée
    packs: int | None = None  # nombre de paquets à acheter
    cost_bought: float | None = None
    macros: Macros | None = None
    macros_generic: bool = False  # valeurs de la table générique, pas de la fiche du produit


def cost_line(ing: Ingredient, product: Product | None, macros_100g: Macros | None) -> Line:
    line = Line(ing, product)
    if macros_100g is None:
        macros_100g = generic_per_100g(ing.name)
        line.macros_generic = macros_100g is not None
    if product is None:
        return line
    if product.unit == "PIECE" and ing.pieces is not None:
        used = ing.pieces
    elif ing.grams is not None:
        used = ing.grams / 1000  # kg ou litres
    else:
        used = None
    if used is not None and product.unit_price:
        line.cost_used = used * product.unit_price
        pack = product.pack_quantity
        if pack:
            # tolérance de 2 % pour les arrondis du prix au kilo affiché
            line.packs = max(1, math.ceil(used / pack - 0.02))
            line.cost_bought = line.packs * product.price
    if macros_100g is not None and ing.grams is not None:
        line.macros = macros_100g.scaled(ing.grams / 100)
    return line


@dataclass
class RecipeResult:
    lines: list[Line]
    portions: int = 1
    missing_macros: list[str] = field(default_factory=list)
    missing_prices: list[str] = field(default_factory=list)

    @property
    def total_cost(self) -> float:
        return sum(l.cost_used or 0 for l in self.lines)

    @property
    def total_bought(self) -> float:
        return sum(l.cost_bought or 0 for l in self.lines)

    @property
    def total_macros(self) -> Macros:
        total = Macros()
        for l in self.lines:
            if l.macros:
                total = total + l.macros
        return total
