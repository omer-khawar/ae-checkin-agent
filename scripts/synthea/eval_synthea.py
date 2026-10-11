#!/usr/bin/env python3
"""Independent evaluation of Interim's deterministic text tools against Synthea's records.

Why this exists: the chart-scan answer key (``packages/rules/data/chartscan_answer_key.json``,
25 cases) was written alongside the scanner's rules, so passing it is a regression test, not an
accuracy estimate. Synthea's notes come from Synthea's own templates. The medication and
encounter ground truth here comes from Synthea's structured FHIR record (imported by
``import_synthea.py``); the symptom ground truth is the note's own "# Chief Complaint" bullets,
which Synthea wrote but which are the same text the scanner reads, so (a) mostly measures
lexicon coverage on bullet text. None of it was written by the scanner's author or by us.
Everything scored is "Synthea synthetic EHR (simulated)"; nothing here is a clinical validation.

What it computes, per note and in aggregate (deterministic; no network, no clock, no LLM):

(a) Symptom extraction: ``interim_rules.chartscan.scan_text`` kept symptom terms vs the note's
    chief complaints mapped to CTCAE v5.0 terms by ``complaint_map.json``.
(b) Medication extraction: scanner medication findings vs the ingredients active at the note
    (structured + the note's own list) and prescribed at the encounter; con-med matcher
    (``interim_rules.conmed.match_conmed``) normalization of every Synthea medication display;
    and a section-aware variant that runs the matcher on each item of the note's
    "# Medications" list.
(c) Escalation: red flags by encounter class (over-escalation on ambulatory notes, recall on
    emergency encounters, seriousness cue vs emergency/inpatient encounters).
(d) Baseline vitals: Synthea pulse / breathing medians vs the corroboration thresholds read
    from ``packages/rules/data/vitals_corroboration.json``.

Usage::

    .venv/Scripts/python.exe scripts/synthea/eval_synthea.py            # writes the markdown
    .venv/Scripts/python.exe scripts/synthea/eval_synthea.py --check    # recompute and compare

``--check`` recomputes the document and requires it to equal the committed file byte for byte
(after normalizing CRLF to LF). The document embeds no wall-clock time and no git commit: its
header carries the Synthea reference date and the sha256 of every input, so it changes exactly
when an input or the scoring changes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from functools import cache
from pathlib import Path
from typing import Any, cast

REPO = Path(__file__).resolve().parents[2]
RULES_PKG = REPO / "packages" / "rules"
if str(RULES_PKG) not in sys.path:  # a clean clone without an editable install
    sys.path.insert(0, str(RULES_PKG))

from interim_rules.chartscan import (  # noqa: E402
    ScanResult,
    escalation_level,
    scan_text,
    seriousness_suspected,
)
from interim_rules.conmed import match_conmed  # noqa: E402
from interim_rules.models import ConMedMatch  # noqa: E402
from interim_rules.tables import data_dir, load_table  # noqa: E402

SYNTHEA_DATA = REPO / "data" / "synthetic" / "synthea"
DEFAULT_NOTES = SYNTHEA_DATA / "notes.json"
DEFAULT_PARTICIPANTS = SYNTHEA_DATA / "participants.json"
DEFAULT_MAP = Path(__file__).resolve().with_name("complaint_map.json")
DEFAULT_OUT = REPO / "docs" / "eval" / "synthea_results.md"

LABEL = "Synthea synthetic EHR (simulated)"
EVAL_VERSION = "1.0.0"

RULE_TABLES: tuple[str, ...] = (
    "chartscan_lexicon",
    "chartscan_red_flags",
    "medlist",
    "conmed_matching",
    "vitals_corroboration",
)
"""Rules-package tables whose content decides the results; their hashes go in the header."""

SERIOUS_CLASSES: frozenset[str] = frozenset({"emergency", "inpatient"})
"""Encounter classes that are a hospitalization or ER visit (the ICH E2A seriousness trigger)."""

TOP_N = 10
"""How many rows the error listings show."""

JsonObj = dict[str, Any]


@cache
def cached_match(text: str) -> ConMedMatch:
    """``match_conmed`` memoized per process. The matcher is a pure function of the text and
    the bundled list, and its pure-Python Levenshtein dominates the run time (the same ~70
    distinct strings recur across 72 notes)."""
    return match_conmed(text)


class EvalError(RuntimeError):
    """An input is malformed or the complaint map does not cover the data."""


# --------------------------------------------------------------------------------------
# Metric arithmetic
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Score:
    """Precision over predictions and recall over ground-truth items.

    The two are counted separately because a fuzzy match can make one prediction cover two
    ground-truth items (a combination product); for plain set comparison
    ``pred_correct == gt_found``. An empty denominator gives ``None`` (shown as "n/a"), never
    a flattering 1.0.
    """

    pred_correct: int = 0
    pred_total: int = 0
    gt_found: int = 0
    gt_total: int = 0

    def __add__(self, other: Score) -> Score:
        return Score(
            self.pred_correct + other.pred_correct,
            self.pred_total + other.pred_total,
            self.gt_found + other.gt_found,
            self.gt_total + other.gt_total,
        )

    @property
    def fp(self) -> int:
        return self.pred_total - self.pred_correct

    @property
    def fn(self) -> int:
        return self.gt_total - self.gt_found

    @property
    def precision(self) -> float | None:
        return self.pred_correct / self.pred_total if self.pred_total else None

    @property
    def recall(self) -> float | None:
        return self.gt_found / self.gt_total if self.gt_total else None

    @property
    def f1(self) -> float | None:
        p, r = self.precision, self.recall
        if p is None or r is None:
            return None
        return 2 * p * r / (p + r) if p + r else 0.0


def set_score(expected: Iterable[str], predicted: Iterable[str]) -> Score:
    """Exact set comparison: TP = intersection, FP = predicted only, FN = expected only."""
    e, p = set(expected), set(predicted)
    hit = len(e & p)
    return Score(pred_correct=hit, pred_total=len(p), gt_found=hit, gt_total=len(e))


def sum_scores(scores: Iterable[Score]) -> Score:
    total = Score()
    for s in scores:
        total = total + s
    return total


def fmt(value: float | None) -> str:
    """Three decimals, or "n/a" for an undefined ratio."""
    return "n/a" if value is None else f"{value:.3f}"


def pct(num: int, den: int) -> str:
    return "n/a" if den == 0 else f"{num}/{den} ({100 * num / den:.1f}%)"


# --------------------------------------------------------------------------------------
# Inputs
# --------------------------------------------------------------------------------------


def _obj(value: object, where: str) -> JsonObj:
    if not isinstance(value, dict):
        raise EvalError(f"{where}: expected an object")
    return cast(JsonObj, value)


def _arr(value: object, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise EvalError(f"{where}: expected a list")
    return value


def _text(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise EvalError(f"{where}: expected a string")
    return value


def read_json(path: Path) -> JsonObj:
    with path.open(encoding="utf-8") as fh:
        return _obj(json.load(fh), str(path))


def file_sha256(path: Path) -> str:
    """sha256 of the file's bytes with CRLF normalized to LF (the repo stores text as LF)."""
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


@dataclass(frozen=True)
class Concept:
    """A CTCAE concept: the primary term plus the alternatives accepted for it."""

    primary: str
    accepted: frozenset[str]


@dataclass(frozen=True)
class ComplaintMap:
    """``complaint_map.json``, validated."""

    complaints: Mapping[str, Concept | None]
    """Chief-complaint string -> concept, or ``None`` when CTCAE v5.0 has no term."""
    term_to_concept: Mapping[str, str]
    """Every accepted CTCAE term -> its concept's primary term."""
    ingredient_equivalents: Mapping[str, frozenset[str]]
    meds_heading: str
    meds_separator: str
    meds_empty: frozenset[str]

    def concept_of(self, complaint: str) -> Concept | None:
        if complaint not in self.complaints:
            raise EvalError(
                f"chief complaint {complaint!r} is not in complaint_map.json; add it (with a "
                "CTCAE v5.0 term or null and a rationale) before scoring"
            )
        return self.complaints[complaint]

    def scanner_concept(self, term: str) -> str:
        """The concept a scanner term belongs to (itself when no complaint maps to it)."""
        return self.term_to_concept.get(term, term)


