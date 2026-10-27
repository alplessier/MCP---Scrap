"""Recherche de produits et de prix sur carrefour.fr pour un magasin donné, via Firecrawl.

Carrefour affiche des prix différents selon le magasin choisi. On visite d'abord
https://www.carrefour.fr/set-store/<ref> (qui pose le cookie du magasin), puis on
navigue vers la page de recherche dans la même session navigateur Firecrawl.
"""

import os
import re
from dataclasses import asdict, dataclass
from urllib.parse import quote_plus

from bs4 import BeautifulSoup

from .cache import JsonCache

# Drive Market Clermont-Ferrand Jaude (https://www.carrefour.fr/magasin/market-clermont-ferrand-jaude/drive)
DEFAULT_STORE_REF = os.environ.get("CARREFOUR_STORE", "575")
BASE_URL = "https://www.carrefour.fr"
PRICE_TTL = 7 * 24 * 3600


@dataclass
class Product:
    ean: str
    name: str
    brand: str
    price: float  # prix du paquet, en euros
    unit_price: float | None  # prix au kilo / au litre / à la pièce
    unit: str | None  # "KG", "L", "PIECE"...
    url: str
    promo: str | None = None

    @property
    def pack_quantity(self) -> float | None:
        """Contenance du paquet dans l'unité de `unit` (ex. 0.18 pour 180 g)."""
        if not self.unit_price:
            return None
        return self.price / self.unit_price


def _parse_euros(text: str) -> float | None:
    m = re.search(r"(\d+(?:[.,]\d+)?)", text.replace(" ", ""))
    return float(m.group(1).replace(",", ".")) if m else None


def parse_search_html(html: str) -> list[Product]:
    """Extrait les cartes produit d'une page de résultats carrefour.fr."""
    soup = BeautifulSoup(html, "html.parser")
    products = []
    for card in soup.select("article[data-testid]"):
        ean = card["data-testid"]
        if not ean.isdigit():
            continue
        title = card.select_one(".product-card-title__text")
        amount = card.select_one('[data-testid="product-price__amount--main"]')
        if title is None or amount is None:
            continue  # produit indisponible dans ce magasin
        price = _parse_euros("".join(p.get_text(strip=True) for p in amount.find_all("p")))
        if price is None:
            continue

        unit_price = unit = None
        per_unit = card.select_one('[class*="__per-unit-label"]')
        if per_unit:
            m = re.match(r"\s*([\d.,]+)\s*€\s*/\s*(\w+)", per_unit.get_text())
            if m:
                unit_price, unit = float(m.group(1).replace(",", ".")), m.group(2).upper()

        brand = card.select_one('[class*="__brand"]')
        link = card.select_one('a[href*="/p/"]')
        promo = card.select_one(".sticker-promo__text")
        products.append(Product(
            ean=ean,
            name=title.get_text(strip=True),
            brand=brand.get_text(strip=True) if brand else "",
            price=price,
            unit_price=unit_price,
            unit=unit,
            url=link["href"].split("?")[0] if link else "",
            promo=promo.get_text(strip=True) if promo else None,
        ))
    return products


def store_is_applied(html: str, store_ref: str) -> bool:
    return re.search(rf'"basketServiceId":"[^"]*-{re.escape(store_ref)}"', html) is not None


class CarrefourClient:
    def __init__(self, store_ref: str = DEFAULT_STORE_REF, firecrawl=None):
        self.store_ref = store_ref
        self._firecrawl = firecrawl
        self._cache = JsonCache(f"prix_{store_ref}", PRICE_TTL)

    @property
    def firecrawl(self):
        if self._firecrawl is None:
            from firecrawl import Firecrawl

            self._firecrawl = Firecrawl(api_key=os.environ["FIRECRAWL_API_KEY"])
        return self._firecrawl

    def search(self, query: str, refresh: bool = False) -> list[Product]:
        key = query.strip().lower()
        cached = None if refresh else self._cache.get(key)
        if cached is not None:
            return [Product(**p) for p in cached]

        search_path = f"/s?q={quote_plus(query)}"
        doc = self.firecrawl.scrape(
            f"{BASE_URL}/set-store/{self.store_ref}",
            formats=["rawHtml"],
            max_age=0,
            actions=[
                {"type": "wait", "milliseconds": 2000},
                {"type": "executeJavascript", "script": f"window.location.href = {search_path!r}"},
                {"type": "wait", "milliseconds": 5000},
            ],
        )
        html = doc.raw_html or ""
        if not store_is_applied(html, self.store_ref):
            raise RuntimeError(
                f"Carrefour n'a pas appliqué le magasin {self.store_ref} : les prix seraient ceux d'un autre magasin."
            )
        products = parse_search_html(html)
        self._cache.set(key, [asdict(p) for p in products])
        return products
