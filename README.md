# MCP---Scrap — Mode libre recette + macros

Saisissez une recette en texte libre. L'outil :

1. cherche chaque ingrédient sur **carrefour.fr**, aux prix de **votre magasin** (par défaut le
   *Drive Market Clermont-Ferrand Jaude*), grâce à [Firecrawl](https://firecrawl.dev) ;
2. récupère les **macros** du produit choisi sur [Open Food Facts](https://world.openfoodfacts.org)
   à partir de son code-barres (une table générique Ciqual sert de secours) ;
3. calcule le **coût** (quantité utilisée et paquets à acheter) et les **macros**, au total et par portion.

```
Ingrédient                   Produit Carrefour                              Coût   kcal      P      G      L
------------------------------------------------------------------------------------------------------------
300 g filet de poulet        Filets de Poulet SIMPL'                      3,06 €    345   72.0    0.0    6.0 *
150 g riz basmati            Riz Basmati Long CARREFOUR EXTRA             0,39 €    524   12.9  115.5    1.4
200 g brocolis               Brocoli coupé SIMPL                          0,40 €     68    4.8    7.0    0.0
10 ml huile d'olive          Huile d'Olive Vierge Extra CARREFOUR EXTRA   0,08 €     82    0.0    0.0    9.1
------------------------------------------------------------------------------------------------------------
TOTAL                                                                     3,92 €   1019   89.7  122.5   16.4
PAR PORTION (÷2)                                                          1,96 €    509   44.9   61.2    8.2
```

## Installation

```bash
pip install -r requirements.txt
export FIRECRAWL_API_KEY=fc-...
```

## Utilisation

```bash
# Mode libre interactif : on tape les ingrédients, puis on choisit le produit pour chacun
python -m recette_macros

# En une commande, avec choix automatique du produit
python -m recette_macros -p 2 --auto moins-cher \
  -i "300 g filet de poulet" -i "150 g riz basmati" -i "200 g brocolis" -i "10 ml huile d'olive"

# Depuis un fichier
python -m recette_macros -f exemples/poulet_riz_brocolis.txt -p 2

# Juste les prix d'un produit dans votre magasin
python -m recette_macros --chercher "skyr"
```

Format d'une ligne d'ingrédient :

| Exemple | Signification |
|---|---|
| `200 g blanc de poulet` | quantité en `g`, `kg`, `ml`, `cl` ou `l` (1 ml est compté comme 1 g pour les macros) |
| `2 oeufs @60g` | pièces, avec le poids d'une pièce (nécessaire pour les macros) |
| `3 avocats` | pièces : le prix est calculé si Carrefour vend le produit à la pièce |
| `100 g skyr #3560070945252` | impose un produit précis par son code-barres |

Les lignes commençant par `//` sont des commentaires.

Options utiles : `--auto pertinence|moins-cher` (sans ce choix, le produit est demandé pour chaque
ingrédient), `--top N` (nombre de produits proposés), `--json` (sortie machine),
`--magasin REF` (autre magasin), `--rafraichir` (ignore le cache des prix).

## Changer de magasin

La référence du magasin figure dans le HTML de sa page Drive (`/set-store/<ref>`). Pour le
Drive Jaude, c'est `575`. Pour un autre magasin, passez `--magasin <ref>` ou définissez la
variable `CARREFOUR_STORE`. L'outil vérifie que Carrefour a bien appliqué ce magasin et
s'arrête sinon, plutôt que de renvoyer les prix d'un autre magasin.

## Crédits Firecrawl et cache

- Une recherche de produit coûte quelques crédits Firecrawl (navigation avec choix du magasin).
- Une fiche Open Food Facts est récupérée en direct, gratuitement ; Firecrawl (1 crédit) ne sert
  qu'en secours si l'accès direct échoue.
- Les prix sont gardés en cache **7 jours** et les macros **90 jours** dans
  `~/.cache/recette_macros/` (modifiable avec `RECETTE_MACROS_CACHE`).

## Limites

- Les macros sont celles du produit **tel que vendu** : comptez le riz et les pâtes en poids sec.
- Les valeurs marquées `*` viennent d'une table générique approximative (produit sans fiche Open Food Facts).
- Les promos « Mardi PASS » et les remises fidélité ne sont pas déduites ; elles sont signalées
  lors du choix du produit.
- Le scraping dépend de la structure HTML de carrefour.fr et peut casser si le site change.
  Usage personnel uniquement.

## Tests

```bash
python -m pytest
```
