"""Verification and additive merge of a language-model reader's findings (CONTRACTS.md R5.3).

Product line: **Gemini reads, rules decide, people confirm. Nothing is accepted without a
word-for-word quote.** A language model (Gemini, called by ``apps/api``) may only ADD
findings to what the deterministic scanner (:mod:`interim_rules.chartscan`) found. This module
is the gate between the two and it is pure: no I/O besides reading the JSON tables, no clock,
no network, no model. Given the note text and the model's raw JSON answer it:

1. :func:`verify` keeps a finding only if

   * its ``quote`` is located in the text (exact; else whitespace- and case-normalized, mapped
     back to the original offsets so ``text[span_start:span_end]`` is the evidence span and is
     what the finding quotes from then on),
   * a symptom ``term`` is in the **closed vocabulary** (:func:`closed_vocabulary`),
   * a ``count`` appears as digits inside the quote,
   * a medication ``name`` appears inside the quote,
   * its ``status`` / ``action`` is one the contract defines.

   Everything else goes to ``rejected`` with a reason. Only ``current`` / ``resolved``
   symptoms can become drafts; ``negated`` / ``historical`` / ``hypothetical`` ones are kept
   as listed ``notes``.
2. :func:`merge` adds the verified findings to the scanner's result. **The merge is additive**:
   every scanner finding, the red flags, the excluded mentions and the escalation level are
   carried through unchanged (property-tested). A reader finding of a term (or drug) the
   scanner already kept is the same finding, labeled ``both``; a new one is labeled
   ``gemini``. A reader finding never overrides a mention the scanner excluded (negated,
   allergy, ...). **Grades stay rules**: :func:`chartscan.reader_symptom_finding` grades a
   reader symptom with the scanner's own stool bands and context grading, never with a number
   from the model.

``found_by`` is therefore ``"scanner"`` for everything the scanner alone found, ``"both"`` for
what both found and ``"gemini"`` for what only the reader found. Nothing here decides a tier,
seriousness, causality or a page: the caller's tier function sees the merged result's
findings and the scanner's unchanged red flags.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date
from functools import cache
from typing import Any, Literal

from . import chartscan
from .conmed import match_conmed
from .tables import TableError, load_table

READER_TABLE_NAMES: tuple[str, ...] = ("reader_answer_key",)
"""Tables this module owns (the eval harness ``scripts/eval_reader.py`` reads the key)."""

UNMAPPED = "UNMAPPED"
"""What the reader writes as ``term`` when nothing in the closed vocabulary fits."""
QUOTE_MAX_CHARS = 160
"""Longest quote accepted (the prompt asks for at most this many characters)."""
COUNT_MAX = 1000.0
UNIT_MAX_CHARS = 40
NAME_MAX_CHARS = 80
STATUSES: tuple[str, ...] = ("current", "historical", "negated", "hypothetical", "resolved")
DRAFT_STATUSES: tuple[str, ...] = ("current", "resolved")
ACTIONS: tuple[str, ...] = ("started", "stopped", "changed", "held", "taking")

FoundBy = Literal["scanner", "gemini", "both"]
MedChange = chartscan.MedChange

_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_TYPOGRAPHIC = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "“": '"',
        "”": '"',
        "–": "-",
        "—": "-",
        " ": " ",
    }
)


# --------------------------------------------------------------------------- #
# Closed vocabulary
# --------------------------------------------------------------------------- #


@cache
def closed_vocabulary() -> tuple[str, ...]:
    """The only symptom names the reader may use: the scanner lexicon's CTCAE terms, the ten
    kiosk terms and the immune-related terms of ``ctcae_terms.json`` (``reader_terms``)."""
    table = load_table("ctcae_terms")
    names: list[str] = list(chartscan.symptom_terms())
    for key in ("terms", "reader_terms"):
        rows = table.get(key, [])
        names.extend(str(row["aedecod"]) for row in rows if isinstance(row, dict))
    return tuple(dict.fromkeys(names))


@cache
def _vocabulary_index() -> dict[str, str]:
    return {name.casefold(): name for name in closed_vocabulary()}


# --------------------------------------------------------------------------- #
# Locating a quote
# --------------------------------------------------------------------------- #


def _fold(text: str) -> tuple[str, list[int]]:
    """Case-folded, whitespace-collapsed text and, for each output character, the index of the
    original character it came from (so a match maps back to original offsets)."""
    out: list[str] = []
    index: list[int] = []
    for i, ch in enumerate(text.translate(_TYPOGRAPHIC)):
        if ch.isspace():
            if out and out[-1] != " ":
                out.append(" ")
                index.append(i)
            continue
        for lowered in ch.lower():
            out.append(lowered)
            index.append(i)
    return "".join(out), index


def locate_quote(text: str, quote: str) -> tuple[int, int] | None:
    """``(start, end)`` with ``text[start:end]`` the quoted words, or ``None``.

    Exact match first; else the quote must appear after both sides are lower-cased, typographic
    punctuation is made ASCII and whitespace runs are collapsed. The span is mapped back to the
    original text, so the returned slice is what the finding quotes.
    """
    wanted = quote.strip()
    if not wanted:
        return None
    start = text.find(wanted)
    if start >= 0:
        return start, start + len(wanted)
    folded_text, index = _fold(text)
    folded_quote = _fold(wanted)[0].strip()
    if not folded_quote:
        return None
    at = folded_text.find(folded_quote)
    if at < 0:
        return None
    return index[at], index[at + len(folded_quote) - 1] + 1


def _contains_words(haystack: str, needle: str) -> bool:
    folded_needle = _fold(needle)[0].strip()
    return bool(folded_needle) and folded_needle in _fold(haystack)[0]


# --------------------------------------------------------------------------- #
# Verified findings
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ReaderSymptom:
    """A symptom the reader proposed whose quote, term and count passed verification."""

    term: str
    status: str
    quote: str
    span_start: int
    span_end: int
    count: float | None = None
    count_unit: str | None = None


@dataclass(frozen=True)
class ReaderMed:
    """A medication the reader proposed whose quote and name passed verification."""

    name: str
    generic: str | None
    action: str
    quote: str
    span_start: int
    span_end: int


@dataclass(frozen=True)
class Rejection:
    """A reader item that did not pass, with the reason a coordinator can read."""

    kind: Literal["symptom", "medication"]
    quote: str
    reason: str
    label: str = ""
    """The term or medication name the reader gave."""


@dataclass(frozen=True)
class VerifyResult:
    symptoms: tuple[ReaderSymptom, ...]
    """Verified ``current`` / ``resolved`` symptoms (these can become drafts)."""
    notes: tuple[ReaderSymptom, ...]
    """Verified symptoms with another status (negated, historical, hypothetical): listed only."""
    medications: tuple[ReaderMed, ...]
    rejected: tuple[Rejection, ...]


def _text(value: object, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    return cleaned[:limit] if cleaned else None


def _count(value: object) -> tuple[float | None, str | None]:
    """``(count, error)``: a non-negative number, ``None`` when absent."""
    if value is None or value == "":
        return None, None
    if isinstance(value, bool):
        return None, "the count is not a number"
    number: float
    if isinstance(value, int | float):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None, "the count is not a number"
    else:
        return None, "the count is not a number"
    if number != number or number < 0 or number > COUNT_MAX:
        return None, f"the count {value!r} is outside 0 to {COUNT_MAX:g}"
    return number, None


def _count_in_quote(count: float, quote: str) -> bool:
    return any(float(m.group(0)) == count for m in _NUMBER.finditer(quote))


def _items(raw: Mapping[str, Any], key: str) -> list[Any]:
    items = raw.get(key)
    return list(items) if isinstance(items, list) else []


def verify(text: str, raw: object) -> VerifyResult:
    """Check every item of the reader's raw JSON answer against ``text`` (see module docs)."""
    symptoms: list[ReaderSymptom] = []
    notes: list[ReaderSymptom] = []
    meds: list[ReaderMed] = []
    rejected: list[Rejection] = []
    if not isinstance(raw, Mapping):
        return VerifyResult(
            (), (), (), (Rejection("symptom", "", "the reader answer is not an object"),)
        )
    vocabulary = _vocabulary_index()

    for item in _items(raw, "symptoms"):
        entry: Mapping[str, Any] = item if isinstance(item, Mapping) else {}
        quote_raw = _text(entry.get("quote"), 10_000) or ""
        term_raw = _text(entry.get("term"), NAME_MAX_CHARS) or ""

        def reject(reason: str, quote: str = quote_raw, term: str = term_raw) -> None:
            rejected.append(Rejection("symptom", quote, reason, term))

        if not isinstance(item, Mapping):
            reject("the item is not an object")
            continue
        if len(quote_raw) > QUOTE_MAX_CHARS:
            reject(f"the quote is longer than {QUOTE_MAX_CHARS} characters")
            continue
        span = locate_quote(text, quote_raw)
        if span is None:
            reject("the quote is not in the text word for word")
            continue
        quote = text[span[0] : span[1]]
        if term_raw.casefold() == UNMAPPED.casefold():
            reject(
                "the reader could not map this to a term in the closed vocabulary (UNMAPPED)", quote
            )
            continue
        term = vocabulary.get(term_raw.casefold())
        if term is None:
            reject("the term is not in the closed vocabulary", quote)
            continue
        status = (_text(entry.get("status"), 20) or "").casefold()
        if status not in STATUSES:
            reject(f"the status {status!r} is not one of {', '.join(STATUSES)}", quote, term)
            continue
        count, count_error = _count(entry.get("count"))
        if count_error is not None:
            reject(count_error, quote, term)
            continue
        if count is not None and not _count_in_quote(count, quote):
            reject(f"the count {count:g} does not appear as digits inside the quote", quote, term)
            continue
        found = ReaderSymptom(
            term=term,
            status=status,
            quote=quote,
            span_start=span[0],
            span_end=span[1],
            count=count,
            count_unit=_text(entry.get("count_unit"), UNIT_MAX_CHARS)
            if count is not None
            else None,
        )
        (symptoms if status in DRAFT_STATUSES else notes).append(found)

    for item in _items(raw, "medications"):
        entry = item if isinstance(item, Mapping) else {}
        quote_raw = _text(entry.get("quote"), 10_000) or ""
        name = _text(entry.get("name"), NAME_MAX_CHARS) or ""

        def reject_med(reason: str, quote: str = quote_raw, label: str = name) -> None:
            rejected.append(Rejection("medication", quote, reason, label))

        if not isinstance(item, Mapping):
            reject_med("the item is not an object")
            continue
        if len(quote_raw) > QUOTE_MAX_CHARS:
            reject_med(f"the quote is longer than {QUOTE_MAX_CHARS} characters")
            continue
        span = locate_quote(text, quote_raw)
        if span is None:
            reject_med("the quote is not in the text word for word")
            continue
        quote = text[span[0] : span[1]]
        if not name or not _contains_words(quote, name):
            reject_med("the medication name does not appear inside the quote", quote)
            continue
        action = (_text(entry.get("action"), 20) or "").casefold()
        if action not in ACTIONS:
            reject_med(f"the action {action!r} is not one of {', '.join(ACTIONS)}", quote)
            continue
        meds.append(
            ReaderMed(
                name=name,
                generic=_text(entry.get("generic"), NAME_MAX_CHARS),
                action=action,
                quote=quote,
                span_start=span[0],
                span_end=span[1],
            )
        )
    return VerifyResult(tuple(symptoms), tuple(notes), tuple(meds), tuple(rejected))


