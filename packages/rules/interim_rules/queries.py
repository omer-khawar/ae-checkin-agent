"""Sponsor-side edit checks and drafted query answers (CONTRACTS.md R4.4, CLAUDE.md §00 step 7).

After a site posts records to the EDC, the sponsor's data manager runs edit checks and
sends a *query* back for every failure; the coordinator answers each one. This module is
the deterministic, pure half of that loop:

* :func:`run_edit_checks` evaluates every check in ``data/edit_checks.json`` against a list
  of drafted or confirmed records and returns one :class:`QueryCandidate` per failure. Each
  candidate names the record, the field, a plain-English query text, a severity
  (``"data"`` or ``"safety"``) and its evidence: the check itself (kind ``"rule"``), any
  table it consulted (kind ``"table"``), and the record's own evidence pointers for the
  fields involved, so a query is as traceable as the draft it is about.
* :func:`suggest_answer` drafts an answer for the coordinator to edit, in the same shape as
  :class:`interim_rules.narrative.WrittenText` (``kind = "query_answer"``,
  ``writer = "template"``). Every sentence is assembled from the facts it is given and
  cites only evidence ids that appear in those facts. :func:`answer_facts` builds that fact
  bundle from a candidate and its record, so the API needs one call for each.

Checks are declarative. A check's ``condition`` is a small expression (``all`` / ``any`` /
``not`` over named operations) that :func:`parse_edit_checks` validates when the table is
loaded; an unknown operation, parameter or template slot fails loudly with
:class:`~interim_rules.tables.TableError`. Clinical numbers are not repeated in the table:
the protocol's required CM fields come from ``protocol_rules.json`` and vital-sign bounds
from ``vitals_corroboration.json``.

A check never changes a record and never decides anything clinical: it asks a person to
look. No I/O beyond the package's JSON tables, no clock, no network, no LLM.

Record shape
------------
A record is the API's draft dict (``services.common.draft_to_dict``):
``{id, lineage_id, ae_open_id, domain, status, usubjid, fields: {SDTM: value},
evidence: {SDTM: [{kind, id, ts, note}]}}``. A flat mapping of SDTM fields (with
``DOMAIN`` or a ``domain`` key) and a :class:`~interim_rules.models.DraftRecord` are also
accepted. Records whose ``status`` is ``"rejected"`` are skipped.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping, Sequence, Sized
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from functools import lru_cache
from typing import Literal, NotRequired, Required, TypedDict, cast

from . import plain_language
from .models import DraftRecord, ProtocolRef
from .narrative import Sentence, WrittenText
from .tables import (
    TableError,
    ctcae_terms,
    irae_mapping,
    load_table,
    protocol_rules,
    vitals_config,
)

TABLE_NAME = "edit_checks"
TABLE_FILE = "edit_checks.json"
QUERY_TABLE_NAMES: tuple[str, ...] = (TABLE_NAME,)
"""The JSON table this module owns (not part of :data:`interim_rules.tables.TABLE_NAMES`)."""

IRAE_TABLE_FILE = "irae_mapping.json"
VITALS_TABLE_FILE = "vitals_corroboration.json"
PROTOCOL_TABLE_FILE = "protocol_rules.json"

Severity = Literal["data", "safety"]
SEVERITIES: tuple[str, ...] = ("data", "safety")
DOMAINS: tuple[str, ...] = ("AE", "CM", "VS")
ANSWER_KIND = "query_answer"

_FIELDS_FROM_PROTOCOL = "protocol_rules.cm_required_fields"
_BOUNDS_FROM_VITALS = "vitals_corroboration.plausibility"
_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
_FIELD_NAME = re.compile(r"[A-Z][A-Z0-9_]*")
_DATE_ONLY = re.compile(r"\d{4}-\d{2}-\d{2}")


# --------------------------------------------------------------------------- #
# Public result types
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class QueryEvidence:
    """An evidence pointer ``{kind, id, ts, note}`` (the API's evidence shape).

    The kind is a plain string rather than :data:`~interim_rules.models.EvidenceKind`
    because a record's evidence may come from the API's chart-note path
    (``"chart_note"``), which the rules package's literal does not list.
    """

    kind: str
    id: str
    ts: str | None
    note: str

    def to_dict(self) -> dict[str, object]:
        return {"kind": self.kind, "id": self.id, "ts": self.ts, "note": self.note}


@dataclass(frozen=True)
class QueryCandidate:
    """One failed edit check on one record (CONTRACTS R4.4).

    ``record_key`` names the exact record version the query was raised on (the draft id
    when the record has one), so the API can store it as the query's ``draft_id``.
    ``field`` is the field shown to the coordinator (for the medication check, the first
    field still missing); ``fields`` lists every field the check read (``field`` first).

    ``key`` is the dedup identity and is stable across runs, draft versions and partial
    fixes: ``check_id|lineage_key|check_field``. ``lineage_key`` is the record's
    ``lineage_id`` (every version of one record shares it), falling back to ``record_key``;
    ``check_field`` is the check's own declared field, which never drifts as the coordinator
    fills fields in. One open query per record lineage per check therefore keeps one key.
    """

    check_id: str
    domain: str
    record_key: str
    field: str
    text: str
    severity: Severity
    evidence: tuple[QueryEvidence, ...]
    fields: tuple[str, ...] = ()
    usubjid: str | None = None
    protocol_ref: ProtocolRef | None = None
    lineage_key: str = ""
    check_field: str = ""

    @property
    def key(self) -> str:
        lineage = self.lineage_key or self.record_key
        return f"{self.check_id}|{lineage}|{self.check_field or self.field}"

    def to_dict(self) -> dict[str, object]:
        return {
            "check_id": self.check_id,
            "domain": self.domain,
            "record_key": self.record_key,
            "lineage_key": self.lineage_key or self.record_key,
            "field": self.field,
            "fields": list(self.fields),
            "text": self.text,
            "severity": self.severity,
            "usubjid": self.usubjid,
            "protocol_ref": (
                None
                if self.protocol_ref is None
                else {
                    "section": self.protocol_ref.section,
                    "printed_page": self.protocol_ref.printed_page,
                }
            ),
            "evidence": [e.to_dict() for e in self.evidence],
            "key": self.key,
        }


@dataclass(frozen=True)
class QueryContext:
    """What the checks need beyond the records themselves.

    * ``signed_packet_keys``: keys (draft id, lineage id or open-AE id) of AE records whose
      serious-event packet is signed.
    * ``noted_record_keys``: keys of records with an investigator note stored outside their
      fields.
    """

    signed_packet_keys: frozenset[str] = frozenset()
    noted_record_keys: frozenset[str] = frozenset()


# --------------------------------------------------------------------------- #
# Fact bundle for suggest_answer (narrative.py conventions: every fact object
# carries evidence_ids, and a sentence may cite only those ids)
# --------------------------------------------------------------------------- #


class CheckFact(TypedDict):
    check_id: str
    evidence_ids: list[str]


class LabelFact(TypedDict):
    value: str
    evidence_ids: list[str]


class FieldFact(TypedDict):
    """A queried field's current value in plain words (``None`` when empty).

    ``code`` carries the raw recorded value when ``value_labels`` turned it into plain words
    (``INTERIM_IRAE`` ``"N"`` is shown as ``"no"``), so the UI can show it one click deeper.
    """

    field: str
    plain_label: str
    value: str | None
    evidence_ids: list[str]
    code: NotRequired[str]


class SourceFact(TypedDict, total=False):
    """One piece of source evidence behind a queried field; ``note`` is quoted verbatim."""

    kind: Required[str]
    note: Required[str]
    ts: str
    evidence_ids: Required[list[str]]


class ExtraFact(TypedDict):
    """Anything else the API knows, e.g. ``{"label": "Serious-event report", "value": "signed
    2026-10-12", "evidence_ids": [packet_id]}``."""

    label: str
    value: str
    evidence_ids: list[str]


class AnswerFacts(TypedDict, total=False):
    check: CheckFact
    record_label: LabelFact
    fields: list[FieldFact]
    sources: list[SourceFact]
    missing_fields: list[str]
    extra: list[ExtraFact]


# --------------------------------------------------------------------------- #
# Condition model
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class AllOf:
    conditions: tuple[Condition, ...]


@dataclass(frozen=True)
class AnyOf:
    conditions: tuple[Condition, ...]


@dataclass(frozen=True)
class NotCond:
    condition: Condition


@dataclass(frozen=True)
class FieldMissing:
    fields: tuple[str, ...]
    labels: Mapping[str, str]
    """Plain words per field (the protocol's own terms when read from protocol_rules.json)."""
    not_required_when: Mapping[str, Condition]
    from_protocol: bool


@dataclass(frozen=True)
class FieldEquals:
    field: str
    values: tuple[str, ...]


@dataclass(frozen=True)
class DateBefore:
    field: str
    before_field: str


@dataclass(frozen=True)
class ValueOutside:
    field: str
    min: float | None
    max: float | None
    key_field: str | None
    metric_for_key: Mapping[str, str]
    from_vitals: bool


@dataclass(frozen=True)
class FlagWithoutNote:
    flag_field: str
    flag_values: tuple[str, ...]
    note_fields: tuple[str, ...]


@dataclass(frozen=True)
class SeriousWithoutPacket:
    field: str
    values: tuple[str, ...]


@dataclass(frozen=True)
class ImmuneRelatedMarkedNo:
    grade_field: str
    min_grade: int
    term_field: str
    irae_field: str
    no_values: tuple[str, ...]
    additional_terms: Mapping[str, str]


Condition = (
    AllOf
    | AnyOf
    | NotCond
    | FieldMissing
    | FieldEquals
    | DateBefore
    | ValueOutside
    | FlagWithoutNote
    | SeriousWithoutPacket
    | ImmuneRelatedMarkedNo
)

_OP_SLOTS: dict[str, frozenset[str]] = {
    "field_missing": frozenset({"missing_fields", "missing_codes"}),
    "field_equals": frozenset({"value"}),
    "date_before": frozenset({"value", "other_value"}),
    "value_outside": frozenset({"value", "low", "high", "unit"}),
    "flag_present_without_note": frozenset({"flag"}),
    "aeser_y_without_signed_packet": frozenset({"value"}),
    "potentially_immune_related_and_irae_no": frozenset({"grade", "term", "irae_category"}),
}
_OP_PARAMS: dict[str, frozenset[str]] = {
    "field_missing": frozenset({"field", "fields", "fields_from", "not_required_when"}),
    "field_equals": frozenset({"field", "values"}),
    "date_before": frozenset({"field", "before_field"}),
    "value_outside": frozenset(
        {"field", "min", "max", "key_field", "bounds_from", "metric_for_key"}
    ),
    "flag_present_without_note": frozenset({"flag_field", "flag_values", "note_fields"}),
    "aeser_y_without_signed_packet": frozenset({"field", "values"}),
    "potentially_immune_related_and_irae_no": frozenset(
        {"grade_field", "min_grade", "term_field", "irae_field", "no_values", "additional_terms"}
    ),
}
_ANSWER_CLOSE_SLOTS = frozenset({"record_label", "missing_fields"})


@dataclass(frozen=True)
class EditCheck:
    """One row of ``edit_checks.json``."""

    id: str
    domain: str
    field: str
    severity: Severity
    condition: Condition
    query_text: str
    answer_close: str
    protocol_ref: ProtocolRef | None
    quote: str | None
    source: str
    rationale: str


@dataclass(frozen=True)
class AnswerWriterConfig:
    kind: str
    writer: Literal["template"]
    sentence_separator: str
    max_source_sentences: int
    source_kinds: tuple[str, ...]
    kind_labels: Mapping[str, str]
    missing_value: str
    templates: Mapping[str, str]
    grade_fields: tuple[str, ...]


@dataclass(frozen=True)
class EditCheckTable:
    checks: tuple[EditCheck, ...]
    record_labels: Mapping[str, str]
    field_labels: Mapping[str, str]
    answer: AnswerWriterConfig
    value_labels: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    """Plain words per coded value, keyed by field name, then by casefolded code."""


# --------------------------------------------------------------------------- #
# Table parsing
# --------------------------------------------------------------------------- #


def _str(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TableError(f"{where}: expected non-empty text")
    return value


def _dict(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TableError(f"{where}: expected an object")
    return cast(dict[str, object], value)


def _strs(value: object, where: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise TableError(f"{where}: expected a non-empty list")
    return tuple(_str(v, f"{where}[{i}]") for i, v in enumerate(cast(list[object], value)))


def _field_name(value: object, where: str) -> str:
    name = _str(value, where)
    if not _FIELD_NAME.fullmatch(name):
        raise TableError(f"{where}: {name!r} is not an SDTM-style field name")
    return name


def _num(value: object, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TableError(f"{where}: expected a number")
    return float(value)


def _placeholders(template: str) -> list[str]:
    return _PLACEHOLDER.findall(template)


def _op_names(cond: Condition) -> set[str]:
    """Operation names whose slots a template may use (``not`` exposes none)."""
    if isinstance(cond, AllOf | AnyOf):
        return set().union(*(_op_names(c) for c in cond.conditions))
    if isinstance(cond, NotCond):
        return set()
    return {_OP_OF[type(cond)]}


def _parse_condition(raw: object, where: str) -> Condition:
    spec = _dict(raw, where)
    if "all" in spec or "any" in spec:
        key = "all" if "all" in spec else "any"
        if len(spec) != 1:
            raise TableError(f"{where}: '{key}' must be the only key")
        items = spec[key]
        if not isinstance(items, list) or not items:
            raise TableError(f"{where}.{key}: expected a non-empty list")
        parsed = tuple(
            _parse_condition(c, f"{where}.{key}[{i}]")
            for i, c in enumerate(cast(list[object], items))
        )
        return AllOf(parsed) if key == "all" else AnyOf(parsed)
    if "not" in spec:
        if len(spec) != 1:
            raise TableError(f"{where}: 'not' must be the only key")
        return NotCond(_parse_condition(spec["not"], f"{where}.not"))
    op = _str(spec.get("op"), f"{where}.op")
    if op not in _OP_PARAMS:
        raise TableError(f"{where}.op: unknown operation {op!r}")
    unknown = set(spec) - {"op"} - _OP_PARAMS[op]
    if unknown:
        raise TableError(f"{where}: unknown parameter(s) {sorted(unknown)} for {op!r}")
    return _PARSERS[op](spec, where)


def _parse_field_missing(spec: Mapping[str, object], where: str) -> Condition:
    given = [k for k in ("field", "fields", "fields_from") if k in spec]
    if len(given) != 1:
        raise TableError(f"{where}: give exactly one of 'field', 'fields', 'fields_from'")
    labels: dict[str, str] = {}
    from_protocol = False
    if "field" in spec:
        fields: tuple[str, ...] = (_field_name(spec["field"], f"{where}.field"),)
    elif "fields" in spec:
        fields = tuple(
            _field_name(f, f"{where}.fields") for f in _strs(spec["fields"], f"{where}.fields")
        )
    else:
        if spec["fields_from"] != _FIELDS_FROM_PROTOCOL:
            raise TableError(f"{where}.fields_from: only {_FIELDS_FROM_PROTOCOL!r} is supported")
        rules = protocol_rules()
        fields = tuple(rules.cm_required_fields)
        labels = {f.field: f.protocol_term for f in rules.cm_required_detail}
        from_protocol = True
    raw_nrw = spec.get("not_required_when", {})
    nrw: dict[str, Condition] = {}
    for name, cond in _dict(raw_nrw, f"{where}.not_required_when").items():
        if name not in fields:
            raise TableError(f"{where}.not_required_when: {name!r} is not a checked field")
        nrw[name] = _parse_condition(cond, f"{where}.not_required_when.{name}")
    return FieldMissing(fields, labels, nrw, from_protocol)


def _parse_field_equals(spec: Mapping[str, object], where: str) -> Condition:
    return FieldEquals(
        _field_name(spec.get("field"), f"{where}.field"), _strs(spec.get("values"), where)
    )


def _parse_date_before(spec: Mapping[str, object], where: str) -> Condition:
    return DateBefore(
        _field_name(spec.get("field"), f"{where}.field"),
        _field_name(spec.get("before_field"), f"{where}.before_field"),
    )


def _parse_value_outside(spec: Mapping[str, object], where: str) -> Condition:
    fld = _field_name(spec.get("field"), f"{where}.field")
    if "bounds_from" in spec:
        if spec["bounds_from"] != _BOUNDS_FROM_VITALS:
            raise TableError(f"{where}.bounds_from: only {_BOUNDS_FROM_VITALS!r} is supported")
        if "min" in spec or "max" in spec:
            raise TableError(f"{where}: give 'bounds_from' or 'min'/'max', not both")
        key_field = _field_name(spec.get("key_field"), f"{where}.key_field")
        metrics = {
            k: _str(v, f"{where}.metric_for_key.{k}")
            for k, v in _dict(spec.get("metric_for_key"), f"{where}.metric_for_key").items()
        }
        known = vitals_config().plausibility
        for key, metric in metrics.items():
            if metric not in known:
                raise TableError(f"{where}.metric_for_key.{key}: no plausibility row {metric!r}")
        return ValueOutside(fld, None, None, key_field, metrics, True)
    low = _num(spec["min"], f"{where}.min") if "min" in spec else None
    high = _num(spec["max"], f"{where}.max") if "max" in spec else None
    if low is None and high is None:
        raise TableError(f"{where}: give 'bounds_from' or at least one of 'min'/'max'")
    if low is not None and high is not None and low > high:
        raise TableError(f"{where}: min is greater than max")
    if "key_field" in spec or "metric_for_key" in spec:
        raise TableError(f"{where}: 'key_field'/'metric_for_key' need 'bounds_from'")
    return ValueOutside(fld, low, high, None, {}, False)


def _parse_flag(spec: Mapping[str, object], where: str) -> Condition:
    return FlagWithoutNote(
        _field_name(spec.get("flag_field"), f"{where}.flag_field"),
        _strs(spec.get("flag_values"), f"{where}.flag_values"),
        tuple(
            _field_name(f, f"{where}.note_fields")
            for f in _strs(spec.get("note_fields"), f"{where}.note_fields")
        ),
    )


def _parse_serious(spec: Mapping[str, object], where: str) -> Condition:
    return SeriousWithoutPacket(
        _field_name(spec.get("field"), f"{where}.field"),
        _strs(spec.get("values"), f"{where}.values"),
    )


def _parse_irae(spec: Mapping[str, object], where: str) -> Condition:
    min_grade = spec.get("min_grade")
    if isinstance(min_grade, bool) or not isinstance(min_grade, int) or not 1 <= min_grade <= 5:
        raise TableError(f"{where}.min_grade: expected an integer grade 1..5")
    extra = {
        _str(term, f"{where}.additional_terms"): _str(cat, f"{where}.additional_terms.{term}")
        for term, cat in _dict(
            spec.get("additional_terms", {}), f"{where}.additional_terms"
        ).items()
    }
    return ImmuneRelatedMarkedNo(
        grade_field=_field_name(spec.get("grade_field"), f"{where}.grade_field"),
        min_grade=min_grade,
        term_field=_field_name(spec.get("term_field"), f"{where}.term_field"),
        irae_field=_field_name(spec.get("irae_field"), f"{where}.irae_field"),
        no_values=_strs(spec.get("no_values"), f"{where}.no_values"),
        additional_terms=extra,
    )


_PARSERS: dict[str, Callable[[Mapping[str, object], str], Condition]] = {
    "field_missing": _parse_field_missing,
    "field_equals": _parse_field_equals,
    "date_before": _parse_date_before,
    "value_outside": _parse_value_outside,
    "flag_present_without_note": _parse_flag,
    "aeser_y_without_signed_packet": _parse_serious,
    "potentially_immune_related_and_irae_no": _parse_irae,
}
_OP_OF: dict[type, str] = {
    FieldMissing: "field_missing",
    FieldEquals: "field_equals",
    DateBefore: "date_before",
    ValueOutside: "value_outside",
    FlagWithoutNote: "flag_present_without_note",
    SeriousWithoutPacket: "aeser_y_without_signed_packet",
    ImmuneRelatedMarkedNo: "potentially_immune_related_and_irae_no",
}


def _check_template(
    template: str, allowed_lower: frozenset[str], upper_ok: bool, where: str
) -> None:
    for name in _placeholders(template):
        if _FIELD_NAME.fullmatch(name):
            if not upper_ok:
                raise TableError(f"{where}: record field slot {{{name}}} is not allowed here")
        elif name not in allowed_lower:
            raise TableError(f"{where}: unknown slot {{{name}}}; allowed: {sorted(allowed_lower)}")


def _protocol_ref(raw: object, where: str) -> ProtocolRef | None:
    if raw is None:
        return None
    ref = _dict(raw, where)
    page = ref.get("printed_page")
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        raise TableError(f"{where}.printed_page: expected a positive integer")
    return ProtocolRef(section=_str(ref.get("section"), f"{where}.section"), printed_page=page)


def _parse_check(raw: object, where: str) -> EditCheck:
    entry = _dict(raw, where)
    check_id = _str(entry.get("id"), f"{where}.id")
    if not re.fullmatch(r"query\.[a-z0-9_]+", check_id):
        raise TableError(f"{where}.id: {check_id!r} must look like 'query.snake_case'")
    domain = _str(entry.get("domain"), f"{where}.domain")
    if domain not in DOMAINS:
        raise TableError(f"{where}.domain: expected one of {list(DOMAINS)}")
    severity = _str(entry.get("severity"), f"{where}.severity")
    if severity not in SEVERITIES:
        raise TableError(f"{where}.severity: expected one of {list(SEVERITIES)}")
    condition = _parse_condition(entry.get("condition"), f"{where}.condition")
    slots = frozenset({"record_label"}).union(*(_OP_SLOTS[op] for op in _op_names(condition)))
    query_text = _str(entry.get("query_text"), f"{where}.query_text")
    _check_template(query_text, slots, True, f"{where}.query_text")
    answer_close = _str(entry.get("answer_close"), f"{where}.answer_close")
    _check_template(answer_close, _ANSWER_CLOSE_SLOTS, False, f"{where}.answer_close")
    protocol_ref = _protocol_ref(entry.get("protocol_ref"), f"{where}.protocol_ref")
    quote = entry.get("quote")
    if quote is not None:
        quote = _str(quote, f"{where}.quote")
        if protocol_ref is None:
            raise TableError(f"{where}.quote: a quote needs a protocol_ref")
    return EditCheck(
        id=check_id,
        domain=domain,
        field=_field_name(entry.get("field"), f"{where}.field"),
        severity=cast(Severity, severity),
        condition=condition,
        query_text=query_text,
        answer_close=answer_close,
        protocol_ref=protocol_ref,
        quote=quote,
        source=_str(entry.get("source"), f"{where}.source"),
        rationale=_str(entry.get("rationale"), f"{where}.rationale"),
    )


def _parse_answer(raw: object) -> AnswerWriterConfig:
    where = "edit_checks.answer_writer"
    spec = _dict(raw, where)
    templates = {
        k: _str(v, f"{where}.templates.{k}")
        for k, v in _dict(spec.get("templates"), f"{where}.templates").items()
    }
    required = {
        "opening": frozenset({"plain_label", "record_label"}),
        "field_value": frozenset({"plain_label", "value"}),
        "field_value_grade": frozenset({"plain_label", "value"}),
        "field_missing": frozenset({"plain_label"}),
        "source": frozenset({"kind_label", "when", "note"}),
        "source_no_time": frozenset({"kind_label", "note"}),
        "extra": frozenset({"label", "value"}),
    }
    for name, allowed in required.items():
        if name not in templates:
            raise TableError(f"{where}.templates: missing {name!r}")
        _check_template(templates[name], allowed, False, f"{where}.templates.{name}")
    if spec.get("writer") != "template":
        raise TableError(f"{where}.writer: must be 'template'")
    if spec.get("kind") != ANSWER_KIND:
        raise TableError(f"{where}.kind: must be {ANSWER_KIND!r}")
    max_sources = spec.get("max_source_sentences")
    if isinstance(max_sources, bool) or not isinstance(max_sources, int) or max_sources < 0:
        raise TableError(f"{where}.max_source_sentences: expected a non-negative integer")
    separator = spec.get("sentence_separator")
    if not isinstance(separator, str) or not separator:
        raise TableError(f"{where}.sentence_separator: expected text")
    kind_labels = {
        k: _str(v, f"{where}.kind_labels.{k}")
        for k, v in _dict(spec.get("kind_labels"), f"{where}.kind_labels").items()
    }
    source_kinds = _strs(spec.get("source_kinds"), f"{where}.source_kinds")
    for kind in source_kinds:
        if kind not in kind_labels:
            raise TableError(f"{where}.kind_labels: missing a label for {kind!r}")
    return AnswerWriterConfig(
        kind=ANSWER_KIND,
        writer="template",
        sentence_separator=separator,
        max_source_sentences=max_sources,
        source_kinds=source_kinds,
        kind_labels=kind_labels,
        missing_value=_str(spec.get("missing_value"), f"{where}.missing_value"),
        templates=templates,
        grade_fields=_strs(spec.get("grade_fields"), f"{where}.grade_fields"),
    )


def parse_edit_checks(table: Mapping[str, object]) -> EditCheckTable:
    """Validate a loaded ``edit_checks.json`` (exposed for tests of malformed tables)."""
    raw_checks = table.get("checks")
    if not isinstance(raw_checks, list) or not raw_checks:
        raise TableError("edit_checks.checks: expected a non-empty list")
    checks = tuple(
        _parse_check(raw, f"edit_checks.checks[{i}]")
        for i, raw in enumerate(cast(list[object], raw_checks))
    )
    seen: set[str] = set()
    for check in checks:
        if check.id in seen:
            raise TableError(f"edit_checks.checks: duplicate id {check.id!r}")
        seen.add(check.id)
    raw_labels = _dict(table.get("record_labels"), "edit_checks.record_labels")
    record_labels: dict[str, str] = {}
    for domain in DOMAINS:
        text = _str(raw_labels.get(domain), f"edit_checks.record_labels.{domain}")
        _check_template(text, frozenset(), True, f"edit_checks.record_labels.{domain}")
        record_labels[domain] = text
    field_labels = {
        k: _str(v, f"edit_checks.field_labels.{k}")
        for k, v in _dict(table.get("field_labels", {}), "edit_checks.field_labels").items()
        if k != "rationale"
    }
    return EditCheckTable(
        checks,
        record_labels,
        field_labels,
        _parse_answer(table.get("answer_writer")),
        _parse_value_labels(table.get("value_labels", {})),
    )


def _parse_value_labels(raw: object) -> dict[str, dict[str, str]]:
    """``value_labels``: ``{FIELD: {code: plain words}}``; codes compare casefolded."""
    where = "edit_checks.value_labels"
    out: dict[str, dict[str, str]] = {}
    for name, codes in _dict(raw, where).items():
        if name in ("rationale", "source"):
            continue
        fld = _field_name(name, f"{where}.{name}")
        mapping: dict[str, str] = {}
        for code, words in _dict(codes, f"{where}.{fld}").items():
            folded = _str(code, f"{where}.{fld}").strip().casefold()
            if folded in mapping:
                raise TableError(f"{where}.{fld}: code {code!r} is listed twice")
            mapping[folded] = _str(words, f"{where}.{fld}.{code}").strip()
        out[fld] = mapping
    return out


@lru_cache(maxsize=1)
def edit_check_table() -> EditCheckTable:
    """The validated ``edit_checks.json`` (cached per process)."""
    return parse_edit_checks(load_table(TABLE_NAME))


def edit_checks() -> tuple[EditCheck, ...]:
    return edit_check_table().checks


def check_ids() -> tuple[str, ...]:
    """Every ``query.*`` rule id, in table order (for rules_catalog / plain_language)."""
    return tuple(c.id for c in edit_checks())


def check_by_id(check_id: str) -> EditCheck | None:
    return next((c for c in edit_checks() if c.id == check_id), None)


# --------------------------------------------------------------------------- #
# Records and context
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class _Record:
    domain: str
    fields: Mapping[str, object]
    evidence: Mapping[str, tuple[QueryEvidence, ...]]
    record_key: str
    lineage_key: str
    keys: frozenset[str]
    usubjid: str | None
    status: str | None


def _evidence_list(value: object, where: str) -> tuple[QueryEvidence, ...]:
    if value is None:
        return ()
    if not isinstance(value, list | tuple):
        raise ValueError(f"{where}: expected a list of evidence pointers")
    out: list[QueryEvidence] = []
    for i, raw in enumerate(cast(Sequence[object], value)):
        if not isinstance(raw, Mapping):
            raise ValueError(f"{where}[{i}]: expected an object")
        ev = cast(Mapping[str, object], raw)
        kind, ident, ts, note = ev.get("kind"), ev.get("id"), ev.get("ts"), ev.get("note")
        if not isinstance(kind, str) or not isinstance(ident, str) or not ident:
            raise ValueError(f"{where}[{i}]: evidence needs text 'kind' and 'id'")
        out.append(
            QueryEvidence(
                kind=kind,
                id=ident,
                ts=ts if isinstance(ts, str) else None,
                note=note if isinstance(note, str) else "",
            )
        )
    return tuple(out)


def _to_record(raw: Mapping[str, object] | DraftRecord, index: int) -> _Record:
    where = f"records[{index}]"
    if isinstance(raw, DraftRecord):
        fields: Mapping[str, object] = {f.name: f.value for f in raw.fields}
        evidence = {
            f.name: tuple(QueryEvidence(e.kind, e.id, e.ts, e.note) for e in f.evidence)
            for f in raw.fields
        }
        domain: object = raw.domain
        top: Mapping[str, object] = {}
    else:
        if not isinstance(raw, Mapping):
            raise ValueError(f"{where}: expected an object")
        top = raw
        inner = raw.get("fields")
        fields = cast(Mapping[str, object], inner) if isinstance(inner, Mapping) else raw
        raw_ev = raw.get("evidence")
        evidence = {}
        if isinstance(raw_ev, Mapping):
            for name, lst in cast(Mapping[str, object], raw_ev).items():
                evidence[name] = _evidence_list(lst, f"{where}.evidence.{name}")
        elif raw_ev is not None and not isinstance(inner, Mapping):
            raise ValueError(f"{where}.evidence: expected an object keyed by field")
        domain = raw.get("domain") or fields.get("DOMAIN")
    if not isinstance(domain, str) or not domain.strip():
        raise ValueError(f"{where}: record has no domain")
    domain = domain.strip().upper()
    usubjid_raw = fields.get("USUBJID") or top.get("usubjid")
    usubjid = str(usubjid_raw) if usubjid_raw not in (None, "") else None
    seq = fields.get(f"{domain}SEQ")
    ident = top.get("id")
    if isinstance(ident, str) and ident:
        record_key = ident
    elif usubjid is not None and seq not in (None, ""):
        record_key = f"{domain}:{usubjid}:{_fmt(seq, '')}"
    else:
        record_key = f"{domain}#{index}"
    keys = {record_key}
    for name in ("id", "lineage_id", "ae_open_id", "linked_ae_open_id"):
        value = top.get(name)
        if isinstance(value, str) and value:
            keys.add(value)
    # Every version of one record shares its lineage id (CONTRACTS R4.4: one query per
    # record, not per version); a record without one is its own lineage.
    lineage = top.get("lineage_id")
    lineage_key = lineage if isinstance(lineage, str) and lineage else record_key
    status = top.get("status")
    return _Record(
        domain=domain,
        fields=fields,
        evidence=evidence,
        record_key=record_key,
        lineage_key=lineage_key,
        keys=frozenset(keys),
        usubjid=usubjid,
        status=status if isinstance(status, str) else None,
    )


def _to_context(context: QueryContext | Mapping[str, object] | None) -> QueryContext:
    if context is None:
        return QueryContext()
    if isinstance(context, QueryContext):
        return context

    def keys(name: str) -> frozenset[str]:
        value = context.get(name)
        if value is None:
            return frozenset()
        if isinstance(value, str) or not isinstance(value, Iterable):
            raise ValueError(f"context.{name}: expected a list of keys")
        return frozenset(str(v) for v in cast(Iterable[object], value))

    return QueryContext(
        signed_packet_keys=keys("signed_packet_keys"),
        noted_record_keys=keys("noted_record_keys"),
    )


# --------------------------------------------------------------------------- #
# Value helpers
# --------------------------------------------------------------------------- #


def _is_missing(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, list | tuple | dict | set):
        return len(cast(Sized, value)) == 0
    return False


def _fmt(value: object, missing: str) -> str:
    """Render a field value in plain text; empty values render as ``missing``."""
    if _is_missing(value):
        return missing
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return str(int(value))
        return f"{value:g}"
    if isinstance(value, list | tuple):
        return ", ".join(_fmt(v, missing) for v in cast(Sequence[object], value))
    return str(value).strip()


def _equals(value: object, options: Sequence[str]) -> bool:
    if _is_missing(value) or isinstance(value, list | tuple | dict):
        return False
    text = _fmt(value, "").casefold()
    return any(text == opt.strip().casefold() for opt in options)


def _number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _when(value: object) -> tuple[date, datetime | None] | None:
    """``(calendar date, UTC instant or None)`` for a full ISO 8601 date; ``None`` otherwise."""
    if not isinstance(value, str) or not _DATE_ONLY.match(value.strip()):
        return None
    text = value.strip()
    if len(text) == 10:
        try:
            return date.fromisoformat(text), None
        except ValueError:
            return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    instant = parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    return parsed.date(), instant


def _join(words: Sequence[str]) -> str:
    if len(words) <= 1:
        return "".join(words)
    return ", ".join(words[:-1]) + " and " + words[-1]


def _unique(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    for v in values:
        if v not in out:
            out.append(v)
    return out


def display_value(name: str, value: object, missing: str) -> str:
    """A field value in plain words: ``value_labels`` first, then the recorded text.

    ``display_value("INTERIM_IRAE", "N", ...)`` is ``"no"``; a code with no entry in
    ``edit_checks.json`` value_labels is shown as recorded.
    """
    text = _fmt(value, missing)
    if _is_missing(value) or isinstance(value, bool | list | tuple | dict):
        return text
    words = edit_check_table().value_labels.get(name, {})
    return words.get(text.casefold(), text)


def field_label(name: str) -> str:
    """Plain label for a field: plain_language.json first, then this table's fallbacks."""
    if plain_language.has_label(name):
        return plain_language.label(name)
    return edit_check_table().field_labels.get(name, name)


# --------------------------------------------------------------------------- #
# Evaluation
# --------------------------------------------------------------------------- #


@dataclass
class _Match:
    slots: dict[str, str] = field(default_factory=dict)
    fields: list[str] = field(default_factory=list)
    evidence: list[QueryEvidence] = field(default_factory=list)
    missing_labels: list[str] = field(default_factory=list)

    def merge(self, other: _Match) -> None:
        for k, v in other.slots.items():
            self.slots.setdefault(k, v)
        self.fields = _unique([*self.fields, *other.fields])
        self.evidence.extend(other.evidence)
        self.missing_labels = _unique([*self.missing_labels, *other.missing_labels])


def _immune_category(term: str, cond: ImmuneRelatedMarkedNo) -> tuple[str, str] | None:
    """``(category, table file)`` when ``term`` is potentially immune-related."""
    folded = term.strip().casefold()
    mapping = irae_mapping()
    for item_id, row in ctcae_terms().items():
        if row.aedecod.casefold() == folded:
            irae = mapping.get(item_id)
            if irae is not None and irae.potentially_immune_related:
                return irae.irae_category, IRAE_TABLE_FILE
            return None
    for extra_term, category in cond.additional_terms.items():
        if extra_term.casefold() == folded:
            return category, TABLE_FILE
    return None


def _evaluate(cond: Condition, rec: _Record, ctx: QueryContext, missing: str) -> _Match | None:
    f = rec.fields
    if isinstance(cond, AllOf):
        merged = _Match()
        for inner in cond.conditions:
            got = _evaluate(inner, rec, ctx, missing)
            if got is None:
                return None
            merged.merge(got)
        return merged
    if isinstance(cond, AnyOf):
        for inner in cond.conditions:
            got = _evaluate(inner, rec, ctx, missing)
            if got is not None:
                return got
        return None
    if isinstance(cond, NotCond):
        return _Match() if _evaluate(cond.condition, rec, ctx, missing) is None else None
    if isinstance(cond, FieldMissing):
        absent = [
            name
            for name in cond.fields
            if _is_missing(f.get(name))
            and not (
                name in cond.not_required_when
                and _evaluate(cond.not_required_when[name], rec, ctx, missing) is not None
            )
        ]
        if not absent:
            return None
        words = [cond.labels.get(n) or field_label(n) for n in absent]
        table_ev: list[QueryEvidence] = []
        if cond.from_protocol:
            ref = protocol_rules().cm_required_reference.protocol_ref
            table_ev.append(
                QueryEvidence(
                    "table",
                    PROTOCOL_TABLE_FILE,
                    None,
                    f"cm_required_fields (protocol section {ref.section}, "
                    f"printed page {ref.printed_page})",
                )
            )
        return _Match(
            slots={"missing_fields": _join(words), "missing_codes": ", ".join(absent)},
            fields=absent,
            evidence=table_ev,
            missing_labels=words,
        )
    if isinstance(cond, FieldEquals):
        value = f.get(cond.field)
        if not _equals(value, cond.values):
            return None
        return _Match(
            slots={"value": display_value(cond.field, value, missing)}, fields=[cond.field]
        )
    if isinstance(cond, DateBefore):
        end, start = _when(f.get(cond.field)), _when(f.get(cond.before_field))
        if end is None or start is None:
            return None
        if end[1] is not None and start[1] is not None:
            before = end[1] < start[1]
        else:
            before = end[0] < start[0]
        if not before:
            return None
        return _Match(
            slots={
                "value": _fmt(f.get(cond.field), missing),
                "other_value": _fmt(f.get(cond.before_field), missing),
            },
            fields=[cond.field, cond.before_field],
        )
    if isinstance(cond, ValueOutside):
        number = _number(f.get(cond.field))
        if number is None:
            return None
        low, high, unit = cond.min, cond.max, ""
        involved = [cond.field]
        evidence: list[QueryEvidence] = []
        if cond.from_vitals:
            assert cond.key_field is not None
            metric = cond.metric_for_key.get(_fmt(f.get(cond.key_field), "").upper())
            if metric is None:
                return None
            bounds = vitals_config().plausibility[metric]
            low, high, unit = bounds.min, bounds.max, bounds.unit
            involved.append(cond.key_field)
            evidence.append(
                QueryEvidence(
                    "table",
                    VITALS_TABLE_FILE,
                    None,
                    f"plausibility.{metric}: {_fmt(low, missing)}-{_fmt(high, missing)} {unit}",
                )
            )
        if (low is None or number >= low) and (high is None or number <= high):
            return None
        return _Match(
            slots={
                "value": _fmt(number, missing),
                "low": _fmt(low, missing),
                "high": _fmt(high, missing),
                "unit": unit or _fmt(f.get(f"{cond.field[:2]}ORRESU"), ""),
            },
            fields=involved,
            evidence=evidence,
        )
    if isinstance(cond, FlagWithoutNote):
        flag = f.get(cond.flag_field)
        if not _equals(flag, cond.flag_values):
            return None
        if any(not _is_missing(f.get(n)) for n in cond.note_fields):
            return None
        if rec.keys & ctx.noted_record_keys:
            return None
        return _Match(
            slots={"flag": display_value(cond.flag_field, flag, missing)},
            fields=[cond.flag_field, *cond.note_fields],
        )
    if isinstance(cond, SeriousWithoutPacket):
        value = f.get(cond.field)
        if not _equals(value, cond.values) or rec.keys & ctx.signed_packet_keys:
            return None
        return _Match(
            slots={"value": display_value(cond.field, value, missing)}, fields=[cond.field]
        )
    # ImmuneRelatedMarkedNo
    grade = _number(f.get(cond.grade_field))
    term = f.get(cond.term_field)
    if grade is None or grade < cond.min_grade or not isinstance(term, str):
        return None
    if not _equals(f.get(cond.irae_field), cond.no_values):
        return None
    found = _immune_category(term, cond)
    if found is None:
        return None
    category, table_file = found
    return _Match(
        slots={"grade": _fmt(grade, missing), "term": term.strip(), "irae_category": category},
        fields=[cond.irae_field, cond.grade_field, cond.term_field],
        evidence=[
            QueryEvidence(
                "table",
                table_file,
                None,
                f"{term.strip()}: potentially immune-related ({category})",
            )
        ],
    )


def _render(template: str, lookup: Callable[[str], str]) -> str:
    return _PLACEHOLDER.sub(lambda m: lookup(m.group(1)), template)


def _record_label(rec: _Record, table: EditCheckTable) -> str:
    missing = table.answer.missing_value
    return _render(
        table.record_labels[rec.domain],
        lambda n: display_value(n, rec.fields.get(n), missing),
    )


def _candidate(
    check: EditCheck, rec: _Record, match: _Match, table: EditCheckTable
) -> QueryCandidate:
    missing = table.answer.missing_value
    label = _record_label(rec, table)

    def lookup(name: str) -> str:
        if name == "record_label":
            return label
        if name in match.slots:
            return match.slots[name]
        return display_value(name, rec.fields.get(name), missing)

    primary = check.field if (not match.fields or check.field in match.fields) else match.fields[0]
    involved = tuple(_unique([primary, *match.fields]))
    rule_note = f"{check.id} on {rec.record_key}.{primary}"
    if check.protocol_ref is not None:
        rule_note += (
            f" (protocol section {check.protocol_ref.section}, "
            f"printed page {check.protocol_ref.printed_page})"
        )
    evidence: list[QueryEvidence] = [QueryEvidence("rule", check.id, None, rule_note)]
    evidence.extend(match.evidence)
    for name in involved:
        evidence.extend(rec.evidence.get(name, ()))
    seen: set[tuple[str, str]] = set()
    deduped: list[QueryEvidence] = []
    for ev in evidence:
        if (ev.kind, ev.id) not in seen:
            seen.add((ev.kind, ev.id))
            deduped.append(ev)
    return QueryCandidate(
        check_id=check.id,
        domain=rec.domain,
        record_key=rec.record_key,
        field=primary,
        text=_render(check.query_text, lookup),
        severity=check.severity,
        evidence=tuple(deduped),
        fields=involved,
        usubjid=rec.usubjid,
        protocol_ref=check.protocol_ref,
        lineage_key=rec.lineage_key,
        check_field=check.field,
    )


def run_edit_checks(
    records: Sequence[Mapping[str, object] | DraftRecord],
    context: QueryContext | Mapping[str, object] | None = None,
) -> list[QueryCandidate]:
    """Run every edit check on every record; one candidate per (check, record) failure.

    Order is deterministic: records in the order given, checks in table order. Rejected
    records are skipped. Malformed records raise :class:`ValueError` naming the record.

    Candidates are deduplicated on :attr:`QueryCandidate.key`, so one check raises at most
    one query per record lineage. Pass the latest version of each record; when several
    versions of one lineage are given, the first one given raises the query.
    """
    table = edit_check_table()
    ctx = _to_context(context)
    out: list[QueryCandidate] = []
    seen: set[str] = set()
    for index, raw in enumerate(records):
        rec = _to_record(raw, index)
        if rec.status == "rejected":
            continue
        for check in table.checks:
            if check.domain != rec.domain:
                continue
            match = _evaluate(check.condition, rec, ctx, table.answer.missing_value)
            if match is None:
                continue
            candidate = _candidate(check, rec, match, table)
            if candidate.key not in seen:
                seen.add(candidate.key)
                out.append(candidate)
    return out


# --------------------------------------------------------------------------- #
# Suggested answers
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class _QueryView:
    check_id: str | None
    field: str
    fields: tuple[str, ...]
    evidence: tuple[QueryEvidence, ...]


def _view(query: QueryCandidate | Mapping[str, object]) -> _QueryView:
    if isinstance(query, QueryCandidate):
        return _QueryView(
            query.check_id, query.field, query.fields or (query.field,), query.evidence
        )
    check_id = query.get("check_id")
    fld = query.get("field")
    if not isinstance(fld, str) or not fld:
        raise ValueError("query.field: expected the field the query is about")
    raw_fields = query.get("fields")
    fields = (
        tuple(str(v) for v in cast(Sequence[object], raw_fields))
        if isinstance(raw_fields, list | tuple) and raw_fields
        else (fld,)
    )
    return _QueryView(
        check_id if isinstance(check_id, str) and check_id else None,
        fld,
        tuple(_unique([fld, *fields])),
        _evidence_list(query.get("evidence"), "query.evidence"),
    )


def answer_facts(
    query: QueryCandidate | Mapping[str, object],
    record: Mapping[str, object] | DraftRecord,
    extra: Sequence[ExtraFact] = (),
) -> AnswerFacts:
    """Build the fact bundle :func:`suggest_answer` writes from.

    ``check`` cites the query's own rule and table pointers; each queried field cites the
    record's evidence for that field, or the check's pointers when the field has none (the
    check is what read the value); ``sources`` are the record's primary evidence for the
    queried fields; ``missing_fields`` comes from re-running the check on the record.
    """
    table = edit_check_table()
    view = _view(query)
    rec = _to_record(record, 0)
    missing = table.answer.missing_value
    check_ids_cited = _unique(e.id for e in view.evidence if e.kind in ("rule", "table"))
    if not check_ids_cited and view.check_id is not None:
        check_ids_cited = [view.check_id]
    facts: AnswerFacts = {}
    if check_ids_cited:
        facts["check"] = {"check_id": view.check_id or "manual", "evidence_ids": check_ids_cited}
    term_field = {"AE": "AETERM", "CM": "CMTRT", "VS": "VSTESTCD"}.get(rec.domain, view.field)
    label_ids = _unique(e.id for e in rec.evidence.get(term_field, ())) or check_ids_cited
    if label_ids:
        facts["record_label"] = {"value": _record_label(rec, table), "evidence_ids": label_ids}
    field_facts: list[FieldFact] = []
    sources: list[SourceFact] = []
    seen_sources: set[str] = set()
    for name in view.fields:
        own = rec.evidence.get(name, ())
        ids = _unique(e.id for e in own) or check_ids_cited
        value = rec.fields.get(name)
        if ids:
            fact: FieldFact = {
                "field": name,
                "plain_label": field_label(name),
                "value": None if _is_missing(value) else display_value(name, value, missing),
                "evidence_ids": ids,
            }
            recorded = None if _is_missing(value) else _fmt(value, missing)
            if recorded is not None and recorded != fact["value"]:
                fact["code"] = recorded
            field_facts.append(fact)
        for ev in own:
            if ev.kind in table.answer.source_kinds and ev.note and ev.id not in seen_sources:
                seen_sources.add(ev.id)
                source: SourceFact = {"kind": ev.kind, "note": ev.note, "evidence_ids": [ev.id]}
                if ev.ts:
                    source["ts"] = ev.ts
                sources.append(source)
    if field_facts:
        facts["fields"] = field_facts
    if sources:
        facts["sources"] = sources
    check = check_by_id(view.check_id) if view.check_id else None
    if check is not None:
        match = _evaluate(check.condition, rec, QueryContext(), missing)
        if match is not None and match.missing_labels:
            facts["missing_fields"] = list(match.missing_labels)
    if extra:
        facts["extra"] = [
            {"label": e["label"], "value": e["value"], "evidence_ids": list(e["evidence_ids"])}
            for e in extra
        ]
    return facts


def _ids_of(raw: object) -> list[str]:
    if not isinstance(raw, Mapping):
        return []
    ids = cast(Mapping[str, object], raw).get("evidence_ids")
    if not isinstance(ids, list | tuple):
        return []
    return _unique(v for v in cast(Sequence[object], ids) if isinstance(v, str) and v)


def _text_of(raw: Mapping[str, object], key: str) -> str | None:
    value = raw.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _format_ts(ts: str) -> str:
    when = _when(ts)
    if when is None or when[1] is None:
        return ts
    return when[1].strftime("%Y-%m-%d %H:%M UTC")


def _objects(raw: object) -> list[Mapping[str, object]]:
    if not isinstance(raw, list | tuple):
        return []
    return [
        cast(Mapping[str, object], v) for v in cast(Sequence[object], raw) if isinstance(v, Mapping)
    ]


def suggest_answer(
    query: QueryCandidate | Mapping[str, object], facts: Mapping[str, object]
) -> dict[str, object]:
    """Draft an answer to ``query`` from ``facts`` (an :data:`AnswerFacts` bundle).

    Returns ``{kind: "query_answer", writer: "template", sentences: [{text, evidence_ids,
    section, template_id}], text}`` (the :class:`~interim_rules.narrative.WrittenText`
    shape). Every sentence cites at least one evidence id and only ids present in
    ``facts``; a sentence whose facts are absent is left out. With nothing citable the
    result has no sentences and empty text, and the API shows no suggestion.
    """
    table = edit_check_table()
    cfg = table.answer
    tpl = cfg.templates
    view = _view(query)
    check = check_by_id(view.check_id) if view.check_id else None
    sentences: list[Sentence] = []

    def add(name: str, text: str, ids: Sequence[str]) -> None:
        if ids and text.strip():
            sentences.append(
                Sentence(
                    text=text,
                    evidence_ids=tuple(_unique(ids)),
                    section="answer",
                    template_id=f"{ANSWER_KIND}.{name}",
                )
            )

    check_ids = _ids_of(facts.get("check"))
    label_raw = facts.get("record_label")
    label_ids = _ids_of(label_raw)
    label = (
        _text_of(cast(Mapping[str, object], label_raw), "value")
        if isinstance(label_raw, Mapping)
        else None
    )
    field_objs = _objects(facts.get("fields"))
    primary_label = next(
        (
            _text_of(o, "plain_label")
            for o in field_objs
            if o.get("field") == view.field and _text_of(o, "plain_label")
        ),
        None,
    ) or field_label(view.field)

    if label is not None and check_ids and label_ids:
        add(
            "opening",
            _render(
                tpl["opening"], {"plain_label": primary_label, "record_label": label}.__getitem__
            ),
            [*check_ids, *label_ids],
        )
    for obj in field_objs:
        ids = _ids_of(obj)
        name = _text_of(obj, "field") or ""
        plain = _text_of(obj, "plain_label") or field_label(name)
        value = _text_of(obj, "value")
        if value is None:
            add(
                "field_missing",
                _render(tpl["field_missing"], {"plain_label": plain}.__getitem__),
                ids,
            )
        else:
            key = "field_value_grade" if name in cfg.grade_fields else "field_value"
            add(key, _render(tpl[key], {"plain_label": plain, "value": value}.__getitem__), ids)
    shown = 0
    for obj in _objects(facts.get("sources")):
        if shown >= cfg.max_source_sentences:
            break
        kind = _text_of(obj, "kind")
        note = obj.get("note")
        if kind not in cfg.source_kinds or not isinstance(note, str) or not note.strip():
            continue
        slots = {"kind_label": cfg.kind_labels[kind], "note": note}
        ts = _text_of(obj, "ts")
        if ts is not None:
            slots["when"] = _format_ts(ts)
            add("source", _render(tpl["source"], slots.__getitem__), _ids_of(obj))
        else:
            add("source_no_time", _render(tpl["source_no_time"], slots.__getitem__), _ids_of(obj))
        shown += 1
    for obj in _objects(facts.get("extra")):
        extra_label, extra_value = _text_of(obj, "label"), _text_of(obj, "value")
        if extra_label and extra_value:
            add(
                "extra",
                _render(tpl["extra"], {"label": extra_label, "value": extra_value}.__getitem__),
                _ids_of(obj),
            )
    if check is not None and check_ids:
        missing_raw = facts.get("missing_fields")
        missing_words = (
            [str(v) for v in cast(Sequence[object], missing_raw) if isinstance(v, str) and v]
            if isinstance(missing_raw, list | tuple)
            else []
        )
        slots_close: dict[str, str] = {}
        if label is not None:
            slots_close["record_label"] = label
        if missing_words:
            slots_close["missing_fields"] = _join(missing_words)
        needed = set(_placeholders(check.answer_close))
        if needed <= set(slots_close):
            close_ids = [*check_ids, *(label_ids if "record_label" in needed else [])]
            add("close", _render(check.answer_close, slots_close.__getitem__), close_ids)

    written = WrittenText(
        kind=cfg.kind,
        writer=cfg.writer,
        sentences=tuple(sentences),
        text=cfg.sentence_separator.join(s.text for s in sentences),
    )
    return written.to_dict()


__all__ = [
    "ANSWER_KIND",
    "DOMAINS",
    "QUERY_TABLE_NAMES",
    "SEVERITIES",
    "TABLE_FILE",
    "AnswerFacts",
    "EditCheck",
    "EditCheckTable",
    "ExtraFact",
    "FieldFact",
    "QueryCandidate",
    "QueryContext",
    "QueryEvidence",
    "Severity",
    "SourceFact",
    "answer_facts",
    "check_by_id",
    "check_ids",
    "display_value",
    "edit_check_table",
    "edit_checks",
    "field_label",
    "parse_edit_checks",
    "run_edit_checks",
    "suggest_answer",
]
