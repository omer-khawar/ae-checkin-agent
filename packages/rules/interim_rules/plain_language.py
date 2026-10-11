"""Plain-language labels and rule sentences (CLAUDE.md §00, CONTRACTS.md R3.1).

The dashboard leads with plain words for non-clinicians ("Severity grade (provisional)")
and keeps SDTM variable names and rule ids one click deeper. Everything here is read from
``data/plain_language.json``; this module only looks values up and fills templates.

Template filling is deliberately small and safe:

* placeholders are ``{name}`` where ``name`` is a key of the rule's ``inputs`` (dots allowed,
  e.g. ``{shortness_of_breath.composite}``); there is no attribute or index access, so a
  template can never reach into Python objects (no ``str.format``);
* a placeholder may also be filled from the alternate input names in ``input_aliases``;
* values are rendered plainly (``True`` -> ``yes``, ``2.0`` -> ``2``, lists comma-joined,
  long strings shortened); ``None``, empty strings, non-finite numbers and nested objects
  count as missing;
* if any placeholder is missing, the rule's ``fallback`` sentence (which has no
  placeholders) is returned instead, so a missing input never crashes and never leaves a
  half-filled sentence;
* a rule may list ``variants``: ``{"when": {"input", "op", "value"}, "sentence"}`` tried in
  order before the main sentence, compared on the raw numeric input (``op`` is one of
  ``eq``/``lt``/``lte``/``gt``/``gte``). E.g. the dedup sentence says "earlier today" rather
  than "0 days ago".
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from .tables import TableError, item_map, load_table

PLAIN_LANGUAGE_TABLE_NAMES: tuple[str, ...] = ("plain_language",)
"""The JSON tables this module owns (``tables.TABLE_NAMES`` lists the engine's)."""

_TABLE = "plain_language"
_PLACEHOLDER = re.compile(r"\{([A-Za-z0-9_.]+)\}")
_RENDER_KINDS = ("field_label", "item_label")
"""How ``render_as`` may present an input's values (SDTM name / item id -> plain label)."""
_MAX_VALUE_CHARS = 160
"""Longest rendered input value; longer text (e.g. a chart-note quote) is shortened."""


_VARIANT_OPS: dict[str, Any] = {
    "eq": lambda a, b: a == b,
    "lt": lambda a, b: a < b,
    "lte": lambda a, b: a <= b,
    "gt": lambda a, b: a > b,
    "gte": lambda a, b: a >= b,
}


@dataclass(frozen=True)
class RuleVariant:
    """An alternate sentence used when one numeric input meets a condition."""

    input: str
    op: str
    value: float
    sentence: str
    placeholders: tuple[str, ...]


@dataclass(frozen=True)
class RuleText:
    sentence: str
    fallback: str
    placeholders: tuple[str, ...]
    variants: tuple[RuleVariant, ...] = ()


@dataclass(frozen=True)
class ClockKind:
    name: str
    section: str
    printed_page: int
    note: str


@dataclass(frozen=True)
class PlainLanguage:
    fields: Mapping[str, str]
    field_domains: Mapping[str, tuple[str, ...]]
    rules: Mapping[str, RuleText]
    aliases: Mapping[str, tuple[str, ...]]
    render_as: Mapping[str, str]
    tiers: Mapping[int, str]
    grades: Mapping[int, str]
    clock_kinds: Mapping[str, ClockKind]
    evidence_kinds: Mapping[str, str]
    domains: Mapping[str, str]


# --------------------------------------------------------------------------- #
# Table loading and validation
# --------------------------------------------------------------------------- #


def _str(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TableError(f"{where}: expected a non-empty string")
    return value


def _obj(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TableError(f"{where}: expected an object")
    return value


def _str_map(value: object, where: str) -> dict[str, str]:
    return {k: _str(v, f"{where}.{k}") for k, v in _obj(value, where).items()}


def _int_map(value: object, where: str) -> dict[int, str]:
    out: dict[int, str] = {}
    for key, text in _str_map(value, where).items():
        if not key.isdigit():
            raise TableError(f"{where}.{key}: keys must be whole numbers")
        out[int(key)] = text
    return out


def _check_braces(text: str, where: str) -> None:
    """Only well-formed ``{name}`` placeholders may contain braces."""
    stripped = _PLACEHOLDER.sub("", text)
    if "{" in stripped or "}" in stripped:
        raise TableError(f"{where}: malformed placeholder in {text!r}")


def _variants(value: object, where: str) -> tuple[RuleVariant, ...]:
    if not isinstance(value, list):
        raise TableError(f"{where}: expected a list")
    out: list[RuleVariant] = []
    for i, raw in enumerate(value):
        w = f"{where}[{i}]"
        entry = _obj(raw, w)
        when = _obj(entry.get("when"), f"{w}.when")
        op = _str(when.get("op"), f"{w}.when.op")
        if op not in _VARIANT_OPS:
            raise TableError(f"{w}.when.op: expected one of {', '.join(_VARIANT_OPS)}")
        number = when.get("value")
        if isinstance(number, bool) or not isinstance(number, int | float):
            raise TableError(f"{w}.when.value: expected a number")
        sentence = _str(entry.get("sentence"), f"{w}.sentence")
        _check_braces(sentence, f"{w}.sentence")
        out.append(
            RuleVariant(
                input=_str(when.get("input"), f"{w}.when.input"),
                op=op,
                value=float(number),
                sentence=sentence,
                placeholders=tuple(_PLACEHOLDER.findall(sentence)),
            )
        )
    return tuple(out)


@lru_cache(maxsize=1)
def plain_language() -> PlainLanguage:
    """Load and validate ``plain_language.json`` once per process."""
    table = load_table(_TABLE)

    fields: dict[str, str] = {}
    field_domains: dict[str, tuple[str, ...]] = {}
    for name, raw in _obj(table.get("fields"), "plain_language.fields").items():
        where = f"plain_language.fields.{name}"
        entry = _obj(raw, where)
        fields[name] = _str(entry.get("label"), f"{where}.label")
        domains = entry.get("domains", [])
        if not isinstance(domains, list):
            raise TableError(f"{where}.domains: expected a list")
        field_domains[name] = tuple(_str(d, f"{where}.domains") for d in domains)

    rules: dict[str, RuleText] = {}
    for rule_id, raw in _obj(table.get("rules"), "plain_language.rules").items():
        where = f"plain_language.rules.{rule_id}"
        entry = _obj(raw, where)
        sentence = _str(entry.get("sentence"), f"{where}.sentence")
        fallback = _str(entry.get("fallback"), f"{where}.fallback")
        _check_braces(sentence, f"{where}.sentence")
        if "{" in fallback or "}" in fallback:
            raise TableError(f"{where}.fallback: must not contain placeholders")
        rules[rule_id] = RuleText(
            sentence=sentence,
            fallback=fallback,
            placeholders=tuple(_PLACEHOLDER.findall(sentence)),
            variants=_variants(entry.get("variants", []), f"{where}.variants"),
        )

    aliases: dict[str, tuple[str, ...]] = {}
    for name, raw in _obj(table.get("input_aliases", {}), "plain_language.input_aliases").items():
        if not isinstance(raw, list):
            raise TableError(f"plain_language.input_aliases.{name}: expected a list")
        aliases[name] = tuple(_str(a, f"plain_language.input_aliases.{name}") for a in raw)

    render_as = _str_map(table.get("render_as", {}), "plain_language.render_as")
    for name, kind in render_as.items():
        if kind not in _RENDER_KINDS:
            raise TableError(f"plain_language.render_as.{name}: must be one of {_RENDER_KINDS}")

    clocks: dict[str, ClockKind] = {}
    for kind, raw in _obj(table.get("clock_kinds"), "plain_language.clock_kinds").items():
        where = f"plain_language.clock_kinds.{kind}"
        entry = _obj(raw, where)
        ref = _obj(entry.get("protocol_ref"), f"{where}.protocol_ref")
        page = ref.get("printed_page")
        if isinstance(page, bool) or not isinstance(page, int):
            raise TableError(f"{where}.protocol_ref.printed_page: expected an integer")
        clocks[kind] = ClockKind(
            name=_str(entry.get("name"), f"{where}.name"),
            section=_str(ref.get("section"), f"{where}.protocol_ref.section"),
            printed_page=page,
            note=_str(entry.get("note"), f"{where}.note"),
        )

    return PlainLanguage(
        fields=fields,
        field_domains=field_domains,
        rules=rules,
        aliases=aliases,
        render_as=render_as,
        tiers=_int_map(table.get("tiers"), "plain_language.tiers"),
        grades=_int_map(table.get("grades"), "plain_language.grades"),
        clock_kinds=clocks,
        evidence_kinds=_str_map(table.get("evidence_kinds"), "plain_language.evidence_kinds"),
        domains=_str_map(table.get("domains"), "plain_language.domains"),
    )


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #


def has_label(field: str) -> bool:
    """True when the table has a plain label for this SDTM / INTERIM_* variable."""
    return field in plain_language().fields


def label(field: str) -> str:
    """Plain label for an SDTM or ``INTERIM_*`` variable; an unknown name is returned as-is."""
    return plain_language().fields.get(field, field)


def field_labels(fields: Iterable[str]) -> dict[str, str]:
    """``{field: plain label}`` for every given name (the API's ``labels`` payload)."""
    return {name: label(name) for name in fields}


def tier_name(tier: int) -> str:
    """Plain name of an escalation tier 0..3 (``ValueError`` otherwise)."""
    if isinstance(tier, bool) or not isinstance(tier, int):
        raise ValueError(f"tier must be an integer, got {tier!r}")
    name = plain_language().tiers.get(tier)
    if name is None:
        raise ValueError(f"unknown tier {tier}; expected one of {sorted(plain_language().tiers)}")
    return name


def grade_label(grade: int) -> str:
    """'moderate (grade 2, provisional, investigator to confirm)'; 0 -> 'none reported'."""
    if isinstance(grade, bool) or not isinstance(grade, int):
        raise ValueError(f"grade must be an integer, got {grade!r}")
    word = plain_language().grades.get(grade)
    if word is None:
        raise ValueError(f"unknown grade {grade}; Interim assigns grades 0 to 3 only")
    if grade == 0:
        return word
    return f"{word} (grade {grade}, provisional, investigator to confirm)"


def clock_name(kind: str) -> str:
    """'Serious event report due' (``sae``) / 'Special-interest event report due' (``aesi``)."""
    clock = plain_language().clock_kinds.get(kind)
    if clock is None:
        raise ValueError(f"unknown clock kind {kind!r}; expected 'sae' or 'aesi'")
    return clock.name


def clock_kind(kind: str) -> ClockKind:
    """Full clock entry: plain name, protocol section and printed page, and a note."""
    clock = plain_language().clock_kinds.get(kind)
    if clock is None:
        raise ValueError(f"unknown clock kind {kind!r}; expected 'sae' or 'aesi'")
    return clock


def evidence_kind_name(kind: str) -> str:
    """Plain name of an evidence kind; an unknown kind is returned as-is."""
    return plain_language().evidence_kinds.get(kind, kind)


def domain_name(domain: str) -> str:
    """'Side effect' / 'Vital signs' / 'Medication change'; an unknown domain as-is."""
    return plain_language().domains.get(domain, domain)


def rule_ids() -> frozenset[str]:
    """Every rule id that has a plain sentence."""
    return frozenset(plain_language().rules)


# --------------------------------------------------------------------------- #
# Rule sentences
# --------------------------------------------------------------------------- #


def _render(value: object) -> str | None:
    """A value as plain text, or ``None`` when it counts as missing."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        if value.is_integer():
            return str(int(value))
        return f"{value:.2f}".rstrip("0").rstrip(".")
    if isinstance(value, str):
        text = " ".join(value.split())
        if not text:
            return None
        if len(text) > _MAX_VALUE_CHARS:
            text = text[: _MAX_VALUE_CHARS - 3].rstrip() + "..."
        return text
    if isinstance(value, list | tuple):
        parts = [p for p in (_render(v) for v in value) if p is not None]
        return ", ".join(parts) if parts else "none"
    return None


def _as_labels(value: object, kind: str) -> object:
    """Replace SDTM names / item ids with plain labels (strings only; others unchanged)."""
    if kind == "field_label":
        fields = plain_language().fields

        def convert(v: object) -> object:
            return fields.get(v, v) if isinstance(v, str) else v
    else:
        items = item_map()

        def convert(v: object) -> object:
            return items[v].label if isinstance(v, str) and v in items else v

    if isinstance(value, list | tuple):
        return [convert(v) for v in value]
    return convert(value)


def _lookup(
    name: str, inputs: Mapping[str, object], aliases: Mapping[str, tuple[str, ...]]
) -> str | None:
    table = plain_language()
    for key in (name, *aliases.get(name, ())):
        if key in inputs:
            value = inputs[key]
            kind = table.render_as.get(name)
            if kind is not None:
                value = _as_labels(value, kind)
            rendered = _render(value)
            if rendered is not None:
                return rendered
    return None


def _variant_applies(
    variant: RuleVariant, inputs: Mapping[str, object], aliases: Mapping[str, tuple[str, ...]]
) -> bool:
    """The variant's condition on the raw input (numbers only; anything else never matches)."""
    for key in (variant.input, *aliases.get(variant.input, ())):
        if key not in inputs:
            continue
        value = inputs[key]
        if isinstance(value, bool) or not isinstance(value, int | float):
            return False
        if not math.isfinite(float(value)):
            return False
        return bool(_VARIANT_OPS[variant.op](float(value), variant.value))
    return False


def rule_sentence(rule_id: str, inputs: Mapping[str, object] | None = None) -> str:
    """One short plain sentence for a fired rule, filled from its ``inputs``.

    Falls back to the rule's input-free sentence when any placeholder is missing, and to a
    generic sentence naming the rule id when the rule is not in the table. Never raises for
    missing or odd inputs.
    """
    table = plain_language()
    text = table.rules.get(rule_id)
    if text is None:
        return f"Interim applied the rule '{rule_id}'."
    values = inputs if isinstance(inputs, Mapping) else {}
    template, placeholders = text.sentence, text.placeholders
    for variant in text.variants:
        if _variant_applies(variant, values, table.aliases):
            template, placeholders = variant.sentence, variant.placeholders
            break
    filled: dict[str, str] = {}
    for name in placeholders:
        rendered = _lookup(name, values, table.aliases)
        if rendered is None:
            return text.fallback
        filled[name] = rendered
    sentence = _PLACEHOLDER.sub(lambda m: filled[m.group(1)], template)
    # A template may open with a value ('{drug} is ...'); a sentence starts with a capital.
    return sentence[:1].upper() + sentence[1:]


__all__ = [
    "PLAIN_LANGUAGE_TABLE_NAMES",
    "ClockKind",
    "PlainLanguage",
    "RuleText",
    "RuleVariant",
    "clock_kind",
    "clock_name",
    "domain_name",
    "evidence_kind_name",
    "field_labels",
    "grade_label",
    "has_label",
    "label",
    "plain_language",
    "rule_ids",
    "rule_sentence",
    "tier_name",
]