# --------------------------------------------------------------------------- #
# Additive merge
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ReaderMerge:
    """The scanner's result with the reader's verified additions, and who found what."""

    result: chartscan.ScanResult
    """Scanner findings first, unchanged, then the reader-only findings. Red flags, excluded
    mentions and the human-request flag are the scanner's, untouched."""
    symptom_found_by: Mapping[str, FoundBy]
    """CTCAE term -> who found the kept symptom (one kept finding per term)."""
    med_found_by: Mapping[str, FoundBy]
    """Generic drug name -> who found the kept medication."""
    reader_symptoms: tuple[chartscan.SymptomFinding, ...]
    """The reader-only symptom findings (``found_by == "gemini"``)."""
    reader_meds: tuple[chartscan.MedFinding, ...]
    notes: tuple[ReaderSymptom, ...]
    rejected: tuple[Rejection, ...]
    n_both: int
    """Reader findings that matched a scanner finding."""


def med_change(action: str) -> MedChange:
    """The scanner's change vocabulary for a reader action (``held`` is a temporary stop)."""
    if action == "held":
        return "stopped"
    if action in ("started", "stopped", "changed", "taking"):
        return action  # type: ignore[return-value]
    return "taking"


def _drug_name(med: ReaderMed) -> str:
    """Lower-case generic name: the reader's generic, else the bundled list's match, else the
    name as written."""
    if med.generic:
        return med.generic.casefold()
    match = match_conmed(med.name)
    if match.matched_name and match.confidence >= 0.8:
        return match.matched_name.casefold()
    return med.name.casefold()


