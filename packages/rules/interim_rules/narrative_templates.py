"""The template table behind :mod:`interim_rules.narrative` and its slot-filling renderer.

``data/narrative_templates.json`` holds every sentence, label, joiner and date
format the template writer uses; this module parses and validates it once and
renders variants. It knows nothing about SAEs or briefs: it only fills
``{slot}`` placeholders from a :class:`Scope` of already-formatted slots, each
of which carries the evidence ids of the fact it came from.

Rendering rules (documented in the table's ``rationale``):

* A sentence lists variants in priority order. The first variant whose
  ``when`` conditions all hold and whose slots (its placeholders plus any
  ``cite`` names) are all present is used.
* A rendered sentence cites the union of its slots' evidence ids, in the order
  the slots appear. A sentence with no evidence id is never produced.
* When no variant fits, the sentence is omitted. There is no filler.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, cast

from .tables import TableError, load_table

TABLE_NAME = "narrative_templates"
TABLE_FILE = f"{TABLE_NAME}.json"

KINDS: tuple[str, ...] = ("sae_narrative", "aesi_narrative", "visit_brief")
"""Every text kind the template writer produces (CONTRACTS.md R3.1)."""

FRAGMENT_NAMES: tuple[str, ...] = (
    "grade_point",
    "conmed_action",
    "conmed_protocol",
    "acknowledgement",
)
LABEL_GROUPS: tuple[str, ...] = (
    "conmed_direction",
    "trend",
    "clock_kind",
    "clock_status",
    "ae_status",
    "vitals_method",
    "acknowledged",
    "cm_fields",
)

PLACEHOLDER = re.compile(r"\{([a-z_]+(?:\.[a-z_]+)?)\}")
"""``{name}`` or ``{alias.name}``; anything else in braces is a table error."""


@dataclass(frozen=True)
class Slot:
    """One formatted fact value and the evidence ids of the fact it came from."""

    text: str
    evidence_ids: tuple[str, ...]


@dataclass(frozen=True)
class Scope:
    """The slots and ``when`` flags available to a template."""

    slots: Mapping[str, Slot]
    flags: Mapping[str, str]

    def merged(self, alias: str, element: Scope) -> Scope:
        """This scope plus ``element``'s slots and flags under ``alias.``."""
        slots = dict(self.slots)
        slots.update({f"{alias}.{name}": slot for name, slot in element.slots.items()})
        flags = dict(self.flags)
        flags.update({f"{alias}.{name}": value for name, value in element.flags.items()})
        return Scope(slots, flags)


@dataclass(frozen=True)
class Variant:
    template: str
    when: tuple[tuple[str, str], ...]
    cite: tuple[str, ...]

    @property
    def slot_names(self) -> tuple[str, ...]:
        """Placeholders in order of appearance, then ``cite`` names, without repeats."""
        return unique([*PLACEHOLDER.findall(self.template), *self.cite])


@dataclass(frozen=True)
class SentenceSpec:
    id: str
    section: str
    variants: tuple[Variant, ...]
    for_each: str | None
    alias: str | None
    if_empty: tuple[Variant, ...]


@dataclass(frozen=True)
class KindSpec:
    kind: str
    facts_kind: str | None
    sentences: tuple[SentenceSpec, ...]


@dataclass(frozen=True)
class Formats:
    datetime: str
    list_separator: str
    list_last_separator: str
    trend_separator: str
    sentence_separator: str


@dataclass(frozen=True)
class TextCheck:
    """A validation pattern; ``must_contain`` is set for qualifiers, empty for forbidden text."""

    pattern: re.Pattern[str]
    must_contain: str
    reason: str


@dataclass(frozen=True)
class NarrativeTemplates:
    formats: Formats
    labels: Mapping[str, Mapping[str, str]]
    fragments: Mapping[str, tuple[Variant, ...]]
    sections: Mapping[str, str]
    kinds: Mapping[str, KindSpec]
    forbidden: tuple[TextCheck, ...]
    qualifiers: tuple[TextCheck, ...]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def unique(values: Iterable[str]) -> tuple[str, ...]:
    """``values`` without repeats, first occurrence wins (deterministic order)."""
    seen: dict[str, None] = {}
    for value in values:
        seen.setdefault(value, None)
    return tuple(seen)


def join_list(texts: Sequence[str], formats: Formats) -> str:
    """``a``, ``a and b``, ``a, b and c`` using the table's separators."""
    if len(texts) <= 1:
        return "".join(texts)
    head = formats.list_separator.join(texts[:-1])
    return f"{head}{formats.list_last_separator}{texts[-1]}"


def render(variants: Sequence[Variant], scope: Scope, *, require_evidence: bool) -> Slot | None:
    """Fill the first variant that fits ``scope``; ``None`` when none does.

    ``require_evidence`` is true for sentences (a sentence must cite at least one
    evidence id) and false for fragments, whose caller attaches the element's ids.
    """
    for variant in variants:
        if any(scope.flags.get(key) != value for key, value in variant.when):
            continue
        names = variant.slot_names
        if any(name not in scope.slots for name in names):
            continue
        ids = unique(i for name in names for i in scope.slots[name].evidence_ids)
        if require_evidence and not ids:
            continue
        text = PLACEHOLDER.sub(lambda m: scope.slots[m.group(1)].text, variant.template)
        return Slot(text, ids)
    return None


# --------------------------------------------------------------------------- #
# Table parsing
# --------------------------------------------------------------------------- #


