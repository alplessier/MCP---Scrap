"""Interface en ligne de commande du mode libre recette + macros + prix Carrefour."""

import argparse
import json
import sys
from dataclasses import asdict

from .carrefour import DEFAULT_STORE_REF, CarrefourClient, Product
from .nutrition import NutritionClient
from .recipe import Ingredient, RecipeResult, choose_product, cost_line, is_usable, parse_line, parse_recipe
from .text import matches


def fmt_eur(v: float | None) -> str:
    return "—" if v is None else f"{v:.2f} €".replace(".", ",")


def describe(p: Product) -> str:
    unit = f"{p.unit_price:.2f} €/{p.unit}".replace(".", ",") if p.unit_price else "prix/kg inconnu"
    promo = f"  [{p.promo}]" if p.promo else ""
    return f"{p.name} — {fmt_eur(p.price)} ({unit}){promo}"


def ask_product(ing: Ingredient, products: list[Product], top: int) -> Product | None:
    relevant = [p for p in products if matches(ing.name, p.name)]
    shown = (relevant + [p for p in products if p not in relevant])[:top]
    print(f"\n» {ing.raw}")
    for i, p in enumerate(shown, 1):
        flag = "" if is_usable(ing, p) else "  (unité incompatible)"
        print(f"  {i}. {describe(p)}{flag}")
    print("  0. ignorer cet ingrédient")
    default = choose_product(ing, products, top=top)
    default_idx = shown.index(default) + 1 if default in shown else 0
    while True:
        answer = input(f"  Choix [{default_idx}] : ").strip()
        if not answer:
            return default
        if answer.isdigit() and 0 <= int(answer) <= len(shown):
            return shown[int(answer) - 1] if int(answer) else None
        print("  Réponse invalide.")


def compute(ingredients, portions, carrefour, nutrition, strategy, interactive, top, refresh) -> RecipeResult:
    result = RecipeResult(lines=[], portions=portions)
    for ing in ingredients:
        products = carrefour.search(ing.ean or ing.name, refresh=refresh)
        if interactive and products and not ing.ean:
            product = ask_product(ing, products, top)
        else:
            product = choose_product(ing, products, strategy, top)
        macros = nutrition.per_100g(product.ean) if product else None
        line = cost_line(ing, product, macros)
        if line.cost_used is None:
            result.missing_prices.append(ing.raw)
        if line.macros is None:
            result.missing_macros.append(ing.raw)
        result.lines.append(line)
    return result


def print_result(r: RecipeResult) -> None:
    print()
    header = f"{'Ingrédient':<28} {'Produit Carrefour':<42} {'Coût':>8} {'kcal':>6} {'P':>6} {'G':>6} {'L':>6}"
    print(header)
    print("-" * len(header))
    for l in r.lines:
        name = (l.product.name if l.product else "introuvable")[:42]
        m = l.macros
        cols = (f"{m.kcal:6.0f} {m.proteines:6.1f} {m.glucides:6.1f} {m.lipides:6.1f}" if m else f"{'—':>6} " * 4)
        star = " *" if l.macros_generic else ""
        print(f"{l.ingredient.raw[:28]:<28} {name:<42} {fmt_eur(l.cost_used):>8} {cols}{star}")
    t = r.total_macros
    print("-" * len(header))
    print(f"{'TOTAL':<71} {fmt_eur(r.total_cost):>8} {t.kcal:6.0f} {t.proteines:6.1f} {t.glucides:6.1f} {t.lipides:6.1f}")
    if r.portions > 1:
        p = t.scaled(1 / r.portions)
        print(f"{f'PAR PORTION (÷{r.portions})':<71} {fmt_eur(r.total_cost / r.portions):>8} "
              f"{p.kcal:6.0f} {p.proteines:6.1f} {p.glucides:6.1f} {p.lipides:6.1f}")
    print(f"\nCoût d'achat des paquets entiers : {fmt_eur(r.total_bought)}")
    for l in r.lines:
        if l.packs:
            print(f"  - {l.packs} × {l.product.name} ({fmt_eur(l.product.price)})")
    if any(l.macros_generic for l in r.lines):
        print("\n* macros génériques (table Ciqual approximative) : produit absent d'Open Food Facts")
    if r.missing_prices:
        print("\n⚠ Prix non calculé pour : " + ", ".join(r.missing_prices))
    if r.missing_macros:
        print("⚠ Macros manquantes pour : " + ", ".join(r.missing_macros)
              + "\n  (aliment inconnu, ou quantité en pièces sans poids : utilisez '@60g')")


def read_free_mode() -> list[Ingredient]:
    print("Mode libre : saisissez un ingrédient par ligne (ex. '200 g blanc de poulet', '2 oeufs @60g').")
    print("Ligne vide pour terminer.")
    ingredients = []
    while True:
        line = input("> ").strip()
        if not line:
            return ingredients
        try:
            ingredients.append(parse_line(line))
        except ValueError as e:
            print(f"  {e}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="recette_macros", description="Recette en mode libre : macros + prix Carrefour.")
    ap.add_argument("-i", "--ingredient", action="append", default=[], help="ex. '200 g blanc de poulet' (répétable)")
    ap.add_argument("-f", "--fichier", help="fichier texte, un ingrédient par ligne")
    ap.add_argument("-p", "--portions", type=int, default=None)
    ap.add_argument("--chercher", metavar="PRODUIT", help="affiche simplement les prix d'un produit")
    ap.add_argument("--auto", choices=["pertinence", "moins-cher"],
                    help="choix automatique du produit (sinon, choix interactif)")
    ap.add_argument("--top", type=int, default=5, help="nombre de produits proposés par ingrédient")
    ap.add_argument("--magasin", default=DEFAULT_STORE_REF, help="référence Carrefour du magasin (575 = Drive Jaude)")
    ap.add_argument("--rafraichir", action="store_true", help="ignore le cache des prix")
    ap.add_argument("--json", action="store_true", help="sortie JSON")
    args = ap.parse_args(argv)

    carrefour = CarrefourClient(args.magasin)

    if args.chercher:
        products = carrefour.search(args.chercher, refresh=args.rafraichir)
        if args.json:
            print(json.dumps([asdict(p) for p in products], ensure_ascii=False, indent=2))
        else:
            for p in products:
                print(f"- {describe(p)}\n  {p.url}")
        return 0

    if args.fichier:
        with open(args.fichier, encoding="utf-8") as fh:
            ingredients = parse_recipe(fh.read())
    elif args.ingredient:
        ingredients = [parse_line(l) for l in args.ingredient]
    else:
        ingredients = read_free_mode()
    if not ingredients:
        print("Aucun ingrédient.")
        return 1

    portions = args.portions
    if portions is None:
        portions = 1
        if not args.auto and sys.stdin.isatty():
            answer = input("Nombre de portions [1] : ").strip()
            portions = int(answer) if answer.isdigit() and int(answer) > 0 else 1

    interactive = args.auto is None and sys.stdin.isatty()
    result = compute(ingredients, portions, carrefour, NutritionClient(), args.auto or "pertinence",
                     interactive, args.top, args.rafraichir)

    if args.json:
        print(json.dumps({
            "lignes": [asdict(l) for l in result.lines],
            "portions": result.portions,
            "cout_total": result.total_cost,
            "cout_achat": result.total_bought,
            "macros_total": asdict(result.total_macros),
        }, ensure_ascii=False, indent=2))
    else:
        print_result(result)
    return 0