def merge(
    text: str,
    scan: chartscan.ScanResult,
    verified: VerifyResult,
    *,
    ref_date: date | None = None,
) -> ReaderMerge:
    """Add the verified reader findings to ``scan`` (never removing or changing anything)."""
    kept_terms = {s.term for s in scan.symptoms}
    excluded_terms = {s.term: s for s in scan.excluded_symptoms}
    kept_drugs = {m.drug for m in scan.meds}
    excluded_drugs = {m.drug: m for m in scan.excluded_meds}
    symptom_found_by: dict[str, FoundBy] = dict.fromkeys(kept_terms, "scanner")
    med_found_by: dict[str, FoundBy] = dict.fromkeys(kept_drugs, "scanner")
    rejected = list(verified.rejected)
    added_symptoms: list[chartscan.SymptomFinding] = []
    added_meds: list[chartscan.MedFinding] = []
    n_both = 0

    for found in verified.symptoms:
        term = found.term
        if term in kept_terms:
            if symptom_found_by[term] == "scanner":
                symptom_found_by[term] = "both"
                n_both += 1
            continue
        if term in excluded_terms:
            why = excluded_terms[term].excluded_reason
            rejected.append(
                Rejection(
                    "symptom",
                    found.quote,
                    f"the scanner excluded {term} in this text ({why}); the reader does not "
                    "override the rules",
                    term,
                )
            )
            continue
        if term in symptom_found_by:
            rejected.append(
                Rejection(
                    "symptom",
                    found.quote,
                    f"another reader finding for {term} was already kept",
                    term,
                )
            )
            continue
        blocked = chartscan.reader_symptom_exclusion(text, found.span_start, found.span_end)
        if blocked is not None:
            rejected.append(
                Rejection(
                    "symptom",
                    found.quote,
                    f"the scanner's {blocked[0]} rule applies here ({blocked[1]}); the reader "
                    "does not override the rules",
                    term,
                )
            )
            continue
        finding = chartscan.reader_symptom_finding(
            text,
            term,
            found.span_start,
            found.span_end,
            ref_date=ref_date,
            count=found.count,
        )
        if found.status == "resolved" and not finding.resolved:
            finding = replace(finding, resolved=True)
        added_symptoms.append(finding)
        symptom_found_by[term] = "gemini"

    for med in verified.medications:
        drug = _drug_name(med)
        if drug in kept_drugs:
            if med_found_by[drug] == "scanner":
                med_found_by[drug] = "both"
                n_both += 1
            continue
        if drug in excluded_drugs:
            rejected.append(
                Rejection(
                    "medication",
                    med.quote,
                    f"the scanner excluded {drug} in this text "
                    f"({excluded_drugs[drug].excluded_reason}); the reader does not override "
                    "the rules",
                    med.name,
                )
            )
            continue
        if drug in med_found_by:
            rejected.append(
                Rejection(
                    "medication",
                    med.quote,
                    f"another reader finding for {drug} was already kept",
                    med.name,
                )
            )
            continue
        blocked_med = chartscan.reader_med_exclusion(text, med.span_start, med.span_end)
        if blocked_med is not None:
            rejected.append(
                Rejection(
                    "medication",
                    med.quote,
                    f"the scanner's {blocked_med[0]} rule applies here ({blocked_med[1]}); the "
                    "reader does not override the rules",
                    med.name,
                )
            )
            continue
        if med.action == "taking":
            # A concomitant-medication record captures a change (started/stopped/changed/held).
            # An ongoing medicine, often the study drug itself, is not drafted from the reader.
            rejected.append(
                Rejection(
                    "medication",
                    med.quote,
                    "not drafted: an ongoing medication, not a change",
                    med.name,
                )
            )
            continue
        change = med_change(med.action)
        added_meds.append(
            chartscan.MedFinding(
                drug=drug,
                change=change,
                quote=med.quote,
                span_start=med.span_start,
                span_end=med.span_end,
                reason=(
                    f"the second reader gave '{med.name}' as {med.action}"
                    + (" (a hold is drafted as a stop)" if med.action == "held" else "")
                    + "; the quote was found word for word in the text"
                ),
            )
        )
        med_found_by[drug] = "gemini"

    result = replace(
        scan,
        symptoms=(*scan.symptoms, *added_symptoms),
        meds=(*scan.meds, *added_meds),
    )
    return ReaderMerge(
        result=result,
        symptom_found_by=symptom_found_by,
        med_found_by=med_found_by,
        reader_symptoms=tuple(added_symptoms),
        reader_meds=tuple(added_meds),
        notes=verified.notes,
        rejected=tuple(rejected),
        n_both=n_both,
    )


