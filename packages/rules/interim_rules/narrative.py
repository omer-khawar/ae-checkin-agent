"""Template writer for SAE/AESI narratives and visit briefs (CLAUDE.md §00.2–§00.4, CONTRACTS R3.1).

Rules decide, text tools write, people confirm. This module is the default
text tool: :func:`write` turns a structured fact bundle into short, plain,
past-tense sentences, and every sentence cites the evidence ids of the facts it
was built from. It is pure (no I/O beyond the package's own
``narrative_templates.json``, no clock, no network, no LLM) and deterministic:
the same facts always produce the same text.

* **Facts** are plain dicts built by the API from database rows. Their shapes
  are the TypedDicts below (:class:`SaeFacts`, :class:`BriefFacts`). Every fact
  carries ``evidence_ids``; a fact with no evidence id, or with an empty value,
  is treated as absent, because a sentence may only say what it can cite.
* **Wording** lives in ``data/narrative_templates.json``. The code formats fact
  values (dates, numbers, coded labels) into slots and lets the table's
  variants decide the sentence. A sentence whose facts are missing is omitted;
  the only sentence about absent data is "Information still needed: ...",
  built from the caller's ``missing_information`` list.
* :func:`validate_written` checks any :class:`WrittenText`, including an LLM
  writer's output, against the facts: unknown evidence ids, empty sentences,
  quoted passages that are not verbatim in a fact the same sentence cites, filler
  and advice words, and grades, AESI mentions or seriousness/causality wording
  without the "investigator to confirm" qualifier.
  The API's LLM adapter accepts LLM text only when it returns no problems.

Malformed facts (a wrong type, an unrecognized coded value, an unparseable
date) raise :class:`ValueError` naming the field; the API builds facts from its
own rows, so a malformed bundle is a bug to surface, not text to guess at.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Literal, Required, TypedDict, cast

from .narrative_templates import (
    KINDS,
    TABLE_FILE,
    NarrativeTemplates,
    Scope,
    Slot,
    join_list,
    narrative_templates,
    render,
    unique,
)
from .timefmt import parse_iso_utc

NARRATIVE_TABLE_NAMES: tuple[str, ...] = ("narrative_templates",)
"""The JSON table this module owns (not part of :data:`interim_rules.tables.TABLE_NAMES`)."""

NarrativeKind = Literal["sae_narrative", "aesi_narrative", "visit_brief"]
WriterName = Literal["template", "llm"]
WRITERS: tuple[str, ...] = ("template", "llm")

ConMedChange = Literal["started", "stopped", "taking", "changed"]
ProtocolFlag = Literal["prohibited", "discouraged", "permitted"]
PROTOCOL_FLAGS: tuple[str, ...] = ("prohibited", "discouraged", "permitted")
QuestionKind = Literal["cm_missing_fields", "unresolved_ae", "unsigned_packet", "other"]
QUESTION_KINDS: tuple[str, ...] = ("cm_missing_fields", "unresolved_ae", "unsigned_packet", "other")
ClockKind = Literal["sae", "aesi"]
ClockStatus = Literal["running", "reported (mock)", "stopped"]


# --------------------------------------------------------------------------- #
# Fact schemas (documented in the package README)
# --------------------------------------------------------------------------- #


class TextFact(TypedDict):
    """A single value and the evidence behind it. Dates are ``YYYY-MM-DD`` or ISO-8601 UTC."""

    value: str
    evidence_ids: list[str]


class EventFact(TypedDict):
    """The event: CTCAE term (``AEDECOD``) and the plain label shown to non-clinicians."""

    term: str
    plain_label: str
    evidence_ids: list[str]


class GradeFact(TypedDict):
    """A provisional CTCAE grade (0–5); always rendered as provisional."""

    grade: int
    evidence_ids: list[str]


class DeadlineFact(TypedDict, total=False):
    """The 24-hour reporting deadline and the protocol section that sets it."""

    due_at: Required[str]
    hours: Required[float]
    protocol_section: str
    printed_page: int
    evidence_ids: Required[list[str]]


class QuoteFact(TypedDict, total=False):
    """A verbatim passage from a source record (chart note, free text)."""

    text: Required[str]
    source_label: str
    evidence_ids: Required[list[str]]


class ConMedFact(TypedDict, total=False):
    """A concomitant medication with its protocol status (``protocol_rules.json``)."""

    name: Required[str]
    direction: Required[ConMedChange]
    date: str
    protocol_flag: ProtocolFlag
    protocol_section: str
    printed_page: int
    exception_text: str
    missing_fields: list[str]
    evidence_ids: Required[list[str]]


class EscalationFact(TypedDict, total=False):
    """An escalation tier and whether the on-call role acknowledged it."""

    tier: Required[int]
    tier_name: Required[str]
    date: str
    reason: str
    acknowledged: bool
    acknowledged_at: str
    evidence_ids: Required[list[str]]


class SaeFacts(TypedDict, total=False):
    """Facts for an SAE or AESI narrative (``write("sae_narrative" | "aesi_narrative", ...)``).

    ``kind`` must match the narrative kind when given. ``seriousness_criteria``
    and ``aesi_reasons`` are lists of plain statements (each a :class:`TextFact`);
    ``missing_information`` lists what the follow-up report still needs.
    """

    kind: ClockKind
    participant: TextFact
    study_id: TextFact
    study_drug: TextFact
    last_dose: TextFact
    event: EventFact
    onset: TextFact
    quotes: list[QuoteFact]
    provisional_grade: GradeFact
    site_awareness_at: TextFact
    awareness_source: TextFact
    seriousness_criteria: list[TextFact]
    aesi_reasons: list[TextFact]
    deadline: DeadlineFact
    conmeds: list[ConMedFact]
    escalation: EscalationFact
    action_taken: TextFact
    outcome: TextFact
    causality: TextFact
    reporter_role: TextFact
    missing_information: list[TextFact]


class GradePoint(TypedDict, total=False):
    grade: Required[int]
    date: str
    evidence_ids: Required[list[str]]


class SideEffectFact(TypedDict, total=False):
    """A side effect new since the cut-off, with its provisional grades over time."""

    term: Required[str]
    plain_label: Required[str]
    grades: list[GradePoint]
    evidence_ids: Required[list[str]]


class OpenAeFact(TypedDict, total=False):
    term: Required[str]
    plain_label: Required[str]
    onset: str
    last_reported: str
    ongoing: bool
    evidence_ids: Required[list[str]]


class ClockFact(TypedDict, total=False):
    """A 24-hour reporting clock (``sae`` or possible ``aesi``)."""

    kind: Required[ClockKind]
    event_label: Required[str]
    hours: float
    due_at: Required[str]
    status: ClockStatus
    evidence_ids: Required[list[str]]


class NoteFact(TypedDict, total=False):
    note_type: Required[str]
    note_date: str
    author: str
    n_symptoms: int
    n_meds: int
    evidence_ids: Required[list[str]]


class VitalsFact(TypedDict, total=False):
    """Vitals context only; ``is_measured`` false renders the word "simulated"."""

    is_measured: Required[bool]
    source: Required[str]
    pulse_median: float
    breathing_median: float
    date: str
    evidence_ids: Required[list[str]]


class QuestionFact(TypedDict):
    """A question to ask at the visit; see :func:`derive_questions`."""

    kind: QuestionKind
    subject: str
    details: list[str]
    evidence_ids: list[str]


class BriefFacts(TypedDict, total=False):
    """Facts for a visit-prep brief (``write("visit_brief", ...)``).

    A list given as ``[]`` means "none since the cut-off" and produces a
    "No ... were recorded" sentence for side effects and medication changes; an
    absent list says nothing. ``questions`` defaults to :func:`derive_questions`.
    """

    participant: TextFact
    since: TextFact
    next_visit: TextFact
    new_side_effects: list[SideEffectFact]
    open_aes: list[OpenAeFact]
    med_changes: list[ConMedFact]
    escalations: list[EscalationFact]
    clocks: list[ClockFact]
    notes: list[NoteFact]
    vitals: VitalsFact
    questions: list[QuestionFact]
    missing_information: list[TextFact]


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Sentence:
    """One generated sentence, the evidence it cites, and where it belongs."""

    text: str
    evidence_ids: tuple[str, ...]
    section: str
    template_id: str

    def to_dict(self) -> dict[str, object]:
        return {
            "text": self.text,
            "evidence_ids": list(self.evidence_ids),
            "section": self.section,
            "template_id": self.template_id,
        }


@dataclass(frozen=True)
class WrittenText:
    """``{kind, writer, sentences, text}``; ``text`` is the sentences joined (CONTRACTS R3.1)."""

    kind: str
    writer: WriterName
    sentences: tuple[Sentence, ...]
    text: str
    fallback_reason: str | None = field(default=None)

    def to_dict(self) -> dict[str, object]:
        out: dict[str, object] = {
            "kind": self.kind,
            "writer": self.writer,
            "sentences": [s.to_dict() for s in self.sentences],
            "text": self.text,
        }
        if self.fallback_reason is not None:
            out["fallback_reason"] = self.fallback_reason
        return out


def section_titles() -> dict[str, str]:
    """Plain section titles keyed by :attr:`Sentence.section` (from the template table)."""
    return dict(narrative_templates().sections)


# --------------------------------------------------------------------------- #
# Fact readers: typed access with a precise error path
# --------------------------------------------------------------------------- #

FactMap = Mapping[str, object]
_DATE_ONLY = re.compile(r"\d{4}-\d{2}-\d{2}")


def _obj(value: object, where: str) -> FactMap | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError(f"{where}: expected an object")
    return cast(FactMap, value)


def _objs(value: object, where: str) -> list[FactMap] | None:
    if value is None:
        return None
    if not isinstance(value, list | tuple):
        raise ValueError(f"{where}: expected a list")
    out: list[FactMap] = []
    for i, entry in enumerate(cast(Sequence[object], value)):
        obj = _obj(entry, f"{where}[{i}]")
        if obj is None:
            raise ValueError(f"{where}[{i}]: expected an object")
        out.append(obj)
    return out


def _ids(m: FactMap, where: str) -> tuple[str, ...]:
    raw = m.get("evidence_ids")
    if raw is None:
        return ()
    if not isinstance(raw, list | tuple):
        raise ValueError(f"{where}.evidence_ids: expected a list of strings")
    out: list[str] = []
    for i, value in enumerate(cast(Sequence[object], raw)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{where}.evidence_ids[{i}]: expected a non-empty string")
        out.append(value)
    return unique(out)


def _str(m: FactMap, key: str, where: str) -> str | None:
    value = m.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{where}.{key}: expected a string")
    return value.strip() or None


def _int(m: FactMap, key: str, where: str) -> int | None:
    value = m.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{where}.{key}: expected an integer")
    return value


def _num(m: FactMap, key: str, where: str) -> str | None:
    value = m.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{where}.{key}: expected a number")
    if not math.isfinite(value):
        raise ValueError(f"{where}.{key}: expected a finite number")
    return f"{value:g}"


def _bool(m: FactMap, key: str, where: str) -> bool | None:
    value = m.get(key)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ValueError(f"{where}.{key}: expected true or false")
    return value


def _strs(m: FactMap, key: str, where: str) -> list[str]:
    value = m.get(key)
    if value is None:
        return []
    if not isinstance(value, list | tuple):
        raise ValueError(f"{where}.{key}: expected a list of strings")
    out: list[str] = []
    for i, entry in enumerate(cast(Sequence[object], value)):
        if not isinstance(entry, str):
            raise ValueError(f"{where}.{key}[{i}]: expected a string")
        if entry.strip():
            out.append(entry.strip())
    return out


def _coded(value: str | None, allowed: Sequence[str], where: str) -> str | None:
    if value is not None and value not in allowed:
        raise ValueError(f"{where}: {value!r} is not one of {list(allowed)}")
    return value


def _format_when(value: str, where: str, tpl: NarrativeTemplates) -> str:
    """``YYYY-MM-DD`` stays as is; a timestamp renders in UTC with the table's format."""
    if _DATE_ONLY.fullmatch(value):
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"{where}: not a valid date: {value!r}") from exc
        return value
    try:
        moment = parse_iso_utc(value)
    except ValueError as exc:
        raise ValueError(f"{where}: {exc}") from exc
    return moment.strftime(tpl.formats.datetime)


