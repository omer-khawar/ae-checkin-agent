"""Typed, validated access to the JSON rule tables in ``packages/rules/data``.

Every clinical number the engine uses comes from one of these tables; the
Python modules only read them. Each table carries a top-level ``source`` and
``rationale`` (CONTRACTS.md §1.1) and is validated on first use, so a malformed
table fails loudly instead of silently mis-grading a participant.

Loading is cached per process. The tables are small and immutable at run time.
The data directory is resolved relative to this file: ``<package>/../data``
(the repository layout, used by the editable install) with ``<package>/data``
as the fallback for a wheel / non-editable install, where ``pyproject.toml``
maps the repository's ``data/`` directory to the ``interim_rules.data``
package so the tables ship inside the distribution. A candidate counts only if
it holds the sentinel table, so an unrelated ``data/`` directory that happens
to sit next to the package can never shadow the real one.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache, lru_cache
from pathlib import Path
from typing import Any, cast

from .models import ATTRIBUTES, Attribute

_PACKAGE_DIR = Path(__file__).resolve().parent
_CANDIDATE_DATA_DIRS: tuple[Path, ...] = (_PACKAGE_DIR.parent / "data", _PACKAGE_DIR / "data")
_SENTINEL_TABLE = "proctcae_items.json"
"""A table that must exist in any directory we accept as the data directory."""

TABLE_NAMES: tuple[str, ...] = (
    "proctcae_items",
    "gate_questions",
    "composite_scoring",
    "composite_to_grade",
    "red_flags",
    "vitals_corroboration",
    "escalation_ladder",
    "seriousness",
    "ctcae_terms",
    "medlist",
    "dedup",
    "conmed_matching",
    "rules_catalog",
)
"""Every table this package owns (``personas.json`` is owned by the eval harness)."""


class TableError(ValueError):
    """A rule table is missing or malformed."""


def data_dir() -> Path:
    """Directory holding the JSON tables (the first candidate that contains the sentinel)."""
    for candidate in _CANDIDATE_DATA_DIRS:
        if (candidate / _SENTINEL_TABLE).is_file():
            return candidate
    raise TableError(f"rules data directory not found; looked in {_CANDIDATE_DATA_DIRS}")


@cache
def load_table(name: str) -> dict[str, Any]:
    """Load ``<name>.json`` and check it carries ``source`` and ``rationale``."""
    path = data_dir() / f"{name}.json"
    if not path.is_file():
        raise TableError(f"table not found: {path}")
    with path.open(encoding="utf-8") as fh:
        raw: object = json.load(fh)
    if not isinstance(raw, dict):
        raise TableError(f"{name}.json: top level must be an object")
    table = cast(dict[str, Any], raw)
    for key in ("source", "rationale"):
        value = table.get(key)
        if not isinstance(value, str) or not value.strip():
            raise TableError(f"{name}.json: missing non-empty '{key}'")
    return table


# --------------------------------------------------------------------------- #
# Shape validators (JSON -> typed values with a precise error location)
# --------------------------------------------------------------------------- #


def _as_str(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise TableError(f"{where}: expected string, got {type(value).__name__}")
    return value


def _as_int(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TableError(f"{where}: expected integer, got {type(value).__name__}")
    return value


def _as_number(value: object, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TableError(f"{where}: expected number, got {type(value).__name__}")
    return float(value)


def _as_bool(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise TableError(f"{where}: expected boolean, got {type(value).__name__}")
    return value


def _as_list(value: object, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise TableError(f"{where}: expected list, got {type(value).__name__}")
    return value


def _as_dict(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TableError(f"{where}: expected object, got {type(value).__name__}")
    return cast(dict[str, Any], value)


def _as_attribute(value: object, where: str) -> Attribute:
    text = _as_str(value, where)
    if text not in ATTRIBUTES:
        raise TableError(f"{where}: unknown attribute {text!r}")
    return text


def _int_keyed(value: object, where: str) -> dict[int, int]:
    out: dict[int, int] = {}
    for key, item in _as_dict(value, where).items():
        try:
            int_key = int(key)
        except ValueError as exc:
            raise TableError(f"{where}: key {key!r} is not an integer") from exc
        out[int_key] = _as_int(item, f"{where}[{key}]")
    return out


# --------------------------------------------------------------------------- #
# proctcae_items.json / gate_questions.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ItemDef:
    """One check-in item: what is asked, which attributes, and how answers map to integers."""

    id: str
    order: int
    label: str
    short_label: str
    ctcae_term: str
    attributes: tuple[Attribute, ...]
    prompts: Mapping[str, str]
    response_options: Mapping[str, Mapping[str, int]]
    recall_window: str
    optional_gate_fields: tuple[str, ...]
    """Gate fields (e.g. ``temp_c``) that belong with this item as evidence only."""

    def has(self, attribute: str) -> bool:
        return attribute in self.attributes

    def max_value(self, attribute: Attribute) -> int:
        return max(self.response_options[attribute].values())

    def option_label(self, attribute: Attribute, value: int) -> str | None:
        """The response label for an integer value, e.g. ``2 -> "Moderate"``."""
        for label, mapped in self.response_options.get(attribute, {}).items():
            if mapped == value:
                return label
        return None


@lru_cache(maxsize=1)
def items() -> tuple[ItemDef, ...]:
    """The shipped items in display order."""
    table = load_table("proctcae_items")
    out: list[ItemDef] = []
    for idx, raw in enumerate(_as_list(table.get("items"), "proctcae_items.items")):
        where = f"proctcae_items.items[{idx}]"
        entry = _as_dict(raw, where)
        attributes = tuple(
            _as_attribute(a, f"{where}.attributes")
            for a in _as_list(entry.get("attributes"), where)
        )
        if not attributes or len(set(attributes)) != len(attributes):
            raise TableError(f"{where}: attributes must be a non-empty set")
        prompts = {
            key: _as_str(val, f"{where}.prompts.{key}")
            for key, val in _as_dict(entry.get("prompts"), f"{where}.prompts").items()
        }
        options: dict[str, Mapping[str, int]] = {}
        raw_options = _as_dict(entry.get("response_options"), f"{where}.response_options")
        for attr, opts in raw_options.items():
            options[attr] = {
                label: _as_int(v, f"{where}.response_options.{attr}.{label}")
                for label, v in _as_dict(opts, f"{where}.response_options.{attr}").items()
            }
        for attr in attributes:
            if attr not in options or attr not in prompts:
                raise TableError(f"{where}: attribute {attr!r} needs prompts and response_options")
            if min(options[attr].values()) != 0:
                raise TableError(f"{where}: response_options.{attr} must start at 0")
        optional_fields = tuple(
            _as_str(
                _as_dict(f, f"{where}.optional_fields").get("id"), f"{where}.optional_fields.id"
            )
            for f in _as_list(entry.get("optional_fields", []), f"{where}.optional_fields")
        )
        out.append(
            ItemDef(
                id=_as_str(entry.get("id"), f"{where}.id"),
                order=_as_int(entry.get("order"), f"{where}.order"),
                label=_as_str(entry.get("label"), f"{where}.label"),
                short_label=_as_str(entry.get("short_label"), f"{where}.short_label"),
                ctcae_term=_as_str(entry.get("ctcae_term"), f"{where}.ctcae_term"),
                attributes=attributes,
                prompts=prompts,
                response_options=options,
                recall_window=_as_str(entry.get("recall_window"), f"{where}.recall_window"),
                optional_gate_fields=optional_fields,
            )
        )
    out.sort(key=lambda item: item.order)
    ids = [item.id for item in out]
    if len(set(ids)) != len(ids):
        raise TableError("proctcae_items: duplicate item ids")
    return tuple(out)


@lru_cache(maxsize=1)
def item_map() -> Mapping[str, ItemDef]:
    return {item.id: item for item in items()}


def item_by_id(item_id: str) -> ItemDef:
    try:
        return item_map()[item_id]
    except KeyError as exc:
        raise ValueError(f"unknown item_id {item_id!r}") from exc


def recall_window() -> str:
    return _as_str(
        load_table("proctcae_items").get("recall_window"), "proctcae_items.recall_window"
    )


@dataclass(frozen=True)
class GateQuestion:
    """One of the three gate questions, with its full table row available as ``raw``."""

    id: str
    order: int
    type: str
    field: str
    label: str
    raw: Mapping[str, Any]


@lru_cache(maxsize=1)
def gate_questions() -> tuple[GateQuestion, ...]:
    table = load_table("gate_questions")
    out: list[GateQuestion] = []
    for idx, raw in enumerate(_as_list(table.get("questions"), "gate_questions.questions")):
        where = f"gate_questions.questions[{idx}]"
        entry = _as_dict(raw, where)
        out.append(
            GateQuestion(
                id=_as_str(entry.get("id"), f"{where}.id"),
                order=_as_int(entry.get("order"), f"{where}.order"),
                type=_as_str(entry.get("type"), f"{where}.type"),
                field=_as_str(entry.get("field"), f"{where}.field"),
                label=_as_str(entry.get("label"), f"{where}.label"),
                raw=entry,
            )
        )
    return tuple(sorted(out, key=lambda q: q.order))


# --------------------------------------------------------------------------- #
# composite_scoring.json / composite_to_grade.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class CompositeTables:
    """The Basch et al. 2021 lookup tables, keyed by attribute values in table order."""

    three: Mapping[tuple[int, ...], int]
    freq_sev: Mapping[tuple[int, ...], int]
    sev_int: Mapping[tuple[int, ...], int]
    freq_int: Mapping[tuple[int, ...], int]
    single: Mapping[Attribute, Mapping[int, int]]
    presence: Mapping[int, int]
    zero_gate: Mapping[str, Attribute]
    reproduced_verbatim: bool


def _rows_to_map(rows: object, keys: tuple[str, ...], where: str) -> dict[tuple[int, ...], int]:
    out: dict[tuple[int, ...], int] = {}
    for idx, raw in enumerate(_as_list(rows, where)):
        row = _as_dict(raw, f"{where}[{idx}]")
        key = tuple(_as_int(row.get(k), f"{where}[{idx}].{k}") for k in keys)
        if key in out:
            raise TableError(f"{where}[{idx}]: duplicate row for {key}")
        out[key] = _as_int(row.get("composite"), f"{where}[{idx}].composite")
    return out


@lru_cache(maxsize=1)
def composite_tables() -> CompositeTables:
    table = load_table("composite_scoring")
    single: dict[Attribute, Mapping[int, int]] = {}
    for attr, mapping in _as_dict(
        table.get("single_attribute_by_attribute"),
        "composite_scoring.single_attribute_by_attribute",
    ).items():
        single[_as_attribute(attr, "composite_scoring.single_attribute_by_attribute")] = _int_keyed(
            mapping, f"composite_scoring.single_attribute_by_attribute.{attr}"
        )
    generic_single = _int_keyed(table.get("single_attribute"), "composite_scoring.single_attribute")
    if single.get("severity") != generic_single:
        raise TableError("composite_scoring: single_attribute must equal the severity-only mapping")
    zero_gate = {
        key: _as_attribute(val, f"composite_scoring.zero_gate.{key}")
        for key, val in _as_dict(table.get("zero_gate"), "composite_scoring.zero_gate").items()
    }
    return CompositeTables(
        three=_rows_to_map(
            table.get("three_attribute"),
            ("frequency", "severity", "interference"),
            "composite_scoring.three_attribute",
        ),
        freq_sev=_rows_to_map(
            table.get("two_attribute_freq_sev"),
            ("frequency", "severity"),
            "composite_scoring.two_attribute_freq_sev",
        ),
        sev_int=_rows_to_map(
            table.get("two_attribute_sev_int"),
            ("severity", "interference"),
            "composite_scoring.two_attribute_sev_int",
        ),
        freq_int=_rows_to_map(
            table.get("two_attribute_freq_int"),
            ("frequency", "interference"),
            "composite_scoring.two_attribute_freq_int",
        ),
        single=single,
        presence=_int_keyed(table.get("presence"), "composite_scoring.presence"),
        zero_gate=zero_gate,
        reproduced_verbatim=_as_bool(
            table.get("reproduced_verbatim"), "composite_scoring.reproduced_verbatim"
        ),
    )


@dataclass(frozen=True)
class GradeMap:
    map: Mapping[int, int]
    max_assignable_grade: int
    grade_label: str


@lru_cache(maxsize=1)
def grade_map() -> GradeMap:
    table = load_table("composite_to_grade")
    return GradeMap(
        map=_int_keyed(table.get("map"), "composite_to_grade.map"),
        max_assignable_grade=_as_int(
            table.get("max_assignable_grade"), "composite_to_grade.max_assignable_grade"
        ),
        grade_label=_as_str(table.get("grade_label"), "composite_to_grade.grade_label"),
    )


# --------------------------------------------------------------------------- #
# red_flags.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class SevereItemDefinition:
    severity_attribute_min: int
    no_severity_attribute_composite_min: int


@dataclass(frozen=True)
class RedFlagRule:
    id: str
    description: str
    condition: Mapping[str, Any]
    tier_floor: int
    seriousness: bool
    effect: str


@dataclass(frozen=True)
class RedFlagTable:
    severe_item: SevereItemDefinition
    rules: tuple[RedFlagRule, ...]


@lru_cache(maxsize=1)
def red_flag_table() -> RedFlagTable:
    table = load_table("red_flags")
    severe = _as_dict(table.get("severe_item_definition"), "red_flags.severe_item_definition")
    rules: list[RedFlagRule] = []
    for idx, raw in enumerate(_as_list(table.get("rules"), "red_flags.rules")):
        where = f"red_flags.rules[{idx}]"
        entry = _as_dict(raw, where)
        rules.append(
            RedFlagRule(
                id=_as_str(entry.get("id"), f"{where}.id"),
                description=_as_str(entry.get("description"), f"{where}.description"),
                condition=_as_dict(entry.get("condition"), f"{where}.condition"),
                tier_floor=_as_int(entry.get("tier_floor"), f"{where}.tier_floor"),
                seriousness=_as_bool(entry.get("seriousness"), f"{where}.seriousness"),
                effect=_as_str(entry.get("effect"), f"{where}.effect"),
            )
        )
    return RedFlagTable(
        severe_item=SevereItemDefinition(
            severity_attribute_min=_as_int(
                severe.get("severity_attribute_min"),
                "red_flags.severe_item_definition.severity_attribute_min",
            ),
            no_severity_attribute_composite_min=_as_int(
                severe.get("no_severity_attribute_composite_min"),
                "red_flags.severe_item_definition.no_severity_attribute_composite_min",
            ),
        ),
        rules=tuple(rules),
    )


# --------------------------------------------------------------------------- #
# vitals_corroboration.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Bounds:
    min: float
    max: float
    unit: str

    def contains(self, value: float) -> bool:
        return self.min <= value <= self.max


@dataclass(frozen=True)
class CorroborationRule:
    id: str
    description: str
    condition: Mapping[str, Any]
    reason: str
    tier_bump: int


@dataclass(frozen=True)
class VitalsConfig:
    min_confidence: float
    plausibility: Mapping[str, Bounds]
    """Keyed by metric (``pulse``, ``breathing``); a metric without bounds is never implausible."""
    min_window_s: Mapping[str, float]
    """Minimum averaging window per metric (``pulse``, ``breathing``, ``hrv``) for a reading to
    count; a metric missing here has no window requirement."""
    simulated_sources: tuple[str, ...]
    """Source names that are simulated by definition (``mock``), whatever ``is_measured`` says."""
    max_tier_bump: int
    method_measured: str
    method_simulated: str
    rules: tuple[CorroborationRule, ...]


@lru_cache(maxsize=1)
def vitals_config() -> VitalsConfig:
    table = load_table("vitals_corroboration")
    bounds: dict[str, Bounds] = {}
    raw_bounds = _as_dict(table.get("plausibility"), "vitals_corroboration.plausibility")
    for key, raw in raw_bounds.items():
        where = f"vitals_corroboration.plausibility.{key}"
        entry = _as_dict(raw, where)
        metric = key.removesuffix("_bpm")
        bounds[metric] = Bounds(
            min=_as_number(entry.get("min"), f"{where}.min"),
            max=_as_number(entry.get("max"), f"{where}.max"),
            unit=_as_str(entry.get("unit"), f"{where}.unit"),
        )
    min_window: dict[str, float] = {}
    for metric, raw_window in _as_dict(
        table.get("min_window_s"), "vitals_corroboration.min_window_s"
    ).items():
        seconds = _as_number(raw_window, f"vitals_corroboration.min_window_s.{metric}")
        if seconds <= 0:
            raise TableError(f"vitals_corroboration.min_window_s.{metric}: must be positive")
        min_window[metric] = seconds
    simulated_sources = tuple(
        _as_str(s, "vitals_corroboration.simulated_sources")
        for s in _as_list(table.get("simulated_sources"), "vitals_corroboration.simulated_sources")
    )
    labels = _as_dict(table.get("method_labels"), "vitals_corroboration.method_labels")
    rules: list[CorroborationRule] = []
    for idx, raw in enumerate(_as_list(table.get("rules"), "vitals_corroboration.rules")):
        where = f"vitals_corroboration.rules[{idx}]"
        entry = _as_dict(raw, where)
        rules.append(
            CorroborationRule(
                id=_as_str(entry.get("id"), f"{where}.id"),
                description=_as_str(entry.get("description"), f"{where}.description"),
                condition=_as_dict(entry.get("condition"), f"{where}.condition"),
                reason=_as_str(entry.get("reason"), f"{where}.reason"),
                tier_bump=_as_int(entry.get("tier_bump"), f"{where}.tier_bump"),
            )
        )
    return VitalsConfig(
        min_confidence=_as_number(
            table.get("min_confidence"), "vitals_corroboration.min_confidence"
        ),
        plausibility=bounds,
        min_window_s=min_window,
        simulated_sources=simulated_sources,
        max_tier_bump=_as_int(table.get("max_tier_bump"), "vitals_corroboration.max_tier_bump"),
        method_measured=_as_str(
            labels.get("measured"), "vitals_corroboration.method_labels.measured"
        ),
        method_simulated=_as_str(
            labels.get("simulated"), "vitals_corroboration.method_labels.simulated"
        ),
        rules=tuple(rules),
    )


# --------------------------------------------------------------------------- #
# escalation_ladder.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class TierDef:
    tier: int
    name: str
    action: str
    sla: str
    triggers: tuple[str, ...]
    stop_screen: bool
    page_oncall: bool
    stop_screen_text: str | None


@dataclass(frozen=True)
class EscalationLadder:
    base_tier_by_max_grade: Mapping[int, int]
    max_tier: int
    tiers: Mapping[int, TierDef]


@lru_cache(maxsize=1)
def escalation_ladder() -> EscalationLadder:
    table = load_table("escalation_ladder")
    tiers: dict[int, TierDef] = {}
    for idx, raw in enumerate(_as_list(table.get("tiers"), "escalation_ladder.tiers")):
        where = f"escalation_ladder.tiers[{idx}]"
        entry = _as_dict(raw, where)
        text = entry.get("stop_screen_text")
        tier = TierDef(
            tier=_as_int(entry.get("tier"), f"{where}.tier"),
            name=_as_str(entry.get("name"), f"{where}.name"),
            action=_as_str(entry.get("action"), f"{where}.action"),
            sla=_as_str(entry.get("sla"), f"{where}.sla"),
            triggers=tuple(
                _as_str(t, f"{where}.triggers") for t in _as_list(entry.get("triggers"), where)
            ),
            stop_screen=_as_bool(entry.get("stop_screen"), f"{where}.stop_screen"),
            page_oncall=_as_bool(entry.get("page_oncall"), f"{where}.page_oncall"),
            stop_screen_text=None if text is None else _as_str(text, f"{where}.stop_screen_text"),
        )
        if tier.stop_screen and not tier.stop_screen_text:
            raise TableError(f"{where}: stop_screen tiers need stop_screen_text")
        tiers[tier.tier] = tier
    max_tier = _as_int(table.get("max_tier"), "escalation_ladder.max_tier")
    for level in range(max_tier + 1):
        if level not in tiers:
            raise TableError(f"escalation_ladder: tier {level} is not defined")
    return EscalationLadder(
        base_tier_by_max_grade=_int_keyed(
            table.get("base_tier_by_max_grade"), "escalation_ladder.base_tier_by_max_grade"
        ),
        max_tier=max_tier,
        tiers=tiers,
    )


# --------------------------------------------------------------------------- #
# seriousness.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class SeriousnessConfig:
    criteria: tuple[str, ...]
    trigger_gates: tuple[str, ...]
    site_to_sponsor_hours: float
    fatal_or_life_threatening_days: int
    other_serious_days: int
    sponsor_clock_source: str


@lru_cache(maxsize=1)
def seriousness_config() -> SeriousnessConfig:
    table = load_table("seriousness")
    sponsor = _as_dict(
        table.get("informational_sponsor_clocks"), "seriousness.informational_sponsor_clocks"
    )
    triggers = tuple(
        _as_str(_as_dict(t, "seriousness.triggers").get("gate"), "seriousness.triggers.gate")
        for t in _as_list(table.get("triggers"), "seriousness.triggers")
    )
    return SeriousnessConfig(
        criteria=tuple(
            _as_str(c, "seriousness.criteria") for c in _as_list(table.get("criteria"), "criteria")
        ),
        trigger_gates=triggers,
        site_to_sponsor_hours=_as_number(
            table.get("site_to_sponsor_hours"), "seriousness.site_to_sponsor_hours"
        ),
        fatal_or_life_threatening_days=_as_int(
            sponsor.get("fatal_or_life_threatening_days"),
            "seriousness.informational_sponsor_clocks.fatal_or_life_threatening_days",
        ),
        other_serious_days=_as_int(
            sponsor.get("other_serious_days"),
            "seriousness.informational_sponsor_clocks.other_serious_days",
        ),
        sponsor_clock_source=_as_str(
            sponsor.get("source"), "seriousness.informational_sponsor_clocks.source"
        ),
    )


# --------------------------------------------------------------------------- #
# ctcae_terms.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class CtcaeTerm:
    item_id: str
    aedecod: str
    meddra_code_mock: str
    meddra_soc: str
    definition: str | None
    grade_definitions: Mapping[int, str | None]
    note: str | None


@lru_cache(maxsize=1)
def ctcae_terms() -> Mapping[str, CtcaeTerm]:
    """CTCAE term rows keyed by item id."""
    table = load_table("ctcae_terms")
    out: dict[str, CtcaeTerm] = {}
    for idx, raw in enumerate(_as_list(table.get("terms"), "ctcae_terms.terms")):
        where = f"ctcae_terms.terms[{idx}]"
        entry = _as_dict(raw, where)
        grades: dict[int, str | None] = {}
        for key, text in _as_dict(
            entry.get("grade_definitions"), f"{where}.grade_definitions"
        ).items():
            grades[int(key)] = None if text is None else _as_str(text, f"{where}.grade_definitions")
        definition = entry.get("definition")
        note = entry.get("note")
        term = CtcaeTerm(
            item_id=_as_str(entry.get("item_id"), f"{where}.item_id"),
            aedecod=_as_str(entry.get("aedecod"), f"{where}.aedecod"),
            meddra_code_mock=_as_str(entry.get("meddra_code_mock"), f"{where}.meddra_code_mock"),
            meddra_soc=_as_str(entry.get("meddra_soc"), f"{where}.meddra_soc"),
            definition=None if definition is None else _as_str(definition, f"{where}.definition"),
            grade_definitions=grades,
            note=None if note is None else _as_str(note, f"{where}.note"),
        )
        out[term.item_id] = term
    return out


def ctcae_term_for_item(item_id: str) -> CtcaeTerm:
    try:
        return ctcae_terms()[item_id]
    except KeyError as exc:
        raise TableError(f"ctcae_terms.json has no row for item {item_id!r}") from exc


# --------------------------------------------------------------------------- #
# medlist.json / conmed_matching.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class MedEntry:
    name: str
    kind: str
    generic: str


@dataclass(frozen=True)
class MedList:
    entries: tuple[MedEntry, ...]
    is_rxnorm: bool
    built_at: str
    source: str


@lru_cache(maxsize=1)
def medlist() -> MedList:
    table = load_table("medlist")
    entries: list[MedEntry] = []
    seen: set[str] = set()
    for idx, raw in enumerate(_as_list(table.get("entries"), "medlist.entries")):
        where = f"medlist.entries[{idx}]"
        entry = _as_dict(raw, where)
        name = _as_str(entry.get("name"), f"{where}.name").strip()
        if not name or name != name.lower():
            raise TableError(f"{where}: names must be non-empty and lowercase")
        if name in seen:
            raise TableError(f"{where}: duplicate name {name!r}")
        seen.add(name)
        entries.append(
            MedEntry(
                name=name,
                kind=_as_str(entry.get("kind"), f"{where}.kind"),
                generic=_as_str(entry.get("generic"), f"{where}.generic").strip().lower(),
            )
        )
    return MedList(
        entries=tuple(entries),
        is_rxnorm=_as_bool(table.get("is_rxnorm"), "medlist.is_rxnorm"),
        built_at=_as_str(table.get("built_at"), "medlist.built_at"),
        source=_as_str(table.get("source"), "medlist.source"),
    )


@dataclass(frozen=True)
class ConMedMatchingConfig:
    max_levenshtein_distance: int
    min_token_length: int
    min_levenshtein_confidence: float
    """A Levenshtein match below this confidence is reported as unmatched (candidates kept)."""
    top_candidates: int


@lru_cache(maxsize=1)
def conmed_matching_config() -> ConMedMatchingConfig:
    table = load_table("conmed_matching")
    floor = _as_number(
        table.get("min_levenshtein_confidence"), "conmed_matching.min_levenshtein_confidence"
    )
    if not 0.0 <= floor <= 1.0:
        raise TableError("conmed_matching.min_levenshtein_confidence: must be within 0..1")
    return ConMedMatchingConfig(
        max_levenshtein_distance=_as_int(
            table.get("max_levenshtein_distance"), "conmed_matching.max_levenshtein_distance"
        ),
        min_token_length=_as_int(table.get("min_token_length"), "conmed_matching.min_token_length"),
        min_levenshtein_confidence=floor,
        top_candidates=_as_int(table.get("top_candidates"), "conmed_matching.top_candidates"),
    )


# --------------------------------------------------------------------------- #
# dedup.json / rules_catalog.json
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class DedupConfig:
    window_days: int
    max_future_skew_s: float
    """How far after ``completed_at`` an open AE's last report may be dated and still count
    (clock skew tolerance); anything later is skipped with a logged reason."""


@lru_cache(maxsize=1)
def dedup_config() -> DedupConfig:
    table = load_table("dedup")
    window_days = _as_int(table.get("window_days"), "dedup.window_days")
    skew = _as_number(table.get("max_future_skew_s"), "dedup.max_future_skew_s")
    if skew < 0:
        raise TableError("dedup.max_future_skew_s: must not be negative")
    return DedupConfig(window_days=window_days, max_future_skew_s=skew)


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    category: str
    description_template: str


@lru_cache(maxsize=1)
def rules_catalog() -> Mapping[str, CatalogEntry]:
    table = load_table("rules_catalog")
    out: dict[str, CatalogEntry] = {}
    for idx, raw in enumerate(_as_list(table.get("rules"), "rules_catalog.rules")):
        where = f"rules_catalog.rules[{idx}]"
        entry = _as_dict(raw, where)
        rule = CatalogEntry(
            id=_as_str(entry.get("id"), f"{where}.id"),
            category=_as_str(entry.get("category"), f"{where}.category"),
            description_template=_as_str(
                entry.get("description_template"), f"{where}.description_template"
            ),
        )
        if rule.id in out:
            raise TableError(f"{where}: duplicate rule id {rule.id!r}")
        out[rule.id] = rule
    return out
