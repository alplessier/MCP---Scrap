"""Construit site/data/catalogue.json : le catalogue et les macros réunis, sous forme compacte pour le navigateur."""

import json
import os
import re
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
// @match        {site}/*
// @run-at       document-idle
// @grant        none
// @downloadURL  {site}/carrefour-panier.user.js
// @updateURL    {site}/carrefour-panier.user.js
// ==/UserScript==
"""
COLUMNS = ["ean", "nom", "marque", "prix", "prix_unite", "unite", "conditionnement", "rayon", "categorie",
           "promo", "image", "url", "macros", "nutriments"]


def build_site_data(data_dir: Path = DATA_DIR, site_dir: Path = SITE_DIR) -> Path:
    catalogue = json.loads((data_dir / "produits.json").read_text(encoding="utf-8"))
    nutrition_path = data_dir / "nutrition.json"
    nutrition = json.loads(nutrition_path.read_text(encoding="utf-8")) if nutrition_path.exists() else {}
    rows = []
    for p in catalogue["produits"]:
        entry = nutrition.get(p["ean"])
        macros = entry["m"] if entry else None
        nutriments = entry.get("n") if entry and macros else None
        rows.append([p.get(c) for c in COLUMNS[:-2]] + [macros, nutriments])
    out = {
        "maj": catalogue["maj"],
        "magasin": catalogue["magasin"],
        "colonnes": COLUMNS,
        "produits": rows,
        # macros puis, s'ils sont connus, fibres, sucres, acides gras saturés et sel
        "generique": {k: list(m.as_tuple()) + list(m.nutriments or []) for k, m in GENERIC_PER_100G.items()},
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


def fetch_photos(site_dir: Path = SITE_DIR, get=None, log=print) -> int:
    """Copie dans site/img/<id>.webp la photo (version légère) de chaque recette de site/recettes.json.

    Lancé avant chaque mise en ligne : le site ne dépend plus du serveur d'images. Une photo déjà copiée
    n'est pas retéléchargée ; un échec est ignoré (le site charge alors l'image en ligne, ou l'emoji).
    """
    if get is None:
        import requests

        get = lambda url: requests.get(url, timeout=20)  # noqa: E731
    recipes = json.loads((site_dir / "recettes.json").read_text(encoding="utf-8"))["recettes"]
    folder = site_dir / "img"
    folder.mkdir(exist_ok=True)
    copied = 0
    for r in recipes:
        url, target = r.get("photo"), folder / f"{r['id']}.webp"
        if not url or target.exists():
            continue
        try:
            resp = get(re.sub(r"\.png$", "_min.webp", url))
            if resp.status_code == 200 and resp.content[:4] == b"RIFF":
                target.write_bytes(resp.content)
                copied += 1
        except Exception as e:  # réseau : sans gravité, le site a ses replis
            log(f"photo de {r['id']} non copiée : {e}")
    return copied


ASSET_RE = re.compile(r'((?:href|src)="(?:style\.css|core\.js|app\.js|sync\.js))(?:\?v=[^"]*)?"')


def stamp_assets(site_dir: Path = SITE_DIR, version: str | None = None) -> str:
    """Ajoute ?v=<version> aux fichiers du site dans index.html.

    Chaque mise en ligne change l'adresse de style.css, core.js et app.js : le navigateur ne peut pas
    garder une ancienne version en cache à côté de la nouvelle page.
    """
    version = version or os.environ.get("GITHUB_SHA", "")[:10] or datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    path = site_dir / "index.html"
    html = path.read_text(encoding="utf-8")
    path.write_text(ASSET_RE.sub(lambda m: f'{m.group(1)}?v={version}"', html), encoding="utf-8")
    return version


if __name__ == "__main__":
    print(build_site_data())
    print("version des fichiers :", stamp_assets())
    print("photos copiées :", fetch_photos())
