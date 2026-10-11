"""The recorded-answers cache of the second reader (CONTRACTS.md R5.3).

``data/llm_cache/gemini_reader.json`` is committed so a clean clone shows the reader with no
API key and no network: ``{key: {model, prompt_version, recorded_at, response}}`` where
``key = sha256(PROMPT_VERSION + "\\n" + kind + "\\n" + text)``. The file is rewritten
atomically (temp file in the same directory, then ``os.replace``) under a process lock. It
never holds the API key; only the model's parsed JSON answer is stored.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


def cache_key(prompt_version: str, kind: str, text: str) -> str:
    return hashlib.sha256(f"{prompt_version}\n{kind}\n{text}".encode()).hexdigest()


@dataclass(frozen=True)
class CacheEntry:
    model: str | None
    prompt_version: str | None
    recorded_at: str | None
    response: dict[str, Any]


class ReaderCache:
    """A JSON file of recorded answers; reads are fresh, writes are atomic."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def get(self, key: str) -> CacheEntry | None:
        entry = self._load().get(key)
        if not isinstance(entry, dict) or not isinstance(entry.get("response"), dict):
            return None
        return CacheEntry(
            model=entry.get("model") if isinstance(entry.get("model"), str) else None,
            prompt_version=(
                entry.get("prompt_version")
                if isinstance(entry.get("prompt_version"), str)
                else None
            ),
            recorded_at=entry.get("recorded_at")
            if isinstance(entry.get("recorded_at"), str)
            else None,
            response=entry["response"],
        )

    def put(
        self,
        key: str,
        *,
        model: str,
        prompt_version: str,
        recorded_at: str,
        response: dict[str, Any],
    ) -> bool:
        """Record one answer; ``False`` (never an exception) when the file cannot be written."""
        with _LOCK:
            data = self._load()
            data[key] = {
                "model": model,
                "prompt_version": prompt_version,
                "recorded_at": recorded_at,
                "response": response,
            }
            return self._write(data)

    def _write(self, data: dict[str, Any]) -> bool:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(
                dir=self.path.parent, prefix=".gemini_reader.", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                    json.dump(data, fh, indent=2, sort_keys=True, ensure_ascii=False)
                    fh.write("\n")
                os.replace(tmp, self.path)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise
        except OSError:
            return False
        return True

    def drop(self, key: str) -> bool:
        """Forget one answer (``scripts/record_gemini_cache.py --force``); ``True`` if removed."""
        with _LOCK:
            data = self._load()
            if key not in data:
                return False
            del data[key]
            return self._write(data)

    def __len__(self) -> int:
        return len(self._load())