# --------------------------------------------------------------------------- #
# Scope builders: facts -> formatted slots (each with its fact's evidence ids)
# --------------------------------------------------------------------------- #


class _Builder:
    """Collects slots and flags for one scope; skips any value without evidence."""

    def __init__(self, tpl: NarrativeTemplates) -> None:
        self.tpl = tpl
        self.slots: dict[str, Slot] = {}
        self.flags: dict[str, str] = {}

    def put(self, name: str, text: str | None, ids: Sequence[str]) -> None:
        if text is not None and ids:
            self.slots[name] = Slot(text, tuple(ids))

    def text_fact(self, facts: FactMap, key: str, name: str, *, when: bool = False) -> None:
        fact = _obj(facts.get(key), key)
        if fact is None:
            return
        value = _str(fact, "value", key)
        if value is not None and when:
            value = _format_when(value, f"{key}.value", self.tpl)
        self.put(name, value, _ids(fact, key))

    def joined(self, facts: FactMap, key: str, name: str) -> None:
        """Join a list of :class:`TextFact` values into one slot citing all of them."""
        entries = _objs(facts.get(key), key) or []
        texts: list[str] = []
        ids: list[str] = []
        for i, entry in enumerate(entries):
            where = f"{key}[{i}]"
            value = _str(entry, "value", where)
            entry_ids = _ids(entry, where)
            if value is not None and entry_ids:
                texts.append(value)
                ids.extend(entry_ids)
        if texts:
            self.put(name, join_list(texts, self.tpl.formats), unique(ids))

    def fragment(self, fragment: str, name: str, ids: Sequence[str]) -> None:
        """Render a table fragment into slot ``name``, citing ``ids`` plus its slots' ids."""
        rendered = render(self.tpl.fragments[fragment], self.scope(), require_evidence=False)
        if rendered is not None:
            self.put(name, rendered.text, unique([*rendered.evidence_ids, *ids]))

    def scope(self) -> Scope:
        return Scope(dict(self.slots), dict(self.flags))


