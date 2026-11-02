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

Inspiré de la simplicité de Jow, avec en plus la partie nutrition et sport :

| Page | Contenu |
|---|---|
| **Recettes** | 123 recettes sportives (`site/recettes.json`) en grandes cartes : prix par personne, protéines, kcal. Filtres (Perte de gras, Prise de muscle, Gourmand, Protéiné, Après la séance, Petit-déj, Collation & dessert, Meal prep, Végétarien, Moins de 20 min, Petit budget) et recherche. Le bouton **+** ajoute au menu. Avec un profil, l'accueil affiche **le top 3** dans chaque filtre et les filtres sont triés par pertinence. **« Pour : »** permet de cocher les personnes à table (seul, couple, famille) : seules les recettes compatibles avec toutes sont proposées, la note combine celle de chacun (moyenne tirée vers la plus basse) et chaque carte montre la portion conseillée par personne. Les fiches reprennent ce choix dans « Pour qui ? ». Sous la recherche, des **suggestions** (poulet, skyr, œufs…) et l'accès à **« Avec ce que j'ai »**. Le ♡ met une recette en **favori** : rangée « Vos favoris » sur l'accueil et filtre dédié. |
| **Avec ce que j'ai** | On indique ce qu'il y a dans le frigo et les placards ; les recettes compatibles avec le foyer sont classées par ingrédients manquants (« ✓ 3/4 · il manque : lait de coco »). Huile, sel et épices sont supposés déjà là. |
| **Fiche recette** | Bandeau des chiffres clés (temps, kcal et protéines par personne, prix), ingrédients en vignettes rondes, **« Pour qui ? »** : on coche les profils du foyer (et des invités) ; chacun reçoit la portion de son objectif, ses apports sont comparés à son repas idéal, et les quantités comme le panier suivent. **« Vous avez sûrement déjà… »** : huile, sel, épices, sauce soja… et ingrédients `(facultatif)` comptés dans les macros mais hors panier, sauf si on les demande. Étapes illustrées par l'ingrédient utilisé ; choix des produits du Drive dans un volet. Mode **« Passer en cuisine »** étape par étape, avec les ingrédients de l'étape et l'écran qui reste allumé. |
| **Menu** | Les recettes de la semaine, leurs couverts, le coût total et la moyenne des macros par repas. |
| **Semaine** (onglet) | Planning de la semaine : chaque jour, un créneau par repas (petit-déj, déjeuner, collation, dîner, en-cas du soir, selon le nombre de repas de chacun). « + Choisir une recette » propose d'abord les recettes ajoutées avec **+**, puis les mieux notées et compatibles. Pour chaque repas, on coche qui mange, avec la portion de chacun calée sur ses besoins **de ce jour-là**. On voit combien de repas il manque sur la semaine, et chaque jour les apports de chaque personne (kcal, protéines, glucides, lipides, coût) face à ses besoins, ainsi que les **fibres, sucres, acides gras saturés et sel** face aux repères de l'Anses (fibres ≥ 30 g, sucres ≤ 100 g, AG saturés ≤ 12 % des calories, sel ≤ 6 g). « Copier à … » répète un repas le lendemain (meal prep). Les courses couvrent toute la semaine. |
| **Courses** | Liste regroupée par rayon, en paquets entiers. Les quantités d'un même produit sont additionnées sur toute la semaine, puis le site retient la **combinaison de formats la moins chère** du même produit (même nom, même marque) : une boîte de 12 œufs plutôt que deux de 6, une boîte d'1 kg plutôt que deux de 500 g, ou un panachage (12 + 6). Chaque changement est signalé avec l'économie et peut être annulé (« Garder mon format ») ; cochez ce que vous avez déjà, puis **un bouton** envoie tout au panier Carrefour, ou ouvrez la **liste guidée** sans rien installer. |
| **Profil** | Le **foyer** : seul, en couple ou en famille, plusieurs profils (membres présents ou non). Chaque membre : âge, poids, taille, activité, objectif (sèche, recomposition, maintien, prise de masse), repas par jour → besoins en kcal et en macros (Mifflin-St Jeor) ; allergies et intolérances (14 allergènes majeurs simplifiés à 10), régime (végétarien, pescétarien, végétalien, sans porc), petit-déjeuner sucré ou salé, ingrédients détestés (liste déroulante). Pour le foyer : budget par jour et par personne, temps de cuisine par jour, matériel disponible. Les recettes incompatibles avec un membre présent sont masquées ; budget, temps et goût du petit-déjeuner font baisser la note ; chaque fiche propose « Adapter au foyer » avec la portion de chacun. **Jours de sport** par membre : ces jours-là l'énergie monte (en glucides), les jours de repos elle baisse d'autant, avec le même total sur la semaine ; le site s'adapte au jour en cours. |
| **Créer** (onglet) | On cherche un produit du Drive (photo, prix, macros), on l'ajoute d'un clic et on règle la quantité ; le produit choisi reste modifiable. Depuis « Produits du Drive », le bouton **+ Ma recette** ajoute aussi un produit. Saisie en texte toujours possible. Le brouillon est conservé jusqu'à l'enregistrement. |