def _obj(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TableError(f"{TABLE_FILE}: {where}: expected object")
    return cast(dict[str, Any], value)


def _str(value: object, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise TableError(f"{TABLE_FILE}: {where}: expected non-empty string")
    return value


def _list(value: object, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise TableError(f"{TABLE_FILE}: {where}: expected list")
    return value


def _variant(raw: object, where: str) -> Variant:
    spec = _obj(raw, where)
    template = _str(spec.get("template"), f"{where}.template")
    if "{" in PLACEHOLDER.sub("", template) or "}" in PLACEHOLDER.sub("", template):
        raise TableError(f"{TABLE_FILE}: {where}.template: malformed placeholder in {template!r}")
    when = _obj(spec.get("when", {}), f"{where}.when")
    cite = _list(spec.get("cite", []), f"{where}.cite")
    return Variant(
        template=template,
        when=tuple(
            (_str(k, f"{where}.when"), _str(v, f"{where}.when.{k}")) for k, v in when.items()
        ),
        cite=tuple(_str(c, f"{where}.cite") for c in cite),
    )


def _variants(raw: object, where: str, *, allow_empty: bool = False) -> tuple[Variant, ...]:
    entries = _list(raw, where)
    if not entries and not allow_empty:
        raise TableError(f"{TABLE_FILE}: {where}: needs at least one variant")
    return tuple(_variant(entry, f"{where}[{i}]") for i, entry in enumerate(entries))


def _sentence(raw: object, where: str, sections: Mapping[str, str]) -> SentenceSpec:
    spec = _obj(raw, where)
    section = _str(spec.get("section"), f"{where}.section")
    if section not in sections:
        raise TableError(f"{TABLE_FILE}: {where}.section: {section!r} is not in 'sections'")
    for_each = spec.get("for_each")
    alias = spec.get("as")
    if (for_each is None) != (alias is None):
        raise TableError(f"{TABLE_FILE}: {where}: 'for_each' and 'as' go together")
    return SentenceSpec(
        id=_str(spec.get("id"), f"{where}.id"),
        section=section,
        variants=_variants(spec.get("variants"), f"{where}.variants"),
        for_each=None if for_each is None else _str(for_each, f"{where}.for_each"),
        alias=None if alias is None else _str(alias, f"{where}.as"),
        if_empty=_variants(spec.get("if_empty", []), f"{where}.if_empty", allow_empty=True),
    )


def _kinds(raw: object, sections: Mapping[str, str]) -> dict[str, KindSpec]:
    table = _obj(raw, "kinds")
    parsed: dict[str, KindSpec] = {}
    for kind in KINDS:
        spec = _obj(table.get(kind), f"kinds.{kind}")
        source_kind = spec.get("sentences_from", kind)
        source = _obj(table.get(source_kind), f"kinds.{kind}.sentences_from")
        sentences = _list(source.get("sentences"), f"kinds.{source_kind}.sentences")
        facts_kind = spec.get("facts_kind")
        parsed[kind] = KindSpec(
            kind=kind,
            facts_kind=None if facts_kind is None else _str(facts_kind, f"kinds.{kind}.facts_kind"),
            sentences=tuple(
                _sentence(s, f"kinds.{source_kind}.sentences[{i}]", sections)
                for i, s in enumerate(sentences)
            ),
        )
    return parsed


def _checks(raw: object, where: str, *, qualifier: bool) -> tuple[TextCheck, ...]:
    out: list[TextCheck] = []
    for i, entry in enumerate(_list(raw, where)):
        spec = _obj(entry, f"{where}[{i}]")
        pattern = _str(spec.get("pattern"), f"{where}[{i}].pattern")
        try:
            compiled = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            raise TableError(f"{TABLE_FILE}: {where}[{i}].pattern: {exc}") from exc
        must = _str(spec.get("must_contain"), f"{where}[{i}].must_contain") if qualifier else ""
        out.append(TextCheck(compiled, must, _str(spec.get("reason"), f"{where}[{i}].reason")))
    return tuple(out)


def parse_templates(raw: Mapping[str, Any]) -> NarrativeTemplates:
    """Validate the raw table and build the typed form; :class:`TableError` names the problem."""
    fmt = _obj(raw.get("formats"), "formats")
    formats = Formats(
        datetime=_str(fmt.get("datetime"), "formats.datetime"),
        list_separator=_str(fmt.get("list_separator"), "formats.list_separator"),
        list_last_separator=_str(fmt.get("list_last_separator"), "formats.list_last_separator"),
        trend_separator=_str(fmt.get("trend_separator"), "formats.trend_separator"),
        sentence_separator=_str(fmt.get("sentence_separator"), "formats.sentence_separator"),
    )
    labels_raw = _obj(raw.get("labels"), "labels")
    labels = {
        group: {
            _str(k, f"labels.{group}"): _str(v, f"labels.{group}.{k}")
            for k, v in _obj(labels_raw.get(group), f"labels.{group}").items()
        }
        for group in LABEL_GROUPS
    }
    fragments_raw = _obj(raw.get("fragments"), "fragments")
    fragments = {
        name: _variants(fragments_raw.get(name), f"fragments.{name}") for name in FRAGMENT_NAMES
    }
    sections = {
        _str(k, "sections"): _str(v, f"sections.{k}")
        for k, v in _obj(raw.get("sections"), "sections").items()
    }
    validation = _obj(raw.get("validation"), "validation")
    return NarrativeTemplates(
        formats=formats,
        labels=labels,
        fragments=fragments,
        sections=sections,
        kinds=_kinds(raw.get("kinds"), sections),
        forbidden=_checks(
            validation.get("forbidden_patterns"), "validation.forbidden_patterns", qualifier=False
        ),
        qualifiers=_checks(validation.get("qualifiers"), "validation.qualifiers", qualifier=True),
    )


@lru_cache(maxsize=1)
def narrative_templates() -> NarrativeTemplates:
    """The parsed ``narrative_templates.json`` (loaded and validated once per process)."""
    return parse_templates(load_table(TABLE_NAME))