_Lists = dict[str, tuple[tuple[Scope, ...], int]]
"""``for_each`` key -> (usable element scopes, number of entries the caller passed)."""


def _label(tpl: NarrativeTemplates, group: str, code: str, where: str) -> str:
    labels = tpl.labels[group]
    if code not in labels:
        raise ValueError(f"{where}: {code!r} is not one of {sorted(labels)}")
    return labels[code]


def _plain_fields(tpl: NarrativeTemplates, names: Sequence[str]) -> list[str]:
    labels = tpl.labels["cm_fields"]
    return [labels.get(name, name) for name in names]


def _conmed_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    direction = _str(m, "direction", where)
    flag = _coded(_str(m, "protocol_flag", where), PROTOCOL_FLAGS, f"{where}.protocol_flag")
    date_text = _str(m, "date", where)
    page = _int(m, "printed_page", where)
    missing = _plain_fields(tpl, _strs(m, "missing_fields", where))
    b.put("name", _str(m, "name", where), ids)
    if direction is not None:
        b.put("verb", _label(tpl, "conmed_direction", direction, f"{where}.direction"), ids)
    if date_text is not None:
        b.put("date", _format_when(date_text, f"{where}.date", tpl), ids)
    b.put("section", _str(m, "protocol_section", where), ids)
    b.put("page", None if page is None else str(page), ids)
    b.put("exception", _str(m, "exception_text", where), ids)
    b.put("missing", join_list(missing, tpl.formats) if missing else None, ids)
    if flag is not None:
        b.flags["flag"] = flag
    b.fragment("conmed_action", "action", ids)
    b.fragment("conmed_protocol", "protocol", ids)
    return b.scope()


