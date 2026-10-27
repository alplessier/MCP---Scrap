# MCP---Scrap — Recettes & macros au Drive Carrefour Jaude

Un site pour chiffrer ses recettes **en euros et en macros**, avec les prix du
*Drive Market Clermont-Ferrand Jaude*.

- **Relevé une fois par semaine**, pas à chaque recherche : chaque lundi, GitHub Actions relève les
  ~12 000 produits alimentaires du Drive avec [Firecrawl](https://firecrawl.dev) (environ **12 crédits
  par semaine**, un par rayon), puis enregistre le résultat dans `data/`.
- **Macros récupérées une seule fois** : seuls les produits **nouveaux** sont interrogés sur
  [Open Food Facts](https://world.openfoodfacts.org) (gratuit). Les produits encore sans fiche sont
  retentés toutes les 4 semaines.
- **Site statique** : tous les calculs se font dans le navigateur, à partir du dernier relevé.
  Une recherche ne coûte rien et ne fait aucun appel à Carrefour.

## Le site

| Onglet | Contenu |
|---|---|
| **Recette** | Mode libre : un ingrédient par ligne (`300 g filet de poulet`, `2 oeufs @60g`…). Pour chaque ligne, le produit choisi (modifiable), son coût et ses macros, puis le coût, les kcal et les macros **par portion**, et le prix des paquets entiers à acheter. |
| **Produits** | Recherche dans le catalogue, triable par prix au kilo ou par **grammes de protéines par euro**. |
| **Mes recettes** | Recettes enregistrées dans le navigateur, recalculées avec les prix de la semaine. Le bouton « Copier le lien » partage une recette. |

### Envoyer une recette au panier Carrefour

Le bouton **🛒 Ajouter au panier Carrefour** ouvre carrefour.fr sur le Drive Jaude et ajoute les paquets
entiers de la recette au panier. Si vous êtes connecté à votre compte, ce panier est aussi celui de
l'**application Carrefour** : il ne reste qu'à choisir le créneau et payer.

Un site extérieur ne peut pas toucher au panier Carrefour (le navigateur l'interdit). L'ajout est donc fait
**sur carrefour.fr** par `site/carrefour-panier.js`, installé une fois au choix :

- **Userscript (recommandé, un seul clic ensuite)** : extension [Violentmonkey](https://violentmonkey.github.io/)
  ou [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Firefox Android ; app « Userscripts »
  sur iPhone), puis le lien `carrefour-panier.user.js` du site. Il se met à jour tout seul.
- **Favori** : glisser le bouton « 🛒 Panier recette » dans la barre de favoris, et cliquer dessus une fois la
  page Carrefour ouverte.

La recette voyage dans l'ancre de l'adresse (`#recette-macros=…`), qui n'est jamais envoyée à un serveur.
Le script utilise la fonction d'ajout du site Carrefour lui-même (`window.ONECF.addToCart`). Les
quantités s'ajoutent à ce qui est déjà au panier, et les produits indisponibles ce jour-là sont signalés.

### Format d'une ligne d'ingrédient

| Exemple | Signification |
|---|---|
| `200 g blanc de poulet` | quantité en `g`, `kg`, `ml`, `cl` ou `l` (1 ml est compté comme 1 g pour les macros) |
| `2 oeufs @60g` | pièces, avec le poids d'une pièce (nécessaire pour les macros) |
| `3 avocats` | pièces : le prix est calculé si le produit est vendu à la pièce |
| `100 g skyr #3560070945252` | impose un produit précis par son code-barres |

## Mise en ligne (une seule fois)

1. **Clé Firecrawl** : *Settings → Secrets and variables → Actions → New repository secret*,
   nom `FIRECRAWL_API_KEY`.
2. **GitHub Pages** : *Settings → Pages → Source : GitHub Actions*.
   Sur un dépôt **privé**, Pages demande un compte GitHub Pro. Sinon, rendez le dépôt public :
   il ne contient aucun secret, la clé reste dans les secrets GitHub.
3. Fusionnez sur `main`, puis lancez le workflow une première fois :
   *Actions → Relevé hebdomadaire et site → Run workflow*. Le tout premier relevé des macros
   prend environ 1 h (Open Food Facts limite le débit) ; les suivants, quelques minutes.

Ensuite, tout est automatique chaque lundi matin.

## Fichiers de données

| Fichier | Contenu |
|---|---|
| `data/produits.json` | État actuel du catalogue, un produit par ligne : chaque commit hebdomadaire ne montre que ce qui a changé. |
| `data/historique_prix.csv` | Une ligne par **changement** de prix (date, code-barres, prix). |
| `data/nutrition.json` | Macros pour 100 g par code-barres, complétées seulement pour les nouveaux produits. |

## En local

```bash
pip install -r requirements.txt

# Site : construit site/data/catalogue.json, puis le sert en local
python -m recette_macros.site && python -m http.server -d site 8000

# Ligne de commande (utilise le dernier relevé, sans frais)
python -m recette_macros -p 2 --auto moins-cher -i "300 g filet de poulet" -i "150 g riz basmati"
python -m recette_macros --chercher "skyr"

# Relevé manuel (consomme des crédits Firecrawl)
export FIRECRAWL_API_KEY=fc-...
python -m recette_macros.update                         # tous les rayons
python -m recette_macros.update --rayons cremerie       # un seul rayon, les autres sont conservés
```

`--live` sur la ligne de commande interroge carrefour.fr en direct (payant) au lieu du relevé.

## Comment fonctionne le relevé

Pour chaque rayon, une seule session Firecrawl :

1. ouvre `https://www.carrefour.fr/set-store/575`, ce qui choisit le Drive Jaude ;
2. ouvre le rayon `/r/<rayon>` ;
3. lit toutes ses pages via l'API JSON qu'utilise le site Carrefour lui-même (prix, prix au kilo
   et promos propres au magasin).

Les produits « marketplace » (vendeurs tiers, absents du Drive) sont écartés. Un rayon en échec est
retenté une fois, puis garde ses produits de la semaine précédente.

Pour changer de magasin, trouvez sa référence dans le HTML de sa page Drive (`/set-store/<ref>`)
et passez `--magasin <ref>` (ou la variable `CARREFOUR_STORE`).

## Limites

- Macros du produit **tel que vendu** : comptez le riz et les pâtes en poids sec.
- Les valeurs marquées `*` viennent d'une table générique approximative (produit sans fiche Open Food Facts).
- Les promos « Mardi PASS » et les remises fidélité sont signalées mais pas déduites.
- Le relevé dépend de la structure de carrefour.fr et peut casser si le site change. Usage personnel uniquement.

## Tests

```bash
python -m pytest
```
