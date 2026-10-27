"""Cache JSON sur disque avec durée de validité, pour économiser les crédits Firecrawl."""

import json
import os
import time
from pathlib import Path

CACHE_DIR = Path(os.environ.get("RECETTE_MACROS_CACHE", Path.home() / ".cache" / "recette_macros"))


class JsonCache:
    def __init__(self, name: str, ttl_seconds: float):
        self.path = CACHE_DIR / f"{name}.json"
        self.ttl = ttl_seconds
        try:
            self._data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            self._data = {}

    def get(self, key: str):
        entry = self._data.get(key)
        if entry is None or time.time() - entry["t"] > self.ttl:
            return None
        return entry["v"]

    def set(self, key: str, value) -> None:
        self._data[key] = {"t": time.time(), "v": value}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
