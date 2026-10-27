"""Construit site/data/catalogue.json : le catalogue et les macros réunis, sous forme compacte pour le navigateur."""

import json
from datetime import datetime, timezone
from pathlib import Path

from .catalogue import DATA_DIR
from .nutrition import GENERIC_PER_100G

SITE_DIR = Path(__file__).resolve().parent.parent / "site"
SITE_URL = "https://alplessier.github.io/MCP---Scrap"
USERSCRIPT_HEADER = """// ==UserScript==
// @name         Recettes & macros — panier Carrefour
// @namespace    {site}
// @version      {version}
// @description  Ajoute au panier carrefour.fr les produits d'une recette du site Recettes & macros
// @match        https://www.carrefour.fr/*
// @run-at       document-idle
// @grant        none
// @downloadURL  {site}/carrefour-panier.user.js
// @updateURL    {site}/carrefour-panier.user.js
// ==/UserScript==
"""
COLUMNS = ["ean", "nom", "marque", "prix", "prix_unite", "unite", "conditionnement", "rayon", "categorie",
           "promo", "image", "url", "macros"]


def build_site_data(data_dir: Path = DATA_DIR, site_dir: Path = SITE_DIR) -> Path:
    catalogue = json.loads((data_dir / "produits.json").read_text(encoding="utf-8"))
    nutrition_path = data_dir / "nutrition.json"
    nutrition = json.loads(nutrition_path.read_text(encoding="utf-8")) if nutrition_path.exists() else {}
    rows = []
    for p in catalogue["produits"]:
        entry = nutrition.get(p["ean"])
        macros = entry["m"] if entry else None
        rows.append([p.get(c) for c in COLUMNS[:-1]] + [macros])
    out = {
        "maj": catalogue["maj"],
        "magasin": catalogue["magasin"],
        "colonnes": COLUMNS,
        "produits": rows,
        "generique": {k: list(m.as_tuple()) for k, m in GENERIC_PER_100G.items()},
    }
    path = site_dir / "data" / "catalogue.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    build_userscript(site_dir)
    return path


def build_userscript(site_dir: Path = SITE_DIR) -> Path:
    """site/carrefour-panier.user.js : le script du panier avec l'en-tête des extensions (Violentmonkey...).

    La version est la date de construction : les extensions n'installent une mise à jour que si la
    version augmente, ce qui arrive ainsi à chaque déploiement.
    """
    code = (site_dir / "carrefour-panier.js").read_text(encoding="utf-8")
    version = datetime.now(timezone.utc).strftime("1.%Y%m%d.%H%M")
    path = site_dir / "carrefour-panier.user.js"
    path.write_text(USERSCRIPT_HEADER.format(site=SITE_URL, version=version) + code, encoding="utf-8")
    return path


if __name__ == "__main__":
    print(build_site_data())
