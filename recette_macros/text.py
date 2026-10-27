"""Comparaison approximative de noms d'aliments (accents, pluriels, mots vides)."""

import re
import unicodedata

STOPWORDS = {"de", "du", "des", "la", "le", "les", "au", "aux", "en", "et", "a", "d", "l"}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def matches(query: str, name: str) -> bool:
    """Vrai si chaque mot significatif de `query` apparaît (au pluriel près) dans `name`."""
    words = re.findall(r"[a-z0-9]+", normalize(name))
    for token in re.findall(r"[a-z0-9]+", normalize(query)):
        if token in STOPWORDS:
            continue
        stem = token.rstrip("sx") if len(token) > 3 else token
        if not any(w.startswith(stem) for w in words):
            return False
    return True