def _escalation_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    tier = _int(m, "tier", where)
    date_text = _str(m, "date", where)
    acked_at = _str(m, "acknowledged_at", where)
    acknowledged = _bool(m, "acknowledged", where)
    b.put("tier", None if tier is None else str(tier), ids)
    b.put("tier_name", _str(m, "tier_name", where), ids)
    b.put("reason", _str(m, "reason", where), ids)
    if date_text is not None:
        b.put("date", _format_when(date_text, f"{where}.date", tpl), ids)
    if acked_at is not None:
        b.put("acked_at", _format_when(acked_at, f"{where}.acknowledged_at", tpl), ids)
    if acknowledged is not None:
        b.flags["acknowledged"] = "true" if acknowledged else "false"
        b.fragment("acknowledgement", "ack", ids)
    return b.scope()


def _elements(
    facts: FactMap,
    key: str,
    build: Callable[[FactMap, str, NarrativeTemplates], Scope],
    tpl: NarrativeTemplates,
    lists: _Lists,
) -> None:
    entries = _objs(facts.get(key), key)
    if entries is None:
        return
    scopes = tuple(build(entry, f"{key}[{i}]", tpl) for i, entry in enumerate(entries))
    lists[key] = (scopes, len(entries))


def _quote_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    b.put("text", _str(m, "text", where), ids)
    b.put("source", _str(m, "source_label", where), ids)
    return b.scope()


