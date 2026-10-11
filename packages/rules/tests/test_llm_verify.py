"""The second reader's gate: verification, additive merge, grading by rules (R5.3)."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from interim_rules import chartscan as cs
from interim_rules import llm_verify as lv
from interim_rules.tables import load_table

N_HYPO = (
    "Oncology clinic follow-up. Denies diarrhea or rash. Labs reviewed: TSH 18.2, free T4 low. "
    "Hypothyroidism, grade 2, likely immune-related. Started levothyroxine 50 mcg daily. "
    "Fatigue persists."
)
C_STOOLS = "6 or 7 watery stools a day since Friday, started Imodium"


def raw(symptoms: list[dict[str, Any]] | None = None, meds: list[dict[str, Any]] | None = None):
    return {"symptoms": symptoms or [], "medications": meds or []}


def sym(quote: str, term: str, status: str = "current", **extra: Any) -> dict[str, Any]:
    return {"quote": quote, "term": term, "status": status, **extra}


def med(quote: str, name: str, action: str = "started", **extra: Any) -> dict[str, Any]:
    return {"quote": quote, "name": name, "action": action, **extra}


# --------------------------------------------------------------------------- #
# Vocabulary and quote location
# --------------------------------------------------------------------------- #


def test_closed_vocabulary_is_scanner_kiosk_and_immune_terms() -> None:
    vocabulary = set(lv.closed_vocabulary())
    assert set(cs.symptom_terms()) <= vocabulary
    assert {"Dyspnea", "Hypothyroidism", "Pneumonitis", "Colitis", "Guillain-Barre syndrome"} <= (
        vocabulary
    )
    assert lv.UNMAPPED not in vocabulary
    table = load_table("ctcae_terms")
    assert len(table["reader_terms"]) >= 20
    for row in table["reader_terms"]:
        assert row["source"] and row["meddra_soc"] and isinstance(row["in_ctcae_v5"], bool)


def test_locate_quote_exact_and_normalized() -> None:
    text = "Pt has  loose\nstools,  “watery” overnight."
    assert lv.locate_quote(text, "overnight") == (text.index("overnight"), len(text) - 1)
    start, end = lv.locate_quote(text, 'LOOSE stools, "WATERY"') or (-1, -1)
    assert text[start:end] == "loose\nstools,  “watery”"
    assert lv.locate_quote(text, "   ") is None
    assert lv.locate_quote(text, "not there") is None


# --------------------------------------------------------------------------- #
# verify
# --------------------------------------------------------------------------- #


def test_verify_keeps_current_and_resolved_and_lists_the_rest() -> None:
    text = N_HYPO
    out = lv.verify(
        text,
        raw(
            [
                sym("Hypothyroidism, grade 2, likely immune-related", "Hypothyroidism"),
                sym("Fatigue persists", "fatigue"),
                sym("Denies diarrhea", "Diarrhea", "negated"),
                sym("Fatigue", "Fatigue", "resolved"),
            ],
            [med("Started levothyroxine 50 mcg daily", "levothyroxine", generic="Levothyroxine")],
        ),
    )
    assert [(s.term, s.status) for s in out.symptoms] == [
        ("Hypothyroidism", "current"),
        ("Fatigue", "current"),
        ("Fatigue", "resolved"),
    ]
    assert [(n.term, n.status) for n in out.notes] == [("Diarrhea", "negated")]
    assert out.rejected == ()
    for found in (*out.symptoms, *out.notes):
        assert text[found.span_start : found.span_end] == found.quote
    assert out.medications[0].generic == "Levothyroxine"


@pytest.mark.parametrize(
    ("item", "needle"),
    [
        (sym("No such words here", "Fatigue"), "not in the text word for word"),
        (sym("Fatigue persists", "UNMAPPED"), "UNMAPPED"),
        (sym("Fatigue persists", "Tummy trouble"), "closed vocabulary"),
        (sym("Fatigue persists", "Fatigue", "maybe"), "status"),
        (sym("Fatigue persists", "Fatigue", count=3), "digits inside the quote"),
        (sym("Fatigue persists", "Fatigue", count="lots"), "not a number"),
        (sym("Fatigue persists", "Fatigue", count=True), "not a number"),
        (sym("Fatigue persists", "Fatigue", count=-2), "outside"),
        (sym("Fatigue persists", "Fatigue", count=[1]), "not a number"),
        (sym("x" * 161, "Fatigue"), "longer than"),
        ("just a string", "not an object"),
    ],
)
def test_verify_rejects_with_a_reason(item: Any, needle: str) -> None:
    text = N_HYPO + " " + "x" * 161
    out = lv.verify(text, {"symptoms": [item]})
    assert out.symptoms == () and out.notes == ()
    assert len(out.rejected) == 1 and needle in out.rejected[0].reason
    assert out.rejected[0].kind == "symptom"


def test_verify_count_must_be_digits_in_the_quote() -> None:
    ok = lv.verify(C_STOOLS, raw([sym("6 or 7 watery stools a day", "Diarrhea", count=7)]))
    assert ok.symptoms[0].count == 7.0 and ok.rejected == ()
    spelled = lv.verify(
        "six watery stools a day", raw([sym("six watery stools a day", "Diarrhea", count=6)])
    )
    assert spelled.symptoms == () and "digits" in spelled.rejected[0].reason
    unit = lv.verify(
        C_STOOLS,
        raw([sym("6 or 7 watery stools a day", "Diarrhea", count="7", count_unit="stools")]),
    )
    assert unit.symptoms[0].count_unit == "stools"


@pytest.mark.parametrize(
    ("item", "needle"),
    [
        (med("Started Imodium", "loperamide"), "name does not appear"),
        (med("Started Imodium", "Imodium", "borrowed"), "action"),
        (med("Never said this", "Imodium"), "not in the text word for word"),
        (med("Started Imodium", ""), "name does not appear"),
        (med("y" * 161, "Imodium"), "longer than"),
        (12, "not an object"),
    ],
)
def test_verify_rejects_medications_with_a_reason(item: Any, needle: str) -> None:
    out = lv.verify(C_STOOLS + " " + "y" * 161, {"medications": [item]})
    assert out.medications == ()
    assert len(out.rejected) == 1 and needle in out.rejected[0].reason
    assert out.rejected[0].kind == "medication"


def test_verify_tolerates_garbage_shapes() -> None:
    assert lv.verify("text", None).rejected[0].reason == "the reader answer is not an object"
    assert lv.verify("text", {"symptoms": "nope", "medications": 3}) == lv.VerifyResult(
        (), (), (), ()
    )
    assert lv.verify("text", {}).symptoms == ()


# --------------------------------------------------------------------------- #
# merge
# --------------------------------------------------------------------------- #


def merged(text: str, answer: dict[str, Any], ref: date | None = None) -> lv.ReaderMerge:
    return lv.merge(text, cs.scan_text(text, ref), lv.verify(text, answer), ref_date=ref)


def test_scanner_alone_misses_the_hypothyroidism_the_reader_finds() -> None:
    assert "Hypothyroidism" not in {s.term for s in cs.scan_text(N_HYPO).symptoms}
    out = merged(
        N_HYPO,
        raw(
            [
                sym("Hypothyroidism, grade 2, likely immune-related", "Hypothyroidism"),
                sym("Denies diarrhea", "Diarrhea", "negated"),
            ],
            [med("Started levothyroxine 50 mcg daily", "levothyroxine", generic="levothyroxine")],
        ),
        date(2026, 10, 10),
    )
    finding = next(s for s in out.result.symptoms if s.term == "Hypothyroidism")
    assert out.symptom_found_by["Hypothyroidism"] == "gemini"
    assert finding.grade_hint == 2 and "explicit 'grade 2'" in finding.grade_basis
    assert N_HYPO[finding.span_start : finding.span_end] == finding.quote
    # the scanner's lexicon already knows levothyroxine, so the same medication is "both"
    assert out.med_found_by["levothyroxine"] == "both"
    assert out.reader_meds == ()
    assert [n.term for n in out.notes] == ["Diarrhea"]
    rules = lv.reader_rules_fired(out)
    assert [r["rule_id"] for r in rules] == [cs.RULE_GEMINI_SYMPTOM]
    for rule in rules:
        inputs = rule["inputs"]
        assert isinstance(inputs, dict) and inputs["found_by"] == "gemini"
        assert rule["quote"] == inputs["quote"]
    payload = lv.apply_found_by(cs.scan_result_to_dict(out.result), out)
    assert {s["term"]: s["found_by"] for s in payload["symptoms"]}["Hypothyroidism"] == "gemini"
    assert all(s["found_by"] == "scanner" for s in payload["excluded_symptoms"])
    json.dumps(lv.reader_note_dicts(out.notes))
    json.dumps(lv.rejection_dicts(out.rejected))


def test_counted_diarrhea_is_graded_by_the_stool_band_not_the_model() -> None:
    text = "Patient reports diarrhea 6 or 7 times through the day."
    out = merged(
        text,
        raw([sym("diarrhea 6 or 7 times through the day", "Diarrhea", count=7)]),
    )
    # the scanner already kept Diarrhea in this sentence: same finding, labeled both
    assert out.symptom_found_by["Diarrhea"] == "both" and out.reader_symptoms == ()
    only = "He has had 9 episodes of runny output in 24 hours, per the nurse."
    reader_only = merged(only, raw([sym("9 episodes of runny output", "Diarrhea", count=9)]))
    finding = reader_only.reader_symptoms[0]
    assert finding.grade_hint == 3 and "9 stools/day" in finding.grade_basis
    assert "second reader" in finding.grade_basis
    two = merged(only, raw([sym("9 episodes", "Diarrhea", count=9)]))
    assert two.reader_symptoms[0].grade_hint == 3
    low = "Output was loose, 2 episodes of runny output yesterday."
    assert (
        merged(low, raw([sym("2 episodes of runny output", "Diarrhea", count=2)]))
        .reader_symptoms[0]
        .grade_hint
        == 1
    )


def test_reader_symptom_without_a_severity_word_is_grade_one_mentioned() -> None:
    text = "Labs notable for hypophysitis on the MRI read."
    finding = merged(text, raw([sym("hypophysitis", "Hypophysitis")])).reader_symptoms[0]
    assert finding.grade_hint == 1
    assert "mentioned" in finding.grade_basis
    severe = "Severe myositis was noted on exam."
    assert merged(severe, raw([sym("myositis", "Myositis")])).reader_symptoms[0].grade_hint == 3
    capped = "Uveitis, grade 4, hospitalized."
    got = merged(capped, raw([sym("Uveitis", "Uveitis")])).reader_symptoms[0]
    assert got.grade_hint == 3 and "capped" in got.grade_basis


def test_reader_symptom_carries_onset_resolved_and_hospital_cue() -> None:
    text = "Uveitis for 3 days, worsening. Admitted overnight with myositis, resolved now."
    out = merged(
        text,
        raw([sym("Uveitis for 3 days", "Uveitis"), sym("myositis", "Myositis", "resolved")]),
        date(2026, 10, 10),
    )
    uveitis, myositis = out.reader_symptoms
    assert uveitis.onset_days == 3 and uveitis.onset_date == "2026-10-07"
    assert uveitis.worsening
    assert myositis.resolved and myositis.grade_hint == 3
    assert "possible hospitalization" in myositis.reason


def test_resolved_status_marks_the_finding_resolved() -> None:
    out = merged("Uveitis seen last week.", raw([sym("Uveitis", "Uveitis", "resolved")]))
    assert out.reader_symptoms[0].resolved


def test_both_when_the_scanner_found_the_same_term_or_drug() -> None:
    text = "Fatigue noted. Started loperamide for diarrhea."
    out = merged(
        text,
        raw(
            [sym("Fatigue", "Fatigue")],
            [med("Started loperamide", "loperamide", generic="loperamide")],
        ),
    )
    assert out.symptom_found_by["Fatigue"] == "both"
    assert out.med_found_by["loperamide"] == "both"
    assert out.n_both == 2
    assert out.reader_symptoms == () and out.reader_meds == ()
    assert out.result == cs.scan_text(text)


def test_reader_never_overrides_what_the_scanner_excluded() -> None:
    text = "Denies nausea. Declined ondansetron. Allergic to penicillin."
    scan = cs.scan_text(text)
    assert scan.excluded_symptoms and scan.excluded_meds
    out = merged(
        text,
        raw(
            [sym("nausea", "Nausea")],
            [med("ondansetron", "ondansetron", "taking"), med("penicillin", "penicillin")],
        ),
    )
    assert out.result == scan
    reasons = [r.reason for r in out.rejected]
    assert len(reasons) == 3 and all("does not override" in r for r in reasons)


def test_second_finding_for_the_same_term_or_drug_is_rejected_as_a_duplicate() -> None:
    text = (
        "Hypophysitis on MRI. Hypophysitis again on the follow-up CT. "
        "Started prednisone then prednisone."
    )
    out = merged(
        text,
        raw(
            [sym("Hypophysitis on MRI", "Hypophysitis"), sym("Hypophysitis again", "hypophysitis")],
            [
                med("Started prednisone", "prednisone"),
                med("then prednisone", "prednisone", "taking"),
            ],
        ),
    )
    assert len(out.reader_symptoms) == 1 or out.symptom_found_by["Hypophysitis"] != "gemini"
    assert sum("already kept" in r.reason for r in out.rejected) >= 1


def test_medication_without_generic_uses_the_bundled_list_then_the_written_name() -> None:
    text = "She began Claritin yesterday. Also started zorbixol 5 mg."
    out = merged(
        text,
        raw(
            [],
            [
                med("began Claritin", "Claritin"),
                med("started zorbixol 5 mg", "zorbixol", "held"),
            ],
        ),
    )
    drugs = {m.drug: m for m in out.reader_meds}
    assert set(drugs) <= {"loratadine", "claritin", "zorbixol"}
    assert drugs["zorbixol"].change == "stopped" and "hold" in drugs["zorbixol"].reason
    assert lv.med_change("changed") == "changed" and lv.med_change("taking") == "taking"
    assert lv.med_change("odd") == "taking"


def test_merge_without_reader_is_the_identity_and_labels_everything_scanner() -> None:
    scan = cs.scan_text("Mild nausea. Started loperamide.")
    out = lv.merge("Mild nausea. Started loperamide.", scan, lv.VerifyResult((), (), (), ()))
    assert out.result == scan
    payload = lv.apply_found_by(cs.scan_result_to_dict(scan), None)
    assert all(s["found_by"] == "scanner" for s in (*payload["symptoms"], *payload["meds"]))


# --------------------------------------------------------------------------- #
# Properties
# --------------------------------------------------------------------------- #

TEXTS = [
    N_HYPO,
    C_STOOLS,
    "Pt reports 3 days of diarrhea, 4-5 loose stools per day, started loperamide OTC. "
    "Admitted to the ED for dehydration. Denies fever.",
    "Seen in clinic. Rash on arms, mild. No shortness of breath. Allergic to sulfa.",
]
VOCAB = [*lv.closed_vocabulary(), "UNMAPPED", "Nonsense term"]
STATUS = [*lv.STATUSES, "weird"]
ACTION = [*lv.ACTIONS, "weird"]


@st.composite
def reader_answers(draw: st.DrawFn) -> tuple[str, dict[str, Any]]:
    text = draw(st.sampled_from(TEXTS))

    def quote() -> st.SearchStrategy[str]:
        spans = st.tuples(st.integers(0, len(text)), st.integers(0, 80)).map(
            lambda t: text[t[0] : t[0] + t[1]]
        )
        return st.one_of(spans, st.text(max_size=30))

    symptoms = draw(
        st.lists(
            st.fixed_dictionaries(
                {
                    "quote": quote(),
                    "term": st.sampled_from(VOCAB),
                    "status": st.sampled_from(STATUS),
                },
                optional={"count": st.one_of(st.integers(-3, 30), st.text(max_size=3), st.none())},
            ),
            max_size=6,
        )
    )
    meds = draw(
        st.lists(
            st.fixed_dictionaries(
                {
                    "quote": quote(),
                    "name": st.sampled_from(["loperamide", "levothyroxine", "x", "prednisone", ""]),
                    "action": st.sampled_from(ACTION),
                },
                optional={"generic": st.one_of(st.none(), st.sampled_from(["loperamide", "foo"]))},
            ),
            max_size=4,
        )
    )
    return text, {"symptoms": symptoms, "medications": meds}


@settings(max_examples=150, deadline=None)
@given(reader_answers())
def test_property_merge_is_additive_and_every_quote_is_in_the_text(
    case: tuple[str, dict[str, Any]],
) -> None:
    text, answer = case
    scan = cs.scan_text(text)
    verified = lv.verify(text, answer)
    out = lv.merge(text, scan, verified)
    result = out.result
    n_s, n_m = len(scan.symptoms), len(scan.meds)
    # every scanner finding is preserved, unchanged and first
    assert result.symptoms[:n_s] == scan.symptoms
    assert result.meds[:n_m] == scan.meds
    assert result.excluded_symptoms == scan.excluded_symptoms
    assert result.excluded_meds == scan.excluded_meds
    assert result.red_flags == scan.red_flags
    assert result.human_requested == scan.human_requested
    # so the escalation and seriousness the tier is built from are exactly the scanner's
    for kind in ("note", "utterance"):
        assert cs.escalation_level(result, kind) == cs.escalation_level(scan, kind)  # type: ignore[arg-type]
    assert cs.seriousness_suspected(result) == cs.seriousness_suspected(scan)
    # every reader finding quotes the text word for word, in the closed vocabulary, graded by rules
    vocabulary = set(lv.closed_vocabulary())
    for added in result.symptoms[n_s:]:
        assert text[added.span_start : added.span_end] == added.quote and added.quote
        assert added.term in vocabulary
        assert added.grade_hint is not None and 1 <= added.grade_hint <= 3
        assert out.symptom_found_by[added.term] == "gemini"
    for added_med in result.meds[n_m:]:
        assert text[added_med.span_start : added_med.span_end] == added_med.quote
        assert out.med_found_by[added_med.drug] == "gemini"
    assert len({s.term for s in result.symptoms}) == len(result.symptoms)
    for note in verified.notes:
        assert text[note.span_start : note.span_end] == note.quote
        assert note.status not in lv.DRAFT_STATUSES
    for rejection in out.rejected:
        assert rejection.reason


@settings(max_examples=150, deadline=None)
@given(
    st.recursive(
        st.none()
        | st.booleans()
        | st.integers()
        | st.floats(allow_nan=True)
        | st.text(max_size=10),
        lambda children: (
            st.lists(children, max_size=3)
            | st.dictionaries(
                st.sampled_from(["symptoms", "medications", "quote", "term"]), children, max_size=3
            )
        ),
        max_leaves=12,
    )
)
def test_property_verify_never_raises_on_arbitrary_json(value: Any) -> None:
    out = lv.verify(N_HYPO, value)
    for found in out.symptoms:
        assert N_HYPO[found.span_start : found.span_end] == found.quote


# --------------------------------------------------------------------------- #
# The reader answer key
# --------------------------------------------------------------------------- #


def test_reader_answer_key_loads_and_matches_the_scanner_where_it_says_so() -> None:
    cases = {c.id: c for c in lv.reader_answer_key()}
    assert set(cases) == {"N-HYPO", "C-STOOLS"}
    for case in cases.values():
        scan = cs.scan_text(case.text, date.fromisoformat(case.note_date))
        found = {s.term: s for s in scan.symptoms}
        drugs = {(m.drug, m.change) for m in scan.meds}
        for expected in case.symptoms:
            assert (expected.term in found) is expected.scanner_finds, (case.id, expected.term)
            assert expected.quote_contains.lower() in case.text.lower()
            if expected.scanner_finds and expected.grade is not None:
                assert found[expected.term].grade_hint == expected.grade
        for expected_med in case.meds:
            assert ((expected_med.drug, expected_med.change) in drugs) is expected_med.scanner_finds
        assert not set(case.forbidden_terms) & set(found)
    assert cases["C-STOOLS"].kind == "call" and cases["N-HYPO"].kind == "note"


def test_malformed_reader_answer_key_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    import copy

    from interim_rules import tables
    from interim_rules.tables import TableError

    good = tables.load_table("reader_answer_key")

    def attempt(mutate: Any) -> str:
        bad = copy.deepcopy(good)
        mutate(bad)
        lv.reader_answer_key.cache_clear()
        monkeypatch.setattr(lv, "load_table", lambda name: bad)
        with pytest.raises(TableError) as err:
            lv.reader_answer_key()
        return str(err.value)

    assert "closed vocabulary" in attempt(
        lambda t: t["cases"][0]["expected"]["symptoms"][0].__setitem__("term", "Nope")
    )
    assert "duplicate" in attempt(lambda t: t["cases"].append(dict(t["cases"][0])))
    assert "'note' or 'call'" in attempt(lambda t: t["cases"][0].__setitem__("kind", "x"))
    assert "unknown change" in attempt(
        lambda t: t["cases"][0]["expected"]["meds"][0].__setitem__("change", "x")
    )
    assert "integer or null" in attempt(
        lambda t: t["cases"][0]["expected"]["symptoms"][0].__setitem__("grade", "2")
    )
    assert "expected a list" in attempt(lambda t: t.__setitem__("cases", {}))
    assert "expected an object" in attempt(lambda t: t["cases"].__setitem__(0, 5))
    assert "non-empty string" in attempt(lambda t: t["cases"][0].__setitem__("text", ""))
    monkeypatch.undo()
    lv.reader_answer_key.cache_clear()
    assert len(lv.reader_answer_key()) == 2


def test_an_ongoing_medication_is_not_drafted_from_the_reader() -> None:
    """A CM record captures a change; an ongoing medicine (often the study drug) is not drafted."""
    text = "Continue cemiplimab. Started levothyroxine 50 mcg daily."
    answer = {
        "symptoms": [],
        "medications": [
            {"quote": "cemiplimab", "name": "cemiplimab", "action": "taking"},
            {"quote": "levothyroxine", "name": "levothyroxine", "action": "started"},
        ],
    }
    out = merged(text, answer)
    drugs = {m.drug for m in out.reader_meds}
    assert "cemiplimab" not in drugs
    assert any(r.quote == "cemiplimab" and "ongoing" in r.reason for r in out.rejected)