Tout est enregistré dans le navigateur (menu, foyer et profils, recettes perso). Les calculs sont dans
`site/core.js`, testés avec Node (`node --test tests/site_core.test.js`), et un test vérifie que chaque ingrédient des
recettes trouve un produit du Drive avec des macros.

### Note de pertinence (« Le top 3 pour vous »)

Chaque recette reçoit une note sur 100 pour l'objectif du profil, calculée sur la portion adaptée à
votre repas idéal (au plus ×2) : part des calories venant des protéines, écart au repas idéal, part
des lipides au-delà de 35 % et coût. Les pondérations dépendent de l'objectif (`SCORE_WEIGHTS` dans
`site/core.js`). Les collations sont comparées à une collation (12 % des besoins du jour), et les
rangées de repas ne proposent pas de collation ni de petit-déj.

### Ajouter une recette au catalogue

Ajoutez une entrée à `site/recettes.json` (ingrédients au format du mode libre, pour les portions
indiquées), puis lancez `python -m recette_macros.site && node --test tests/` : le test signale tout
ingrédient qui ne trouve pas de produit ou de macros.

### Envoyer une recette au panier Carrefour

Le bouton **🛒 Ajouter au panier Carrefour** ouvre carrefour.fr sur le Drive Jaude et ajoute les paquets
entiers de la recette au panier. Si vous êtes connecté à votre compte, ce panier est aussi celui de
l'**application Carrefour** : il ne reste qu'à choisir le créneau et payer.

Un site extérieur ne peut pas toucher au panier Carrefour (le navigateur l'interdit), et Carrefour n'offre
ni API publique ni lien d'ajout groupé. Deux façons de faire :

- **Liste guidée, sans rien installer** (`#/panier-guide`) : chaque produit s'ouvre sur carrefour.fr, ou dans
  l'application Carrefour sur mobile si elle prend le lien ; on l'ajoute et il est coché. Progression conservée.
- **Tout en un clic, avec le script** `site/carrefour-panier.js`, installé une fois :
  extension [Tampermonkey](https://www.tampermonkey.net/) ou [Violentmonkey](https://violentmonkey.github.io/)
  (ordinateur, Firefox sur Android) ou app « Userscripts » (Safari sur iPhone), puis le lien
  `carrefour-panier.user.js` du site. Le script s'annonce aussi sur le site : une fois installé, le bouton
  ouvre directement Carrefour, sans fenêtre d'explication. Il se met à jour tout seul. La fenêtre d'envoi
  affiche les étapes d'installation propres à l'appareil (ordinateur, Android, iPhone).
- Sur ordinateur, un **favori** « 🛒 Panier recette » reste possible, à cliquer une fois la page Carrefour ouverte.

La recette voyage dans l'ancre de l'adresse (`#recette-macros=…`), qui n'est jamais envoyée à un serveur.
Le script utilise la fonction d'ajout du site Carrefour lui-même (`window.ONECF.addToCart`). Les
quantités s'ajoutent à ce qui est déjà au panier, et les produits indisponibles ce jour-là sont signalés.

### Format d'une ligne d'ingrédient

| Exemple | Signification |
|---|---|
| `200 g blanc de poulet` | quantité en `g`, `kg`, `ml`, `cl` ou `l` (1 ml est compté comme 1 g pour les macros) |
| `2 oeufs @60g` | pièces, avec le poids d'une pièce (nécessaire pour les macros) |
| `1 bouquet coriandre (facultatif)` | ingrédient facultatif : affiché avec un badge, pas ajouté au panier par défaut |
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
| `data/nutrition.json` | Par code-barres, pour 100 g : macros (`m`) et fibres, sucres, acides gras saturés, sel (`n`), complétés seulement pour les nouveaux produits. Les produits connus d'avant l'ajout des nutriments sont complétés petit à petit ; « Run workflow » avec **nutrition_seule** le fait sans relever les prix. |

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