def _sae_context(facts: FactMap, facts_kind: str, tpl: NarrativeTemplates) -> tuple[Scope, _Lists]:
    declared = _str(facts, "kind", "facts")
    if declared is not None and declared != facts_kind:
        raise ValueError(f"facts.kind: {declared!r} does not match this narrative ({facts_kind!r})")
    b = _Builder(tpl)
    b.flags["kind"] = facts_kind
    for key in ("participant", "study_id", "study_drug", "awareness_source", "action_taken"):
        b.text_fact(facts, key, key)
    for key in ("outcome", "causality", "reporter_role"):
        b.text_fact(facts, key, key)
    for key in ("last_dose", "onset", "site_awareness_at"):
        b.text_fact(facts, key, key, when=True)
    event = _obj(facts.get("event"), "event")
    if event is not None:
        ids = _ids(event, "event")
        b.put("event_label", _str(event, "plain_label", "event"), ids)
        b.put("event_term", _str(event, "term", "event"), ids)
    grade = _obj(facts.get("provisional_grade"), "provisional_grade")
    if grade is not None:
        value = _int(grade, "grade", "provisional_grade")
        if value is not None and not 0 <= value <= 5:
            raise ValueError("provisional_grade.grade: expected 0 to 5")
        b.put("grade", None if value is None else str(value), _ids(grade, "provisional_grade"))
    deadline = _obj(facts.get("deadline"), "deadline")
    if deadline is not None:
        ids = _ids(deadline, "deadline")
        due = _str(deadline, "due_at", "deadline")
        page = _int(deadline, "printed_page", "deadline")
        b.put("deadline", None if due is None else _format_when(due, "deadline.due_at", tpl), ids)
        b.put("deadline_hours", _num(deadline, "hours", "deadline"), ids)
        b.put("deadline_section", _str(deadline, "protocol_section", "deadline"), ids)
        b.put("deadline_page", None if page is None else str(page), ids)
    b.joined(facts, "seriousness_criteria", "criteria")
    b.joined(facts, "aesi_reasons", "aesi_reasons")
    b.joined(facts, "missing_information", "missing")
    escalation = _obj(facts.get("escalation"), "escalation")
    if escalation is not None:
        esc = _escalation_scope(escalation, "escalation", tpl)
        b.slots.update({f"esc.{name}": slot for name, slot in esc.slots.items()})
    lists: _Lists = {}
    _elements(facts, "quotes", _quote_scope, tpl, lists)
    _elements(facts, "conmeds", _conmed_scope, tpl, lists)
    return b.scope(), lists


def _side_effect_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    b.put("label", _str(m, "plain_label", where), ids)
    b.put("term", _str(m, "term", where), ids)
    points: list[tuple[str, int, Slot]] = []
    for i, point in enumerate(_objs(m.get("grades"), f"{where}.grades") or []):
        pw = f"{where}.grades[{i}]"
        pb = _Builder(tpl)
        point_ids = _ids(point, pw)
        grade = _int(point, "grade", pw)
        when = _str(point, "date", pw)
        if grade is None or not point_ids:
            continue
        pb.put("grade", str(grade), point_ids)
        if when is not None:
            pb.put("date", _format_when(when, f"{pw}.date", tpl), point_ids)
        rendered = render(tpl.fragments["grade_point"], pb.scope(), require_evidence=True)
        if rendered is not None:
            points.append((when or "", grade, rendered))
    if all(when for when, _, _ in points):
        points.sort(key=lambda p: p[0])
    if points:
        trend_ids = unique(i for _, _, slot in points for i in slot.evidence_ids)
        b.put(
            "trend", tpl.formats.trend_separator.join(slot.text for _, _, slot in points), trend_ids
        )
        if len(points) >= 2:
            first, last = points[0][1], points[-1][1]
            code = "worsening" if last > first else "improving" if last < first else "unchanged"
            b.put("direction", _label(tpl, "trend", code, f"{where}.grades"), trend_ids)
    return b.scope()


def _open_ae_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    b.put("label", _str(m, "plain_label", where), ids)
    b.put("term", _str(m, "term", where), ids)
    for key, name in (("onset", "onset"), ("last_reported", "last_reported")):
        value = _str(m, key, where)
        if value is not None:
            b.put(name, _format_when(value, f"{where}.{key}", tpl), ids)
    ongoing = _bool(m, "ongoing", where)
    if ongoing is not None:
        status = _label(tpl, "ae_status", "ongoing" if ongoing else "resolved", where)
        b.put("status", status, ids)
    return b.scope()


def _clock_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    kind = _str(m, "kind", where)
    status = _str(m, "status", where)
    due = _str(m, "due_at", where)
    if kind is not None:
        b.put("kind", _label(tpl, "clock_kind", kind, f"{where}.kind"), ids)
    if status is not None:
        b.put("status", _label(tpl, "clock_status", status, f"{where}.status"), ids)
    if due is not None:
        b.put("due", _format_when(due, f"{where}.due_at", tpl), ids)
    b.put("event", _str(m, "event_label", where), ids)
    b.put("hours", _num(m, "hours", where), ids)
    return b.scope()


def _note_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    note_date = _str(m, "note_date", where)
    n_symptoms = _int(m, "n_symptoms", where)
    n_meds = _int(m, "n_meds", where)
    b.put("type", _str(m, "note_type", where), ids)
    b.put("author", _str(m, "author", where), ids)
    if note_date is not None:
        b.put("date", _format_when(note_date, f"{where}.note_date", tpl), ids)
    b.put("n_symptoms", None if n_symptoms is None else str(n_symptoms), ids)
    b.put("n_meds", None if n_meds is None else str(n_meds), ids)
    return b.scope()