def reader_rules_fired(merged: ReaderMerge) -> list[dict[str, object]]:
    """Plain-English rule firings for the reader-only findings, in the shape of
    :func:`chartscan.rules_fired` (``chartscan.gemini_symptom`` / ``chartscan.gemini_med``)."""
    out: list[dict[str, object]] = []
    for s in merged.reader_symptoms:
        onset = f"; onset {s.onset_days} day(s) before the note" if s.onset_days is not None else ""
        resolved = "; resolved per the text" if s.resolved else ""
        out.append(
            {
                "rule_id": chartscan.RULE_GEMINI_SYMPTOM,
                "category": chartscan.RULE_CATEGORY,
                "description": (
                    f"Second reader: '{s.quote}' -> {s.term}, provisional grade hint "
                    f"{s.grade_hint} ({s.grade_basis}){onset}{resolved}. The reader only found "
                    "the words; the grade is the scanner's rule"
                ),
                "inputs": {
                    "quote": s.quote,
                    "span_start": s.span_start,
                    "span_end": s.span_end,
                    "term": s.term,
                    "grade_hint": s.grade_hint,
                    "grade_basis": s.grade_basis,
                    "onset_days": s.onset_days,
                    "onset_date": s.onset_date,
                    "worsening": s.worsening,
                    "resolved": s.resolved,
                    "reason": s.reason,
                    "found_by": "gemini",
                },
                "effect": f"AE draft candidate: AEDECOD = {s.term}, AETOXGR hint = {s.grade_hint}",
                "span_start": s.span_start,
                "span_end": s.span_end,
                "quote": s.quote,
            }
        )
    for m in merged.reader_meds:
        out.append(
            {
                "rule_id": chartscan.RULE_GEMINI_MED,
                "category": chartscan.RULE_CATEGORY,
                "description": (f"Second reader: '{m.quote}' -> {m.drug} ({m.change}): {m.reason}"),
                "inputs": {
                    "quote": m.quote,
                    "span_start": m.span_start,
                    "span_end": m.span_end,
                    "drug": m.drug,
                    "change": m.change,
                    "reason": m.reason,
                    "found_by": "gemini",
                },
                "effect": f"CM draft candidate: CMDECOD = {m.drug}, change = {m.change}",
                "span_start": m.span_start,
                "span_end": m.span_end,
                "quote": m.quote,
            }
        )
    return out