def load_complaint_map(path: Path) -> ComplaintMap:
    raw = read_json(path)
    for key in ("source", "rationale"):
        if not _text(raw.get(key), f"{path}.{key}").strip():
            raise EvalError(f"{path}: missing non-empty {key!r}")
    complaints: dict[str, Concept | None] = {}
    term_to_concept: dict[str, str] = {}
    for name, entry_raw in _obj(raw.get("complaints"), "complaints").items():
        entry = _obj(entry_raw, f"complaints.{name}")
        if not _text(entry.get("rationale"), f"complaints.{name}.rationale").strip():
            raise EvalError(f"complaints.{name}: missing rationale")
        term = entry.get("ctcae_term")
        if term is None:
            complaints[name] = None
            continue
        primary = _text(term, f"complaints.{name}.ctcae_term")
        alts = [
            _text(a, f"complaints.{name}.also_accept")
            for a in _arr(entry.get("also_accept", []), f"complaints.{name}.also_accept")
        ]
        concept = Concept(primary, frozenset([primary, *alts]))
        for t in concept.accepted:
            if term_to_concept.setdefault(t, primary) != primary:
                raise EvalError(f"CTCAE term {t!r} is accepted under two different concepts")
        complaints[name] = concept
    eq_section = _obj(raw.get("ingredient_equivalents"), "ingredient_equivalents")
    equivalents: dict[str, frozenset[str]] = {}
    for k, vs in _obj(eq_section.get("map"), "ingredient_equivalents.map").items():
        where = f"ingredient_equivalents.map.{k}"
        equivalents[k.lower()] = frozenset(_text(v, where).lower() for v in _arr(vs, where))
    fmt_section = _obj(raw.get("note_format"), "note_format")
    return ComplaintMap(
        complaints=complaints,
        term_to_concept=term_to_concept,
        ingredient_equivalents=equivalents,
        meds_heading=_text(fmt_section.get("medications_heading"), "note_format.heading"),
        meds_separator=_text(fmt_section.get("item_separator"), "note_format.item_separator"),
        meds_empty=frozenset(
            _text(m, "note_format.empty_markers")
            for m in _arr(fmt_section.get("empty_markers"), "note_format.empty_markers")
        ),
    )


@dataclass(frozen=True)
class GtMed:
    """One ground-truth medication at a note."""

    display: str
    ingredients: tuple[str, ...]
    """Lowercase; the leading ingredient first."""
    in_text: bool
    """Visible in the note text: listed in '# Medications' (``note_section``), or its full
    display (as active or as prescribed at this encounter) appears anywhere in the note."""
    origin: str
    """``structured+note_section``, ``structured``, ``note_section`` or ``prescribed``."""

    @property
    def key(self) -> str:
        return self.ingredients[0]


@dataclass(frozen=True)
class Note:
    id: str
    label: str
    note_date: str
    encounter_class: str
    text: str
    chief_complaints: tuple[str, ...]
    meds: tuple[GtMed, ...]
    conditions: tuple[str, ...]
    is_emergency: bool


def _ingredients(item: Mapping[str, Any], where: str) -> tuple[str, ...]:
    lead = _text(item.get("ingredient"), f"{where}.ingredient").lower()
    extra = [_text(i, where).lower() for i in _arr(item.get("ingredients") or [], where)]
    return tuple(dict.fromkeys([lead, *extra]))


def load_notes(path: Path) -> tuple[JsonObj, list[Note]]:
    raw = read_json(path)
    notes: list[Note] = []
    for idx, n_raw in enumerate(_arr(raw.get("notes"), "notes")):
        w = f"notes[{idx}]"
        n = _obj(n_raw, w)
        gt = _obj(n.get("ground_truth"), f"{w}.ground_truth")
        text = _text(n.get("text"), f"{w}.text")
        lowered = text.lower()
        meds: dict[str, GtMed] = {}
        for m_idx, m_raw in enumerate(_arr(gt.get("active_medications_at_note"), w)):
            m = _obj(m_raw, f"{w}.active_medications_at_note[{m_idx}]")
            sources = [_text(s, f"{w}.sources") for s in _arr(m.get("sources"), w)]
            ing = _ingredients(m, w)
            display = _text(m.get("display"), w)
            meds.setdefault(
                ing[0],
                GtMed(
                    display=display,
                    ingredients=ing,
                    # Visible if the note lists it under '# Medications', or if its full display
                    # is printed anywhere else in the note (e.g. the Plan's prescription list).
                    in_text="note_section" in sources or display.lower() in lowered,
                    origin="+".join(sorted(sources)),
                ),
            )
        for p_idx, p_raw in enumerate(_arr(gt.get("prescribed_at_encounter"), w)):
            p = _obj(p_raw, f"{w}.prescribed_at_encounter[{p_idx}]")
            ing = _ingredients(p, w)
            display = _text(p.get("display"), w)
            visible = display.lower() in lowered
            existing = meds.get(ing[0])
            if existing is not None:
                # Already counted as active; a prescription printed in the note text still makes
                # it visible there, so it belongs in the R(text) denominator.
                if visible and not existing.in_text:
                    meds[ing[0]] = replace(existing, in_text=True)
                continue
            meds[ing[0]] = GtMed(display, ing, visible, "prescribed")
        notes.append(
            Note(
                id=_text(n.get("id"), f"{w}.id"),
                label=_text(n.get("label"), f"{w}.label"),
                note_date=_text(n.get("note_date"), f"{w}.note_date"),
                encounter_class=_text(n.get("encounter_class"), f"{w}.encounter_class"),
                text=text,
                chief_complaints=tuple(
                    _text(c, f"{w}.chief_complaints") for c in _arr(gt.get("chief_complaints"), w)
                ),
                meds=tuple(sorted(meds.values(), key=lambda g: g.key)),
                conditions=tuple(
                    _text(_obj(c, w).get("display"), w).lower()
                    for c in _arr(gt.get("conditions_diagnosed_at_encounter"), w)
                ),
                is_emergency=bool(gt.get("is_emergency_encounter")),
            )
        )
    notes.sort(key=lambda x: x.id)
    return raw, notes


# --------------------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------------------


def section_at(text: str, pos: int) -> str:
    """The Markdown heading ("# Chief Complaint", "## Plan") the offset falls under."""
    heading = "(before any heading)"
    for m in re.finditer(r"^#{1,6} [^\n]*", text, re.M):
        if m.start() > pos:
            break
        heading = m.group(0).strip()
    return heading


def med_section_items(text: str, cmap: ComplaintMap) -> list[str]:
    """The items of the note's medication list section (empty for 'No Active Medications.')."""
    m = re.search(rf"^{re.escape(cmap.meds_heading)}[ \t]*\n(.*?)(?=^#|\Z)", text, re.M | re.S)
    if m is None:
        return []
    body = " ".join(m.group(1).split())
    if not body or body in cmap.meds_empty:
        return []
    return [item.strip() for item in body.split(cmap.meds_separator) if item.strip()]


def snippet(text: str, start: int, end: int, width: int = 50) -> str:
    """The quoted span with up to ``width`` characters of its line on each side."""
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    line_end = len(text) if line_end == -1 else line_end
    a, b = max(line_start, start - width), min(line_end, end + width)
    prefix = "..." if a > line_start else ""
    suffix = "..." if b < line_end else ""
    return f"{prefix}{text[a:b].strip()}{suffix}"


@dataclass(frozen=True)
class HistoryScope:
    """The scanner's history cue and how far before a term it may sit (from its lexicon)."""

    pattern: re.Pattern[str]
    max_words: int


def history_scope() -> HistoryScope:
    lex = load_table("chartscan_lexicon")
    return HistoryScope(
        pattern=re.compile(_text(_obj(lex["historical"], "historical")["pattern"], "h"), re.I),
        max_words=int(_obj(lex["scope"], "scope")["negation_max_words"]),
    )


def words_after_history_cue(text: str, start: int, hist: HistoryScope) -> int | None:
    """Words between the last history cue earlier on the span's line and the span, if any."""
    line_start = text.rfind("\n", 0, start) + 1
    cues = list(hist.pattern.finditer(text, line_start, start))
    if not cues:
        return None
    return len(text[cues[-1].end() : start].split())