def _question_scope(m: FactMap, where: str, tpl: NarrativeTemplates) -> Scope:
    b = _Builder(tpl)
    ids = _ids(m, where)
    kind = _coded(_str(m, "kind", where), QUESTION_KINDS, f"{where}.kind")
    details = _plain_fields(tpl, _strs(m, "details", where))
    b.put("subject", _str(m, "subject", where), ids)
    b.put("details", join_list(details, tpl.formats) if details else None, ids)
    if kind is not None:
        b.flags["kind"] = kind
    return b.scope()


def _brief_context(facts: FactMap, tpl: NarrativeTemplates) -> tuple[Scope, _Lists]:
    b = _Builder(tpl)
    b.text_fact(facts, "participant", "participant")
    b.text_fact(facts, "since", "since", when=True)
    b.text_fact(facts, "next_visit", "next_visit", when=True)
    b.joined(facts, "missing_information", "missing")
    vitals = _obj(facts.get("vitals"), "vitals")
    if vitals is not None:
        ids = _ids(vitals, "vitals")
        measured = _bool(vitals, "is_measured", "vitals")
        when = _str(vitals, "date", "vitals")
        if measured is not None:
            method = _label(tpl, "vitals_method", "measured" if measured else "simulated", "vitals")
            b.put("vitals.method", method, ids)
        b.put("vitals.source", _str(vitals, "source", "vitals"), ids)
        b.put("vitals.pulse", _num(vitals, "pulse_median", "vitals"), ids)
        b.put("vitals.breathing", _num(vitals, "breathing_median", "vitals"), ids)
        if when is not None:
            b.put("vitals.date", _format_when(when, "vitals.date", tpl), ids)
    lists: _Lists = {}
    _elements(facts, "new_side_effects", _side_effect_scope, tpl, lists)
    _elements(facts, "open_aes", _open_ae_scope, tpl, lists)
    _elements(facts, "med_changes", _conmed_scope, tpl, lists)
    _elements(facts, "escalations", _escalation_scope, tpl, lists)
    _elements(facts, "clocks", _clock_scope, tpl, lists)
    _elements(facts, "notes", _note_scope, tpl, lists)
    questions = facts.get("questions")
    if questions is None:
        derived = cast(list[object], derive_questions(facts))
        questions = derived if derived else None
    _elements({"questions": questions}, "questions", _question_scope, tpl, lists)
    return b.scope(), lists


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def _question(kind: QuestionKind, subject: str, ids: Sequence[str]) -> QuestionFact:
    return {"kind": kind, "subject": subject, "details": [], "evidence_ids": list(ids)}


def derive_questions(facts: Mapping[str, object]) -> list[QuestionFact]:
    """Deterministic "questions to ask at the visit" (CLAUDE.md §00.4).

    In order: medications whose record still lacks protocol-required CM fields
    (§7.7, p. 69), open AEs not yet resolved, and reporting clocks still running
    (an unsigned packet). Each question cites the evidence of the fact it came from.
    """
    out: list[QuestionFact] = []
    for i, med in enumerate(_objs(facts.get("med_changes"), "med_changes") or []):
        where = f"med_changes[{i}]"
        name, ids = _str(med, "name", where), _ids(med, where)
        missing = _strs(med, "missing_fields", where)
        if name is not None and ids and missing:
            question: QuestionFact = {
                "kind": "cm_missing_fields",
                "subject": name,
                "details": missing,
                "evidence_ids": list(ids),
            }
            out.append(question)
    for i, ae in enumerate(_objs(facts.get("open_aes"), "open_aes") or []):
        where = f"open_aes[{i}]"
        label, ids = _str(ae, "plain_label", where), _ids(ae, where)
        if label is not None and ids and _bool(ae, "ongoing", where):
            out.append(_question("unresolved_ae", label, ids))
    for i, clock in enumerate(_objs(facts.get("clocks"), "clocks") or []):
        where = f"clocks[{i}]"
        label, ids = _str(clock, "event_label", where), _ids(clock, where)
        if label is not None and ids and _str(clock, "status", where) == "running":
            out.append(_question("unsigned_packet", label, ids))
    return out


