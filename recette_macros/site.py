"""Construit site/data/catalogue.json : le catalogue et les macros réunis, sous forme compacte pour le navigateur."""

import json
from pathlib import Path

from .catalogue import DATA_DIR
from .nutrition import GENERIC_PER_100G

SITE_DIR = Path(__file__).resolve().parent.parent / "site"
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
    return path


if __name__ == "__main__":
    print(build_site_data())
