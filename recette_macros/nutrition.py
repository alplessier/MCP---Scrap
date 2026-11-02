"""Valeurs nutritionnelles (pour 100 g) via l'API Open Food Facts, à partir du code-barres.

Les valeurs sont stockées dans data/nutrition.json. Le relevé hebdomadaire n'interroge
Open Food Facts que pour les produits nouveaux, et retente de temps en temps ceux qui
n'avaient pas encore de fiche.
"""

import json
import os
import time
from dataclasses import dataclass, field
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


# Nutriments suivis en plus des macros, pour 100 g (None : non renseigné)
NUTRIENTS = ("fibres", "sucres", "satures", "sel")
OFF_NUTRIENT_KEYS = ("fiber_100g", "sugars_100g", "saturated-fat_100g", "salt_100g")


@dataclass
class Macros:
    kcal: float = 0.0
    proteines: float = 0.0
    glucides: float = 0.0
    lipides: float = 0.0
    # fibres, sucres, acides gras saturés, sel (g pour 100 g) ; None si la fiche ne les donne pas
    nutriments: list | None = field(default=None, compare=False)

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
    "aubergine": Macros(25, 1, 4, 0.2),
    "ail": Macros(130, 6, 25, 0.5),
    "corn flakes": Macros(380, 7, 84, 1),
    "macaroni": Macros(355, 12.5, 71, 1.5),
    "raisins secs": Macros(300, 3, 70, 0.5),
    "chou fleur": Macros(25, 2, 3, 0.3),
    "poivron": Macros(30, 1, 5, 0.3),
    "concombre": Macros(13, 0.7, 2, 0.1),
    "champignon": Macros(22, 3, 0.5, 0.3),
    "mais": Macros(85, 3, 15, 1.5),  # en conserve
    "legumes": Macros(35, 2, 5, 0.5),
    "olives noires": Macros(230, 1.5, 1, 24),
    "myrtille": Macros(57, 0.7, 12, 0.3),
    "datte": Macros(290, 2.5, 65, 0.4),
    "moutarde": Macros(150, 7, 5, 11),
    "creme": Macros(135, 3, 4, 12),  # crème légère
    "emmental": Macros(380, 28, 0, 29),
    "mozzarella": Macros(250, 18, 1, 19),
    "chevre": Macros(270, 18, 1, 21),
    "galette": Macros(190, 6, 38, 1.5),  # galette de blé noir prête à garnir
    "lasagne": Macros(355, 12.5, 71, 1.5),
    "semoule": Macros(350, 12, 72, 1.5),
    "boulgour": Macros(350, 12, 70, 1.5),
    "gnocchi": Macros(150, 3.5, 32, 0.5),
    "farine": Macros(345, 10, 72, 1.2),
    "chapelure": Macros(380, 12, 73, 3),
    "speculoos": Macros(480, 5, 72, 19),
    "levure": Macros(100, 0, 25, 0),
    "chocolat noir": Macros(550, 7, 40, 38),
    "cacao": Macros(380, 20, 15, 21),
    "whey": Macros(380, 75, 8, 6),
    "chia": Macros(490, 17, 8, 31),
    "noix": Macros(690, 15, 7, 65),
    "tahin": Macros(600, 18, 10, 55),
    "paprika": Macros(300, 14, 20, 13),
    "ras el hanout": Macros(300, 12, 30, 12),
    "curcuma": Macros(310, 10, 45, 3),
    "cannelle": Macros(250, 4, 55, 1),
    "sauce soja": Macros(60, 8, 6, 0),
    "miel": Macros(320, 0.4, 80, 0),
    "curry": Macros(325, 13, 25, 14),
    "cumin": Macros(375, 18, 34, 22),
}