def complaint_quote(text: str, complaint: str) -> str:
    """The note line that carries a chief complaint ("- Cramping")."""
    m = re.search(rf"^- {re.escape(complaint)}\s*$", text, re.M)
    return m.group(0).strip() if m else complaint


# --------------------------------------------------------------------------------------
# Medication name comparison
# --------------------------------------------------------------------------------------

_COMPONENT_SPLIT = re.compile(r"\s*(?:-|/|,|\band\b)\s*")


def name_matches(
    predicted: str, ingredient: str, equivalents: Mapping[str, frozenset[str]]
) -> bool:
    """Whether a predicted generic name names this ingredient.

    Lowercase comparison of each component of the prediction ("amoxicillin-clavulanate" ->
    amoxicillin, clavulanate) against the ingredient: equal, or the ingredient followed by a
    salt ("naproxen sodium"), or a listed synonym. A shared first word alone is not enough
    ("sodium chloride" is not "sodium fluoride").
    """
    names = {ingredient, *equivalents.get(ingredient, frozenset())}
    for comp in _COMPONENT_SPLIT.split(predicted.lower().strip()):
        for name in names:
            if comp == name or comp.startswith(name + " ") or name.startswith(comp + " "):
                return True
    return False


def med_score(
    predicted: Iterable[str],
    truth: Sequence[GtMed],
    equivalents: Mapping[str, frozenset[str]],
    *,
    text_only: bool,
) -> tuple[Score, list[str], list[GtMed]]:
    """Score predicted drug names against a note's medications.

    Precision is always judged against every ground-truth medication (a correct drug is
    correct whichever source recorded it); recall is over the text-visible items when
    ``text_only`` else over all of them. Returns the score, the false-positive names and the
    missed items.
    """
    preds = sorted(set(predicted))
    targets = [g for g in truth if g.in_text] if text_only else list(truth)

    def hits(name: str, g: GtMed) -> bool:
        return any(name_matches(name, ing, equivalents) for ing in g.ingredients)

    correct = [p for p in preds if any(hits(p, g) for g in truth)]
    found = [g for g in targets if any(hits(p, g) for p in preds)]
    missed = [g for g in targets if g not in found]
    fps = [p for p in preds if p not in correct]
    return Score(len(correct), len(preds), len(found), len(targets)), fps, missed


# --------------------------------------------------------------------------------------
# Per-note evaluation
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SymptomError:
    note_id: str
    concept: str
    quote: str
    context: str
    supported_by_record: bool = False
    """For a false positive: the term's words appear in a structured Condition of this
    encounter (a real diagnosis, just not a chief complaint)."""
    section: str = ""
    """The note heading the quote sits under."""
    history_words: int | None = None
    """For a false positive: words between an earlier 'history of' cue on the line and the
    term (``None`` when there is no such cue)."""


@dataclass
class NoteResult:
    note: Note
    expected: set[str]
    out_of_scope: list[str]
    predicted: set[str]
    symptom: Score
    symptom_in_lexicon: Score
    symptom_fp: list[SymptomError]
    symptom_fn: list[SymptomError]
    scanner_meds: list[str]
    section_meds: list[str]
    med_scanner_text: Score
    med_scanner_all: Score
    med_section_text: Score
    med_union_text: Score
    med_fp: list[tuple[str, str]]
    med_missed_text: list[GtMed]
    red_flags: list[tuple[str, str, str, str]]
    """(category, level, quote, section) per red flag."""
    escalation: str
    serious: bool
    scan: ScanResult = field(repr=False)


def evaluate_note(
    note: Note, cmap: ComplaintMap, lexicon_terms: frozenset[str], hist: HistoryScope
) -> NoteResult:
    scan = scan_text(note.text, date.fromisoformat(note.note_date))

    expected: set[str] = set()
    out_of_scope: list[str] = []
    for complaint in note.chief_complaints:
        concept = cmap.concept_of(complaint)
        if concept is None:
            out_of_scope.append(complaint)
        else:
            expected.add(concept.primary)
    in_lexicon = {c for c in expected if any(t in lexicon_terms for t in _accepted(cmap, c))}
    quote_of: dict[str, tuple[str, int, int]] = {}
    for s in scan.symptoms:
        quote_of.setdefault(cmap.scanner_concept(s.term), (s.quote, s.span_start, s.span_end))
    predicted = set(quote_of)

    fp_errors = []
    for fp_concept in sorted(predicted - expected):
        quote, start, end = quote_of[fp_concept]
        words = [w for w in re.findall(r"[a-z]+", quote.lower()) if len(w) > 3]
        supported = bool(words) and any(all(w in c for w in words) for c in note.conditions)
        fp_errors.append(
            SymptomError(
                note.id,
                fp_concept,
                quote,
                snippet(note.text, start, end),
                supported,
                section_at(note.text, start),
                words_after_history_cue(note.text, start, hist),
            )
        )
    fn_errors = []
    for complaint in note.chief_complaints:
        concept = cmap.concept_of(complaint)
        if concept is not None and concept.primary not in predicted:
            q = complaint_quote(note.text, complaint)
            fn_errors.append(SymptomError(note.id, concept.primary, q, q))

    eq = cmap.ingredient_equivalents
    scanner_meds = sorted({m.drug for m in scan.meds})
    section_meds = sorted(
        {
            m.matched_name
            for item in med_section_items(note.text, cmap)
            for m in [cached_match(item)]
            if m.matched_name is not None
        }
    )
    s_text, s_fps, s_missed = med_score(scanner_meds, note.meds, eq, text_only=True)
    s_all, _, _ = med_score(scanner_meds, note.meds, eq, text_only=False)
    sec_text, sec_fps, _ = med_score(section_meds, note.meds, eq, text_only=True)
    uni_text, _, _ = med_score([*scanner_meds, *section_meds], note.meds, eq, text_only=True)

    flags: list[tuple[str, str, str, str]] = [
        (f.category, str(f.level), f.quote, section_at(note.text, f.span_start))
        for f in scan.red_flags
    ]
    return NoteResult(
        note=note,
        expected=expected,
        out_of_scope=out_of_scope,
        predicted=predicted,
        symptom=set_score(expected, predicted),
        # A predicted concept is always emittable by the lexicon, so predictions stay as-is.
        symptom_in_lexicon=set_score(in_lexicon, predicted),
        symptom_fp=fp_errors,
        symptom_fn=fn_errors,
        scanner_meds=scanner_meds,
        section_meds=section_meds,
        med_scanner_text=s_text,
        med_scanner_all=s_all,
        med_section_text=sec_text,
        med_union_text=uni_text,
        med_fp=[("scanner", p) for p in s_fps] + [("section+matcher", p) for p in sec_fps],
        med_missed_text=s_missed,
        red_flags=flags,
        escalation=escalation_level(scan, "note"),
        serious=seriousness_suspected(scan),
        scan=scan,
    )


def _accepted(cmap: ComplaintMap, primary: str) -> frozenset[str]:
    for concept in cmap.complaints.values():
        if concept is not None and concept.primary == primary:
            return concept.accepted
    return frozenset({primary})


# --------------------------------------------------------------------------------------
# Con-med matcher normalization over every Synthea display
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MatchRow:
    text: str
    ingredients: tuple[str, ...]
    n_notes: int
    labels: tuple[str, ...]
    matched: str | None
    kind: str
    confidence: float
    nearest: str
    outcome: str
    """``correct``, ``wrong`` or ``unmatched``."""


def match_rows(
    occurrences: Mapping[str, tuple[tuple[str, ...], set[str], set[str]]],
    eq: Mapping[str, frozenset[str]],
) -> list[MatchRow]:
    """Run the con-med matcher on each distinct text; ``occurrences`` maps text ->
    (ingredients, note ids, participant labels)."""
    rows = []
    for text in sorted(occurrences):
        ingredients, note_ids, labels = occurrences[text]
        m = cached_match(text)
        if m.matched_name is None:
            outcome = "unmatched"
        elif any(name_matches(m.matched_name, ing, eq) for ing in ingredients):
            outcome = "correct"
        else:
            outcome = "wrong"
        nearest = f"{m.candidates[0][0]} (d={m.candidates[0][1]})" if m.candidates else "-"
        rows.append(
            MatchRow(
                text,
                ingredients,
                len(note_ids),
                tuple(sorted(labels)),
                m.matched_name,
                m.match_kind,
                m.confidence,
                nearest,
                outcome,
            )
        )
    return rows


