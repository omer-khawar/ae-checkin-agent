"""Second-reader configuration, read from the environment (CONTRACTS.md R5.3).

Kept out of ``settings.py`` on purpose: the reader is optional, its key is read from the
process environment only, and this module never logs or stores it.

* ``GEMINI_API_KEY``: Google Generative Language API key (unset: no live calls).
* ``INTERIM_LLM_MODE``: ``auto`` (recorded answer, else a live call when a key exists),
  ``replay`` (recorded answers only, never the network) or ``off``. Default ``auto``.
* ``INTERIM_GEMINI_MODEL``: model id. Default ``gemini-3.5-flash`` (2.5-flash answers 404
  "no longer available to new users"; the reader then falls back to the newest stable flash).
* ``INTERIM_GEMINI_TIMEOUT_S``: HTTP timeout in seconds. Default ``25``.
* ``LLM_CACHE_DIR``: directory holding ``gemini_reader.json``. Default ``<repo>/data/llm_cache``.
* ``INTERIM_GEMINI_BASE_URL``: API root (tests, proxies). Default Google's.

For local development the repo-root ``.env`` is read as a fallback for the same names; a real
environment variable always wins. Nothing is read at import time, so tests can change the
environment between calls.

Under pytest the reader is hermetic: ``.env`` is ignored and the mode defaults to ``off``
unless ``INTERIM_LLM_MODE`` is set in the process environment (a test that wants the reader
sets it, usually to ``replay`` with its own ``LLM_CACHE_DIR``). Without this, a developer's
key or the committed cache would change what unrelated tests see.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from ..settings import REPO_ROOT

Mode = Literal["auto", "replay", "off"]
MODES: tuple[str, ...] = ("auto", "replay", "off")
DEFAULT_MODEL = "gemini-3.5-flash"
DEFAULT_TIMEOUT_S = 25.0
DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
CACHE_FILE = "gemini_reader.json"
_ENV_NAMES = (
    "GEMINI_API_KEY",
    "INTERIM_LLM_MODE",
    "INTERIM_GEMINI_MODEL",
    "INTERIM_GEMINI_TIMEOUT_S",
    "LLM_CACHE_DIR",
    "INTERIM_GEMINI_BASE_URL",
)


def _dotenv_values() -> dict[str, str]:
    """The reader's variables from the repo-root ``.env`` (development convenience)."""
    path = REPO_ROOT / ".env"
    if not path.is_file():
        return {}
    try:
        from dotenv import dotenv_values

        raw = dotenv_values(path)
    except Exception:  # pragma: no cover - a broken .env must never break a request
        return {}
    return {k: v for k, v in raw.items() if k in _ENV_NAMES and isinstance(v, str) and v}


@dataclass(frozen=True)
class ReaderConfig:
    mode: Mode = "auto"
    api_key: str = field(default="", repr=False)
    model: str = DEFAULT_MODEL
    timeout_s: float = DEFAULT_TIMEOUT_S
    cache_dir: Path = REPO_ROOT / "data" / "llm_cache"
    base_url: str = DEFAULT_BASE_URL

    @property
    def cache_path(self) -> Path:
        return self.cache_dir / CACHE_FILE

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> ReaderConfig:
        """Build from ``environ`` (default: the process environment, then ``.env``)."""
        if environ is None:
            under_pytest = "PYTEST_CURRENT_TEST" in os.environ
            source: Mapping[str, str] = (
                {"INTERIM_LLM_MODE": "off", **os.environ}
                if under_pytest
                else {**_dotenv_values(), **os.environ}
            )
        else:
            source = environ
        mode = (source.get("INTERIM_LLM_MODE") or "auto").strip().lower()
        try:
            timeout = float(source.get("INTERIM_GEMINI_TIMEOUT_S") or DEFAULT_TIMEOUT_S)
        except ValueError:
            timeout = DEFAULT_TIMEOUT_S
        if timeout <= 0:
            timeout = DEFAULT_TIMEOUT_S
        cache_dir = source.get("LLM_CACHE_DIR")
        return cls(
            mode=mode if mode in MODES else "auto",  # type: ignore[arg-type]
            api_key=(source.get("GEMINI_API_KEY") or "").strip(),
            model=(source.get("INTERIM_GEMINI_MODEL") or DEFAULT_MODEL).strip(),
            timeout_s=timeout,
            cache_dir=Path(cache_dir) if cache_dir else REPO_ROOT / "data" / "llm_cache",
            base_url=(source.get("INTERIM_GEMINI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
        )
