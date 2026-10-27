"""Relevé hebdomadaire : catalogue du Drive, puis macros des seuls nouveaux produits, puis données du site.

    python -m recette_macros.update                # tout
    python -m recette_macros.update --rayons cremerie surgeles
    python -m recette_macros.update --nutrition    # uniquement les macros manquantes
"""

import argparse
import os

from .catalogue import DATA_DIR, RAYONS, update_catalogue
from .carrefour import DEFAULT_STORE_REF
from .nutrition import update_nutrition
from .site import build_site_data


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="recette_macros.update")
    ap.add_argument("--rayons", nargs="+", default=RAYONS, help="rayons à relever (par défaut : tous)")
    ap.add_argument("--magasin", default=DEFAULT_STORE_REF)
    ap.add_argument("--nutrition", action="store_true", help="ne relève pas les prix, complète seulement les macros")
    args = ap.parse_args(argv)

    from firecrawl import Firecrawl

    firecrawl = Firecrawl(api_key=os.environ["FIRECRAWL_API_KEY"])
    result = {}
    if not args.nutrition:
        result = update_catalogue(firecrawl, args.magasin, args.rayons, DATA_DIR)
    # Pas de repli Firecrawl par défaut pour Open Food Facts : l'accès direct est gratuit.
    off_firecrawl = firecrawl if os.environ.get("OFF_VIA_FIRECRAWL") else None
    update_nutrition(DATA_DIR, off_firecrawl)
    build_site_data(DATA_DIR)
    # Échec si plus de la moitié des rayons a échoué : le workflow le signalera
    return 1 if len(result.get("rayons_en_echec", [])) > len(args.rayons) / 2 else 0


if __name__ == "__main__":
    raise SystemExit(main())