def display_occurrences(
    notes: Sequence[Note],
) -> dict[str, tuple[tuple[str, ...], set[str], set[str]]]:
    out: dict[str, tuple[tuple[str, ...], set[str], set[str]]] = {}
    for note in notes:
        for g in note.meds:
            _, ids, labels = out.setdefault(g.display, (g.ingredients, set(), set()))
            ids.add(note.id)
            labels.add(note.label)
    return out


def section_occurrences(
    notes: Sequence[Note], cmap: ComplaintMap
) -> dict[str, tuple[tuple[str, ...], set[str], set[str]]]:
    """Each '# Medications' item with the ingredients of the ground-truth item it names (the
    item text starts with that medication's lowercased display)."""
    out: dict[str, tuple[tuple[str, ...], set[str], set[str]]] = {}
    for note in notes:
        for item in med_section_items(note.text, cmap):
            lowered = item.lower()
            owner = next((g for g in note.meds if g.display.lower() == lowered), None) or next(
                (g for g in note.meds if any(i in lowered for i in g.ingredients)), None
            )
            ings = owner.ingredients if owner else ()
            _, ids, labels = out.setdefault(item, (ings, set(), set()))
            ids.add(note.id)
            labels.add(note.label)
    return out


# --------------------------------------------------------------------------------------
# Baseline vitals vs corroboration thresholds
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Threshold:
    metric: str
    """``pulse`` or ``breathing`` (the table's metric name)."""
    key: str
    """The participants.json ``baseline_vitals`` key (``pulse_bpm``)."""
    value: float
    rule_ids: tuple[str, ...]
    unit: str


def corroboration_thresholds() -> list[Threshold]:
    """Every ``vital`` condition of ``vitals_corroboration.json`` (>= only), grouped by metric
    and value. Nothing is hardcoded: change the table and this section changes."""
    table = load_table("vitals_corroboration")
    plaus = _obj(table.get("plausibility"), "vitals_corroboration.plausibility")
    found: dict[tuple[str, float], list[str]] = defaultdict(list)
    for r_raw in _arr(table.get("rules"), "vitals_corroboration.rules"):
        rule = _obj(r_raw, "rule")
        cond = _obj(rule.get("condition"), "rule.condition")
        for c_raw in _arr(cond.get("all"), "rule.condition.all"):
            c = _obj(c_raw, "condition")
            if c.get("kind") != "vital":
                continue
            if c.get("op") != ">=":
                raise EvalError(f"unsupported vital operator {c.get('op')!r}")
            found[(_text(c.get("metric"), "metric"), float(c["value"]))].append(
                _text(rule.get("id"), "rule.id")
            )
    out = []
    for (metric, value), ids in sorted(found.items()):
        key = f"{metric}_bpm"
        if key not in plaus:
            raise EvalError(f"no plausibility entry {key!r} for vital metric {metric!r}")
        unit = _text(_obj(plaus[key], key).get("unit"), f"{key}.unit")
        out.append(Threshold(metric, key, value, tuple(sorted(ids)), unit))
    return out


def plausibility_bounds() -> dict[str, tuple[float, float]]:
    plaus = _obj(load_table("vitals_corroboration").get("plausibility"), "plausibility")
    return {
        k: (float(_obj(v, k)["min"]), float(_obj(v, k)["max"])) for k, v in sorted(plaus.items())
    }


@dataclass(frozen=True)
class VitalSeries:
    label: str
    median: float | None
    values: tuple[float, ...]


def participant_vitals(participants: Sequence[JsonObj], key: str) -> list[VitalSeries]:
    out = []
    for p in participants:
        bv = _obj(p.get("baseline_vitals") or {}, "baseline_vitals")
        series = bv.get(key)
        if series is None:
            out.append(VitalSeries(_text(p.get("label"), "label"), None, ()))
            continue
        s = _obj(series, key)
        values = tuple(float(_obj(v, key)["value"]) for v in _arr(s.get("values"), key))
        median = s.get("median")
        out.append(
            VitalSeries(
                _text(p.get("label"), "label"),
                None if median is None else float(median),
                values,
            )
        )
    return sorted(out, key=lambda v: v.label)


# --------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------


@dataclass
class Report:
    lines: list[str] = field(default_factory=list)

    def add(self, *lines: str) -> None:
        self.lines.extend(lines)

    def table(self, header: Sequence[str], rows: Iterable[Sequence[object]]) -> None:
        self.lines.append("| " + " | ".join(header) + " |")
        self.lines.append("|" + "|".join("---" for _ in header) + "|")
        for row in rows:
            cells = [str(c).replace("|", "\\|").replace("\n", " ") for c in row]
            self.lines.append("| " + " | ".join(cells) + " |")
        self.lines.append("")

    def text(self) -> str:
        return "\n".join(self.lines).rstrip("\n") + "\n"


def _score_row(name: str, s: Score) -> list[object]:
    return [
        name,
        s.pred_correct,
        s.fp,
        s.fn,
        fmt(s.precision),
        fmt(s.recall),
        fmt(s.f1),
    ]


SCORE_HEADER = ("", "TP", "FP", "FN", "Precision", "Recall", "F1")


def _f(value: float) -> str:
    return f"{value:g}"


@dataclass(frozen=True)
class Inputs:
    notes_path: Path
    participants_path: Path
    map_path: Path
    manifest_path: Path


@dataclass(frozen=True)
class VitalsSummary:
    """One metric x threshold row of section (d)."""

    threshold: Threshold
    n_participants: int
    medians: tuple[float, ...]
    at_or_above_median: int
    any_reading_at_or_above: int
    implausible_readings: int

    @property
    def headroom(self) -> tuple[float, float] | None:
        """(min, max) of threshold - participant median."""
        if not self.medians:
            return None
        gaps = [self.threshold.value - m for m in self.medians]
        return min(gaps), max(gaps)


@dataclass(frozen=True)
class EscalationSummary:
    by_class: Mapping[str, Sequence[NoteResult]]
    flagged: Mapping[str, Sequence[NoteResult]]
    emergency: Sequence[NoteResult]
    emergency_flagged: Sequence[NoteResult]
    serious_notes: Sequence[NoteResult]
    serious_caught: Sequence[NoteResult]
    serious_elsewhere: Sequence[NoteResult]
    n_flagged: int

    @property
    def ambulatory(self) -> tuple[int, int]:
        """(flagged, total) ambulatory notes."""
        return len(self.flagged.get("ambulatory", [])), len(self.by_class.get("ambulatory", []))


@dataclass(frozen=True)
class Evaluation:
    """Everything computed; the renderers below only format it."""

    inputs: Inputs
    reference_date: str
    generated_with: JsonObj
    runs: tuple[JsonObj, ...]
    notes: tuple[Note, ...]
    participants: tuple[JsonObj, ...]
    cmap: ComplaintMap
    lexicon_terms: frozenset[str]
    med_lexicon_size: int
    hist: HistoryScope
    results: tuple[NoteResult, ...]
    display_rows: tuple[MatchRow, ...]
    section_rows: tuple[MatchRow, ...]
    escalation: EscalationSummary
    thresholds: tuple[Threshold, ...]
    vitals: tuple[VitalsSummary, ...]
    series: Mapping[str, Sequence[VitalSeries]]

    def in_lexicon(self, concept: str) -> bool:
        return any(t in self.lexicon_terms for t in _accepted(self.cmap, concept))


def summarize_escalation(results: Sequence[NoteResult]) -> EscalationSummary:
    classes = sorted({x.note.encounter_class for x in results})
    by_class = {c: [x for x in results if x.note.encounter_class == c] for c in classes}
    emergency = [x for x in results if x.note.is_emergency]
    serious_notes = [x for x in results if x.note.encounter_class in SERIOUS_CLASSES]
    return EscalationSummary(
        by_class=by_class,
        flagged={c: [x for x in xs if x.red_flags] for c, xs in by_class.items()},
        emergency=emergency,
        emergency_flagged=[x for x in emergency if x.red_flags],
        serious_notes=serious_notes,
        serious_caught=[x for x in serious_notes if x.serious],
        serious_elsewhere=[
            x for x in results if x.serious and x.note.encounter_class not in SERIOUS_CLASSES
        ],
        n_flagged=sum(1 for x in results if x.red_flags),
    )