def write(kind: str, facts: Mapping[str, object]) -> WrittenText:
    """Assemble the text for ``kind`` from ``facts``; pure and deterministic.

    ``kind`` is ``"sae_narrative"``, ``"aesi_narrative"`` or ``"visit_brief"``.
    Every returned sentence cites at least one evidence id taken from the facts
    it used; sentences whose facts are absent are omitted.
    """
    tpl = narrative_templates()
    spec = tpl.kinds.get(kind)
    if spec is None:
        raise ValueError(f"kind: {kind!r} is not one of {list(KINDS)}")
    if not isinstance(facts, Mapping):
        raise ValueError("facts: expected an object")
    if spec.facts_kind is None:
        scope, lists = _brief_context(facts, tpl)
    else:
        scope, lists = _sae_context(facts, spec.facts_kind, tpl)
    sentences: list[Sentence] = []
    for sentence in spec.sentences:
        template_id = f"{kind}.{sentence.id}"
        rendered: list[Slot | None]
        if sentence.for_each is None or sentence.alias is None:
            rendered = [render(sentence.variants, scope, require_evidence=True)]
        else:
            elements, passed = lists.get(sentence.for_each, ((), -1))
            if passed == 0:
                rendered = [render(sentence.if_empty, scope, require_evidence=True)]
            else:
                alias = sentence.alias
                rendered = [
                    render(sentence.variants, scope.merged(alias, el), require_evidence=True)
                    for el in elements
                ]
        sentences.extend(
            Sentence(_tidy_end(slot.text), slot.evidence_ids, sentence.section, template_id)
            for slot in rendered
            if slot is not None
        )
    text = tpl.formats.sentence_separator.join(s.text for s in sentences)
    return WrittenText(kind=kind, writer="template", sentences=tuple(sentences), text=text)


_DOUBLED_STOP = re.compile(r"([.!?])([\"”])\.$")


def _tidy_end(text: str) -> str:
    """Drop the template's closing period after a verbatim quote that already ends a sentence.

    ``...this exception: "...to treat an irAE.".`` becomes ``..."...to treat an irAE."``;
    the quoted text itself is never changed.
    """
    return _DOUBLED_STOP.sub(r"\1\2", text)


def _walk(value: object) -> Iterator[tuple[str | None, object]]:
    """Yield ``(key, value)`` for every value nested in dicts and lists (key None in lists)."""
    if isinstance(value, Mapping):
        for key, inner in cast(Mapping[object, object], value).items():
            yield (key if isinstance(key, str) else None), inner
            yield from _walk(inner)
    elif isinstance(value, list | tuple):
        for inner in cast(Sequence[object], value):
            yield None, inner
            yield from _walk(inner)


def collect_evidence_ids(facts: Mapping[str, object]) -> tuple[str, ...]:
    """Every evidence id anywhere in ``facts`` (the ids a sentence may cite)."""
    ids: list[str] = []
    for key, value in _walk(facts):
        if key == "evidence_ids" and isinstance(value, list | tuple):
            ids.extend(v for v in cast(Sequence[object], value) if isinstance(v, str))
    return unique(ids)


def _strings_in(value: object, out: list[str]) -> None:
    """Append every string nested in ``value``, skipping ``evidence_ids`` lists."""
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, Mapping):
        for key, inner in cast(Mapping[object, object], value).items():
            if key != "evidence_ids":
                _strings_in(inner, out)
    elif isinstance(value, list | tuple):
        for inner in cast(Sequence[object], value):
            _strings_in(inner, out)


def collect_fact_strings(facts: Mapping[str, object]) -> tuple[str, ...]:
    """Every string value in ``facts`` outside ``evidence_ids`` (what a quote may reproduce)."""
    out: list[str] = []
    _strings_in(facts, out)
    return unique(out)


def strings_by_evidence_id(facts: Mapping[str, object]) -> dict[str, tuple[str, ...]]:
    """For each evidence id, the strings of the fact object(s) that carry it.

    A fact object is any mapping with an ``evidence_ids`` list; its strings are
    every string nested inside it (outside ``evidence_ids``). A quoted passage
    in a sentence must come from a fact the sentence cites, not from any fact
    in the bundle, so a quote cannot be attributed to the wrong source.
    """
    found: dict[str, list[str]] = {}

    def visit(value: object) -> None:
        if isinstance(value, Mapping):
            mapping = cast(Mapping[object, object], value)
            raw_ids = mapping.get("evidence_ids")
            if isinstance(raw_ids, list | tuple):
                strings: list[str] = []
                _strings_in(mapping, strings)
                for ident in cast(Sequence[object], raw_ids):
                    if isinstance(ident, str):
                        found.setdefault(ident, []).extend(strings)
            for inner in mapping.values():
                visit(inner)
        elif isinstance(value, list | tuple):
            for inner in cast(Sequence[object], value):
                visit(inner)

    visit(facts)
    return {ident: unique(strings) for ident, strings in found.items()}


# Straight or curly double quotes, curly single quotes, and straight single quotes
# that open after a non-word character and close before one (so an apostrophe in
# "participant's" is not read as a quote).
_QUOTED = re.compile(
    r"\"([^\"\n]*)\"|“([^”\n]*)”|‘([^’\n]*)’"
    r"|(?<![\w'])'([^'\n]+)'(?![\w'])"
)


