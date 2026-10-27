"""Comparaison approximative de noms d'aliments (accents, pluriels, mots vides)."""

import re
import unicodedata

STOPWORDS = {"de", "du", "des", "la", "le", "les", "au", "aux", "en", "et", "a", "d", "l"}


def normalize(text: str) -> str:
    text = text.lower().replace("œ", "oe").replace("æ", "ae")  # « Œufs » s'écrit avec une ligature
    text = unicodedata.normalize("NFKD", text)
    return "".join(c for c in text if not unicodedata.combining(c))


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", normalize(text))


def query_tokens(query: str) -> list[str]:
    """Mots significatifs de la requête, sans la marque du pluriel."""
    return [t.rstrip("sx") if len(t) > 3 else t for t in words(query) if t not in STOPWORDS]


def relevance(tokens: list[str], name: str) -> float | None:
    """Plus c'est petit, plus `name` est pertinent ; None si un mot de la requête manque.

    Même calcul que dans site/app.js : position des mots trouvés, plus une petite pénalité de longueur.
    """
    name_words = words(name)
    score = 0
    for t in tokens:
        i = next((i for i, w in enumerate(name_words) if w.startswith(t)), None)
        if i is None:
            return None
        score += i
    return score + len(name_words) * 0.05


def category_bonus(tokens: list[str], category: str | None) -> float:
    """Bonus quand la catégorie du produit correspond aussi : « oeufs » → catégorie Œufs, pas Kinder."""
    return -1.0 if category and relevance(tokens, category) is not None else 0.0


def matches(query: str, name: str) -> bool:
    """Vrai si chaque mot significatif de `query` apparaît (au pluriel près) dans `name`."""
    return relevance(query_tokens(query), name) is not None