def summarize_vitals(
    participants: Sequence[JsonObj], thresholds: Sequence[Threshold]
) -> tuple[tuple[VitalsSummary, ...], dict[str, list[VitalSeries]]]:
    bounds = plausibility_bounds()
    series = {t.key: participant_vitals(participants, t.key) for t in thresholds}
    out = []
    for t in thresholds:
        ss = series[t.key]
        medians = tuple(s.median for s in ss if s.median is not None)
        lo, hi = bounds[t.key]
        out.append(
            VitalsSummary(
                threshold=t,
                n_participants=len(medians),
                medians=medians,
                at_or_above_median=sum(1 for m in medians if m >= t.value),
                any_reading_at_or_above=sum(1 for s in ss if any(v >= t.value for v in s.values)),
                implausible_readings=sum(1 for s in ss for v in s.values if not lo <= v <= hi),
            )
        )
    return tuple(out), series


def evaluate(inputs: Inputs) -> Evaluation:
    """Load the inputs, scan every note, and compute every number the report shows."""
    notes_raw, notes = load_notes(inputs.notes_path)
    participants_raw = read_json(inputs.participants_path)
    participants = tuple(
        _obj(p, "participants[]") for p in _arr(participants_raw.get("participants"), "p")
    )
    manifest = read_json(inputs.manifest_path) if inputs.manifest_path.is_file() else {}
    cmap = load_complaint_map(inputs.map_path)
    lexicon = load_table("chartscan_lexicon")
    lexicon_terms = frozenset(_obj(lexicon["symptom_patterns"], "symptom_patterns"))
    hist = history_scope()
    results = tuple(evaluate_note(n, cmap, lexicon_terms, hist) for n in notes)
    eq = cmap.ingredient_equivalents
    thresholds = tuple(corroboration_thresholds())
    vitals, series = summarize_vitals(participants, thresholds)
    return Evaluation(
        inputs=inputs,
        reference_date=_text(notes_raw.get("reference_date"), "notes.reference_date"),
        generated_with=_obj(
            manifest.get("generated_with", participants_raw.get("generated_with", {})),
            "generated_with",
        ),
        runs=tuple(_obj(x, "run") for x in _arr(manifest.get("runs", []), "runs")),
        notes=tuple(notes),
        participants=participants,
        cmap=cmap,
        lexicon_terms=lexicon_terms,
        med_lexicon_size=len(_obj(lexicon["med_patterns"], "med_patterns")),
        hist=hist,
        results=results,
        display_rows=tuple(match_rows(display_occurrences(notes), eq)),
        section_rows=tuple(match_rows(section_occurrences(notes, cmap), eq)),
        escalation=summarize_escalation(results),
        thresholds=thresholds,
        vitals=vitals,
        series=series,
    )


def _sum(ev: Evaluation, attr: str) -> Score:
    return sum_scores(cast(Score, getattr(x, attr)) for x in ev.results)


def _outcomes(rows: Sequence[MatchRow]) -> tuple[int, int, int, int]:
    """(total, correct, wrong, unmatched)."""
    out = Counter(row.outcome for row in rows)
    return len(rows), out["correct"], out["wrong"], out["unmatched"]


def headline_numbers(ev: Evaluation) -> dict[str, str]:
    """The one-line results printed by the CLI and shown at the top of the document."""
    sym, sym_lex = _sum(ev, "symptom"), _sum(ev, "symptom_in_lexicon")
    med_text, med_all = _sum(ev, "med_scanner_text"), _sum(ev, "med_scanner_all")
    sec, uni = _sum(ev, "med_section_text"), _sum(ev, "med_union_text")
    n, ok, bad, un = _outcomes(ev.display_rows)
    esc = ev.escalation
    amb_f, amb_n = esc.ambulatory
    vitals = []
    for v in ev.vitals:
        head = v.headroom
        room = f"{_f(head[0])}-{_f(head[1])}" if head else "n/a"
        vitals.append(
            f"{v.threshold.metric} >= {_f(v.threshold.value)}: {v.at_or_above_median}/"
            f"{v.n_participants} baseline medians at/above (headroom {room})"
        )
    return {
        "symptoms": f"P {fmt(sym.precision)} R {fmt(sym.recall)} F1 {fmt(sym.f1)} "
        f"(in-lexicon R {fmt(sym_lex.recall)})",
        "meds_scanner": f"P {fmt(med_text.precision)} R(text) {fmt(med_text.recall)} "
        f"R(all) {fmt(med_all.recall)}",
        "meds_section_matcher": f"P {fmt(sec.precision)} R(text) {fmt(sec.recall)}; union "
        f"R(text) {fmt(uni.recall)}",
        "matcher_displays": f"{ok}/{n} correct, {bad} wrong, {un} unmatched (coverage "
        f"{fmt((n - un) / n if n else None)})",
        "escalation": f"ambulatory over-escalation {pct(amb_f, amb_n)}; emergency recall "
        f"{pct(len(esc.emergency_flagged), len(esc.emergency))}; seriousness recall "
        f"{pct(len(esc.serious_caught), len(esc.serious_notes))}",
        "vitals": "; ".join(vitals),
    }


# ---------------------------------------------------------------- renderers


def render_header(r: Report, ev: Evaluation, head: Mapping[str, str]) -> None:
    gen = ev.generated_with
    run_text = ", ".join(f"seed {x.get('seed')}: {x.get('patient_count')} kept" for x in ev.runs)
    r.add(
        "# Synthea evaluation of Interim's deterministic text tools",
        "",
        f"> **{LABEL}.** Every note, medication and vital sign scored here is Synthea output: "
        "synthetic patients, no real person. These numbers describe how Interim's rules behave "
        "on Synthea's templated notes. They are **not a clinical validation**.",
        ">",
        "> Generated by `scripts/synthea/eval_synthea.py`. Do not edit by hand. "
        "`eval_synthea.py --check` recomputes this file and requires it to be byte-identical.",
        "",
        "## Why this evaluation matters",
        "",
        "The chart-scan answer key (`packages/rules/data/chartscan_answer_key.json`, 25 cases) was "
        "written alongside the scanner's rules, so passing it is a **regression test, not an "
        "accuracy estimate**. Synthea's notes come from Synthea's own templates. The "
        "**medication and encounter** ground truth comes from Synthea's structured FHIR record, "
        "imported by `scripts/synthea/import_synthea.py`. The **symptom** ground truth is "
        "different: it is the note's own `# Chief Complaint` bullet list, which Synthea renders "
        "from its symptom model independently of the scanner, but which is the same text the "
        "scanner reads. So (a) mostly tests lexicon coverage on bullet text, not extraction "
        "from narrative. None of this ground truth was written by the scanner's author or by "
        "us. The Regeneron judges recommended Synthea, and the starter sheet names it as the "
        "source of chart-scan input. This is the first time the scanner meets text it was not "
        "tuned on.",
        "",
        "## Headline numbers",
        "",
    )
    r.table(
        ("Measure", "Result"),
        [
            ("(a) Symptoms: scanner vs CTCAE-mapped chief complaints", head["symptoms"]),
            ("(b) Medications: scanner vs medications at the note", head["meds_scanner"]),
            (
                "(b) Medications: `# Medications` section + con-med matcher (candidate)",
                head["meds_section_matcher"],
            ),
            ("(b) Con-med matcher on every Synthea medication display", head["matcher_displays"]),
            ("(c) Red flags by encounter class", head["escalation"]),
            ("(d) Baseline vitals vs corroboration thresholds", head["vitals"]),
        ],
    )
    r.add(
        "## Provenance",
        "",
        "Nothing here depends on the clock or a git commit. The document changes only when one "
        "of these inputs or the scoring code changes.",
        "",
    )
    prov: list[tuple[str, str]] = [
        ("Reference date (Synthea `-r`)", ev.reference_date),
        ("Synthea version", str(gen.get("synthea_version", "unknown"))),
        ("Synthea jar sha256", f"`{gen.get('jar_sha256', 'unknown')}`"),
        ("Generation runs (seed: patients kept)", run_text or "unknown"),
        ("Participants / notes", f"{len(ev.participants)} / {len(ev.notes)}"),
        ("Evaluator version", EVAL_VERSION),
    ]
    for label, path in (
        ("data/synthetic/synthea/notes.json", ev.inputs.notes_path),
        ("data/synthetic/synthea/participants.json", ev.inputs.participants_path),
        ("scripts/synthea/complaint_map.json", ev.inputs.map_path),
    ):
        prov.append((f"sha256 `{label}`", f"`{file_sha256(path)}`"))
    for name in RULE_TABLES:
        prov.append(
            (
                f"sha256 `packages/rules/data/{name}.json`",
                f"`{file_sha256(data_dir() / f'{name}.json')}`",
            )
        )
    r.table(("Input", "Value"), prov)