# Fibres, sucres, acides gras saturés et sel pour 100 g des mêmes aliments (approximations Ciqual)
GENERIC_NUTRIENTS = {
    "blanc de poulet": (0, 0, 0.6, 0.15), "filet de poulet": (0, 0, 0.6, 0.15), "poulet": (0, 0, 2.3, 0.2),
    "dinde": (0, 0, 0.5, 0.15), "steak hache": (0, 0, 3, 0.2), "boeuf": (0, 0, 2.5, 0.15),
    "saumon fume": (0, 0.5, 1.8, 3), "saumon": (0, 0, 2.5, 0.15), "thon": (0, 0, 0.3, 0.9),
    "cabillaud": (0, 0, 0.1, 0.2), "crevette": (0, 0, 0.3, 1.2), "jambon": (0, 0.5, 1, 2),
    "oeuf": (0, 0.7, 2.7, 0.35), "tofu": (1, 0.5, 1.2, 0.05), "skyr": (0, 4, 0.1, 0.1),
    "yaourt grecque": (0, 4, 6, 0.12), "yaourt": (0, 5, 1.3, 0.12), "fromage blanc": (0, 4, 2, 0.1),
    "fromage frais": (0, 4, 2.4, 0.1), "feta": (0, 1, 14, 2.8), "parmesan": (0, 0, 19, 1.6),
    "cheddar": (0, 0.5, 21, 1.8), "lait de coco": (1, 2.5, 16, 0.05), "lait": (0, 4.8, 1, 0.11),
    "beurre de cacahuete": (6, 8, 10, 0.5), "beurre": (0, 0.6, 54, 0.03), "huile": (0, 0, 14, 0),
    "riz": (1.4, 0.3, 0.2, 0), "pate": (3, 3, 0.3, 0), "penne": (3, 3, 0.3, 0), "avoine": (10, 1, 1.3, 0),
    "muesli": (7, 20, 1.5, 0.1), "wrap": (2.5, 3, 3, 1.2), "pain": (3, 3, 0.6, 1.2), "quinoa": (7, 3, 0.7, 0),
    "lentille": (11, 2, 0.2, 0.02), "pois chiche": (5, 0.5, 0.3, 0.6), "haricots rouges": (6, 0.5, 0.1, 0.5),
    "petits pois": (5, 3, 0.1, 0.4), "pomme de terre": (1.8, 0.8, 0, 0), "patate douce": (3, 4.2, 0, 0.1),
    "brocoli": (2.6, 1.7, 0.1, 0.03), "courgette": (1, 1.5, 0.1, 0), "haricot vert": (3, 1.5, 0, 0),
    "epinard": (2.2, 0.4, 0.1, 0.1), "carotte": (2.8, 4.7, 0, 0.1), "pulpe de tomate": (1, 3.5, 0, 0.1),
    "sauce tomate": (1.5, 5, 0.2, 0.9), "tomate": (1.2, 2.6, 0, 0), "oignon": (1.7, 4.5, 0, 0),
    "salade": (1.3, 0.8, 0, 0), "citron": (1, 2.5, 0, 0), "avocat": (6.7, 0.7, 2.1, 0), "banane": (2.6, 17, 0.1, 0),
    "fruits rouges": (5, 5, 0, 0), "pomme": (2.4, 10, 0, 0), "amande": (12, 4.4, 3.8, 0), "pesto": (2, 2, 7, 2.5),
    "aubergine": (3, 3, 0, 0), "ail": (2.1, 1, 0.1, 0.04), "corn flakes": (3, 8, 0.2, 1.7),
    "macaroni": (3, 3, 0.3, 0), "raisins secs": (3.7, 59, 0.1, 0.03), "chou fleur": (2, 2, 0.1, 0.03),
    "poivron": (2, 4, 0, 0), "concombre": (0.5, 1.7, 0, 0), "champignon": (1, 0.3, 0, 0.02),
    "mais": (2.4, 4, 0.2, 0.6), "legumes": (3, 3, 0, 0.1), "olives noires": (3, 0, 4, 3),
    "myrtille": (2.4, 10, 0, 0), "datte": (8, 63, 0, 0), "moutarde": (3, 3, 0.7, 5.5), "creme": (0, 4, 8, 0.08),
    "emmental": (0, 0, 18, 0.5), "mozzarella": (0, 1, 12, 0.5), "chevre": (0, 1, 14, 1.2), "galette": (3, 1, 0.3, 1),
    "lasagne": (3, 3, 0.3, 0), "semoule": (3.5, 1, 0.3, 0), "boulgour": (6, 0.5, 0.3, 0),
    "gnocchi": (1.5, 0.8, 0.1, 1), "farine": (3, 1, 0.2, 0), "chapelure": (4, 5, 0.7, 1.5),
    "speculoos": (2, 38, 8, 0.8), "levure": (0, 0, 0, 12), "chocolat noir": (11, 28, 23, 0),
    "cacao": (30, 1, 13, 0.1), "whey": (0, 6, 3, 0.5), "chia": (34, 0, 3.3, 0), "noix": (6.7, 2.6, 6, 0),
    "tahin": (9, 0.5, 8, 0.1), "paprika": (35, 10, 2, 0.2), "ras el hanout": (25, 5, 2, 0.3),
    "curcuma": (21, 3, 1.8, 0.1), "cannelle": (53, 2, 0.3, 0), "sauce soja": (0.8, 1, 0, 14.5),
    "miel": (0, 80, 0, 0), "curry": (33, 3, 2.5, 0.1), "cumin": (11, 2, 1.5, 0.4),
}
for _key, _values in GENERIC_NUTRIENTS.items():
    GENERIC_PER_100G[_key].nutriments = list(_values)


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
    m.nutriments = nutrients_from_nutriments(n)
    return m


def nutrients_from_nutriments(n: dict) -> list | None:
    """Fibres, sucres, acides gras saturés et sel pour 100 g ; None pour une valeur absente de la fiche."""
    values = []
    for key in OFF_NUTRIENT_KEYS:
        try:
            values.append(round(float(n[key]), 2) if n.get(key) not in (None, "") else None)
        except (TypeError, ValueError):
            values.append(None)
    return values if any(v is not None for v in values) else None


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
    """Produits jamais vus, produits sans fiche vérifiés il y a plus de RETRY_MISSING_AFTER, puis
    produits connus d'avant l'ajout des nutriments (fibres, sucres...), à compléter."""
    todo, backfill = [], []
    for ean in eans:
        entry = known.get(ean)
        if entry is None:
            todo.append(ean)
        elif entry["m"] is None and today - date.fromisoformat(entry["vu"]) >= RETRY_MISSING_AFTER:
            todo.append(ean)
        elif entry["m"] is not None and "n" not in entry:
            backfill.append(ean)
    return todo + backfill


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
            if m:
                known[ean]["n"] = m.nutriments
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