def apply_found_by(scan_dict: dict[str, Any], merged: ReaderMerge | None) -> dict[str, Any]:
    """Add ``found_by`` to every symptom and medication of a ``scan_result_to_dict`` payload
    (``"scanner"`` for all of them when there is no merge). Mutates and returns ``scan_dict``."""
    for item in scan_dict.get("symptoms", []):
        item["found_by"] = (
            merged.symptom_found_by.get(item["term"], "scanner") if merged else "scanner"
        )
    for item in scan_dict.get("meds", []):
        item["found_by"] = merged.med_found_by.get(item["drug"], "scanner") if merged else "scanner"
    for key in ("excluded_symptoms", "excluded_meds"):
        for item in scan_dict.get(key, []):
            item["found_by"] = "scanner"
    return scan_dict


def reader_note_dicts(notes: Sequence[ReaderSymptom]) -> list[dict[str, Any]]:
    """The listed-only (negated / historical / hypothetical) reader symptoms as plain dicts."""
    return [
        {
            "term": n.term,
            "status": n.status,
            "quote": n.quote,
            "span_start": n.span_start,
            "span_end": n.span_end,
        }
        for n in notes
    ]


def rejection_dicts(rejected: Sequence[Rejection]) -> list[dict[str, Any]]:
    """``[{quote, reason, kind, label}]`` for the API's ``reader_rejected``."""
    return [
        {"quote": r.quote, "reason": r.reason, "kind": r.kind, "label": r.label} for r in rejected
    ]


