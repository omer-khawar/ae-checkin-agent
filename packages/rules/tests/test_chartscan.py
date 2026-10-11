"""Tests for ``interim_rules.chartscan``, the deterministic chart-note scanner ported from
``omer-khawar/ae-checkin-agent`` (Omer Khawar, MIT; CONTRACTS.md R2.4).

* ``test_answer_key_reproduces_source_evaluation`` reproduces the source repository's
  ``scripts/evaluate.py`` result exactly: AE terms P = R = 1.00, con-med drugs P = R = 1.00,
  11/11 urgent-or-emergency cases escalated, 2/2 emergencies, 0 over-escalations.
* The scoring arithmetic itself is checked on hand-built cases with known misses.
* Unit tests cover every exclusion and grading cue the port preserves, the offset invariant
  ``text[span_start:span_end] == quote``, ``ref_date``-based onsets, table provenance and
  cross-table consistency, and malformed tables failing loudly.
* A hypothesis property: ``scan_text`` never raises on arbitrary text and its output is JSON-safe.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from interim_rules import chartscan as cs
from interim_rules import tables
from interim_rules.tables import TableError, data_dir, load_table, rules_catalog

REF = date(2026, 10, 9)
PARTICIPANTS = {f"P-{n:03d}" for n in range(1, 13)}
MAX_GRADE = int(load_table("composite_to_grade")["max_assignable_grade"])
LEXICON_SECTIONS = [
    "temperature_high", "text_normalization", "scope", "negation", "pseudo_negation",
    "terminators", "historical", "hypothetical", "post_negation", "resolved", "severity_words",
    "explicit_grade", "default_grade", "stool_count",
    "bsa", "worsening", "hospital", "number_words", "duration", "relative_days", "med_started",
    "med_stopped", "med_changed", "med_negated", "allergy", "indication", "human_request",
]  # fmt: skip


def scan(text: str, ref_date: date | None = REF, **kw: bool) -> cs.ScanResult:
    return cs.scan_text(text, ref_date, **kw)


def terms(result: cs.ScanResult) -> list[str]:
    return [s.term for s in result.symptoms]


def excluded(result: cs.ScanResult) -> dict[str, str | None]:
    return {s.term: s.excluded_reason for s in result.excluded_symptoms}


def meds(result: cs.ScanResult) -> set[tuple[str, str]]:
    return {(m.drug, m.change) for m in result.meds}


def symptom(result: cs.ScanResult, term: str) -> cs.SymptomFinding:
    return next(s for s in result.symptoms if s.term == term)


def all_findings(result: cs.ScanResult) -> list[tuple[str, int, int]]:
    out: list[tuple[str, int, int]] = []
    for s in (*result.symptoms, *result.excluded_symptoms):
        out.append((s.quote, s.span_start, s.span_end))
    for m in (*result.meds, *result.excluded_meds):
        out.append((m.quote, m.span_start, m.span_end))
    for r in result.red_flags:
        out.append((r.quote, r.span_start, r.span_end))
    return out


# --------------------------------------------------------------------------- #
# The answer key (reproduces backend/scripts/evaluate.py of the source repository)
# --------------------------------------------------------------------------- #


def test_answer_key_reproduces_source_evaluation() -> None:
    ev = cs.evaluate_answer_key()
    assert ev.n_cases == 42
    assert ev.misses == () and ev.passed
    assert (ev.ae_terms.precision, ev.ae_terms.recall, ev.ae_terms.f1) == (1.0, 1.0, 1.0)
    assert (ev.ae_terms.tp, ev.ae_terms.fp, ev.ae_terms.fn) == (38, 0, 0)
    assert (ev.meds.precision, ev.meds.recall, ev.meds.f1) == (1.0, 1.0, 1.0)
    assert (ev.meds.tp, ev.meds.fp, ev.meds.fn) == (17, 0, 0)
    assert ev.med_change_accuracy == 1.0
    assert (ev.urgent_or_emergency_caught, ev.urgent_or_emergency_needed) == (14, 14)
    assert (ev.emergency_caught, ev.emergency_needed) == (3, 3)
    assert ev.over_escalations == 0
    assert ev.escalation_exact_match == 1.0
    assert (ev.serious_caught, ev.serious_needed) == (3, 3)
    payload = cs.evaluation_to_dict(ev)
    json.dumps(payload, allow_nan=False)
    assert payload["misses"] == [] and payload["passed"] is True
    assert len(payload["per_case"]) == 42


def test_original_source_cases_still_reproduce_the_source_evaluation() -> None:
    """The 25 cases ported from the source repository, scored alone, give exactly the numbers
    its ``scripts/evaluate.py`` reported (the 14 review cases are T18+)."""
    original = [c for c in cs.answer_key() if not (c.id[0] == "T" and int(c.id[1:]) >= 18)]
    ev = cs.evaluate_answer_key(original)
    assert ev.n_cases == 25 and ev.passed
    assert (ev.ae_terms.tp, ev.ae_terms.fp, ev.ae_terms.fn) == (31, 0, 0)
    assert (ev.meds.tp, ev.meds.fp, ev.meds.fn) == (13, 0, 0)
    assert (ev.urgent_or_emergency_caught, ev.urgent_or_emergency_needed) == (11, 11)
    assert (ev.emergency_caught, ev.emergency_needed) == (2, 2)
    assert (ev.serious_caught, ev.serious_needed, ev.over_escalations) == (2, 2, 0)


def raw_cases(cases: tuple[cs.AnswerKeyCase, ...]) -> list[dict[str, Any]]:
    """The answer-key rows as stored (``review_fix`` notes are not part of the dataclass)."""
    rows: list[dict[str, Any]] = load_table("chartscan_answer_key")["cases"]
    assert [r["id"] for r in rows] == [c.id for c in cases]
    return rows


def test_answer_key_composition_and_participant_mapping() -> None:
    cases = cs.answer_key()
    notes = [c for c in cases if c.kind == "note"]
    utterances = [c for c in cases if c.kind == "utterance"]
    assert (len(notes), len(utterances)) == (8, 34)
    assert len({c.id for c in cases}) == 42
    review_cases = [c for c in raw_cases(cs.answer_key()) if c.get("review_fix")]
    assert [c["id"] for c in review_cases] == [f"T{n}" for n in range(18, 35)]
    raw = load_table("chartscan_answer_key")
    mapping = raw["subject_mapping"]
    assert mapping == {f"101-{n:03d}": f"P-{n:03d}" for n in range(1, 7)}
    for note in notes:
        assert note.usubjid_label in PARTICIPANTS
        assert note.note_id and note.note_date == note.ref_date
        date.fromisoformat(note.ref_date)
        assert note.author and note.note_type
    for utt in utterances:
        assert utt.ref_date == raw["utterance_ref_date"] == "2026-10-10"
        assert utt.note_id is None and utt.usubjid_label is None
    # the same AE appears in two notes for one participant (N1 and N7) for cross-note dedup
    by_id = {c.id: c for c in notes}
    assert by_id["N1"].usubjid_label == by_id["N7"].usubjid_label == "P-001"
    assert "Nausea" in by_id["N1"].expected.ae_terms and "Nausea" in by_id["N7"].expected.ae_terms
    assert "SYNTHETIC" in raw["source"] and "Omer Khawar" in raw["source"]


def test_synthetic_chart_notes_file_mirrors_the_answer_key() -> None:
    path = data_dir().parents[2] / "data" / "synthetic" / "chart_notes.json"
    if not path.is_file():  # non-editable install: the repository file is not shipped
        pytest.skip("data/synthetic/chart_notes.json is only present in the repository")
    synthetic = json.loads(path.read_text(encoding="utf-8"))
    assert "SYNTHETIC" in synthetic["_about"] and "Omer Khawar" in synthetic["_about"]
    key = {c.id: c for c in cs.answer_key() if c.kind == "note"}
    assert [n["id"] for n in synthetic["notes"]] == list(key)
    assert synthetic["subject_mapping"] == load_table("chartscan_answer_key")["subject_mapping"]
    for note in synthetic["notes"]:
        case = key[note["id"]]
        assert note["usubjid_label"] == case.usubjid_label
        assert (note["note_date"], note["author"], note["note_type"]) == (
            case.note_date,
            case.author,
            case.note_type,
        )
        assert note["text"] == case.text
        exp = note["expected"]
        assert tuple(exp["ae_terms"]) == case.expected.ae_terms
        assert tuple(tuple(m) for m in exp["meds"]) == case.expected.meds
        assert exp["escalation"] == case.expected.escalation
        assert exp.get("serious", False) is case.expected.serious
        assert exp["escalation"] in ("none", "urgent")  # a note never escalates beyond urgent


def test_scoring_arithmetic_matches_the_source_evaluator() -> None:
    """Hand-built cases with known misses pin the P/R, change-accuracy, escalation and SAE
    arithmetic (micro-averaged, empty classes score 1.0, over-escalation = got > expected)."""

    def case(cid: str, kind: cs.ScanKind, text: str, **exp: Any) -> cs.AnswerKeyCase:
        expected = cs.ExpectedScan(
            ae_terms=tuple(exp.get("ae_terms", ())),
            meds=tuple(exp.get("meds", ())),
            escalation=exp.get("escalation", "none"),
            serious=exp.get("serious", False),
        )
        return cs.AnswerKeyCase(
            id=cid, kind=kind, text=text, ref_date="2026-10-10", expected=expected
        )

    cases = [
        case("A", "note", "Denies nausea.", ae_terms=["Nausea"]),  # false negative
        case(
            "B",
            "note",
            "Severe diarrhea, started loperamide.",
            ae_terms=["Diarrhea"],
            meds=[("loperamide", "stopped")],  # drug right, change wrong
            escalation="urgent",  # expected urgent, nothing fires -> missed escalation
            serious=True,  # expected SAE cue, none -> missed
        ),
        case("C", "utterance", "I have chest pain.", escalation="none"),  # over-escalation + FP
        case("D", "note", "Feels fine.", meds=[("ondansetron", "taking")]),  # drug missed
    ]
    ev = cs.evaluate_answer_key(cases)
    assert ev.n_cases == 4 and not ev.passed
    assert (ev.ae_terms.tp, ev.ae_terms.fp, ev.ae_terms.fn) == (1, 1, 1)
    assert (ev.ae_terms.precision, ev.ae_terms.recall, ev.ae_terms.f1) == (0.5, 0.5, 0.5)
    assert (ev.meds.tp, ev.meds.fp, ev.meds.fn) == (1, 0, 1)
    assert (ev.meds.precision, ev.meds.recall) == (1.0, 0.5)
    assert ev.med_change_accuracy == 0.0  # only matched drugs count toward change accuracy
    assert ev.escalation_exact_match == 0.5
    assert (ev.urgent_or_emergency_caught, ev.urgent_or_emergency_needed) == (0, 1)
    assert (ev.emergency_caught, ev.emergency_needed) == (0, 0)
    assert ev.over_escalations == 1
    assert (ev.serious_caught, ev.serious_needed) == (0, 1)
    problems = {o.case_id: o.problems for o in ev.per_case}
    assert problems["A"] == ("AE missed=['Nausea'] extra=[]",)
    assert problems["B"] == (
        "meds expected=[('loperamide', 'stopped')] got=[('loperamide', 'started')]",
        "escalation expected=urgent got=none",
        "missed possible-SAE cue",
    )
    assert problems["C"] == (
        "AE missed=[] extra=['Chest pain - cardiac']",
        "escalation expected=none got=emergency",
    )
    assert problems["D"] == ("meds expected=[('ondansetron', 'taking')] got=[]",)
    assert [m.case_id for m in ev.misses] == ["A", "B", "C", "D"]
    empty = cs.evaluate_answer_key([])
    assert empty.passed and empty.ae_terms.precision == 1.0 and empty.med_change_accuracy is None
    assert empty.escalation_exact_match == 1.0


# --------------------------------------------------------------------------- #
# Exclusions: negation, pseudo-negation, terminators, history, hypothetical
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("text", "kept", "skipped"),
    [
        ("Denies nausea, vomiting.", [], {"Nausea": "negated", "Vomiting": "negated"}),
        ("No rash noted.", [], {"Rash maculo-papular": "negated"}),
        ("I haven't had any cough.", [], {"Cough": "negated"}),
        ("Pneumonitis ruled out.", [], {"Pneumonitis": "negated"}),
        ("No fever but has diarrhea.", ["Diarrhea"], {"Fever": "negated"}),
        ("I can't stop coughing.", ["Cough"], {}),
        ("Denies nausea. Later reports nausea.", ["Nausea"], {}),
        ("Hx of migraines in her 20s.", [], {"Headache": "historical"}),
        ("History of colitis.", [], {"Colitis": "historical"}),
        ("Pt educated to call for fever > 100.4 or bloody stools.", [], {"Fever": "hypothetical"}),
        ("Monitor for rash.", [], {"Rash maculo-papular": "hypothetical"}),
        ("I'm confused about whether my tiredness counts.", ["Fatigue"], {}),
        ("I'm so tired of this.", [], {}),
    ],
)
def test_context_exclusions(text: str, kept: list[str], skipped: dict[str, str]) -> None:
    result = scan(text)
    assert terms(result) == kept
    assert excluded(result) == skipped
    for s in result.excluded_symptoms:
        assert s.grade_hint is None and s.grade_basis.startswith("not graded")
        assert s.reason.startswith(f"{s.excluded_reason}:")


def test_negation_reason_names_the_cue() -> None:
    result = scan("Denies nausea, vomiting.")
    nausea = next(s for s in result.excluded_symptoms if s.term == "Nausea")
    assert nausea.reason == "negated: 'Denies' precedes 'nausea' in the same clause"
    ruled_out = scan("Pneumonitis ruled out.").excluded_symptoms[0]
    assert ruled_out.reason == "negated: 'ruled out' follows 'Pneumonitis'"
    hx = scan("Hx of migraines in her 20s.").excluded_symptoms[0]
    assert hx.reason == "historical: 'Hx of' precedes 'migraines': past history"
    educated = scan("Pt educated to call for fever.").excluded_symptoms[0]
    assert "instruction or precaution" in educated.reason


def test_hypothetical_also_silences_red_flags() -> None:
    result = scan("Pt educated to call for fever > 100.4 or bloody stools.")
    assert result.red_flags == ()
    assert scan("Denies chest pain.").red_flags == ()


def test_sentence_boundaries_keep_decimals_together() -> None:
    result = scan("Temp 100.4 today. No cough.")
    assert terms(result) == ["Fever"] and symptom(result, "Fever").quote == "Temp 100.4"
    assert excluded(result) == {"Cough": "negated"}


# --------------------------------------------------------------------------- #
# Grade hints
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("text", "grade"),
    [
        ("rash approx 5% BSA", 1),
        ("rash 10% BSA", 2),
        ("rash 30% body surface area", 2),
        ("rash 45% BSA", 3),
    ],
)
def test_bsa_grading(text: str, grade: int) -> None:
    finding = symptom(scan(text), "Rash maculo-papular")
    assert finding.grade_hint == grade
    assert f"maculo-papular rash grade {grade}" in finding.grade_basis


@pytest.mark.parametrize(
    ("text", "grade"),
    [
        ("diarrhea, 3 stools/day", 1),
        ("diarrhea, 4-5 loose stools per day", 2),
        ("diarrhea 6 BMs a day", 2),
        ("diarrhea with 8 episodes per day", 3),
    ],
)
def test_stool_count_grading(text: str, grade: int) -> None:
    finding = symptom(scan(text), "Diarrhea")
    assert finding.grade_hint == grade
    assert f"CTCAE v5 diarrhea grade {grade}" in finding.grade_basis


def test_explicit_grade_beats_every_other_cue() -> None:
    assert symptom(scan("grade 3 diarrhea, 2 stools/day"), "Diarrhea").grade_hint == 3
    rash = symptom(scan("G2 rash 45% BSA"), "Rash maculo-papular")
    assert rash.grade_hint == 2 and rash.grade_basis == "explicit 'grade 2' written in the text"


@pytest.mark.parametrize(
    ("text", "grade", "cue"),
    [
        ("severe nausea", 3, "severe"),
        ("mild headache", 1, "mild"),
        ("headaches, moderate, most afternoons", 2, "moderate"),
        ("a bit of nausea", 1, "a bit of"),
    ],
)
def test_severity_words(text: str, grade: int, cue: str) -> None:
    finding = scan(text).symptoms[0]
    assert finding.grade_hint == grade
    assert (
        finding.grade_basis
        == f"severity word '{cue}' next to the symptom -> provisional grade {grade}"
    )


def test_default_grade_when_no_cue() -> None:
    finding = scan("nausea").symptoms[0]
    assert finding.grade_hint == 1
    assert finding.grade_basis == "mentioned without a severity word -> provisional grade 1"
    assert finding.reason == (
        "'nausea' matched CTCAE term Nausea; no negation, history or instruction cue in scope"
    )


def test_hospital_mention_raises_grade_and_marks_seriousness() -> None:
    result = scan("Admitted overnight for diarrhea.")
    diarrhea = symptom(result, "Diarrhea")
    assert diarrhea.grade_hint == 3
    assert diarrhea.grade_basis.endswith("; raised to 3 because hospitalization/ER is mentioned")
    assert "'Admitted' in the same sentence, not negated (possible hospitalization)" in (
        diarrhea.reason
    )
    assert [(r.level, r.category) for r in result.red_flags] == [("urgent", "hospitalization")]
    assert cs.seriousness_suspected(result)
    ids = [r["rule_id"] for r in cs.rules_fired(result)]
    assert ids == ["chartscan.symptom", "chartscan.red_flag", "chartscan.hospitalization"]
    assert not cs.seriousness_suspected(scan("severe diarrhea"))


# --------------------------------------------------------------------------- #
# Medications
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("started loperamide OTC", {("loperamide", "started")}),
        ("I did stop taking my Advil though.", {("ibuprofen", "stopped")}),
        ("Holding lisinopril per PCP due to cough.", {("lisinopril", "stopped")}),
        ("Dexamethasone discontinued.", {("dexamethasone", "stopped")}),
        ("increased prednisone to 20 mg", {("prednisone", "changed")}),
        ("taking ondansetron as needed", {("ondansetron", "taking")}),
        ("I took some Zofran.", {("ondansetron", "taking")}),
        ("prescribed amoxicillin-clavulanate 875 mg BID", {("amoxicillin-clavulanate", "started")}),
        ("gave me a Z-pack", {("azithromycin", "started")}),
        ("Rx'd cephalexin and docusate.", {("cephalexin", "started"), ("docusate", "started")}),
    ],
)
def test_med_changes_and_normalization(text: str, expected: set[tuple[str, str]]) -> None:
    result = scan(text)
    assert meds(result) == expected
    assert result.excluded_meds == ()
    for m in result.meds:
        assert m.excluded_reason is None and m.reason


def test_med_reason_explains_the_verb() -> None:
    (m,) = scan("started loperamide OTC").meds
    assert m.reason == "'started' appears before 'loperamide' in the same clause -> started"
    (m,) = scan("Dexamethasone discontinued.").meds
    assert m.reason == "'discontinued' appears after 'Dexamethasone' in the same clause -> stopped"
    (m,) = scan("taking ondansetron as needed").meds
    assert m.reason == "'ondansetron' mentioned with no start/stop verb -> currently taking"


def test_med_allergy_and_declined_are_excluded() -> None:
    result = scan("Allergies: amoxicillin, sulfa.")
    assert result.meds == ()
    assert [(m.drug, m.excluded_reason) for m in result.excluded_meds] == [
        ("amoxicillin", "allergy")
    ]
    assert result.excluded_meds[0].reason == "listed as an allergy, not a medication taken"
    result = scan("She is allergic to penicillin and cephalexin.")
    assert [(m.drug, m.excluded_reason) for m in result.excluded_meds] == [
        ("cephalexin", "allergy")
    ]
    result = scan("Patient declined ondansetron.")
    assert result.meds == ()
    (m,) = result.excluded_meds
    assert (m.drug, m.excluded_reason, m.change) == ("ondansetron", "negated", "taking")
    assert m.reason == "medication was declined / not started ('declined')"


def test_med_indication_is_recorded_in_the_reason() -> None:
    (m,) = scan("Urgent care gave me a Z-pack for bronchitis.").meds
    assert m.reason.endswith("; indication: bronchitis (Bronchial infection)")
    (m,) = scan("For a sinus infection, they put me on Augmentin.").meds
    assert m.drug == "amoxicillin-clavulanate" and m.change == "started"
    assert m.reason.endswith("; indication: sinus infection (Sinusitis)")
    (m,) = scan("prescribed oseltamivir for the flu").meds
    assert m.reason.endswith("; indication: flu")


def test_one_finding_per_drug_prefers_an_action_over_taking() -> None:
    text = "Taking loperamide daily. Later stopped loperamide."
    (m,) = scan(text).meds
    assert (m.change, m.quote, m.span_start) == ("stopped", "loperamide", text.rindex("loperamide"))
    text = "Started loperamide. Still taking loperamide."
    (m,) = scan(text).meds
    assert (m.change, m.span_start) == ("started", text.index("loperamide"))


# --------------------------------------------------------------------------- #
# Red flags, escalation policy, human request
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("text", "level", "category", "quote"),
    [
        ("I have chest pain right now.", "emergency", "chest_pain", "chest pain"),
        ("Temp was 38.6 at home last night.", "urgent", "fever", "Temp was 38.6"),
        ("Honestly some days I just want to die.", "emergency", "self_harm", "want to die"),
        ("I can't keep water down.", "urgent", "dehydration", "can't keep water down"),
        ("It's starting to blister on my arms.", "urgent", "skin_blistering", "blister"),
        ("pt with increasing SOB over the past week", "urgent", "dyspnea", "increasing SOB"),
        ("he seems confused at times", "urgent", "confusion", "he seems confused"),
        ("black tarry stools", "urgent", "gi_bleed", "tarry stools"),
        ("blood in my stool", "urgent", "gi_bleed", "blood in my stool"),
        ("yellowing of my eyes", "urgent", "jaundice", "yellowing of my eyes"),
        ("My throat is swelling.", "emergency", "anaphylaxis", "throat is swelling"),
        ("I passed out in the kitchen.", "emergency", "syncope", "passed out"),
        ("I went to the ER Sunday.", "urgent", "hospitalization", "went to the ER"),
    ],
)
def test_red_flag_levels(text: str, level: str, category: str, quote: str) -> None:
    (flag,) = scan(text).red_flags
    assert (flag.level, flag.category, flag.quote) == (level, category, quote)
    assert text[flag.span_start : flag.span_end] == quote
    assert flag.reason


def test_one_red_flag_per_category() -> None:
    result = scan("Fever yesterday and fevers again today; also febrile.")
    assert [r.category for r in result.red_flags] == ["fever"]
    assert result.red_flags[0].quote == "Fever"


@pytest.mark.parametrize(
    ("text", "kind", "detect", "level"),
    [
        ("I have chest pain right now.", "utterance", True, "emergency"),
        ("I have chest pain right now.", "note", False, "urgent"),
        ("Can I talk to a real person please?", "utterance", True, "human_requested"),
        ("Can I talk to a real person please?", "utterance", False, "none"),
        ("Can I talk to a real person please? Temp 101.", "utterance", True, "urgent"),
        ("Patient's representative called. Mild cough.", "note", False, "none"),
        ("Feels well.", "note", False, "none"),
    ],
)
def test_escalation_level_policy(text: str, kind: cs.ScanKind, detect: bool, level: str) -> None:
    result = scan(text, detect_human_request=detect)
    assert result.human_requested is (detect and "real person" in text)
    assert cs.escalation_level(result, kind) == level


# --------------------------------------------------------------------------- #
# Offsets, onsets, worsening, resolved, merging
# --------------------------------------------------------------------------- #


def test_offsets_point_at_the_exact_quote_for_every_answer_key_case() -> None:
    for case in cs.answer_key():
        result = scan(case.text, date.fromisoformat(case.ref_date), detect_human_request=True)
        findings = all_findings(result)
        exp = case.expected
        if exp.ae_terms or exp.meds or exp.escalation in ("urgent", "emergency"):
            assert findings, case.id
        for quote, start, end in findings:
            assert quote and case.text[start:end] == quote, (case.id, quote)


@pytest.mark.parametrize(
    ("text", "term", "days", "onset"),
    [
        ("Dry cough x5 days.", "Cough", 5, "2026-10-04"),
        ("Pt reports 3 days of diarrhea.", "Diarrhea", 3, "2026-10-06"),
        ("increasing SOB over the past week", "Dyspnea", 7, "2026-10-02"),
        ("Mom's been throwing up since last night.", "Vomiting", 1, "2026-10-08"),
        ("diarrhea for a couple of days", "Diarrhea", 2, "2026-10-07"),
        ("nausea x2 weeks", "Nausea", 14, "2026-09-25"),
        ("rash started today", "Rash maculo-papular", 0, "2026-10-09"),
        ("decreased appetite x1 week", "Anorexia", 7, "2026-10-02"),
        ("nausea", "Nausea", None, None),
    ],
)
def test_onset_days_and_ref_date(text: str, term: str, days: int | None, onset: str | None) -> None:
    finding = symptom(scan(text), term)
    assert (finding.onset_days, finding.onset_date) == (days, onset)
    without_ref = symptom(scan(text, None), term)
    assert (without_ref.onset_days, without_ref.onset_date) == (days, None)


def test_worsening_flag() -> None:
    assert symptom(scan("increasing SOB over the past week"), "Dyspnea").worsening
    assert symptom(scan("cough is getting worse"), "Cough").worsening
    assert not symptom(scan("dry cough"), "Cough").worsening


def test_resolved_symptom_still_counts_and_says_so() -> None:
    finding = symptom(scan("Nausea resolved."), "Nausea")
    assert finding.excluded_reason is None and finding.grade_hint == 1
    assert finding.reason.endswith("; the text says it resolved ('resolved')")


def test_two_mentions_of_one_term_merge_into_one_finding() -> None:
    result = scan("Mild nausea this morning. Severe nausea tonight x3 days.")
    assert terms(result) == ["Nausea"]
    finding = result.symptoms[0]
    assert (finding.grade_hint, finding.onset_days, finding.span_start) == (3, 3, 33)
    result = scan("Severe nausea. Nausea x3 days.")
    (finding,) = result.symptoms
    assert (finding.grade_hint, finding.onset_days, finding.quote) == (3, 3, "nausea")
    result = scan("Mild cough. Cough getting worse.")
    assert result.symptoms[0].worsening and result.symptoms[0].grade_hint == 1


def test_abbreviations_are_case_sensitive() -> None:
    assert terms(scan("No SOB at rest but gets breathless climbing stairs.")) == ["Dyspnea"]
    assert symptom(scan("c/o SOB"), "Dyspnea").quote == "SOB"
    assert terms(scan("the sob story")) == []
    assert terms(scan("N/V x2 days")) == ["Nausea", "Vomiting"]


def test_empty_and_whitespace_text() -> None:
    for text in ("", "   \n\n  ", "..."):
        result = scan(text, detect_human_request=True)
        assert result == cs.ScanResult((), (), (), (), (), False)
        assert cs.rules_fired(result) == []
        assert cs.escalation_level(result, "note") == "none"


# --------------------------------------------------------------------------- #
# Serialization, rules-fired view, catalog
# --------------------------------------------------------------------------- #


def test_scan_result_to_dict_is_json_safe() -> None:
    case = next(c for c in cs.answer_key() if c.id == "N1")
    result = scan(case.text, date.fromisoformat(case.ref_date))
    payload = cs.scan_result_to_dict(result)
    json.dumps(payload, allow_nan=False)
    assert list(payload) == [
        "symptoms", "excluded_symptoms", "meds", "excluded_meds", "red_flags", "human_requested"
    ]  # fmt: skip
    assert [s["term"] for s in payload["symptoms"]] == ["Diarrhea", "Nausea"]
    # "Denies fever, chills, or vomiting" negates three; "call for fever > 100.4" is a second,
    # hypothetical fever mention, so Fever appears twice among the exclusions (in text order).
    assert [(s["term"], s["excluded_reason"]) for s in payload["excluded_symptoms"]] == [
        ("Fever", "negated"),
        ("Chills", "negated"),
        ("Vomiting", "negated"),
        ("Fever", "hypothetical"),
    ]
    assert payload["symptoms"][0]["onset_date"] == "2026-10-02"
    assert [(m["drug"], m["change"]) for m in payload["meds"]] == [
        ("ondansetron", "taking"),
        ("loperamide", "started"),
    ]
    assert payload["red_flags"] == [] and payload["human_requested"] is False


def test_rules_fired_use_catalogued_ids_and_carry_spans() -> None:
    catalog = rules_catalog()
    case = next(c for c in cs.answer_key() if c.id == "N6")
    result = scan(case.text, date.fromisoformat(case.ref_date))
    rules = cs.rules_fired(result)
    ids = [r["rule_id"] for r in rules]
    assert ids == [
        "chartscan.symptom",
        "chartscan.symptom",
        "chartscan.med",
        "chartscan.red_flag",
        "chartscan.red_flag",
        "chartscan.hospitalization",
    ]
    for rule in rules:
        assert rule["rule_id"] in catalog
        assert catalog[str(rule["rule_id"])].category == rule["category"] == "chartscan"
        start, end = int(str(rule["span_start"])), int(str(rule["span_end"]))
        assert case.text[start:end] == rule["quote"]
        assert rule["description"] and rule["effect"]
        json.dumps(rule, allow_nan=False)
    why = [str(r["description"]) for r in rules]
    assert why[0].startswith("Chart note: 'new confusion' -> Confusion, provisional grade hint 3")
    assert "onset 7 day(s) before the note" in why[1]
    assert "SAE clock starts" in why[-1]
    excluded_case = scan("Denies nausea. Patient declined ondansetron.")
    assert [r["rule_id"] for r in cs.rules_fired(excluded_case)] == [
        "chartscan.symptom_excluded",
        "chartscan.med_excluded",
    ]


def test_catalog_lists_every_chartscan_rule() -> None:
    catalog = rules_catalog()
    assert set(cs.RULE_IDS) <= set(catalog)
    for rule_id in cs.RULE_IDS:
        assert catalog[rule_id].category == cs.RULE_CATEGORY
        assert catalog[rule_id].description_template
    assert cs.RULE_CATEGORY in load_table("rules_catalog")["categories"]


# --------------------------------------------------------------------------- #
# Tables: provenance, cross-table consistency, malformed tables fail loudly
# --------------------------------------------------------------------------- #


def test_tables_carry_provenance() -> None:
    for name in cs.CHARTSCAN_TABLE_NAMES:
        table = load_table(name)
        assert table["source"].strip() and table["rationale"].strip()
        assert (data_dir() / f"{name}.json").is_file()
    lexicon = load_table("chartscan_lexicon")
    for section in LEXICON_SECTIONS:
        assert lexicon[section]["source"].strip() and lexicon[section]["rationale"].strip(), section
    for section in ("symptom_patterns", "med_patterns"):
        prov = lexicon["provenance"][section]
        assert prov["source"].strip() and prov["rationale"].strip()
    assert "NOT RxNorm" in lexicon["rationale"] or "not RxNorm" in lexicon["rationale"]
    red_flags = load_table("chartscan_red_flags")
    assert "Omer Khawar" in red_flags["source"] and "D-017" in red_flags["rationale"]
    assert len(red_flags["rules"]) == 16
    assert [r["category"] for r in red_flags["rules"] if r["seriousness"]] == ["hospitalization"]


def test_shared_patterns_stay_identical_across_tables() -> None:
    temp = cs.lexicon_temperature_pattern()
    lexicon = load_table("chartscan_lexicon")
    assert lexicon["symptom_patterns"]["Fever"][-1] == temp
    assert cs.red_flag_pattern("fever").endswith(temp)
    assert cs.red_flag_pattern("hospitalization") == cs.hospital_pattern()
    with pytest.raises(KeyError):
        cs.red_flag_pattern("nope")


def test_symptom_terms_overlap_the_kiosk_items() -> None:
    lexicon = load_table("chartscan_lexicon")
    kiosk_terms = {t.aedecod for t in tables.ctcae_terms().values()}
    assert kiosk_terms <= set(lexicon["symptom_patterns"])
    assert all(name == name.lower() for name in lexicon["med_patterns"])


_CACHES = (cs._lexicon, cs._red_flag_table, cs.answer_key)


@pytest.fixture
def table_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Path]:
    """A scratch data directory seeded with the real chartscan tables; caches cleared around it."""
    for name in (
        *cs.CHARTSCAN_TABLE_NAMES,
        "proctcae_items",
        "rules_catalog",
        "composite_to_grade",
    ):
        (tmp_path / f"{name}.json").write_text(
            (data_dir() / f"{name}.json").read_text(encoding="utf-8"), encoding="utf-8"
        )
    monkeypatch.setattr(tables, "data_dir", lambda: tmp_path)
    load_table.cache_clear()
    for cached in _CACHES:
        cached.cache_clear()
    yield tmp_path
    load_table.cache_clear()
    for cached in _CACHES:
        cached.cache_clear()


def _rewrite(path: Path, mutate: Any) -> None:
    table = json.loads(path.read_text(encoding="utf-8"))
    mutate(table)
    path.write_text(json.dumps(table), encoding="utf-8")
    load_table.cache_clear()
    for cached in _CACHES:
        cached.cache_clear()


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda t: t["symptom_patterns"].__setitem__("Nausea", ["("]),
            "invalid regular expression",
        ),
        (lambda t: t["symptom_patterns"].__setitem__("Nausea", []), "at least one pattern"),
        (lambda t: t["negation"].pop("source"), "negation"),
        (lambda t: t["negation"].__setitem__("rationale", "  "), "rationale"),
        (lambda t: t["stool_count"]["bands"].pop(), "last band must be unbounded"),
        (
            lambda t: t["stool_count"]["bands"][0].__setitem__("upper", "4"),
            "expected number or null",
        ),
        (lambda t: t["default_grade"].__setitem__("grade", "1"), "expected integer"),
        (lambda t: t["provenance"].pop("med_patterns"), "provenance.med_patterns"),
        (lambda t: t.__setitem__("severity_words", []), "expected object"),
        (lambda t: t["number_words"].__setitem__("values", [1]), "expected object"),
        (lambda t: t["symptom_patterns"].__setitem__("Nausea", "nausea"), "expected list"),
        (lambda t: t["text_normalization"]["map"].__setitem__("ab", "'"), "one code point"),
        (lambda t: t["text_normalization"]["map"].__setitem__("x", ""), "one code point"),
        (lambda t: t["scope"].__setitem__("negation_max_words", 0), "positive integer"),
        (lambda t: t["scope"].pop("grade_window_chars"), "scope.grade_window_chars"),
        (
            lambda t: t["hospital"].__setitem__("raise_grade_to", 4),
            "exceeds composite_to_grade.max_assignable_grade",
        ),
        (
            lambda t: t["severity_words"]["words"][0].__setitem__("grade", 5),
            "exceeds composite_to_grade.max_assignable_grade",
        ),
    ],
)
def test_malformed_lexicon_fails_loudly(table_dir: Path, mutate: Any, message: str) -> None:
    _rewrite(table_dir / "chartscan_lexicon.json", mutate)
    with pytest.raises(TableError, match=message):
        cs.scan_text("nausea")


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda t: t["rules"][0].__setitem__("level", "critical"), "unknown level"),
        (lambda t: t["rules"].append(dict(t["rules"][0])), "duplicate category"),
        (lambda t: t["rules"][0].__setitem__("pattern", "(?P<x"), "invalid regular expression"),
        (lambda t: t["escalation_levels"].remove("urgent"), "missing 'urgent'"),
        (lambda t: t["rules"][0].__setitem__("seriousness", "no"), "expected boolean"),
    ],
)
def test_malformed_red_flags_fail_loudly(table_dir: Path, mutate: Any, message: str) -> None:
    _rewrite(table_dir / "chartscan_red_flags.json", mutate)
    with pytest.raises(TableError, match=message):
        cs.scan_text("chest pain")


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda t: t["cases"][0]["expected"].__setitem__("escalation", "panic"), "unknown level"),
        (lambda t: t["cases"][0].__setitem__("kind", "email"), "expected 'note' or 'utterance'"),
        (
            lambda t: t["cases"][0].__setitem__("usubjid_label", "P-999"),
            "disagrees with subject_mapping",
        ),
        (lambda t: t["cases"][0]["expected"]["meds"].append(["x"]), "expected \\[drug, change\\]"),
        (lambda t: t["cases"][0]["expected"]["meds"].append(["x", "paused"]), "unknown change"),
        (lambda t: t["cases"].append(dict(t["cases"][0])), "duplicate case id"),
        (lambda t: t["cases"][8].__setitem__("text", None), "expected string"),
    ],
)
def test_malformed_answer_key_fails_loudly(table_dir: Path, mutate: Any, message: str) -> None:
    _rewrite(table_dir / "chartscan_answer_key.json", mutate)
    with pytest.raises(TableError, match=message):
        cs.answer_key()


def test_valid_tables_reload_from_the_scratch_directory(table_dir: Path) -> None:
    assert len(cs.answer_key()) == 42
    assert terms(cs.scan_text("severe nausea")) == ["Nausea"]


# --------------------------------------------------------------------------- #
# Property: scan_text never raises and its output is well-formed
# --------------------------------------------------------------------------- #

VOCAB = [
    "no", "denies", "not", "but", "fever", "100.4", "nausea", "N/V", "SOB", "cough", "x5 days",
    "since yesterday", "severe", "mild", "grade 3", "15% BSA", "rash", "4 stools/day", "admitted",
    "ER", "started", "stopped", "zofran", "Advil", "augmentin", "amoxicillin", "allergies:",
    "declined", "for", "chest pain", "want to die", "can't keep water down", "talk to a human",
    ",", ";", ".", "!", "\n", "hx of", "call if", "monitor for", "resolved", "worse", "tired of",
    "confused about", "he seems confused", "ruled out", "a couple of days", "x", "d", "°F",
    "haven\u2019t", "can\u2019t keep water down", "Fever: no", ", mild", "Tmax 101.3", "not on",
    "switched from zofran to compazine", "Solu-Medrol", "admitted to having", "in the ED",
    "PRN for", "go to the ER if", "grade 5", "\u201cno rash\u201d", "\u00a0",
]  # fmt: skip
SETTINGS = settings(max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow])


def _check_well_formed(text: str, result: cs.ScanResult) -> None:
    for quote, start, end in all_findings(result):
        assert 0 <= start < end <= len(text)
        assert text[start:end] == quote
    assert len({s.term for s in result.symptoms}) == len(result.symptoms)
    assert not {s.term for s in result.symptoms} & {s.term for s in result.excluded_symptoms}
    assert len({m.drug for m in result.meds}) == len(result.meds)
    assert len({r.category for r in result.red_flags}) == len(result.red_flags)
    for s in result.symptoms:
        assert s.excluded_reason is None and s.grade_hint is not None
        assert 1 <= s.grade_hint <= MAX_GRADE
        assert (s.onset_date is None) == (s.onset_days is None)
    for s in result.excluded_symptoms:
        assert s.excluded_reason in ("negated", "historical", "hypothetical")
        assert s.grade_hint is None
    for m in result.excluded_meds:
        assert m.excluded_reason in ("allergy", "negated")
    json.dumps(cs.scan_result_to_dict(result), allow_nan=False)
    json.dumps(cs.rules_fired(result), allow_nan=False)
    for kind in ("note", "utterance"):
        level = cs.escalation_level(result, kind)
        assert level in ("none", "human_requested", "urgent", "emergency")
        if kind == "note":
            assert level != "emergency"


@SETTINGS
@given(st.text(max_size=300))
def test_scan_never_raises_on_arbitrary_text(text: str) -> None:
    _check_well_formed(text, scan(text, detect_human_request=True))
    _check_well_formed(text, scan(text, None))


@SETTINGS
@given(st.lists(st.sampled_from(VOCAB), max_size=30).map(" ".join))
def test_scan_never_raises_on_clinical_vocabulary(text: str) -> None:
    result = scan(text, detect_human_request=True)
    _check_well_formed(text, result)
    again = scan(text, detect_human_request=True)
    assert again == result  # deterministic


# --------------------------------------------------------------------------- #
# Review fixes (2026-10-10): every test here failed before its fix
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "apostrophe",
    ["'", "\u2019", "\u2018", "\u02bc", "\u00b4"],
    ids=["ascii", "U+2019", "U+2018", "U+02BC", "U+00B4"],
)
def test_typographic_apostrophes_behave_like_ascii(apostrophe: str) -> None:
    a = apostrophe
    negated = scan(f"I haven{a}t had any nausea or diarrhea this week.")
    assert terms(negated) == []
    assert excluded(negated) == {"Nausea": "negated", "Diarrhea": "negated"}
    assert terms(scan(f"I can{a}t stop coughing.")) == ["Cough"]  # pseudo-negation still blanked
    declined = scan(f"She didn{a}t start the prednisone.")
    assert declined.meds == ()
    assert [m.excluded_reason for m in declined.excluded_meds] == ["negated"]
    text = f"I can{a}t keep water down."
    (flag,) = scan(text, detect_human_request=True).red_flags
    assert (flag.category, flag.quote) == ("dehydration", f"can{a}t keep water down")
    assert text[flag.span_start : flag.span_end] == flag.quote  # offsets index the original
    emergency = scan(f"I can{a}t breathe.", detect_human_request=True)
    assert [f.category for f in emergency.red_flags] == ["cannot_breathe"]
    assert cs.escalation_level(emergency, "utterance") == "emergency"


def test_normalization_keeps_offsets_and_quotes_from_the_original_text() -> None:
    text = (
        "Started amoxicillin\u2013clavulanate; \u201cno rash\u201d, mild nausea."
        "\u00a0Hx of colitis."
    )
    result = scan(text)
    for quote, start, end in all_findings(result):
        assert text[start:end] == quote
    assert meds(result) == {("amoxicillin-clavulanate", "started")}
    assert result.meds[0].quote == "amoxicillin\u2013clavulanate"  # the en dash is preserved
    assert terms(result) == ["Nausea"]
    assert excluded(result) == {"Rash maculo-papular": "negated", "Colitis": "historical"}
    assert json.dumps(cs.scan_result_to_dict(result), allow_nan=False)


def test_normalization_map_is_table_driven(table_dir: Path) -> None:
    curly = "I haven\u2019t had any nausea."
    assert excluded(cs.scan_text(curly)) == {"Nausea": "negated"}
    _rewrite(
        table_dir / "chartscan_lexicon.json",
        lambda t: t["text_normalization"].__setitem__("map", {}),
    )
    assert terms(cs.scan_text(curly)) == ["Nausea"]  # without the map the contraction is lost


@pytest.mark.parametrize(
    ("text", "kept", "skipped"),
    [
        ("No fever, mild diarrhea.", ["Diarrhea"], {"Fever": "negated"}),
        ("No fever, some nausea.", ["Nausea"], {"Fever": "negated"}),
        ("no vomiting, 3 loose stools/day", ["Diarrhea"], {"Vomiting": "negated"}),
        (
            "No fever and no chills, mild cough.",
            ["Cough"],
            {"Fever": "negated", "Chills": "negated"},
        ),
        ("No rash, + pruritus.", ["Pruritus"], {"Rash maculo-papular": "negated"}),
        ("No admission needed, mild diarrhea.", ["Diarrhea"], {}),
        # a bare comma still continues a negated list
        (
            "Denies nausea, vomiting, diarrhea.",
            [],
            {"Nausea": "negated", "Vomiting": "negated", "Diarrhea": "negated"},
        ),
        (
            "Denies fever, chills, or vomiting.",
            [],
            {"Fever": "negated", "Chills": "negated", "Vomiting": "negated"},
        ),
        # documented limitation: a comma followed by a bare symptom still reads as a list
        (
            "No rash, itching on the legs.",
            [],
            {"Rash maculo-papular": "negated", "Pruritus": "negated"},
        ),
    ],
)
def test_comma_scope(text: str, kept: list[str], skipped: dict[str, str]) -> None:
    result = scan(text)
    assert terms(result) == kept
    assert excluded(result) == skipped
    assert result.red_flags == () and not cs.seriousness_suspected(result)


@pytest.mark.parametrize(
    ("text", "kept", "skipped"),
    [
        (
            "ROS: Nausea: no. Vomiting: no. Fever: no. Rash: yes.",
            ["Rash maculo-papular"],
            {"Nausea": "negated", "Vomiting": "negated", "Fever": "negated"},
        ),
        ("Fever - none. Cough - yes.", ["Cough"], {"Fever": "negated"}),
        (
            "Nausea: none. Rash: absent. Fever: no.",
            [],
            {"Nausea": "negated", "Rash maculo-papular": "negated", "Fever": "negated"},
        ),
        (
            "Fever: no, chills: no; nausea: yes.",
            ["Nausea"],
            {"Fever": "negated", "Chills": "negated"},
        ),
        # the short cue must end the clause: 'no blistering' does not negate the rash
        ("Rash on both arms, no blistering.", ["Rash maculo-papular"], {}),
    ],
)
def test_review_of_systems_negatives(text: str, kept: list[str], skipped: dict[str, str]) -> None:
    result = scan(text)
    assert terms(result) == kept
    assert excluded(result) == skipped
    assert result.red_flags == ()  # 'Fever: no' must not fire the fever red flag


def test_post_negation_reason_names_the_bare_cue() -> None:
    (fever,) = scan("Fever: no.").excluded_symptoms
    assert fever.reason == "negated: 'no' follows 'Fever'"
    (fever,) = scan("Fever - none").excluded_symptoms
    assert fever.reason == "negated: 'none' follows 'Fever'"


@pytest.mark.parametrize(
    ("text", "grade", "serious"),
    [
        ("Not admitted; has diarrhea.", 1, False),
        ("Denies admission; has mild diarrhea x2 days.", 1, False),
        ("Hx of admission for colitis; now has diarrhea.", 1, False),
        ("Admitted overnight for diarrhea.", 3, True),
        ("Not admitted yet but seen in the ER for diarrhea.", 3, True),  # second cue counts
    ],
)
def test_hospital_grade_cue_follows_the_same_context_check(
    text: str, grade: int, serious: bool
) -> None:
    result = scan(text)
    finding = symptom(result, "Diarrhea")
    assert finding.grade_hint == grade
    assert ("hospitalization/ER is mentioned" in finding.grade_basis) is (grade == 3)
    assert ("possible hospitalization" in finding.reason) is (grade == 3)
    assert cs.seriousness_suspected(result) is serious


@pytest.mark.parametrize(
    ("text", "flagged"),
    [
        ("Pt admitted to having mild nausea.", False),
        ("He admitted that he skipped doses.", False),
        ("the sob story about ED", False),
        ("Go to the ER if fever develops.", False),
        ("Advised to go to the ER if symptoms worsen.", False),
        ("If symptoms worsen, go to the ER.", False),
        ("If you feel worse, go to the emergency room.", False),
        ("Return to the ED if you develop a fever.", False),
        ("Call 911 if you cannot breathe, or go to the emergency room.", False),
        ("Seek emergency care if you develop a rash; go to the hospital if it spreads.", False),
        ("Had to call 911 and was taken to the ER.", True),  # an event, not advice
        ("Admission note: mild cough.", True),  # documented residual ambiguity
        ("ED visit 10/08: brought in by wife.", True),
        ("Seen in the ED yesterday.", True),
        ("ER course: IV fluids.", True),
        ("I went to the ER Sunday.", True),
        ("Was admitted.", True),
        ("Admitted for IV fluids.", True),
        ("Hospitalized x2 days.", True),
    ],
)
def test_hospital_cue_needs_hospital_context(text: str, flagged: bool) -> None:
    result = scan(text)
    assert ([f.category for f in result.red_flags] == ["hospitalization"]) is flagged
    assert cs.seriousness_suspected(result) is flagged
    assert all(s.grade_hint == (3 if flagged else 1) for s in result.symptoms)


def test_go_to_the_er_if_is_an_instruction_for_every_cue_after_it() -> None:
    result = scan("Go to the ER if fever develops or you can't keep fluids down.")
    assert result.red_flags == () and terms(result) == []
    assert excluded(result) == {"Fever": "hypothetical"}


def test_explicit_grade_above_the_cap_is_capped() -> None:
    assert MAX_GRADE == 3
    colitis = symptom(scan("Grade 5 colitis."), "Colitis")
    assert colitis.grade_hint == 3
    assert colitis.grade_basis == (
        "clinician wrote 'grade 5'; hint capped at 3 because this system never assigns a "
        "grade above 3, investigator to confirm"
    )
    assert symptom(scan("G4 diarrhea, admitted."), "Diarrhea").grade_hint == 3
    assert symptom(scan("grade 3 nausea"), "Nausea").grade_basis == (
        "explicit 'grade 3' written in the text"
    )
    why = str(cs.rules_fired(scan("Grade 5 colitis."))[0]["description"])
    assert "provisional grade hint 3 (clinician wrote 'grade 5'" in why


def test_scope_windows_come_from_the_table(table_dir: Path) -> None:
    lexicon = table_dir / "chartscan_lexicon.json"
    text = "Denies any new or worsening episodes of nausea."
    assert excluded(cs.scan_text(text)) == {"Nausea": "negated"}
    _rewrite(lexicon, lambda t: t["scope"].__setitem__("negation_max_words", 3))
    assert terms(cs.scan_text(text)) == ["Nausea"]  # 'Denies' is now out of scope
    text = "Severe and very bothersome ongoing daily nausea."
    assert symptom(cs.scan_text(text), "Nausea").grade_hint == 1  # 'Severe' is > 30 chars away
    _rewrite(lexicon, lambda t: t["scope"].__setitem__("severity_before_chars", 60))
    assert symptom(cs.scan_text(text), "Nausea").grade_hint == 3


@pytest.mark.parametrize(
    ("text", "expected", "excluded_drugs"),
    [
        ("Patient was not started on prednisone.", set(), ["prednisone"]),
        ("Not on prednisone.", set(), ["prednisone"]),
        (
            "Never started on ondansetron; is not on loperamide.",
            set(),
            ["ondansetron", "loperamide"],
        ),
        (
            "Switched from Zofran to Compazine.",
            {("ondansetron", "stopped"), ("prochlorperazine", "started")},
            [],
        ),
        ("switched to Compazine", {("prochlorperazine", "started")}, []),
        # a switch written with doses is a dose change, not a stop/start
        ("switched from 4 mg to 8 mg of ondansetron", {("ondansetron", "changed")}, []),
        ("Started Solu-Medrol.", {("methylprednisolone", "started")}, []),
    ],
)
def test_med_negation_and_switch_forms(
    text: str, expected: set[tuple[str, str]], excluded_drugs: list[str]
) -> None:
    result = scan(text)
    assert meds(result) == expected
    assert [m.drug for m in result.excluded_meds] == excluded_drugs
    assert all(m.excluded_reason == "negated" for m in result.excluded_meds)


def test_switch_reasons_name_both_verbs() -> None:
    zofran, compazine = scan("Switched from Zofran to Compazine.").meds
    assert zofran.reason == "'Switched from' appears before 'Zofran' in the same clause -> stopped"
    assert compazine.reason == (
        "'Switched from Zofran to' appears before 'Compazine' in the same clause -> started"
    )
    (m,) = scan("Started Solu-Medrol.").meds
    assert m.quote == "Solu-Medrol"  # the longer brand pattern wins over 'Medrol' inside it


def test_tmax_and_prn_orders() -> None:
    result = scan("Tmax 101.3 overnight, took Tylenol.")
    assert symptom(result, "Fever").quote == "Tmax 101.3"
    assert [f.category for f in result.red_flags] == ["fever"]
    result = scan("Has Tylenol PRN for fever.")
    assert terms(result) == [] and excluded(result) == {"Fever": "hypothetical"}
    assert result.red_flags == () and meds(result) == {("acetaminophen", "taking")}
    assert result.meds[0].reason.endswith("; indication: fever (Fever)")
    # an affirmative mention elsewhere still counts
    result = scan("Tylenol PRN for fever. Fever of 101 last night.")
    assert terms(result) == ["Fever"] and [f.category for f in result.red_flags] == ["fever"]


def test_resolved_is_machine_readable() -> None:
    finding = symptom(scan("Nausea resolved."), "Nausea")
    assert finding.resolved and finding.excluded_reason is None and finding.grade_hint == 1
    assert not symptom(scan("nausea"), "Nausea").resolved
    (ex,) = scan("No nausea, resolved.").excluded_symptoms
    assert not ex.resolved  # an excluded mention is never 'resolved'
    (rule,) = cs.rules_fired(scan("Nausea resolved."))
    assert str(rule["description"]).endswith("; resolved per the text")
    inputs = rule["inputs"]
    assert isinstance(inputs, dict) and inputs["resolved"] is True
    assert cs.scan_result_to_dict(scan("Nausea resolved."))["symptoms"][0]["resolved"] is True


# ---- coverage of the remaining branches -------------------------------------------------- #


def test_sentence_lookup_falls_back_to_the_whole_text() -> None:
    assert cs._sentence_for([], 3) == (0, 4)
    assert cs._sentence_for([(0, 2), (5, 9)], 3) == (0, 9)


def test_nearest_cue_wins_on_both_sides() -> None:
    assert symptom(scan("mild then severe nausea"), "Nausea").grade_hint == 3
    assert symptom(scan("nausea, mild, severe at night"), "Nausea").grade_hint == 1
    (m,) = scan("Pt stopped and then started loperamide").meds
    assert m.change == "started"
    (m,) = scan("started loperamide and stopped it").meds
    assert m.change == "started"


def test_overlapping_patterns_of_one_term_yield_one_mention() -> None:
    result = scan("nausea/vomiting x2 days")
    assert terms(result) == ["Nausea", "Vomiting"]
    assert symptom(result, "Nausea").quote == "nausea"


def test_merging_keeps_the_existing_hospital_cue() -> None:
    result = scan("Admitted for diarrhea. Diarrhea x3 days.")
    (finding,) = result.symptoms
    assert (finding.grade_hint, finding.onset_days) == (3, 3)
    assert "'Admitted' in the same sentence" in finding.reason