def quoted_passages(text: str) -> list[str]:
    """Passages inside straight or curly double or single quotes, in order."""
    return [next((g for g in groups if g), "") for groups in _QUOTED.findall(text)]


def validate_written(
    written: WrittenText | Mapping[str, object], facts: Mapping[str, object]
) -> list[str]:
    """Problems with ``written`` measured against ``facts``; an empty list means acceptable.

    Checks: known kind and writer; at least one sentence; no empty sentence; every
    sentence cites at least one evidence id and every id exists in the facts;
    every quoted passage (double or single quotes, straight or curly) appears
    verbatim in a fact that the same sentence cites; no filler or advice
    wording (``validation.forbidden_patterns``); grades (``grade 3``, ``G3``),
    AESI mentions, and seriousness or causality wording carry their
    "investigator to confirm" qualifier (``validation.qualifiers``); and
    ``text`` equals the sentences joined with the table's separator.
    """
    tpl = narrative_templates()
    data: Mapping[str, object] = written.to_dict() if isinstance(written, WrittenText) else written
    problems: list[str] = []
    if data.get("kind") not in tpl.kinds:
        problems.append(f"kind {data.get('kind')!r} is not one of {list(KINDS)}")
    if data.get("writer") not in WRITERS:
        problems.append(f"writer {data.get('writer')!r} is not one of {list(WRITERS)}")
    raw_sentences = data.get("sentences")
    if not isinstance(raw_sentences, list | tuple) or not raw_sentences:
        problems.append("there are no sentences")
        return problems
    known_ids = set(collect_evidence_ids(facts))
    by_id = strings_by_evidence_id(facts)
    texts: list[str] = []
    for n, raw in enumerate(cast(Sequence[object], raw_sentences), start=1):
        where = f"sentence {n}"
        if not isinstance(raw, Mapping):
            problems.append(f"{where}: expected an object with text and evidence_ids")
            continue
        sentence = cast(Mapping[str, object], raw)
        text = sentence.get("text")
        if not isinstance(text, str) or not text.strip():
            problems.append(f"{where}: empty sentence")
            continue
        texts.append(text)
        raw_ids = sentence.get("evidence_ids")
        problems.extend(_check_ids(raw_ids, known_ids, where))
        cited = _cited_strings(raw_ids, by_id)
        for passage in quoted_passages(text):
            if not any(passage in s for s in cited):
                problems.append(
                    f"{where}: quoted text {passage!r} does not appear in the facts it cites"
                )
        bare = _QUOTED.sub(" ", text)
        for check in tpl.forbidden:
            if check.pattern.search(bare):
                problems.append(f"{where}: forbidden wording ({check.reason})")
        for check in tpl.qualifiers:
            if check.pattern.search(bare) and check.must_contain.casefold() not in text.casefold():
                problems.append(f"{where}: missing {check.must_contain!r} ({check.reason})")
    if data.get("text") != tpl.formats.sentence_separator.join(texts):
        problems.append("text does not equal the sentences joined in order")
    return problems


def _cited_strings(raw: object, by_id: Mapping[str, tuple[str, ...]]) -> tuple[str, ...]:
    """The strings of every fact a sentence cites (empty when it cites nothing valid)."""
    if not isinstance(raw, list | tuple):
        return ()
    ids = [v for v in cast(Sequence[object], raw) if isinstance(v, str)]
    return unique(s for ident in ids for s in by_id.get(ident, ()))


def _check_ids(raw: object, known: set[str], where: str) -> list[str]:
    if not isinstance(raw, list | tuple) or not raw:
        return [f"{where}: cites no evidence id"]
    problems: list[str] = []
    for value in cast(Sequence[object], raw):
        if not isinstance(value, str) or value not in known:
            problems.append(f"{where}: evidence id {value!r} is not in the facts")
    return problems


__all__ = [
    "KINDS",
    "NARRATIVE_TABLE_NAMES",
    "TABLE_FILE",
    "BriefFacts",
    "ClockFact",
    "ConMedFact",
    "DeadlineFact",
    "EscalationFact",
    "EventFact",
    "GradeFact",
    "GradePoint",
    "NarrativeKind",
    "NoteFact",
    "OpenAeFact",
    "QuestionFact",
    "QuoteFact",
    "SaeFacts",
    "Sentence",
    "SideEffectFact",
    "TextFact",
    "VitalsFact",
    "WrittenText",
    "collect_evidence_ids",
    "collect_fact_strings",
    "derive_questions",
    "quoted_passages",
    "strings_by_evidence_id",
    "section_titles",
    "validate_written",
    "write",
]
