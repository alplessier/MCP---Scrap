"""Valeurs nutritionnelles (pour 100 g) via l'API Open Food Facts, à partir du code-barres."""

import json
import os
from dataclasses import dataclass

import requests

from .cache import JsonCache
from .text import matches

OFF_URL = "https://world.openfoodfacts.org/api/v2/product/{ean}.json?fields=product_name,nutriments"
USER_AGENT = "recette-macros/0.1 (https://github.com/alplessier/MCP---Scrap)"
NUTRITION_TTL = 90 * 24 * 3600


@dataclass
class Macros:
    kcal: float = 0.0
    proteines: float = 0.0
    glucides: float = 0.0
    lipides: float = 0.0

    def __add__(self, other: "Macros") -> "Macros":
        return Macros(*(a + b for a, b in zip(self.as_tuple(), other.as_tuple())))

    def scaled(self, factor: float) -> "Macros":
        return Macros(*(v * factor for v in self.as_tuple()))

    def as_tuple(self):
        return (self.kcal, self.proteines, self.glucides, self.lipides)


# Valeurs moyennes pour 100 g d'aliment cru / sec (approximations d'après la table Ciqual de l'Anses),
# utilisées quand le produit n'a pas de fiche Open Food Facts (viande à la coupe, fruits et légumes...).
# Les clés les plus précises d'abord : « pomme de terre » doit passer avant « pomme ».
GENERIC_PER_100G = {
    "blanc de poulet": Macros(115, 24, 0, 2),
    "filet de poulet": Macros(115, 24, 0, 2),
    "poulet": Macros(150, 20, 0, 8),
    "dinde": Macros(107, 23.5, 0, 1.5),
    "steak hache": Macros(150, 20, 0, 7.5),
    "boeuf": Macros(140, 21, 0, 6),
    "saumon": Macros(200, 20, 0, 13),
    "thon": Macros(115, 26, 0, 1),
    "cabillaud": Macros(80, 18, 0, 0.7),
    "jambon": Macros(115, 21, 0.5, 3),
    "oeuf": Macros(140, 12.5, 0.7, 9.8),
    "skyr": Macros(60, 10, 4, 0.2),
    "fromage blanc": Macros(75, 7.5, 4, 3),
    "lait": Macros(46, 3.3, 4.8, 1.6),
    "beurre": Macros(745, 0.7, 0.6, 82),
    "huile": Macros(900, 0, 0, 100),
    "riz": Macros(350, 7.5, 78, 0.6),
    "pate": Macros(355, 12.5, 71, 1.5),
    "avoine": Macros(370, 13.5, 58.7, 7),
    "pain": Macros(260, 9, 50, 1.5),
    "quinoa": Macros(360, 14, 60, 6),
    "lentille": Macros(330, 24, 48, 1.5),
    "pois chiche": Macros(360, 20, 50, 6),
    "pomme de terre": Macros(80, 2, 17, 0.1),
    "patate douce": Macros(86, 1.6, 20, 0.1),
    "brocoli": Macros(34, 2.8, 4, 0.4),
    "courgette": Macros(17, 1.2, 2, 0.3),
    "haricot vert": Macros(30, 1.9, 4, 0.2),
    "epinard": Macros(23, 2.9, 1.6, 0.4),
    "carotte": Macros(36, 0.8, 7.6, 0.3),
    "tomate": Macros(18, 0.9, 3, 0.2),
    "avocat": Macros(160, 2, 1.8, 15),
    "banane": Macros(90, 1.1, 20, 0.3),
    "pomme": Macros(53, 0.3, 11.6, 0.2),
    "amande": Macros(600, 25, 7, 52),
}


def generic_per_100g(ingredient_name: str) -> Macros | None:
    return next((m for key, m in GENERIC_PER_100G.items() if matches(key, ingredient_name)), None)


def macros_from_off(payload: dict) -> Macros | None:
    if payload.get("status") != 1:
        return None
    n = payload.get("product", {}).get("nutriments", {})
    if "energy-kcal_100g" not in n and "proteins_100g" not in n:
        return None
    return Macros(
        kcal=float(n.get("energy-kcal_100g", 0)),
        proteines=float(n.get("proteins_100g", 0)),
        glucides=float(n.get("carbohydrates_100g", 0)),
        lipides=float(n.get("fat_100g", 0)),
    )


class NutritionClient:
    """Interroge Open Food Facts en direct, et passe par Firecrawl si l'accès direct échoue."""

    def __init__(self, firecrawl=None, use_firecrawl_fallback: bool = True):
        self._firecrawl = firecrawl
        self.use_firecrawl_fallback = use_firecrawl_fallback
        self._cache = JsonCache("nutrition", NUTRITION_TTL)

    def _fetch(self, ean: str) -> dict:
        url = OFF_URL.format(ean=ean)
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=15)
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if not self.use_firecrawl_fallback:
                raise
        if self._firecrawl is None:
            from firecrawl import Firecrawl

            self._firecrawl = Firecrawl(api_key=os.environ["FIRECRAWL_API_KEY"])
        return json.loads(self._firecrawl.scrape(url, formats=["rawHtml"]).raw_html)

    def per_100g(self, ean: str) -> Macros | None:
        cached = self._cache.get(ean)
        if cached is not None:
            return Macros(**cached) if cached else None
        macros = macros_from_off(self._fetch(ean))
        self._cache.set(ean, macros.__dict__ if macros else {})
        return macros
