"""Server-side value checks for the SDTM-shaped fields a human may edit or post.

One validator, two callers, so they can never disagree:

* ``PATCH /drafts/{id}`` (``drafts.edit_draft``) runs it in **strict** mode: an
  edited value must already have the type the record stores (an ``int`` grade,
  a ``float`` result), because the new version is what gets exported.
* ``POST /mock-edc/{domain}`` (``exports.validate_edc_records``) runs it in
  **lenient** mode: records round-tripped through CSV carry numbers as strings,
  so ``"2"`` is as good as ``2`` there.

Every bound comes from a rules table (``composite_to_grade.json`` for the grade
range, ``escalation_ladder.json`` for the tier range); nothing clinical is
typed here. Fields not listed are free text and are not checked beyond what
the request schema already enforces.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from datetime import date
from typing import Any

from interim_rules.tables import escalation_ladder, grade_map
from interim_rules.timefmt import normalize_iso

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

Check = Callable[[Any, bool], str | None]
"""``(value, lenient) -> problem text or None``."""


def _is_int(value: Any, lenient: bool) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float) and value.is_integer():
        return True
    return lenient and isinstance(value, str) and value.strip().lstrip("-").isdigit()


def _as_int(value: Any) -> int:
    return int(float(value)) if isinstance(value, str) else int(value)


def _grade(value: Any, lenient: bool) -> str | None:
    allowed = sorted(set(grade_map().map.values()))
    if not _is_int(value, lenient) or _as_int(value) not in allowed:
        top = grade_map().max_assignable_grade
        return (
            f"must be a provisional CTCAE grade {allowed[0]}..{allowed[-1]} "
            f"(G{top + 1}+ are never assigned by Interim), got {value!r}"
        )
    return None


def _tier(value: Any, lenient: bool) -> str | None:
    top = len(escalation_ladder().tiers) - 1
    if not _is_int(value, lenient) or not 0 <= _as_int(value) <= top:
        return f"must be an escalation tier 0..{top}, got {value!r}"
    return None


def _yes_no(value: Any, lenient: bool) -> str | None:
    if value not in ("Y", "N"):
        return f"must be 'Y' or 'N', got {value!r}"
    return None


def _datetime_or_date(value: Any, lenient: bool) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return f"must be an ISO-8601 date or UTC datetime string, got {value!r}"
    text = value.strip()
    if _DATE_RE.match(text):
        return _date(text, lenient)
    try:
        normalize_iso(text)
    except ValueError:
        return f"must be an ISO-8601 date (YYYY-MM-DD) or UTC datetime, got {value!r}"
    return None


def _date(value: Any, lenient: bool) -> str | None:
    if isinstance(value, str) and _DATE_RE.match(value.strip()):
        try:
            date.fromisoformat(value.strip())  # a real calendar date, not just the shape
            return None
        except ValueError:
            pass
    return f"must be an ISO-8601 date (YYYY-MM-DD), got {value!r}"


def _number(value: Any, lenient: bool) -> str | None:
    candidate: Any = value
    if lenient and isinstance(value, str):
        try:
            candidate = float(value)
        except ValueError:
            return f"must be a number, got {value!r}"
    if isinstance(candidate, bool) or not isinstance(candidate, int | float):
        return f"must be a number, got {value!r}"
    if not math.isfinite(float(candidate)):
        return f"must be a finite number, got {value!r}"
    return None


def _not_done(value: Any, lenient: bool) -> str | None:
    if value != "NOT DONE":
        return f"must be 'NOT DONE' or null, got {value!r}"
    return None


NULLABLE_CHECKS: dict[str, Check] = {
    "AETOXGR": _grade,
    "AESER": _yes_no,
    "AEONGO": _yes_no,
    "AESTDTC": _datetime_or_date,
    "AEENDTC": _datetime_or_date,
    "INTERIM_TIER": _tier,
    "VSORRES": _number,
    "VSSTAT": _not_done,
    "VSDTC": _datetime_or_date,
    "CMSTDTC": _date,
    "CMENDTC": _date,
}
"""Field -> check. Every listed field may also be ``null`` (SDTM: not collected / not yet set)."""


def field_problems(fields: Mapping[str, Any], *, lenient: bool = False) -> list[str]:
    """``["AETOXGR must be ...", ...]`` for the known fields in ``fields`` (empty = fine)."""
    out: list[str] = []
    for name, value in fields.items():
        check = NULLABLE_CHECKS.get(name)
        if check is None or value is None or (lenient and value == ""):
            continue
        message = check(value, lenient)
        if message is not None:
            out.append(f"{name} {message}")
    return out