def render_method(r: Report) -> None:
    r.add(
        "## Method",
        "",
        "- Each note is scanned once with `interim_rules.chartscan.scan_text(text, note_date)`, "
        "unchanged. Only kept (non-excluded) findings count as predictions.",
        "- **Symptom ground truth** is the note's `# Chief Complaint` bullets, mapped to CTCAE "
        "v5.0 by `scripts/synthea/complaint_map.json`. Each complaint has its own rationale and "
        "the Synthea module that emits it. Complaints with no CTCAE term (thirst, hunger) are "
        "reported as out of scope, not as misses. Scoring is set-based per note at the "
        "concept level: a concept is a primary CTCAE term plus the alternatives accepted for it "
        "(chest pain may be coded cardiac, chest wall or pleuritic). Precision, recall and F1 are "
        "micro-averaged over notes.",
        "- **Medication ground truth** per note is every medication active on the note date "
        "(structured MedicationRequest intervals plus the note's own `# Medications` list) plus "
        "the encounter's prescriptions, all from `notes.json`. A prediction is correct if it "
        "names any of them. Recall is reported two ways. **R(text)** covers only the items "
        "visible in the note text, which is all a text scanner can find. **R(all)** covers "
        "every item, including structured-only ones the text never mentions. Names are compared "
        "in lower case per ingredient; a salt suffix and the synonyms in `complaint_map.json` "
        "`ingredient_equivalents` count as equal.",
        "- **Section-aware variant (a candidate improvement, not shipped):** split the "
        "`# Medications` line on `;` and run `interim_rules.conmed.match_conmed` on each item. "
        "This shows what a section-aware matcher would add. The scanner is not changed.",
        "- **Escalation:** every red flag the scanner raises, broken down by the FHIR encounter "
        "class. Interim routes every chart-note flag to the coordinator as `urgent`; a note "
        "never pages anyone (D-017). Over-escalation is the share of ambulatory notes with any "
        "flag. Seriousness is checked against emergency and inpatient encounters.",
        "- **Vitals:** Synthea's baseline pulse and breathing medians per participant, compared "
        "with the `vital` conditions read from `packages/rules/data/vitals_corroboration.json`.",
        "",
    )


def render_symptoms(r: Report, ev: Evaluation) -> None:
    results = ev.results
    sym, sym_lex = _sum(ev, "symptom"), _sum(ev, "symptom_in_lexicon")
    oos = Counter(c for x in results for c in x.out_of_scope)
    r.add(
        "## (a) Symptom extraction",
        "",
        f"{len(ev.notes)} notes; {sum(len(x.expected) for x in results)} CTCAE-mappable "
        f"complaint concepts expected; {sum(oos.values())} out-of-scope complaint mentions "
        f"({', '.join(f'{k} {v}' for k, v in sorted(oos.items())) or 'none'}).",
        "",
    )
    r.table(
        SCORE_HEADER,
        [
            _score_row("All CTCAE-mappable complaints", sym),
            _score_row("Only concepts the scanner lexicon can emit", sym_lex),
        ],
    )
    r.add(
        "The second row restricts the ground truth to concepts with a term in "
        "`chartscan_lexicon.json` `symptom_patterns`. The gap between the two rows is lexicon "
        "coverage; the second row measures the scanner on what it was built to find.",
        "",
        "### Per concept",
        "",
    )
    per_concept: dict[str, Score] = defaultdict(Score)
    for x in results:
        for c in x.expected | x.predicted:
            per_concept[c] = per_concept[c] + set_score(x.expected & {c}, x.predicted & {c})
    r.table(
        ("Concept (primary CTCAE term)", *SCORE_HEADER[1:], "Also accepted", "In lexicon"),
        [
            [
                *_score_row(c, per_concept[c]),
                ", ".join(sorted(_accepted(ev.cmap, c) - {c})) or "-",
                "yes" if ev.in_lexicon(c) else "no",
            ]
            for c in sorted(per_concept, key=lambda k: (-per_concept[k].gt_total, k))
        ],
    )

    fn_groups: dict[tuple[str, str], list[SymptomError]] = defaultdict(list)
    fp_groups: dict[tuple[str, str], list[SymptomError]] = defaultdict(list)
    for x in results:
        for e in x.symptom_fn:
            fn_groups[(e.concept, e.quote)].append(e)
        for e in x.symptom_fp:
            fp_groups[(e.concept, e.context)].append(e)

    def by_count(item: tuple[tuple[str, str], list[SymptomError]]) -> tuple[int, str, str]:
        (a, b), es = item
        return -len(es), a, b

    r.add("### Top false negatives (complaint in the note, not found by the scanner)", "")
    r.table(
        ("Concept", "Notes", "Quote", "In lexicon", "Example notes"),
        [
            (
                c,
                len(es),
                f"`{q}`",
                "yes" if ev.in_lexicon(c) else "no",
                ", ".join(e.note_id for e in es[:3]),
            )
            for (c, q), es in sorted(fn_groups.items(), key=by_count)[:TOP_N]
        ]
        or [("-", 0, "-", "-", "-")],
    )
    r.add("### Top false positives (scanner term with no matching chief complaint)", "")
    r.table(
        (
            "Scanner concept",
            "Notes",
            "Quoted span in context",
            "Section",
            "Diagnosed here",
            "Example notes",
        ),
        [
            (
                c,
                len(es),
                f"`{ctx}`",
                f"`{es[0].section}`",
                f"{sum(e.supported_by_record for e in es)}/{len(es)}",
                ", ".join(e.note_id for e in es[:3]),
            )
            for (c, ctx), es in sorted(fp_groups.items(), key=by_count)[:TOP_N]
        ]
        or [("-", 0, "-", "-", "-", "-")],
    )
    fps = [e for es in fp_groups.values() for e in es]
    sections = Counter(e.section for e in fps)
    beyond = [e for e in fps if e.history_words is not None and e.history_words > ev.hist.max_words]
    beyond_words = sorted({e.history_words for e in beyond if e.history_words is not None})
    diagnosed = [e for e in fps if e.supported_by_record]
    r.add(
        f"{len(fps)} false positives. By note section: "
        + (", ".join(f"`{k}` {v}" for k, v in sorted(sections.items())) or "none")
        + ".",
        "",
    )
    if beyond:
        r.add(
            f'- **History lists ({len(beyond)}).** These terms sit in a "Patient has a history '
            f'of ..." list, {beyond_words[0]} to {beyond_words[-1]} words after the cue. The '
            f"scanner's history exclusion only reaches {ev.hist.max_words} words "
            "(`chartscan_lexicon.json` `scope.negation_max_words`), so a past condition near the "
            "end of a long list is read as a current symptom. This is a real scanner error, and "
            "real notes with long problem lists would trigger it too.",
        )
    if diagnosed:
        r.add(
            f"- **Assessment diagnoses ({len(diagnosed)}).** These name a condition Synthea "
            "recorded as diagnosed at the same encounter. It is in the record but is not a chief "
            "complaint, and an infection diagnosis is not a symptom report. Whether such a "
            "mention should become an AE draft is a protocol decision for the coordinator.",
        )
    excluded = Counter(
        (s.term, s.excluded_reason or "-", s.quote)
        for x in results
        for s in x.scan.excluded_symptoms
    )
    r.add(
        "",
        "Mentions the scanner excluded (shown for transparency; not counted as predictions). "
        "When a history-list term sits within the window, the exclusion works:",
        "",
    )
    r.table(
        ("Term", "Reason", "Quote", "Mentions"),
        [(t, reason, f"`{q}`", n) for (t, reason, q), n in sorted(excluded.items())]
        or [("-", "-", "-", 0)],
    )


