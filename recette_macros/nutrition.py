"""Valeurs nutritionnelles (pour 100 g) via l'API Open Food Facts, à partir du code-barres.

Les valeurs sont stockées dans data/nutrition.json. Le relevé hebdomadaire n'interroge
Open Food Facts que pour les produits nouveaux, et retente de temps en temps ceux qui
n'avaient pas encore de fiche.
"""

import json
import os
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import requests

from .cache import JsonCache
from .text import matches

OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product/{ean}.json?fields=product_name,nutriments"
OFF_SEARCH_URL = "https://world.openfoodfacts.org/api/v2/search?code={codes}&fields=code,nutriments&page_size=50"
USER_AGENT = "recette-macros/0.1 (https://github.com/alplessier/MCP---Scrap)"
NUTRITION_TTL = 90 * 24 * 3600
BATCH_SIZE = 25  # au-delà, Open Food Facts répond souvent 503
SEARCH_DELAY = 6.5  # Open Food Facts limite la recherche à 10 requêtes par minute
PRODUCT_DELAY = 0.65  # ... et la lecture d'une fiche à 100 requêtes par minute
TIME_BUDGET = float(os.environ.get("NUTRITION_BUDGET_MIN", 100)) * 60  # le reste attend le relevé suivant
RETRY_MISSING_AFTER = timedelta(days=28)


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
    "saumon fume": Macros(170, 22, 0.5, 9),
    "saumon": Macros(200, 20, 0, 13),
    "thon": Macros(115, 26, 0, 1),
    "cabillaud": Macros(80, 18, 0, 0.7),
    "crevette": Macros(95, 20, 0, 1.5),
    "jambon": Macros(115, 21, 0.5, 3),
    "oeuf": Macros(140, 12.5, 0.7, 9.8),
    "tofu": Macros(125, 13, 1.5, 7.5),
    "skyr": Macros(60, 10, 4, 0.2),
    "yaourt grecque": Macros(120, 6, 4, 9),
    "yaourt": Macros(60, 4, 5, 2),
    "fromage blanc": Macros(75, 7.5, 4, 3),
    "fromage frais": Macros(75, 7, 4, 3.8),
    "feta": Macros(265, 17, 1, 21),
    "parmesan": Macros(400, 33, 0, 29),
    "cheddar": Macros(400, 25, 0.5, 33),
    "lait de coco": Macros(180, 2, 3, 18),  # avant « lait »
    "lait": Macros(46, 3.3, 4.8, 1.6),
    "beurre de cacahuete": Macros(600, 25, 15, 50),  # avant « beurre »
    "beurre": Macros(745, 0.7, 0.6, 82),
    "huile": Macros(900, 0, 0, 100),
    "riz": Macros(350, 7.5, 78, 0.6),
    "pate": Macros(355, 12.5, 71, 1.5),
    "penne": Macros(355, 12.5, 71, 1.5),
    "avoine": Macros(370, 13.5, 58.7, 7),
    "muesli": Macros(370, 9, 65, 7),
    "wrap": Macros(300, 8, 50, 7),
    "pain": Macros(260, 9, 50, 3),
    "quinoa": Macros(360, 14, 60, 6),
    "lentille": Macros(330, 24, 48, 1.5),  # sèches
    "pois chiche": Macros(120, 7, 15, 2.6),  # en conserve, égouttés
    "haricots rouges": Macros(95, 7, 13, 0.5),  # en conserve, égouttés
    "petits pois": Macros(70, 5, 9, 0.5),
    "pomme de terre": Macros(80, 2, 17, 0.1),
    "patate douce": Macros(86, 1.6, 20, 0.1),
    "brocoli": Macros(34, 2.8, 4, 0.4),
    "courgette": Macros(17, 1.2, 2, 0.3),
    "haricot vert": Macros(30, 1.9, 4, 0.2),
    "epinard": Macros(23, 2.9, 1.6, 0.4),
    "carotte": Macros(36, 0.8, 7.6, 0.3),
    "pulpe de tomate": Macros(25, 1.2, 4, 0.2),
    "sauce tomate": Macros(45, 1.5, 7, 1),
    "tomate": Macros(18, 0.9, 3, 0.2),
    "oignon": Macros(40, 1.2, 7, 0.2),
    "salade": Macros(15, 1.3, 1.5, 0.2),
    "citron": Macros(30, 0.8, 3, 0.3),
    "avocat": Macros(160, 2, 1.8, 15),
    "banane": Macros(90, 1.1, 20, 0.3),
    "fruits rouges": Macros(45, 1, 9, 0.4),
    "pomme": Macros(53, 0.3, 11.6, 0.2),
    "amande": Macros(600, 25, 7, 52),
    "pesto": Macros(450, 5, 6, 45),
    "sauce soja": Macros(60, 8, 6, 0),
    "miel": Macros(320, 0.4, 80, 0),
    "curry": Macros(325, 13, 25, 14),
    "cumin": Macros(375, 18, 34, 22),
}


def generic_per_100g(ingredient_name: str) -> Macros | None:
    return next((m for key, m in GENERIC_PER_100G.items() if matches(key, ingredient_name)), None)


