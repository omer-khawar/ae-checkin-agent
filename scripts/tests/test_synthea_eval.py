"""Tests for scripts/synthea/eval_synthea.py (the independent Synthea evaluation).

Three layers:
* metric arithmetic and name comparison on tiny hand-made fixtures;
* the evaluator's note-level logic on a hand-written Synthea-style note (runs the real scanner
  and matcher, no Synthea output needed);
* the committed inputs and docs/eval/synthea_results.md: the complaint map covers every chief
  complaint, and ``--check`` reproduces the committed document byte for byte.
No network; nothing here runs Synthea.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from synthea import eval_synthea as ev  # noqa: E402

CMAP = ev.load_complaint_map(ev.DEFAULT_MAP)
NO_EQ: dict[str, frozenset[str]] = {}


# --------------------------------------------------------------------------------------
# Metric arithmetic
# --------------------------------------------------------------------------------------


def test_set_score_counts_and_ratios() -> None:
    s = ev.set_score({"Cough", "Fatigue"}, {"Fatigue", "Sinusitis"})
    assert (s.pred_correct, s.fp, s.fn) == (1, 1, 1)
    assert s.precision == pytest.approx(0.5)
    assert s.recall == pytest.approx(0.5)
    assert s.f1 == pytest.approx(0.5)


def test_score_empty_denominators_are_undefined_not_perfect() -> None:
    empty = ev.set_score(set(), set())
    assert empty.precision is None
    assert empty.recall is None
    assert empty.f1 is None
    assert ev.fmt(empty.precision) == "n/a"
    # Predictions but nothing expected: precision 0, recall undefined.
    only_fp = ev.set_score(set(), {"Sinusitis"})
    assert only_fp.precision == 0.0
    assert only_fp.recall is None


def test_f1_is_zero_when_nothing_is_right() -> None:
    s = ev.set_score({"Cough"}, {"Fatigue"})
    assert s.precision == 0.0
    assert s.recall == 0.0
    assert s.f1 == 0.0


def test_scores_are_micro_averaged_by_summing_counts() -> None:
    total = ev.sum_scores(
        [ev.set_score({"a"}, {"a"}), ev.set_score({"a", "b"}, set()), ev.set_score(set(), {"c"})]
    )
    assert (total.pred_correct, total.pred_total, total.gt_found, total.gt_total) == (1, 2, 1, 3)
    assert total.precision == pytest.approx(0.5)
    assert total.recall == pytest.approx(1 / 3)
    assert total.f1 == pytest.approx(2 * 0.5 * (1 / 3) / (0.5 + 1 / 3))


def test_formatting_helpers() -> None:
    assert ev.fmt(0.12345) == "0.123"
    assert ev.pct(1, 4) == "1/4 (25.0%)"
    assert ev.pct(0, 0) == "n/a"


# --------------------------------------------------------------------------------------
# Medication name comparison
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("predicted", "ingredient", "expected"),
    [
        ("metoprolol", "metoprolol", True),
        ("naproxen sodium", "naproxen", True),  # salt suffix on the prediction
        ("naproxen", "naproxen sodium", True),  # salt suffix on the ingredient
        ("amoxicillin-clavulanate", "clavulanate", True),  # combination component
        ("sodium chloride", "sodium fluoride", False),  # a shared first word is not enough
        ("loperamide", "sodium fluoride", False),
        ("cyanocobalamin", "vitamin b12", False),  # synonym only via the table
    ],
)
def test_name_matches(predicted: str, ingredient: str, expected: bool) -> None:
    assert ev.name_matches(predicted, ingredient, NO_EQ) is expected


def test_name_matches_uses_the_equivalents_table() -> None:
    assert ev.name_matches("cyanocobalamin", "vitamin b12", CMAP.ingredient_equivalents)


def _gt(display: str, *ingredients: str, in_text: bool) -> ev.GtMed:
    return ev.GtMed(display, tuple(ingredients), in_text, "test")


def test_med_score_precision_over_all_recall_over_text_items() -> None:
    truth = [
        _gt("Cisplatin 50 MG Injection", "cisplatin", in_text=True),
        _gt("Clopidogrel 75 MG Oral Tablet", "clopidogrel", in_text=False),
        _gt("Amoxicillin 250 MG / Clavulanate 125 MG", "amoxicillin", "clavulanate", in_text=True),
    ]
    # clopidogrel is correct (it is in the record) even though the text never shows it.
    s, fps, missed = ev.med_score(
        ["clopidogrel", "amoxicillin", "loperamide"], truth, NO_EQ, text_only=True
    )
    assert (s.pred_correct, s.pred_total) == (2, 3)
    assert (s.gt_found, s.gt_total) == (1, 2)
    assert fps == ["loperamide"]
    assert [g.key for g in missed] == ["cisplatin"]
    s_all, _, _ = ev.med_score(
        ["clopidogrel", "amoxicillin", "loperamide"], truth, NO_EQ, text_only=False
    )
    assert (s_all.gt_found, s_all.gt_total) == (2, 3)


# --------------------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------------------

NOTE_TEXT = (
    "2026-06-16\n\n# Chief Complaint\n- Cough\n- Thirst\n- Cramping\n\n\n"
    "# History of Present Illness\nP-099 is a 70 year-old male. Patient has a history of "
    "stress (finding), gingivitis (disorder), part-time employment (finding), medication "
    "review due (situation), viral sinusitis (disorder).\n\n"
    "# Medications\nacetaminophen 325 mg oral tablet; sodium fluoride 0.0272 mg/mg oral gel\n\n"
    "# Assessment and Plan\nPatient is presenting with stress (finding).\n"
)


def test_med_section_items_split_and_empty_marker() -> None:
    assert ev.med_section_items(NOTE_TEXT, CMAP) == [
        "acetaminophen 325 mg oral tablet",
        "sodium fluoride 0.0272 mg/mg oral gel",
    ]
    empty = "# Medications\nNo Active Medications.\n\n# Assessment and Plan\n"
    assert ev.med_section_items(empty, CMAP) == []
    assert ev.med_section_items("no section here", CMAP) == []


def test_section_snippet_and_history_distance() -> None:
    pos = NOTE_TEXT.index("viral sinusitis") + len("viral ")
    end = pos + len("sinusitis")
    assert ev.section_at(NOTE_TEXT, pos) == "# History of Present Illness"
    assert ev.section_at(NOTE_TEXT, 3) == "(before any heading)"
    snip = ev.snippet(NOTE_TEXT, pos, end, width=10)
    assert "sinusitis" in snip
    assert snip.startswith("...")
    hist = ev.history_scope()
    words = ev.words_after_history_cue(NOTE_TEXT, pos, hist)
    assert words is not None
    assert words > hist.max_words
    assert ev.words_after_history_cue(NOTE_TEXT, NOTE_TEXT.index("- Cough"), hist) is None


def test_complaint_quote_returns_the_bullet_line() -> None:
    assert ev.complaint_quote(NOTE_TEXT, "Cramping") == "- Cramping"
    assert ev.complaint_quote(NOTE_TEXT, "Absent") == "Absent"


# --------------------------------------------------------------------------------------
# Note-level evaluation on a hand-written Synthea-style note (real scanner and matcher)
# --------------------------------------------------------------------------------------


def _note() -> ev.Note:
    return ev.Note(
        id="SYN-TEST-1",
        label="P-099",
        note_date="2026-06-16",
        encounter_class="ambulatory",
        text=NOTE_TEXT,
        chief_complaints=("Cough", "Thirst", "Cramping"),
        meds=(
            _gt("Acetaminophen 325 MG Oral Tablet", "acetaminophen", in_text=True),
            _gt("sodium fluoride 0.0272 MG/MG Oral Gel", "sodium fluoride", in_text=True),
        ),
        conditions=(),
        is_emergency=False,
    )


def test_evaluate_note_scores_symptoms_against_mapped_complaints() -> None:
    lexicon = frozenset(ev.load_table("chartscan_lexicon")["symptom_patterns"])
    res = ev.evaluate_note(_note(), CMAP, lexicon, ev.history_scope())
    # Thirst has no CTCAE term: out of scope, never a miss.
    assert res.out_of_scope == ["Thirst"]
    assert res.expected == {"Cough", "Abdominal pain"}
    assert "Cough" in res.predicted
    assert res.symptom.fn == 1  # 'Cramping' is not in the scanner's lexicon patterns
    assert [e.quote for e in res.symptom_fn] == ["- Cramping"]
    # The long history list puts 'sinusitis' beyond the history window: a false positive.
    fp = {e.concept: e for e in res.symptom_fp}
    assert "Sinusitis" in fp
    assert fp["Sinusitis"].section == "# History of Present Illness"
    assert not fp["Sinusitis"].supported_by_record


def test_evaluate_note_medication_variants() -> None:
    lexicon = frozenset(ev.load_table("chartscan_lexicon")["symptom_patterns"])
    res = ev.evaluate_note(_note(), CMAP, lexicon, ev.history_scope())
    assert res.scanner_meds == ["acetaminophen"]
    assert (res.med_scanner_text.gt_found, res.med_scanner_text.gt_total) == (1, 2)
    # The section-aware matcher finds acetaminophen and wrongly proposes loperamide for the
    # 'sodium' token (two edits from the brand 'imodium').
    assert "acetaminophen" in res.section_meds
    assert ("section+matcher", "loperamide") in res.med_fp


# --------------------------------------------------------------------------------------
# Tables
# --------------------------------------------------------------------------------------


def test_complaint_map_loads_and_every_mapped_term_is_a_string() -> None:
    raw = json.loads(ev.DEFAULT_MAP.read_text(encoding="utf-8"))
    assert raw["source"].strip()
    assert raw["rationale"].strip()
    assert "simulated" in raw["label"]
    for name, entry in raw["complaints"].items():
        term = entry["ctcae_term"]
        assert term is None or (isinstance(term, str) and term.strip()), name
        assert all(isinstance(a, str) and a.strip() for a in entry["also_accept"]), name
        assert entry["rationale"].strip(), name
        if term is None:
            assert CMAP.complaints[name] is None
        else:
            concept = CMAP.complaints[name]
            assert concept is not None
            assert concept.primary == term


def test_complaint_map_rejects_unknown_complaints() -> None:
    with pytest.raises(ev.EvalError, match="not in complaint_map.json"):
        CMAP.concept_of("Hiccups")


def test_complaint_map_covers_every_committed_chief_complaint() -> None:
    _, notes = ev.load_notes(ev.DEFAULT_NOTES)
    seen = {c for n in notes for c in n.chief_complaints}
    assert seen <= set(CMAP.complaints), sorted(seen - set(CMAP.complaints))


def test_thresholds_are_read_from_the_corroboration_table() -> None:
    table = json.loads(
        (ev.data_dir() / "vitals_corroboration.json").read_text(encoding="utf-8")
    )
    expected = {
        (c["metric"], float(c["value"]))
        for rule in table["rules"]
        for c in rule["condition"]["all"]
        if c["kind"] == "vital"
    }
    got = {(t.metric, t.value) for t in ev.corroboration_thresholds()}
    assert got == expected


# --------------------------------------------------------------------------------------
# Committed output: determinism, --check, no identifiers
# --------------------------------------------------------------------------------------


def test_check_passes_on_the_committed_results() -> None:
    assert ev.main(["--check"]) == 0


def test_check_fails_when_the_document_differs(tmp_path: Path) -> None:
    out = tmp_path / "synthea_results.md"
    out.write_text(ev.DEFAULT_OUT.read_text(encoding="utf-8") + "edited by hand\n", "utf-8")
    assert ev.main(["--check", "--out", str(out)]) == 1
    assert ev.main(["--check", "--out", str(tmp_path / "missing.md")]) == 1


def test_report_is_deterministic_and_clock_free(tmp_path: Path) -> None:
    inputs = ev.Inputs(
        ev.DEFAULT_NOTES,
        ev.DEFAULT_PARTICIPANTS,
        ev.DEFAULT_MAP,
        ev.DEFAULT_NOTES.with_name("manifest.json"),
    )
    first, head = ev.build_report(inputs)
    second, _ = ev.build_report(inputs)
    assert first == second
    assert set(head) == {
        "symptoms",
        "meds_scanner",
        "meds_section_matcher",
        "matcher_displays",
        "escalation",
        "vitals",
    }
    # The only dates in the document are Synthea note dates and the reference date.
    reference = json.loads(ev.DEFAULT_NOTES.read_text(encoding="utf-8"))["reference_date"]
    assert reference in first
    assert re.search(r"\d{2}:\d{2}:\d{2}", first) is None  # no wall-clock timestamp
    # A write followed by --check on the same path succeeds.
    out = tmp_path / "r.md"
    assert ev.main(["--out", str(out)]) == 0
    assert ev.main(["--check", "--out", str(out)]) == 0


def test_committed_results_are_labelled_and_carry_no_identifiers() -> None:
    text = ev.DEFAULT_OUT.read_text(encoding="utf-8")
    assert "Synthea synthetic EHR (simulated)" in text
    assert "not a clinical validation" in text
    uuid = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    assert re.search(uuid, text, re.I) is None
    assert re.search(r"\b[A-Z][a-z]+\d{1,3}\b", text) is None  # Synthea name tokens (Boyd728)
    assert re.search(r"\b\d{3}-\d{3}-\d{4}\b", text) is None  # phone numbers