def _kind_table(r: Report, rows: Sequence[MatchRow]) -> None:
    table_rows: list[Sequence[object]] = []
    for kind in sorted({row.kind for row in rows}):
        n, ok, bad, _ = _outcomes([row for row in rows if row.kind == kind])
        table_rows.append((kind, n, ok, bad, "-" if kind == "unmatched" else pct(bad, n)))
    n, ok, bad, un = _outcomes(rows)
    table_rows.append(("**all**", n, ok, bad, pct(bad, n - un)))
    r.table(("match_kind", "Distinct texts", "Correct", "Wrong", "Wrong-match rate"), table_rows)
    r.add(
        f"Accuracy {pct(ok, n)}; coverage (matched at all) {pct(n - un, n)}; precision of "
        f"proposals {pct(ok, n - un)}.",
        "",
    )


def render_meds(r: Report, ev: Evaluation) -> None:
    results = ev.results
    med_text, med_all = _sum(ev, "med_scanner_text"), _sum(ev, "med_scanner_all")
    sec, uni = _sum(ev, "med_section_text"), _sum(ev, "med_union_text")
    origins = Counter(g.origin for x in results for g in x.note.meds)
    r.add(
        "## (b) Medication extraction and normalization",
        "",
        f"Ground truth: {med_all.gt_total} medication items across the notes, of which "
        f"{med_text.gt_total} are visible in the note text. By origin: "
        + ", ".join(f"{k} {v}" for k, v in sorted(origins.items()))
        + ".",
        "",
        "### Extraction from note text",
        "",
    )
    r.table(
        ("Method", "Correct", "FP", "Precision", "R(text)", "F1(text)", "R(all)"),
        [
            (
                "Chart scanner (`scan_text` meds)",
                med_text.pred_correct,
                med_text.fp,
                fmt(med_text.precision),
                fmt(med_text.recall),
                fmt(med_text.f1),
                fmt(med_all.recall),
            ),
            (
                "`# Medications` section + `match_conmed` (candidate)",
                sec.pred_correct,
                sec.fp,
                fmt(sec.precision),
                fmt(sec.recall),
                fmt(sec.f1),
                "-",
            ),
            (
                "Union of both (candidate)",
                uni.pred_correct,
                uni.fp,
                fmt(uni.precision),
                fmt(uni.recall),
                fmt(uni.f1),
                "-",
            ),
        ],
    )
    missed = Counter(g.key for x in results for g in x.med_missed_text)
    r.add(
        "Medications visible in the note text that the scanner did not find, by ingredient. "
        f"The scanner's medication lexicon has {ev.med_lexicon_size} drugs, aimed at symptom "
        "treatments and common con-meds; no chemotherapy agent is in it.",
        "",
    )
    r.table(
        ("Ingredient", "Notes missed"),
        [(k, v) for k, v in sorted(missed.items(), key=lambda kv: (-kv[1], kv[0]))[:15]]
        or [("-", 0)],
    )
    med_fps = Counter((who, name) for x in results for who, name in x.med_fp)
    r.add("False-positive medication names:", "")
    r.table(
        ("Method", "Predicted", "Notes"),
        [(w, n, c) for (w, n), c in sorted(med_fps.items())] or [("-", "-", 0)],
    )

    r.add(
        "### Con-med matcher on Synthea's RxNorm displays",
        "",
        "`match_conmed(display)` on every distinct medication display in the ground truth, "
        "compared with the display's parsed ingredient(s). These long RxNorm strings are not what "
        "a participant types at the kiosk, so this measures the bundled list's coverage, not "
        "kiosk accuracy.",
        "",
    )
    _kind_table(r, ev.display_rows)
    r.add("### Con-med matcher on the `# Medications` items", "")
    _kind_table(r, ev.section_rows)
    wrong = [("RxNorm display", row) for row in ev.display_rows if row.outcome == "wrong"] + [
        ("`# Medications` item", row) for row in ev.section_rows if row.outcome == "wrong"
    ]
    r.add(
        "Wrong matches (every one). The matcher also tries each word of at least "
        "`min_token_length` characters on its own (`conmed_matching.json`). A salt or vitamin "
        "word within two edits of a brand name is therefore proposed as that brand's generic:",
        "",
    )
    r.table(
        ("Where", "Text", "Ingredient", "Proposed", "Kind", "Confidence", "Nearest entry", "Notes"),
        [
            (
                where,
                f"`{w.text}`",
                ", ".join(w.ingredients) or "?",
                w.matched,
                w.kind,
                _f(w.confidence),
                w.nearest,
                w.n_notes,
            )
            for where, w in sorted(wrong, key=lambda pair: (-pair[1].n_notes, pair[1].text))
        ]
        or [("-", "-", "-", "-", "-", "-", "-", 0)],
    )
    gaps: dict[str, tuple[set[str], set[str]]] = {}
    for row in ev.display_rows:
        if row.outcome == "unmatched":
            ids, labels = gaps.setdefault(row.ingredients[0], (set(), set()))
            ids.update(n.id for n in ev.notes if any(g.display == row.text for g in n.meds))
            labels.update(row.labels)
    r.add("Unmatched ingredients, by how often they occur (the medlist gaps):", "")
    r.table(
        ("Ingredient", "Notes", "Participants"),
        [
            (k, len(ids), len(labels))
            for k, (ids, labels) in sorted(gaps.items(), key=lambda kv: (-len(kv[1][0]), kv[0]))
        ]
        or [("-", 0, 0)],
    )


def render_escalation(r: Report, ev: Evaluation) -> None:
    esc = ev.escalation
    results = ev.results
    r.add("## (c) Escalation behaviour", "")
    rows: list[Sequence[object]] = []
    for c, sub in esc.by_class.items():
        levels = Counter(level for x in esc.flagged[c] for _, level, _, _ in x.red_flags)
        rows.append(
            (
                c,
                len(sub),
                pct(len(esc.flagged[c]), len(sub)),
                ", ".join(f"{k} {v}" for k, v in sorted(levels.items())) or "-",
                sum(1 for x in sub if x.serious),
            )
        )
    rows.append(
        (
            "**all**",
            len(results),
            pct(esc.n_flagged, len(results)),
            "-",
            sum(1 for x in results if x.serious),
        )
    )
    r.table(
        (
            "Encounter class",
            "Notes",
            "Notes with a red flag",
            "Flags by table level",
            "Seriousness cue",
        ),
        rows,
    )
    cats = Counter((cat, quote, section) for x in results for cat, _, quote, section in x.red_flags)
    r.table(
        ("Category", "Quote", "Section of the note", "Flags"),
        [
            (cat, f"`{q}`", f"`{s}`", n)
            for (cat, q, s), n in sorted(cats.items(), key=lambda kv: (-kv[1], kv[0]))
        ]
        or [("-", "-", "-", 0)],
    )
    cc_heading = "# Chief Complaint"

    def all_from_complaints(xs: Iterable[NoteResult]) -> bool:
        return all(sec == cc_heading for x in xs for _, _, _, sec in x.red_flags)

    amb_f, amb_n = esc.ambulatory
    amb_why = (
        f" Every one of these flags comes from the `{cc_heading}` section. Synthea repeats a "
        "person's standing symptom list on every note, so one complaint bullet raises the same "
        "flag at every routine visit."
        if amb_f and all_from_complaints(esc.flagged.get("ambulatory", []))
        else ""
    )
    emer_why = (
        f" Every hit comes from the `{cc_heading}` section, not from anything that marks the "
        "visit as an emergency."
        if esc.emergency_flagged and all_from_complaints(esc.emergency_flagged)
        else ""
    )
    serious_why = (
        " No note text names a hospitalization or ER visit (the encounter type is structured, "
        "not written in Synthea's note), so text alone cannot start an SAE clock here. In "
        "Interim, the kiosk's hospitalization gate question is what starts the clock."
        if not esc.serious_caught and not esc.serious_elsewhere
        else ""
    )
    missed = [x.note.id for x in esc.emergency if not x.red_flags]
    chest = [x for x in results if "Chest Pain" in x.note.chief_complaints]
    levels = Counter(x.escalation for x in results)
    r.add(
        f"- **Over-escalation on ambulatory notes:** {pct(amb_f, amb_n)} raise a red flag."
        + amb_why,
        "- **Recall on true emergency encounters** (FHIR `Encounter.class == EMER`): "
        f"{pct(len(esc.emergency_flagged), len(esc.emergency))}."
        + emer_why
        + (f" Missed: {', '.join(missed)}." if missed else ""),
        f"- Notes whose chief complaints include Chest Pain: {len(chest)}; of these, flagged: "
        f"{sum(1 for x in chest if x.red_flags)}. Notes flagged in total: {esc.n_flagged}.",
        "- **Seriousness (hospitalization / ER) cue:** "
        f"{pct(len(esc.serious_caught), len(esc.serious_notes))} of emergency + inpatient "
        f"notes; {len(esc.serious_elsewhere)} on other notes." + serious_why,
        "- Interim's note escalation levels: "
        + ", ".join(f"`{k}` {v}" for k, v in sorted(levels.items()))
        + ". A chart note never pages anyone or stops a kiosk; a flag puts the note in the "
        "coordinator's urgent review queue.",
        "",
    )