# --------------------------------------------------------------------------- #
# The reader answer key (scripts/eval_reader.py)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ExpectedSymptom:
    term: str
    grade: int | None
    quote_contains: str
    scanner_finds: bool
    """Whether the deterministic scanner alone is expected to find this (the reader adds the
    rest)."""


@dataclass(frozen=True)
class ExpectedMed:
    drug: str
    change: str
    scanner_finds: bool


@dataclass(frozen=True)
class ReaderCase:
    """One text the reader eval replays: a chart note or a phone-call summary."""

    id: str
    kind: Literal["note", "call"]
    note_type: str
    note_date: str
    author: str
    text: str
    symptoms: tuple[ExpectedSymptom, ...]
    meds: tuple[ExpectedMed, ...]
    forbidden_terms: tuple[str, ...]
    """Terms the text explicitly negates; no side-effect draft may carry them."""


def _req_str(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TableError(f"{where}: expected a non-empty string")
    return value


def _req_list(value: object, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise TableError(f"{where}: expected a list")
    return value


def _req_dict(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TableError(f"{where}: expected an object")
    return value


@cache
def reader_answer_key() -> tuple[ReaderCase, ...]:
    """The cases of ``reader_answer_key.json``, validated (terms must be in the vocabulary)."""
    where = "reader_answer_key"
    table = load_table(where)
    vocabulary = set(closed_vocabulary())
    out: list[ReaderCase] = []
    seen: set[str] = set()
    for idx, raw_case in enumerate(_req_list(table.get("cases"), f"{where}.cases")):
        w = f"{where}.cases[{idx}]"
        case = _req_dict(raw_case, w)
        case_id = _req_str(case.get("id"), f"{w}.id")
        if case_id in seen:
            raise TableError(f"{w}: duplicate case id {case_id!r}")
        seen.add(case_id)
        kind = _req_str(case.get("kind"), f"{w}.kind")
        if kind not in ("note", "call"):
            raise TableError(f"{w}.kind: expected 'note' or 'call', got {kind!r}")
        date.fromisoformat(_req_str(case.get("note_date"), f"{w}.note_date"))
        expected = _req_dict(case.get("expected"), f"{w}.expected")
        symptoms: list[ExpectedSymptom] = []
        for sidx, raw_s in enumerate(_req_list(expected.get("symptoms"), f"{w}.expected.symptoms")):
            sw = f"{w}.expected.symptoms[{sidx}]"
            entry = _req_dict(raw_s, sw)
            term = _req_str(entry.get("term"), f"{sw}.term")
            if term not in vocabulary:
                raise TableError(f"{sw}.term: {term!r} is not in the closed vocabulary")
            grade = entry.get("grade")
            if grade is not None and (isinstance(grade, bool) or not isinstance(grade, int)):
                raise TableError(f"{sw}.grade: expected an integer or null")
            symptoms.append(
                ExpectedSymptom(
                    term=term,
                    grade=grade,
                    quote_contains=_req_str(entry.get("quote_contains"), f"{sw}.quote_contains"),
                    scanner_finds=bool(entry.get("scanner_finds", False)),
                )
            )
        meds: list[ExpectedMed] = []
        for midx, raw_m in enumerate(_req_list(expected.get("meds"), f"{w}.expected.meds")):
            mw = f"{w}.expected.meds[{midx}]"
            entry = _req_dict(raw_m, mw)
            change = _req_str(entry.get("change"), f"{mw}.change")
            if change not in ("started", "stopped", "changed", "taking"):
                raise TableError(f"{mw}.change: unknown change {change!r}")
            meds.append(
                ExpectedMed(
                    drug=_req_str(entry.get("drug"), f"{mw}.drug"),
                    change=change,
                    scanner_finds=bool(entry.get("scanner_finds", False)),
                )
            )
        forbidden = tuple(
            _req_str(t, f"{w}.expected.forbidden_terms")
            for t in _req_list(expected.get("forbidden_terms"), f"{w}.expected.forbidden_terms")
        )
        out.append(
            ReaderCase(
                id=case_id,
                kind="call" if kind == "call" else "note",
                note_type=_req_str(case.get("note_type"), f"{w}.note_type"),
                note_date=_req_str(case.get("note_date"), f"{w}.note_date"),
                author=_req_str(case.get("author"), f"{w}.author"),
                text=_req_str(case.get("text"), f"{w}.text"),
                symptoms=tuple(symptoms),
                meds=tuple(meds),
                forbidden_terms=forbidden,
            )
        )
    return tuple(out)
