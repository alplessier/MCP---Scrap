"""Relevé hebdomadaire du catalogue alimentaire d'un Drive Carrefour.

Une seule session Firecrawl par rayon (1 crédit) : on choisit le magasin via /set-store/<ref>,
on ouvre le rayon, puis un script lit toutes ses pages avec l'API JSON qu'utilise le site
lui-même (en-tête X-Requested-With). Le rayon complet revient donc pour un seul crédit.

Fichiers produits dans data/ :
- produits.json        : l'état actuel du catalogue (remplacé à chaque relevé)
- historique_prix.csv  : une ligne par changement de prix (date, ean, prix), pas de doublons
"""

import csv
import html
import json
import os
import re
import time
from datetime import date
from pathlib import Path

from .carrefour import BASE_URL, DEFAULT_STORE_REF, Product
from .text import category_bonus, query_tokens, relevance

DATA_DIR = Path(os.environ.get("RECETTE_MACROS_DATA", Path(__file__).resolve().parent.parent / "data"))

# Rayons alimentaires du Drive (slug de https://www.carrefour.fr/r/<slug>)
RAYONS = [
    "fruits-et-legumes",
    "viandes-et-poissons",
    "cremerie",
    "charcuterie-traiteur",
    "surgeles",
    "epicerie-salee",
    "epicerie-sucree",
    "pains-et-patisseries",
    "boissons",
    "vegetal-vegetarien",
    "dietetique-preferences-alimentaires",
]
# « produits-du-monde » n'est pas relevé : c'est un rayon virtuel, ses produits sont déjà dans les autres.

UNITS = {"KG": "KG", "L": "L", "U": "PIECE", "PIECE": "PIECE"}

# Exécuté dans la page du rayon : lit toutes les pages en JSON (6 à la fois) et ne garde que
# les champs utiles, pour que la réponse reste petite.
FETCH_ALL_PAGES_JS = r"""
(async () => {
  const get = async (page) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(location.pathname + '?page=' + page, {
          headers: {'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json'},
          credentials: 'include'});
        if (r.ok) return await r.json();
      } catch (e) {}
      await new Promise(res => setTimeout(res, 1000));
    }
    return null;
  };
  const slim = (item) => {
    const a = item.attributes || {};
    return {type: item.type, ean: a.ean, title: a.title, brand: a.brand, slug: a.slug,
            packaging: a.packaging, format: a.format, offers: a.offers,
            image: ((a.images || {}).paths || [])[0] || null,
            categories: (a.categories || []).map(c => c.label)};
  };
  const out = {items: [], failedPages: [], total: null};
  const first = await get(1);
  if (first) {
    out.total = first.meta.total;
    out.items.push(...first.data.map(slim));
    const pages = [];
    for (let p = 2; p <= first.meta.totalPage; p++) pages.push(p);
    for (let i = 0; i < pages.length; i += 6) {
      const batch = pages.slice(i, i + 6);
      const results = await Promise.all(batch.map(get));
      results.forEach((j, k) => j ? out.items.push(...j.data.map(slim)) : out.failedPages.push(batch[k]));
    }
  } else {
    out.failedPages.push(1);
  }
  const pre = document.createElement('pre');
  pre.id = 'recette-macros-dump';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
"""


class LocalCatalogue:
    """Recherche dans le dernier relevé (data/produits.json) : gratuit, sans appel réseau."""

    def __init__(self, data_dir: Path = DATA_DIR):
        catalogue = json.loads((data_dir / "produits.json").read_text(encoding="utf-8"))
        self.maj = catalogue["maj"]
        self.products = [
            (Product(ean=p["ean"], name=p["nom"], brand=p["marque"], price=p["prix"], unit_price=p["prix_unite"],
                     unit=p["unite"], url=p["url"] or "", promo=p["promo"]), p["categorie"])
            for p in catalogue["produits"]
        ]

    def search(self, query: str, refresh: bool = False) -> list[Product]:
        tokens = query_tokens(query)
        hits = [(r + category_bonus(tokens, cat), p) for p, cat in self.products
                if (r := relevance(tokens, p.name)) is not None]
        return [p for _, p in sorted(hits, key=lambda h: (h[0], h[1].unit_price or 1e9))]


def _first_offer(item: dict, store_service: str) -> dict | None:
    for by_service in (item.get("offers") or {}).values():
        for service_id, offer in by_service.items():
            if service_id.endswith(f"-{store_service}"):
                return offer.get("attributes")
    return None


def normalize_item(item: dict, store_ref: str, rayon: str) -> dict | None:
    """Transforme un produit de l'API Carrefour en entrée compacte du catalogue (None si non vendu au Drive)."""
    if item.get("type") != "product" or not item.get("ean"):
        return None  # "marketplace" : vendeurs tiers, absents du Drive
    offer = _first_offer(item, store_ref)
    if offer is None or not (offer.get("availability") or {}).get("purchasable"):
        return None
    price = offer.get("price") or {}
    if price.get("price") is None:
        return None
    promo = next((p.get("label") for p in offer.get("promotions") or [] if p.get("label")), None)
    image = item.get("image")
    return {
        "ean": item["ean"],
        "nom": item.get("title") or "",
        "marque": item.get("brand") or "",
        "prix": price["price"],
        "prix_unite": price.get("perUnit"),
        "unite": UNITS.get((price.get("unitOfMeasure") or "").upper()),
        "conditionnement": item.get("packaging") or item.get("format") or "",
        "rayon": rayon,
        "categorie": (item.get("categories") or [None])[-1],
        "promo": promo,
        "image": image.replace("p_FORMAT", "p_200x200") if image else None,
        "url": f"{BASE_URL}/p/{item.get('slug')}-{item['ean']}" if item.get("slug") else None,
    }