def render_vitals(r: Report, ev: Evaluation) -> None:
    r.add(
        "## (d) Baseline vitals vs the corroboration thresholds",
        "",
        "Synthea records pulse (LOINC 8867-4) and respiratory rate (9279-1) at yearly visits; "
        "`participants.json` keeps each participant's values and median. The thresholds below "
        "are read from `vitals_corroboration.json`, not typed here.",
        "",
    )
    r.table(
        ("Metric", "Threshold", "Rules"),
        [(t.metric, f">= {_f(t.value)} {t.unit}", ", ".join(t.rule_ids)) for t in ev.thresholds],
    )

    def spread(values: Sequence[float]) -> str:
        if not values:
            return "-"
        return f"{_f(min(values))} / {_f(statistics.median(values))} / {_f(max(values))}"

    rows = []
    for v in ev.vitals:
        head = v.headroom
        rows.append(
            (
                v.threshold.metric,
                v.n_participants,
                spread(v.medians),
                f">= {_f(v.threshold.value)}",
                v.at_or_above_median,
                v.any_reading_at_or_above,
                f"{_f(head[0])} to {_f(head[1])}" if head else "-",
                v.implausible_readings,
            )
        )
    r.table(
        (
            "Metric",
            "Participants",
            "Baseline medians (min / median / max)",
            "Threshold",
            "Median at/above",
            "Any reading at/above",
            "Headroom (threshold - median)",
            "Readings outside plausibility",
        ),
        rows,
    )
    keys = sorted({(t.metric, t.key) for t in ev.thresholds})
    labels = sorted({s.label for ss in ev.series.values() for s in ss})
    per_p: list[Sequence[object]] = []
    for label in labels:
        cells: list[object] = [label]
        for _, key in keys:
            s = next(x for x in ev.series[key] if x.label == label)
            cells.append("-" if s.median is None else f"{_f(s.median)} ({len(s.values)})")
        per_p.append(cells)
    r.add("Per participant (median and number of readings):", "")
    r.table(("Participant", *(f"{m} median (n)" for m, _ in keys)), per_p)
    r.add(
        "The thresholds are the same for everyone. A participant whose baseline sits close to a "
        "threshold needs a much smaller change to fire a rule than one far below it. This is the "
        '"thresholds are not personalized to baseline" limitation in '
        "`docs/WHAT_IT_GETS_WRONG.md`, measured. Synthea's yearly resting values are also not "
        "camera measurements taken during a check-in.",
        "",
    )


def render_limits(r: Report, ev: Evaluation) -> None:
    r.add(
        "## What this does and does not show",
        "",
        "**Shows:**",
        "",
        "- How the shipped scanner and con-med matcher behave on clinical text and medication "
        "names neither of them was tuned on. Medications and encounters are scored against "
        "Synthea's structured FHIR record; symptoms against Synthea's rendered chief-complaint "
        "list in the note (Synthea's own, independent of the scanner, but not structured).",
        "- Concrete, reproducible failure modes, each with a quote and a note id: lexicon gaps, "
        "a history window too short for a long problem list, Levenshtein false matches on "
        "single words, and red flags fired by a templated complaint list.",
        "- How much a cheap, deterministic, section-aware use of the existing matcher would "
        "add, measured before anyone builds it.",
        "",
        "**Does not show:**",
        "",
        "- **Clinical accuracy.** Synthea's notes are templated and far cleaner than real "
        "notes. There is no negation, no narrative, no abbreviations or typos, and every "
        "section repeats. On real notes, precision and recall would both be lower, and the "
        "scanner's negation logic is barely exercised here.",
        "- **True symptoms.** Chief complaints are a proxy. Synthea renders the person's "
        "standing symptom list, not what was said at the visit. In this Synthea version the "
        'lung cancer module\'s dyspnea, fever and fatigue states all emit "Cough" '
        "(`complaint_map.json`), so the cohort shows no dyspnea at all.",
        "- **Immune-related AEs.** Synthea treats NSCLC with cisplatin + paclitaxel and has no "
        "PD-1 inhibitor. These notes say nothing about the pneumonitis, colitis or rash that "
        "matter for cemiplimab.",
        f"- **Generalization.** {len(ev.participants)} participants and {len(ev.notes)} notes "
        "from one Synthea configuration. The counts are small and correlated, because notes "
        "repeat within a participant.",
        "",
    )


def render_appendix(r: Report, ev: Evaluation) -> None:
    r.add("## Appendix: per-note results", "")
    r.table(
        (
            "Note",
            "Class",
            "Expected concepts",
            "Scanner concepts",
            "Sym TP/FP/FN",
            "Meds scanner",
            "Med text found",
            "Red flags",
        ),
        [
            (
                x.note.id,
                x.note.encounter_class,
                ", ".join(sorted(x.expected)) or "-",
                ", ".join(sorted(x.predicted)) or "-",
                f"{x.symptom.pred_correct}/{x.symptom.fp}/{x.symptom.fn}",
                ", ".join(x.scanner_meds) or "-",
                f"{x.med_scanner_text.gt_found}/{x.med_scanner_text.gt_total}",
                ", ".join(sorted({c for c, _, _, _ in x.red_flags})) or "-",
            )
            for x in ev.results
        ],
    )


def build_report(inputs: Inputs) -> tuple[str, dict[str, str]]:
    """Compute everything and render the Markdown. Returns (markdown, headline numbers)."""
    ev = evaluate(inputs)
    head = headline_numbers(ev)
    r = Report()
    render_header(r, ev, head)
    render_method(r)
    render_symptoms(r, ev)
    render_meds(r, ev)
    render_escalation(r, ev)
    render_vitals(r, ev)
    render_limits(r, ev)
    render_appendix(r, ev)
    return r.text(), head


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument("--notes", type=Path, default=DEFAULT_NOTES)
    ap.add_argument("--participants", type=Path, default=DEFAULT_PARTICIPANTS)
    ap.add_argument("--complaint-map", type=Path, default=DEFAULT_MAP)
    ap.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Synthea import manifest (default: manifest.json next to --notes)",
    )
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument(
        "--check",
        action="store_true",
        help="recompute and require --out to be byte-identical (CRLF normalized); write nothing",
    )
    args = ap.parse_args(argv)
    inputs = Inputs(
        notes_path=args.notes,
        participants_path=args.participants,
        map_path=args.complaint_map,
        manifest_path=args.manifest or args.notes.with_name("manifest.json"),
    )
    markdown, headline = build_report(inputs)
    for key, value in headline.items():
        print(f"{key:22} {value}")
    if args.check:
        if not args.out.is_file():
            print(f"check: FAIL, {args.out} does not exist; run without --check first")
            return 1
        current = args.out.read_bytes().replace(b"\r\n", b"\n").decode("utf-8")
        if current != markdown:
            old, new = current.splitlines(), markdown.splitlines()
            first = next(
                (i for i, (a, b) in enumerate(zip(old, new, strict=False)) if a != b),
                min(len(old), len(new)),
            )
            print(f"check: FAIL, {args.out} differs from a fresh run at line {first + 1}")
            print(f"  committed: {old[first] if first < len(old) else '<end of file>'}")
            print(f"  computed:  {new[first] if first < len(new) else '<end of file>'}")
            print("  regenerate with: scripts/synthea/eval_synthea.py (and review the diff)")
            return 1
        print(f"check: OK, {args.out} is byte-identical to a fresh run")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(markdown)
    print(f"wrote {args.out} ({len(markdown.encode('utf-8')):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