def macros_from_nutriments(n: dict) -> Macros | None:
    if "proteins_100g" not in n and "energy-kcal_100g" not in n:
        return None
    m = Macros(
        kcal=float(n.get("energy-kcal_100g") or 0),
        proteines=float(n.get("proteins_100g") or 0),
        glucides=float(n.get("carbohydrates_100g") or 0),
        lipides=float(n.get("fat_100g") or 0),
    )
    # Certaines fiches ont 0 kcal mais des macros renseignées : on recalcule (Atwater 4/4/9).
    if m.kcal == 0 and (m.proteines or m.glucides or m.lipides):
        m.kcal = round(4 * m.proteines + 4 * m.glucides + 9 * m.lipides)
    return m


def macros_from_off(payload: dict) -> Macros | None:
    if payload.get("status") != 1:
        return None
    return macros_from_nutriments(payload.get("product", {}).get("nutriments", {}))


def _get_json(url: str, firecrawl=None) -> dict:
    """Open Food Facts en direct ; Firecrawl (1 crédit) seulement si l'accès direct est bloqué."""
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
        if r.status_code == 404:
            return {"status": 0}  # produit inconnu d'Open Food Facts
        r.raise_for_status()
        return r.json()
    except requests.RequestException:
        if firecrawl is None:
            raise
    doc = firecrawl.scrape(url, formats=["rawHtml"], max_age=0)
    if doc.metadata and doc.metadata.status_code == 404:
        return {"status": 0}
    if doc.metadata and doc.metadata.status_code != 200:
        raise RuntimeError(f"Open Food Facts a répondu {doc.metadata.status_code}")
    return json.loads(doc.raw_html)


def fetch_batch(eans: list[str], firecrawl=None) -> dict[str, Macros | None]:
    payload = _get_json(OFF_SEARCH_URL.format(codes=",".join(eans)), firecrawl)
    found = {p["code"]: macros_from_nutriments(p.get("nutriments") or {}) for p in payload.get("products", [])}
    return {ean: found.get(ean) for ean in eans}


def fetch_one_by_one(eans: list[str], firecrawl=None) -> dict[str, Macros | None]:
    """Repli quand la recherche groupée échoue (Open Food Facts répond parfois 503) ; les échecs sont omis."""
    results = {}
    for ean in eans:
        try:
            results[ean] = macros_from_off(_get_json(OFF_PRODUCT_URL.format(ean=ean), firecrawl))
        except Exception:
            pass
        time.sleep(PRODUCT_DELAY)
    return results


def eans_to_fetch(eans, known: dict, today: date) -> list[str]:
    """Produits jamais vus, et produits sans fiche vérifiés il y a plus de RETRY_MISSING_AFTER."""
    todo = []
    for ean in eans:
        entry = known.get(ean)
        if entry is None:
            todo.append(ean)
        elif entry["m"] is None and today - date.fromisoformat(entry["vu"]) >= RETRY_MISSING_AFTER:
            todo.append(ean)
    return todo


def update_nutrition(data_dir: Path, firecrawl=None, log=print, time_budget: float = TIME_BUDGET) -> dict:
    path = data_dir / "nutrition.json"
    known = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    catalogue = json.loads((data_dir / "produits.json").read_text(encoding="utf-8"))["produits"]
    today = date.today()
    todo = eans_to_fetch([p["ean"] for p in catalogue], known, today)
    log(f"Nutrition : {len(todo)} produits à interroger sur Open Food Facts ({len(known)} déjà connus)")
    found = done = 0
    deadline = time.monotonic() + time_budget
    for i in range(0, len(todo), BATCH_SIZE):
        if time.monotonic() > deadline:
            log(f"  budget de temps atteint : {len(todo) - i} produits restants, traités au prochain relevé")
            break
        batch = todo[i:i + BATCH_SIZE]
        try:
            results = fetch_batch(batch, firecrawl)
        except Exception as e:
            log(f"  lot {i // BATCH_SIZE + 1} en échec ({e}) : interrogation produit par produit")
            results = fetch_one_by_one(batch, firecrawl)
        for ean, m in results.items():
            known[ean] = {"m": list(m.as_tuple()) if m else None, "vu": today.isoformat()}
            found += m is not None
            done += 1
        # enregistré à chaque lot : un relevé interrompu ne perd pas ce qui est déjà fait
        path.write_text(json.dumps(known, separators=(",", ":"), sort_keys=True), encoding="utf-8")
        time.sleep(SEARCH_DELAY)
    log(f"Nutrition : {done} produits interrogés, {found} fiches trouvées")
    return {"interroges": done, "trouves": found}


class NutritionClient:
    """Macros d'un produit : data/nutrition.json d'abord, sinon Open Food Facts (mis en cache)."""

    def __init__(self, data_dir: Path | None = None, firecrawl=None):
        self._firecrawl = firecrawl
        self._cache = JsonCache("nutrition", NUTRITION_TTL)
        self._local = {}
        if data_dir and (data_dir / "nutrition.json").exists():
            self._local = json.loads((data_dir / "nutrition.json").read_text(encoding="utf-8"))

    def per_100g(self, ean: str) -> Macros | None:
        if ean in self._local and self._local[ean]["m"]:
            return Macros(*self._local[ean]["m"])
        cached = self._cache.get(ean)
        if cached is not None:
            return Macros(**cached) if cached else None
        if self._firecrawl is None and os.environ.get("FIRECRAWL_API_KEY"):
            from firecrawl import Firecrawl

            self._firecrawl = Firecrawl(api_key=os.environ["FIRECRAWL_API_KEY"])
        macros = macros_from_off(_get_json(OFF_PRODUCT_URL.format(ean=ean), self._firecrawl))
        self._cache.set(ean, macros.__dict__ if macros else {})
        return macros