def scrape_rayon(firecrawl, rayon: str, store_ref: str = DEFAULT_STORE_REF) -> tuple[list[dict], dict]:
    doc = firecrawl.scrape(
        f"{BASE_URL}/set-store/{store_ref}",
        formats=["rawHtml"],
        max_age=0,
        timeout=180000,
        actions=[
            {"type": "wait", "milliseconds": 2000},
            {"type": "executeJavascript", "script": f"window.location.href = '/r/{rayon}'"},
            {"type": "wait", "milliseconds": 4000},
            {"type": "executeJavascript", "script": FETCH_ALL_PAGES_JS},
            {"type": "wait", "selector": "#recette-macros-dump"},
        ],
    )
    m = re.search(r'<pre id="recette-macros-dump">(.*?)</pre>', doc.raw_html or "", re.S)
    if not m:
        raise RuntimeError(f"Rayon {rayon} : aucune donnée renvoyée")
    dump = json.loads(html.unescape(m.group(1)))
    products = [p for p in (normalize_item(i, store_ref, rayon) for i in dump["items"]) if p]
    info = {"annonces": dump["total"], "lus": len(dump["items"]), "pages_en_echec": dump["failedPages"],
            "drive": len(products)}
    return products, info


def write_catalogue(path: Path, catalogue: dict) -> None:
    """Un produit par ligne : les commits hebdomadaires ne montrent que les produits qui ont changé."""
    head = {k: v for k, v in catalogue.items() if k != "produits"}
    lines = ",\n".join(json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in catalogue["produits"])
    body = json.dumps(head, ensure_ascii=False)[:-1]
    path.write_text(f'{body}, "produits": [\n{lines}\n]}}\n', encoding="utf-8")


def record_price_changes(previous: dict[str, dict], current: dict[str, dict], history_path: Path, today: str) -> int:
    """Ajoute à l'historique les produits nouveaux ou dont le prix a changé. Renvoie le nombre de lignes ajoutées."""
    rows = [(today, ean, p["prix"]) for ean, p in current.items()
            if ean not in previous or previous[ean]["prix"] != p["prix"]]
    new_file = not history_path.exists()
    with history_path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        if new_file:
            writer.writerow(["date", "ean", "prix"])
        writer.writerows(rows)
    return len(rows)


def update_catalogue(firecrawl=None, store_ref: str = DEFAULT_STORE_REF, rayons=RAYONS, data_dir: Path = DATA_DIR,
                     log=print) -> dict:
    if firecrawl is None:
        from firecrawl import Firecrawl

        firecrawl = Firecrawl(api_key=os.environ["FIRECRAWL_API_KEY"])
    data_dir.mkdir(parents=True, exist_ok=True)
    catalogue_path = data_dir / "produits.json"
    previous, previous_failures = {}, set()
    if catalogue_path.exists():
        old = json.loads(catalogue_path.read_text(encoding="utf-8"))
        previous = {p["ean"]: p for p in old["produits"]}
        previous_failures = set(old.get("rayons_en_echec", []))

    current: dict[str, dict] = {}
    failed = []
    for rayon in rayons:
        start = time.time()
        products, info = None, None
        for attempt in range(2):  # les échecs sont souvent passagers : une seconde tentative
            try:
                products, info = scrape_rayon(firecrawl, rayon, store_ref)
            except Exception as e:  # un rayon en échec ne doit pas faire perdre les autres
                log(f"  {rayon} : tentative {attempt + 1} en échec ({e})")
                continue
            if not info["pages_en_echec"]:
                break
        if info is None:
            log(f"✗ {rayon}")
            failed.append(rayon)
            continue
        for p in products:
            current.setdefault(p["ean"], p)  # un produit peut apparaître dans plusieurs rayons
        ok = not info["pages_en_echec"]
        log(f"{'✓' if ok else '✗'} {rayon} : {info['drive']} produits Drive ({info['lus']}/{info['annonces']} lus, "
            f"{time.time() - start:.0f} s){'' if ok else ' — pages en échec : ' + str(info['pages_en_echec'])}")
        if not ok:
            failed.append(rayon)

    # Un rayon en échec ou non relevé cette fois garde ses produits précédents plutôt que de disparaître du site
    scraped = set(rayons) - set(failed)
    for ean, p in previous.items():
        if p["rayon"] not in scraped and ean not in current:
            current[ean] = p

    failed_now = sorted((previous_failures - scraped) | set(failed))
    today = date.today().isoformat()
    changes = record_price_changes(previous, current, data_dir / "historique_prix.csv", today)
    write_catalogue(catalogue_path, {
        "maj": today,
        "magasin": {"ref": store_ref, "nom": "Drive Market Clermont-Ferrand Jaude" if store_ref == "575" else store_ref},
        "rayons_en_echec": failed_now,
        "produits": sorted(current.values(), key=lambda p: (p["rayon"], p["nom"], p["ean"])),
    })
    added = len(current.keys() - previous.keys())
    removed = len(previous.keys() - current.keys())
    log(f"Catalogue : {len(current)} produits ({added} nouveaux, {removed} retirés, {changes} prix modifiés ou ajoutés)")
    return {"produits": len(current), "nouveaux": added, "retires": removed, "rayons_en_echec": failed}
