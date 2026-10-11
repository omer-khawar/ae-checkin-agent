"""Small shared helpers: ids, timestamps, JSON columns.

* IDs are ULIDs (CONTRACTS.md conventions).
* Timestamps are ``YYYY-MM-DDTHH:MM:SS.mmmZ`` strings everywhere; the formatting
  functions are reused from ``interim_rules.timefmt`` so the API and the engine
  can never disagree on the canonical form.
* JSON columns are TEXT; ``dump_json`` / ``load_json`` are the only encoders.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from ulid import ULID

from interim_rules.serialize import to_jsonable
from interim_rules.timefmt import (
    format_iso_utc,
    iso_date,
    normalize_iso,
    parse_iso_utc,
    seconds_between,
    shift,
)

__all__ = [
    "dump_json",
    "iso_date",
    "load_json",
    "new_id",
    "normalize_iso",
    "now_iso",
    "parse_iso_utc",
    "seconds_between",
    "shift",
    "to_jsonable",
]


def new_id() -> str:
    """A fresh ULID (26-char Crockford base32, time-ordered)."""
    return str(ULID())


def now_iso() -> str:
    """The wall clock as the contract's UTC ISO string with milliseconds."""
    return format_iso_utc(datetime.now(UTC))


def dump_json(value: Any) -> str:
    """Compact JSON for a TEXT column (dataclasses/tuples converted first)."""
    return json.dumps(to_jsonable(value), ensure_ascii=False, separators=(",", ":"))


def load_json(text: str | None, default: Any = None) -> Any:
    """Inverse of :func:`dump_json`; ``None``/empty -> ``default``."""
    if text is None or text == "":
        return default
    return json.loads(text)
