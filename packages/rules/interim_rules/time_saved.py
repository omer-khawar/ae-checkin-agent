"""Coordinator time-saved estimate (CLAUDE.md §00.5, CONTRACTS.md R3.1).

Pure arithmetic over ``data/time_model.json``. For each category of work (an AE field, a
medication field, a vitals field, a serious/special-interest report field, a narrative
paragraph, a visit-brief section) the table gives the minutes a person would spend doing it
by hand. Interim pre-fills some of that work from evidence; a person confirms it, and edits
what is wrong. The rule is deliberately conservative:

* a pre-filled unit that a person **did not** edit saves its manual minutes;
* a pre-filled unit that a person **did** edit saves nothing (the person did the work);
* the manual baseline is what typing every pre-filled unit by hand would have cost.

Everything returned is labeled an **estimate**: the per-field minutes are assumptions
anchored to one published data-entry rate (see the table's ``source``), not a measurement.
The function never reads a clock or a database; the API passes the counts.

``estimate`` returns a plain JSON-safe dict (a ``TypedDict``) because CONTRACTS.md R3.1
defines the result as ``{minutes_saved, minutes_manual_baseline, basis[]}`` and the API
returns it as-is from ``GET /metrics/time-saved``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, TypedDict

from .tables import TableError, load_table

TIME_MODEL_TABLE_NAMES: tuple[str, ...] = ("time_model",)
"""The JSON tables this module owns (``tables.TABLE_NAMES`` lists the engine's)."""

_TABLE = "time_model"
_MINUTES_PER_HOUR = 60  # unit conversion, not a clinical number


# --------------------------------------------------------------------------- #
# Table
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Category:
    """One kind of manual work with its minutes per unit."""

    key: str
    minutes_per_unit: float
    unit_singular: str
    unit_plural: str
    basis: str  # "source" | "assumption"
    derivation: str


@dataclass(frozen=True)
class TimeModel:
    categories: Mapping[str, Category]
    aliases: Mapping[str, str]
    countable_fields: Mapping[str, tuple[str, ...]]
    weekly_hours_low: float
    weekly_hours_high: float
    disclaimer: str
    disclaimer_text: str


def _str(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TableError(f"{where}: expected a non-empty string")
    return value


def _num(value: object, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TableError(f"{where}: expected a number")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise TableError(f"{where}: expected a finite number >= 0")
    return number


def _obj(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TableError(f"{where}: expected an object")
    return value


@lru_cache(maxsize=1)
def time_model() -> TimeModel:
    """Load and validate ``time_model.json`` once per process."""
    table = load_table(_TABLE)
    disclaimer = _str(table.get("disclaimer"), "time_model.disclaimer")
    if disclaimer != "estimate":
        raise TableError("time_model.disclaimer: must be 'estimate'")
    categories: dict[str, Category] = {}
    for key, raw in _obj(table.get("categories"), "time_model.categories").items():
        where = f"time_model.categories.{key}"
        entry = _obj(raw, where)
        basis = _str(entry.get("basis"), f"{where}.basis")
        if basis not in ("source", "assumption"):
            raise TableError(f"{where}.basis: must be 'source' or 'assumption'")
        _str(entry.get("source"), f"{where}.source")
        categories[key] = Category(
            key=key,
            minutes_per_unit=_num(entry.get("minutes_per_unit"), f"{where}.minutes_per_unit"),
            unit_singular=_str(entry.get("unit_singular"), f"{where}.unit_singular"),
            unit_plural=_str(entry.get("unit_plural"), f"{where}.unit_plural"),
            basis=basis,
            derivation=_str(entry.get("derivation"), f"{where}.derivation"),
        )
    if not categories:
        raise TableError("time_model.categories: must not be empty")
    aliases: dict[str, str] = {}
    for alias, target in _obj(table.get("aliases", {}), "time_model.aliases").items():
        target_key = _str(target, f"time_model.aliases.{alias}")
        if target_key not in categories:
            raise TableError(f"time_model.aliases.{alias}: unknown category {target_key!r}")
        aliases[alias.upper()] = target_key
    countable: dict[str, tuple[str, ...]] = {}
    raw_countable = _obj(table.get("countable_fields"), "time_model.countable_fields")
    for domain in ("AE", "VS", "CM"):
        names = raw_countable.get(domain)
        if not isinstance(names, list) or not names:
            raise TableError(f"time_model.countable_fields.{domain}: expected a non-empty list")
        countable[domain] = tuple(
            _str(n, f"time_model.countable_fields.{domain}[{i}]") for i, n in enumerate(names)
        )
    weekly = _obj(table.get("weekly_baseline"), "time_model.weekly_baseline")
    low = _num(weekly.get("hours_low"), "time_model.weekly_baseline.hours_low")
    high = _num(weekly.get("hours_high"), "time_model.weekly_baseline.hours_high")
    if low > high:
        raise TableError("time_model.weekly_baseline: hours_low must be <= hours_high")
    return TimeModel(
        categories=categories,
        aliases=aliases,
        countable_fields=countable,
        weekly_hours_low=low,
        weekly_hours_high=high,
        disclaimer=disclaimer,
        disclaimer_text=_str(table.get("disclaimer_text"), "time_model.disclaimer_text"),
    )


# --------------------------------------------------------------------------- #
# Estimate
# --------------------------------------------------------------------------- #


class CategoryBreakdown(TypedDict):
    category: str
    prefilled: int
    edited: int
    saved_units: int
    minutes_per_unit: float
    minutes_saved: float
    minutes_manual_baseline: float
    basis: str


class TimeSavedEstimate(TypedDict):
    minutes_saved: float
    minutes_manual_baseline: float
    basis: list[str]
    breakdown: list[CategoryBreakdown]
    is_estimate: bool
    disclaimer: str


def category_key(name: str) -> str | None:
    """Resolve a caller's category name (case-insensitive, aliases allowed) or ``None``."""
    model = time_model()
    upper = name.strip().upper()
    if upper in model.categories:
        return upper
    return model.aliases.get(upper)


def _count(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{where}: expected a whole number, got {value!r}")
    if value < 0:
        raise ValueError(f"{where}: must not be negative, got {value}")
    return value


def _fmt(minutes: float) -> str:
    """Minutes for a sentence: at most two decimals, no trailing zeros ('0.75', '5', '1.5')."""
    text = f"{minutes:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def _round(minutes: float) -> float:
    """Two decimals: every table rate is a multiple of 0.05 min, so sums stay exact."""
    return round(minutes, 2) + 0.0


def _merge(counts: Mapping[str, int], where: str) -> tuple[dict[str, int], list[str]]:
    """Sum counts per resolved category; return unknown names separately (they earn nothing)."""
    merged: dict[str, int] = {}
    unknown: list[str] = []
    for name, raw in counts.items():
        value = _count(raw, f"{where}[{name!r}]")
        key = category_key(name)
        if key is None:
            if value:
                unknown.append(name)
            continue
        merged[key] = merged.get(key, 0) + value
    return merged, unknown


def estimate(
    prefilled_fields: Mapping[str, int], edited_fields: Mapping[str, int]
) -> TimeSavedEstimate:
    """Estimate coordinator minutes saved from pre-filled and person-edited unit counts.

    ``prefilled_fields`` maps a category (``AE``, ``CM``, ``VS``, ``SAE_FORM``,
    ``NARRATIVE_PARAGRAPH``, ``BRIEF_SECTION``; case-insensitive; aliases such as ``AESI``
    or ``BRIEF`` from the table) to how many units Interim pre-filled from evidence.
    ``edited_fields`` maps the same categories to how many of those pre-filled units a
    person changed. Edited units save nothing; an edited count larger than the pre-filled
    count is capped at it (and said so in ``basis``). Unknown category names earn nothing
    and are listed in ``basis``. Counts must be whole numbers >= 0 (``ValueError``).
    """
    model = time_model()
    prefilled, unknown_pre = _merge(prefilled_fields, "prefilled_fields")
    edited, unknown_edit = _merge(edited_fields, "edited_fields")

    basis: list[str] = []
    breakdown: list[CategoryBreakdown] = []
    total_saved = 0.0
    total_baseline = 0.0
    for key, category in model.categories.items():
        n_pre = prefilled.get(key, 0)
        n_edit_raw = edited.get(key, 0)
        if n_pre == 0 and n_edit_raw == 0:
            continue
        n_edit = min(n_edit_raw, n_pre)
        saved_units = n_pre - n_edit
        minutes = category.minutes_per_unit
        saved = saved_units * minutes
        baseline = n_pre * minutes
        total_saved += saved
        total_baseline += baseline
        assumption = " (assumed rate)" if category.basis == "assumption" else " (sourced rate)"
        line = (
            f"{category.unit_plural}: {n_pre} pre-filled, {n_edit} edited by a person "
            f"(edited ones save nothing), so {saved_units} x {_fmt(minutes)} min = "
            f"{_fmt(saved)} min saved; typing all {n_pre} by hand would take {n_pre} x "
            f"{_fmt(minutes)} min = {_fmt(baseline)} min{assumption}."
        )
        if n_edit_raw > n_pre:
            line += f" {n_edit_raw} edits were reported for {n_pre} pre-filled; counted as {n_pre}."
        basis.append(line[:1].upper() + line[1:])
        breakdown.append(
            CategoryBreakdown(
                category=key,
                prefilled=n_pre,
                edited=n_edit,
                saved_units=saved_units,
                minutes_per_unit=minutes,
                minutes_saved=_round(saved),
                minutes_manual_baseline=_round(baseline),
                basis=category.basis,
            )
        )
    for name in sorted(set(unknown_pre) | set(unknown_edit)):
        basis.append(f"'{name}' is not in the time model, so it counts for no time saved.")

    minutes_saved = _round(total_saved)
    minutes_baseline = _round(total_baseline)
    basis.append(
        f"Total: {_fmt(minutes_saved)} min saved out of {_fmt(minutes_baseline)} min "
        "of manual work (estimate)."
    )
    basis.append(model.disclaimer_text)
    return TimeSavedEstimate(
        minutes_saved=minutes_saved,
        minutes_manual_baseline=minutes_baseline,
        basis=basis,
        breakdown=breakdown,
        is_estimate=True,
        disclaimer=model.disclaimer,
    )


# --------------------------------------------------------------------------- #
# Helpers for the API: counting pre-filled / edited SDTM fields consistently
# --------------------------------------------------------------------------- #


def _is_filled(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list | tuple | dict | set):
        return bool(value)
    return True


def countable_fields(domain: str) -> tuple[str, ...]:
    """The SDTM variables of ``AE`` / ``VS`` / ``CM`` that count toward time saved."""
    fields = time_model().countable_fields.get(domain.strip().upper())
    if fields is None:
        raise ValueError(f"unknown domain {domain!r}; expected AE, VS or CM")
    return fields


def prefilled_count(domain: str, fields: Mapping[str, object]) -> int:
    """How many countable fields of one draft hold a value (pre-filled from evidence)."""
    return sum(1 for name in countable_fields(domain) if _is_filled(fields.get(name)))


def edited_count(
    domain: str, drafted: Mapping[str, object], confirmed: Mapping[str, object]
) -> int:
    """How many countable, pre-filled fields a person changed between draft and confirmation.

    Only fields Interim pre-filled can be "edited"; a field the person filled in from empty
    is their own work and was never counted as pre-filled.
    """
    return sum(
        1
        for name in countable_fields(domain)
        if _is_filled(drafted.get(name)) and drafted.get(name) != confirmed.get(name)
    )


def weekly_baseline_minutes() -> tuple[float, float]:
    """The published 12-15 h per study per week of EHR-to-EDC copying, in minutes."""
    model = time_model()
    return (
        model.weekly_hours_low * _MINUTES_PER_HOUR,
        model.weekly_hours_high * _MINUTES_PER_HOUR,
    )


def weekly_context(minutes_saved: float) -> str:
    """One plain sentence comparing a saving with the published weekly copying burden."""
    if isinstance(minutes_saved, bool) or not isinstance(minutes_saved, int | float):
        raise ValueError(f"minutes_saved: expected a number, got {minutes_saved!r}")
    if not math.isfinite(minutes_saved) or minutes_saved < 0:
        raise ValueError(f"minutes_saved: expected a finite number >= 0, got {minutes_saved}")
    model = time_model()
    low, _ = weekly_baseline_minutes()
    share = 100.0 * minutes_saved / low if low else 0.0
    return (
        f"About {_fmt(_round(minutes_saved))} min saved (estimate); for comparison, coordinators "
        f"report {_fmt(model.weekly_hours_low)}-{_fmt(model.weekly_hours_high)} h per study "
        f"per week copying EHR data into the EDC, so this is about {share:.0f}% of the "
        f"lower figure."
    )


__all__ = [
    "TIME_MODEL_TABLE_NAMES",
    "Category",
    "CategoryBreakdown",
    "TimeModel",
    "TimeSavedEstimate",
    "category_key",
    "countable_fields",
    "edited_count",
    "estimate",
    "prefilled_count",
    "time_model",
    "weekly_baseline_minutes",
    "weekly_context",
]
