"""Template writer (``interim_rules.narrative``): golden text, evidence, omission, validation.

The three golden bundles mirror the §00.6 Monday-morning story: an SAE from an
emergency-room note, a possible AESI from a grade 3 rash at the kiosk, and the
visit brief for the participant seen tomorrow. Every expected sentence is
written out in full so a wording change in ``narrative_templates.json`` shows up
as a reviewable test diff.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from interim_rules import narrative
from interim_rules.narrative import (
    NARRATIVE_TABLE_NAMES,
    WrittenText,
    collect_evidence_ids,
    collect_fact_strings,
    derive_questions,
    quoted_passages,
    section_titles,
    strings_by_evidence_id,
    validate_written,
    write,
)
from interim_rules.narrative_templates import (
    KINDS,
    PLACEHOLDER,
    Scope,
    Slot,
    Variant,
    join_list,
    narrative_templates,
    parse_templates,
    render,
)
from interim_rules.tables import TableError, data_dir, load_table

DISCOURAGED_EXCEPTION = "except in the case of a life-threatening emergency and/or to treat an irAE"

SAE_FACTS: dict[str, Any] = {
    "kind": "sae",
    "participant": {"value": "P-004", "evidence_ids": ["PART-P004"]},
    "study_id": {"value": "R2810-ONC-1624", "evidence_ids": ["STUDY-1"]},
    "study_drug": {"value": "cemiplimab", "evidence_ids": ["STUDY-1"]},
    "last_dose": {"value": "2026-10-02", "evidence_ids": ["DOSE-7"]},
    "event": {
        "term": "Dyspnea",
        "plain_label": "shortness of breath",
        "evidence_ids": ["NOTE-ER-1"],
    },
    "onset": {"value": "2026-10-08", "evidence_ids": ["NOTE-ER-1"]},
    "quotes": [
        {
            "text": "presented to the ED with worsening shortness of breath",
            "source_label": "emergency room note dated 2026-10-09",
            "evidence_ids": ["NOTE-ER-1"],
        }
    ],
    "provisional_grade": {"grade": 3, "evidence_ids": ["NOTE-ER-1", "RULE-chartscan.grade"]},
    "site_awareness_at": {"value": "2026-10-10T06:15:00.000Z", "evidence_ids": ["NOTE-ER-1"]},
    "awareness_source": {
        "value": "an emergency room note ingested by the coordinator",
        "evidence_ids": ["NOTE-ER-1"],
    },
    "seriousness_criteria": [
        {
            "value": "requires inpatient hospitalisation or prolongation of existing "
            "hospitalisation",
            "evidence_ids": ["NOTE-ER-1", "RULE-sae.clock_started"],
        }
    ],
    "deadline": {
        "due_at": "2026-10-11T06:15:00.000Z",
        "hours": 24,
        "protocol_section": "9.4.2",
        "printed_page": 91,
        "evidence_ids": ["CLOCK-1"],
    },
    "conmeds": [
        {
            "name": "prednisone 40 mg",
            "direction": "started",
            "date": "2026-10-09",
            "protocol_flag": "discouraged",
            "protocol_section": "7.7.2",
            "printed_page": 69,
            "exception_text": DISCOURAGED_EXCEPTION,
            "missing_fields": ["CMDOSFRQ", "CMINDC"],
            "evidence_ids": ["NOTE-ER-1"],
        }
    ],
    "escalation": {
        "tier": 2,
        "tier_name": "Nurse call today",
        "date": "2026-10-10T06:15:00.000Z",
        "evidence_ids": ["ESC-1"],
    },
    "reporter_role": {"value": "study coordinator", "evidence_ids": ["USER-coord"]},
    "missing_information": [
        {"value": "outcome", "evidence_ids": ["CLOCK-1"]},
        {"value": "action taken with the study drug", "evidence_ids": ["CLOCK-1"]},
        {"value": "discharge summary", "evidence_ids": ["NOTE-ER-1"]},
    ],
}

AESI_FACTS: dict[str, Any] = {
    "kind": "aesi",
    "participant": {"value": "P-002", "evidence_ids": ["PART-P002"]},
    "study_id": {"value": "R2810-ONC-1624", "evidence_ids": ["STUDY-1"]},
    "study_drug": {"value": "cemiplimab", "evidence_ids": ["STUDY-1"]},
    "event": {"term": "Rash maculo-papular", "plain_label": "rash", "evidence_ids": ["ANS-rash-1"]},
    "onset": {"value": "2026-10-09T22:41:07.000Z", "evidence_ids": ["ANS-rash-1"]},
    "provisional_grade": {
        "grade": 3,
        "evidence_ids": ["ANS-rash-1", "RULE-grade.provisional.rash"],
    },
    "site_awareness_at": {"value": "2026-10-09T22:41:07.000Z", "evidence_ids": ["SESSION-9"]},
    "awareness_source": {"value": "a kiosk check-in", "evidence_ids": ["SESSION-9"]},
    "aesi_reasons": [
        {
            "value": "the protocol lists grade 3 or greater immune-related adverse events as "
            "AESIs (section 9.4.3, page 92), and rash is potentially immune-related",
            "evidence_ids": ["RULE-protocol.aesi_suspected"],
        }
    ],
    "deadline": {
        "due_at": "2026-10-10T22:41:07.000Z",
        "hours": 24,
        "protocol_section": "9.4.3",
        "printed_page": 92,
        "evidence_ids": ["CLOCK-2"],
    },
    "reporter_role": {"value": "study coordinator", "evidence_ids": ["USER-coord"]},
    "missing_information": [
        {"value": "date of last dose", "evidence_ids": ["CLOCK-2"]},
        {"value": "outcome", "evidence_ids": ["CLOCK-2"]},
    ],
}

BRIEF_FACTS: dict[str, Any] = {
    "participant": {"value": "P-002", "evidence_ids": ["PART-P002"]},
    "since": {"value": "2026-10-03", "evidence_ids": ["VISIT-3"]},
    "next_visit": {"value": "2026-10-11", "evidence_ids": ["VISIT-4"]},
    "new_side_effects": [
        {
            "term": "Rash maculo-papular",
            "plain_label": "rash",
            "grades": [
                {"grade": 3, "date": "2026-10-09", "evidence_ids": ["DRAFT-AE-9"]},
                {"grade": 1, "date": "2026-10-05", "evidence_ids": ["DRAFT-AE-5"]},
            ],
            "evidence_ids": ["AEOPEN-rash"],
        }
    ],
    "open_aes": [
        {
            "term": "Rash maculo-papular",
            "plain_label": "rash",
            "onset": "2026-10-05",
            "last_reported": "2026-10-09T22:41:07.000Z",
            "ongoing": True,
            "evidence_ids": ["AEOPEN-rash"],
        }
    ],
    "med_changes": [
        {
            "name": "Prednisone",
            "direction": "started",
            "date": "2026-10-08",
            "protocol_flag": "discouraged",
            "protocol_section": "7.7.2",
            "printed_page": 69,
            "exception_text": DISCOURAGED_EXCEPTION,
            "missing_fields": ["CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC"],
            "evidence_ids": ["DRAFT-CM-3"],
        }
    ],
    "escalations": [
        {
            "tier": 2,
            "tier_name": "Nurse call today",
            "date": "2026-10-09T22:41:07.000Z",
            "reason": "grade 3 rash (provisional, investigator to confirm)",
            "acknowledged": False,
            "evidence_ids": ["ESC-9"],
        }
    ],
    "clocks": [
        {
            "kind": "aesi",
            "event_label": "rash",
            "hours": 24,
            "due_at": "2026-10-10T22:41:07.000Z",
            "status": "running",
            "evidence_ids": ["CLOCK-2"],
        }
    ],
    "notes": [
        {
            "note_type": "urgent-care note",
            "note_date": "2026-10-08",
            "author": "Dr. A. Synthetic",
            "n_symptoms": 1,
            "n_meds": 1,
            "evidence_ids": ["NOTE-UC-1"],
        }
    ],
    "vitals": {
        "is_measured": False,
        "source": "mock",
        "pulse_median": 84,
        "breathing_median": 16,
        "date": "2026-10-09",
        "evidence_ids": ["VS-SUM-9"],
    },
}

GOLDEN_SAE = [
    ("Participant P-004 is enrolled in study R2810-ONC-1624, where the study drug is cemiplimab.",
     ["PART-P004", "STUDY-1"]),
    ("The last recorded dose of cemiplimab was on 2026-10-02.", ["STUDY-1", "DOSE-7"]),
    ("The event was shortness of breath (CTCAE term: Dyspnea), which began on 2026-10-08.",
     ["NOTE-ER-1"]),
    ('The emergency room note dated 2026-10-09 reads: "presented to the ED with worsening '
     'shortness of breath".', ["NOTE-ER-1"]),
    ("The event was recorded as grade 3 (provisional, investigator to confirm).",
     ["NOTE-ER-1", "RULE-chartscan.grade"]),
    ("The site became aware of the event on 2026-10-10 06:15 UTC, from an emergency room note "
     "ingested by the coordinator.", ["NOTE-ER-1"]),
    ("Seriousness criteria suspected: requires inpatient hospitalisation or prolongation of "
     "existing hospitalisation (investigator to confirm).",
     ["NOTE-ER-1", "RULE-sae.clock_started"]),
    ("Under protocol section 9.4.2 (page 91), a serious adverse event must be reported to the "
     "sponsor within 24 hours, regardless of causality; this report is due by "
     "2026-10-11 06:15 UTC.", ["CLOCK-1"]),
    ('The participant started "prednisone 40 mg" on 2026-10-09; the protocol discourages it '
     '(section 7.7.2, page 69), with this exception: "except in the case of a life-threatening '
     'emergency and/or to treat an irAE".', ["NOTE-ER-1"]),
    ("Interim escalated the event to the study team as tier 2 (Nurse call today) on "
     "2026-10-10 06:15 UTC.", ["ESC-1"]),
    ("The relationship to cemiplimab has not yet been assessed by the investigator.",
     ["STUDY-1", "NOTE-ER-1"]),
    ("This draft was prepared from site records by the study coordinator for investigator "
     "review and signature.", ["USER-coord"]),
    ("Information still needed: outcome, action taken with the study drug and discharge "
     "summary.", ["CLOCK-1", "NOTE-ER-1"]),
]  # fmt: skip

GOLDEN_AESI = [
    ("Participant P-002 is enrolled in study R2810-ONC-1624, where the study drug is cemiplimab.",
     ["PART-P002", "STUDY-1"]),
    ("The event was rash (CTCAE term: Rash maculo-papular), which began on 2026-10-09 22:41 UTC.",
     ["ANS-rash-1"]),
    ("The event was recorded as grade 3 (provisional, investigator to confirm).",
     ["ANS-rash-1", "RULE-grade.provisional.rash"]),
    ("The site became aware of the event on 2026-10-09 22:41 UTC, from a kiosk check-in.",
     ["SESSION-9"]),
    ("Possible AESI, investigator to confirm: the protocol lists grade 3 or greater "
     "immune-related adverse events as AESIs (section 9.4.3, page 92), and rash is potentially "
     "immune-related.", ["RULE-protocol.aesi_suspected"]),
    ("Under protocol section 9.4.3 (page 92), this kind of event must be reported to the sponsor "
     "within 24 hours; this report is due by 2026-10-10 22:41 UTC.", ["CLOCK-2"]),
    ("The relationship to cemiplimab has not yet been assessed by the investigator.",
     ["STUDY-1", "ANS-rash-1"]),
    ("This draft was prepared from site records by the study coordinator for investigator "
     "review and signature.", ["USER-coord"]),
    ("Information still needed: date of last dose and outcome.", ["CLOCK-2"]),
]  # fmt: skip

GOLDEN_BRIEF = [
    ("Visit brief for participant P-002: everything recorded since 2026-10-03.",
     ["PART-P002", "VISIT-3"]),
    ("The next visit is scheduled for 2026-10-11.", ["VISIT-4"]),
    ("New side effect: rash (Rash maculo-papular), grade 1 on 2026-10-05, then grade 3 on "
     "2026-10-09, worsening (provisional, investigator to confirm).",
     ["AEOPEN-rash", "DRAFT-AE-5", "DRAFT-AE-9"]),
    ("Open adverse event: rash (Rash maculo-papular), began on 2026-10-05, last reported on "
     "2026-10-09 22:41 UTC, still open.", ["AEOPEN-rash"]),
    ('Medication change: the participant started "Prednisone" on 2026-10-08; the protocol '
     'discourages it (section 7.7.2, page 69), with this exception: "except in the case of a '
     'life-threatening emergency and/or to treat an irAE".', ["DRAFT-CM-3"]),
    ("Escalation on 2026-10-09 22:41 UTC: tier 2 (Nurse call today), grade 3 rash (provisional, "
     "investigator to confirm); not yet acknowledged.", ["ESC-9"]),
    ("24-hour clock (possible AESI, investigator to confirm) for rash: due 2026-10-10 22:41 UTC, "
     "still running.", ["CLOCK-2"]),
    ("Chart note ingested: urgent-care note dated 2026-10-08 by Dr. A. Synthetic (possible side "
     "effects found: 1; medication mentions found: 1).", ["NOTE-UC-1"]),
    ("Vitals context (simulated, source mock) on 2026-10-09: pulse median 84 beats/min and "
     "breathing median 16 breaths/min; vitals are context only.", ["VS-SUM-9"]),
    ('Ask about "Prednisone"; still needed for the medication record: dose, dose unit, '
     "frequency and indication.", ["DRAFT-CM-3"]),
    ("Ask whether the rash has resolved, and if so, on what date.", ["AEOPEN-rash"]),
    ("Make sure the report for rash is signed by the investigator before it is due.",
     ["CLOCK-2"]),
]  # fmt: skip


def _pairs(written: WrittenText) -> list[tuple[str, list[str]]]:
    return [(s.text, list(s.evidence_ids)) for s in written.sentences]


def _without(facts: Mapping[str, Any], *keys: str) -> dict[str, Any]:
    out = copy.deepcopy(dict(facts))
    for key in keys:
        out.pop(key, None)
    return out


# --------------------------------------------------------------------------- #
# Golden outputs
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("kind", "facts", "golden"),
    [
        ("sae_narrative", SAE_FACTS, GOLDEN_SAE),
        ("aesi_narrative", AESI_FACTS, GOLDEN_AESI),
        ("visit_brief", BRIEF_FACTS, GOLDEN_BRIEF),
    ],
)
def test_golden_output(kind: str, facts: dict[str, Any], golden: list[Any]) -> None:
    written = write(kind, facts)
    assert _pairs(written) == [(text, ids) for text, ids in golden]
    assert written.kind == kind
    assert written.writer == "template"
    assert written.fallback_reason is None
    assert written.text == " ".join(text for text, _ in golden)
    assert validate_written(written, facts) == []


def test_sae_sections_follow_ich_e2a_order() -> None:
    sections = [s.section for s in write("sae_narrative", SAE_FACTS).sentences]
    order = ["summary", "event", "seriousness", "medications", "actions", "causality",
             "reporter", "missing"]  # fmt: skip
    assert [s for s in order if s in sections] == order
    assert sections == sorted(sections, key=order.index)


def test_template_ids_and_section_titles() -> None:
    written = write("visit_brief", BRIEF_FACTS)
    assert written.sentences[0].template_id == "visit_brief.header"
    titles = section_titles()
    assert all(s.section in titles for s in written.sentences)
    assert titles["questions"] == "Questions to ask at the visit"


def test_to_dict_shape_and_fallback_reason() -> None:
    written = write("aesi_narrative", AESI_FACTS)
    as_dict = written.to_dict()
    assert set(as_dict) == {"kind", "writer", "sentences", "text"}
    sentences = as_dict["sentences"]
    assert isinstance(sentences, list)
    assert set(sentences[0]) == {"text", "evidence_ids", "section", "template_id"}
    json.dumps(as_dict)
    fallback = WrittenText(
        kind=written.kind,
        writer="template",
        sentences=written.sentences,
        text=written.text,
        fallback_reason="llm output cited an unknown evidence id",
    )
    assert fallback.to_dict()["fallback_reason"] == "llm output cited an unknown evidence id"
    assert validate_written(fallback.to_dict(), AESI_FACTS) == []


# --------------------------------------------------------------------------- #
# Determinism and evidence
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("kind", "facts"),
    [("sae_narrative", SAE_FACTS), ("aesi_narrative", AESI_FACTS), ("visit_brief", BRIEF_FACTS)],
)
def test_deterministic_and_does_not_mutate_facts(kind: str, facts: dict[str, Any]) -> None:
    before = copy.deepcopy(facts)
    first = write(kind, facts)
    second = write(kind, copy.deepcopy(facts))
    assert first == second
    assert facts == before


@pytest.mark.parametrize(
    ("kind", "facts"),
    [("sae_narrative", SAE_FACTS), ("aesi_narrative", AESI_FACTS), ("visit_brief", BRIEF_FACTS)],
)
def test_every_sentence_cites_ids_from_the_facts(kind: str, facts: dict[str, Any]) -> None:
    known = set(collect_evidence_ids(facts))
    for sentence in write(kind, facts).sentences:
        assert sentence.evidence_ids
        assert set(sentence.evidence_ids) <= known


def test_no_grade_without_its_qualifier_and_simulated_is_labelled() -> None:
    for kind, facts in (
        ("sae_narrative", SAE_FACTS),
        ("aesi_narrative", AESI_FACTS),
        ("visit_brief", BRIEF_FACTS),
    ):
        for sentence in write(kind, facts).sentences:
            bare = re.sub(r'"[^"]*"', "", sentence.text)
            if re.search(r"\bgrade\b", bare, re.IGNORECASE):
                assert "investigator to confirm" in sentence.text
            if re.search(r"\bAESI\b", bare):
                assert "possible AESI, investigator to confirm" in sentence.text.replace(
                    "Possible", "possible"
                )
    vitals = [s for s in write("visit_brief", BRIEF_FACTS).sentences if s.section == "vitals"]
    assert "simulated" in vitals[0].text
    measured = copy.deepcopy(BRIEF_FACTS)
    measured["vitals"]["is_measured"] = True
    vitals = [s for s in write("visit_brief", measured).sentences if s.section == "vitals"]
    assert "(measured, source mock)" in vitals[0].text


# --------------------------------------------------------------------------- #
# Omission: missing facts drop sentences, never produce filler
# --------------------------------------------------------------------------- #


def test_missing_facts_omit_their_sentences() -> None:
    facts = _without(SAE_FACTS, "last_dose", "quotes", "escalation", "conmeds", "reporter_role")
    texts = [s.text for s in write("sae_narrative", facts).sentences]
    assert not any("last recorded dose" in t for t in texts)
    assert not any("reads:" in t for t in texts)
    assert not any("escalated" in t for t in texts)
    assert not any("participant started" in t for t in texts)
    assert not any("prepared from site records" in t for t in texts)
    joined = " ".join(texts)
    for filler in ("unknown", "None", "n/a", "{", "}"):
        assert filler not in joined


def test_variant_fallbacks_when_optional_facts_are_missing() -> None:
    facts = _without(
        SAE_FACTS, "study_id", "onset", "awareness_source", "study_drug", "missing_information"
    )
    facts["deadline"] = {"due_at": "2026-10-11T06:15:00Z", "evidence_ids": ["CLOCK-1"]}
    facts["quotes"] = [{"text": "short of breath", "evidence_ids": ["NOTE-ER-1"]}]
    facts["action_taken"] = {"value": "dose held", "evidence_ids": ["ACT-1"]}
    facts["outcome"] = {"value": "recovering", "evidence_ids": ["OUT-1"]}
    facts["causality"] = {"value": "related", "evidence_ids": ["INV-1"]}
    facts["escalation"] = {"tier": 3, "tier_name": "Urgent", "evidence_ids": ["ESC-1"]}
    texts = [s.text for s in write("sae_narrative", facts).sentences]
    assert texts[0] == "Participant P-004 is enrolled in this study."
    assert "The last recorded dose of the study drug was on 2026-10-02." in texts
    assert "The event was shortness of breath (CTCAE term: Dyspnea)." in texts
    assert 'A source record reads: "short of breath".' in texts
    assert "The site became aware of the event on 2026-10-10 06:15 UTC." in texts
    assert "This report is due to the sponsor by 2026-10-11 06:15 UTC." in texts
    assert "Interim escalated the event to the study team as tier 3 (Urgent)." in texts
    assert "Action taken with the study drug: dose held." in texts
    assert "The outcome was recorded as recovering." in texts
    assert "The investigator assessed the relationship to the study drug as related." in texts
    assert not any(t.startswith("Information still needed") for t in texts)


def test_participant_sentence_variants() -> None:
    only_drug = _without(SAE_FACTS, "study_id")
    first = write("sae_narrative", only_drug).sentences[0].text
    assert (
        first == "Participant P-004 is enrolled in this study, where the study drug is cemiplimab."
    )
    no_drug = _without(SAE_FACTS, "study_drug")
    texts = [s.text for s in write("sae_narrative", no_drug).sentences]
    assert texts[0] == "Participant P-004 is enrolled in study R2810-ONC-1624."
    assert "The relationship to the study drug has not yet been assessed by the investigator." in (
        texts
    )
    with_drug = copy.deepcopy(SAE_FACTS)
    with_drug["action_taken"] = {"value": "none yet", "evidence_ids": ["ACT-1"]}
    with_drug["causality"] = {"value": "not related", "evidence_ids": ["INV-1"]}
    texts = [s.text for s in write("sae_narrative", with_drug).sentences]
    assert "Action taken with cemiplimab: none yet." in texts
    assert "The investigator assessed the relationship to cemiplimab as not related." in texts


def test_reporting_deadline_variants() -> None:
    hours_only = copy.deepcopy(SAE_FACTS)
    hours_only["deadline"] = {"due_at": "2026-10-11", "hours": 24.0, "evidence_ids": ["C"]}
    texts = [s.text for s in write("sae_narrative", hours_only).sentences]
    assert "This report is due to the sponsor by 2026-10-11, 24 hours after the site became " in (
        " ".join(texts)
    )


def test_fact_without_evidence_is_treated_as_absent() -> None:
    facts = copy.deepcopy(SAE_FACTS)
    facts["outcome"] = {"value": "recovered", "evidence_ids": []}
    facts["participant"] = {"value": "P-004"}
    facts["onset"] = {"value": "   ", "evidence_ids": ["X"]}
    texts = [s.text for s in write("sae_narrative", facts).sentences]
    assert not any("outcome" in t.lower() and "recorded as" in t for t in texts)
    assert not any(t.startswith("Participant") for t in texts)
    assert "The event was shortness of breath (CTCAE term: Dyspnea)." in texts


def test_all_evidence_removed_gives_no_sentences() -> None:
    def strip(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: ([] if k == "evidence_ids" else strip(v)) for k, v in value.items()}
        if isinstance(value, list):
            return [strip(v) for v in value]
        return value

    for kind, facts in (("sae_narrative", SAE_FACTS), ("visit_brief", BRIEF_FACTS)):
        written = write(kind, strip(facts))
        assert written.sentences == ()
        assert written.text == ""
        assert validate_written(written, facts) == ["there are no sentences"]


def test_empty_facts_write_nothing() -> None:
    for kind in KINDS:
        assert write(kind, {}).sentences == ()


def test_missing_information_sentence_is_explicit() -> None:
    facts = {"missing_information": [{"value": "outcome", "evidence_ids": ["CLOCK-1"]},
                                     {"value": "  ", "evidence_ids": ["CLOCK-1"]},
                                     {"value": "last dose", "evidence_ids": []}]}  # fmt: skip
    written = write("sae_narrative", facts)
    assert _pairs(written) == [("Information still needed: outcome.", ["CLOCK-1"])]
    brief = write("visit_brief", facts)
    assert _pairs(brief) == [("Information still needed: outcome.", ["CLOCK-1"])]


def test_join_list_forms() -> None:
    fmt = narrative_templates().formats
    assert join_list([], fmt) == ""
    assert join_list(["a"], fmt) == "a"
    assert join_list(["a", "b"], fmt) == "a and b"
    assert join_list(["a", "b", "c"], fmt) == "a, b and c"


# --------------------------------------------------------------------------- #
# Visit brief specifics
# --------------------------------------------------------------------------- #


def test_brief_empty_lists_say_none_recorded() -> None:
    facts = {
        "participant": BRIEF_FACTS["participant"],
        "since": BRIEF_FACTS["since"],
        "new_side_effects": [],
        "med_changes": [],
        "open_aes": [],
        "questions": [],
    }
    assert [s.text for s in write("visit_brief", facts).sentences] == [
        "Visit brief for participant P-002: everything recorded since 2026-10-03.",
        "No new side effects were recorded since 2026-10-03.",
        "No medication changes were recorded since 2026-10-03.",
    ]


def test_brief_list_entries_without_evidence_do_not_claim_none() -> None:
    facts = {
        "since": BRIEF_FACTS["since"],
        "new_side_effects": [{"term": "Rash", "plain_label": "rash", "evidence_ids": []}],
    }
    assert write("visit_brief", facts).sentences == ()


def test_brief_trend_variants() -> None:
    def side_effect(grades: list[dict[str, Any]]) -> dict[str, Any]:
        return {"new_side_effects": [{"term": "Diarrhea", "plain_label": "diarrhea",
                                      "grades": grades, "evidence_ids": ["AE-1"]}]}  # fmt: skip

    improving = side_effect([
        {"grade": 3, "date": "2026-10-04", "evidence_ids": ["G1"]},
        {"grade": 2, "date": "2026-10-06T10:00:00Z", "evidence_ids": ["G2"]},
    ])  # fmt: skip
    text = write("visit_brief", improving).sentences[0].text
    assert text == (
        "New side effect: diarrhea (Diarrhea), grade 3 on 2026-10-04, then grade 2 on "
        "2026-10-06 10:00 UTC, improving (provisional, investigator to confirm)."
    )
    # Undated points keep the caller's order; a point without evidence is skipped.
    unchanged = side_effect([
        {"grade": 2, "evidence_ids": ["G1"]},
        {"grade": 2, "evidence_ids": ["G2"]},
        {"grade": 3, "evidence_ids": []},
    ])  # fmt: skip
    text = write("visit_brief", unchanged).sentences[0].text
    assert text == (
        "New side effect: diarrhea (Diarrhea), grade 2, then grade 2, unchanged (provisional, "
        "investigator to confirm)."
    )
    single = side_effect([{"grade": 1, "date": "2026-10-04", "evidence_ids": ["G1"]}])
    assert write("visit_brief", single).sentences[0].text == (
        "New side effect: diarrhea (Diarrhea), grade 1 on 2026-10-04 (provisional, investigator "
        "to confirm)."
    )
    assert write("visit_brief", side_effect([])).sentences[0].text == (
        "New side effect: diarrhea (Diarrhea)."
    )


def test_brief_entry_variants() -> None:
    facts: dict[str, Any] = {
        "open_aes": [
            {"term": "Cough", "plain_label": "cough", "onset": "2026-10-01", "ongoing": False,
             "evidence_ids": ["AE-1"]},
            {"term": "Cough", "plain_label": "cough", "ongoing": True, "evidence_ids": ["AE-2"]},
            {"term": "Cough", "plain_label": "cough", "evidence_ids": ["AE-3"]},
        ],
        "med_changes": [
            {"name": "bevacizumab", "direction": "started", "protocol_flag": "prohibited",
             "protocol_section": "7.7.1", "printed_page": 69, "evidence_ids": ["CM-1"]},
            {"name": "bevacizumab", "direction": "taking", "protocol_flag": "prohibited",
             "evidence_ids": ["CM-2"]},
            {"name": "dexamethasone", "direction": "stopped", "protocol_flag": "discouraged",
             "protocol_section": "7.7.2", "printed_page": 69, "evidence_ids": ["CM-3"]},
            {"name": "dexamethasone", "direction": "changed", "protocol_flag": "discouraged",
             "exception_text": DISCOURAGED_EXCEPTION, "evidence_ids": ["CM-4"]},
            {"name": "hydrocortisone", "direction": "started", "protocol_flag": "discouraged",
             "evidence_ids": ["CM-5"]},
            {"name": "denosumab", "direction": "started", "protocol_flag": "permitted",
             "protocol_section": "7.7.2", "printed_page": 69, "evidence_ids": ["CM-6"]},
            {"name": "denosumab", "direction": "started", "protocol_flag": "permitted",
             "evidence_ids": ["CM-7"]},
            {"name": "loratadine", "direction": "started", "evidence_ids": ["CM-8"]},
        ],
        "escalations": [
            {"tier": 3, "tier_name": "Urgent", "date": "2026-10-09", "acknowledged": True,
             "acknowledged_at": "2026-10-09T08:05:00Z", "evidence_ids": ["E-1"]},
            {"tier": 2, "tier_name": "Nurse call today", "date": "2026-10-09",
             "evidence_ids": ["E-2"]},
            {"tier": 2, "tier_name": "Nurse call today", "acknowledged": True,
             "evidence_ids": ["E-3"]},
            {"tier": 1, "tier_name": "Coordinator review", "evidence_ids": ["E-4"]},
        ],
        "clocks": [
            {"kind": "sae", "event_label": "hospital admission", "due_at": "2026-10-10T06:15:00Z",
             "status": "reported (mock)", "evidence_ids": ["C-1"]},
            {"kind": "sae", "event_label": "hospital admission", "due_at": "2026-10-10",
             "evidence_ids": ["C-2"]},
        ],
        "notes": [
            {"note_type": "ER note", "note_date": "2026-10-09", "n_symptoms": 2, "n_meds": 0,
             "evidence_ids": ["N-1"]},
            {"note_type": "ER note", "note_date": "2026-10-09", "author": "Dr. B",
             "evidence_ids": ["N-2"]},
            {"note_type": "ER note", "note_date": "2026-10-09", "evidence_ids": ["N-3"]},
            {"note_type": "ER note", "evidence_ids": ["N-4"]},
        ],
        "vitals": {"is_measured": True, "source": "presage", "pulse_median": 72.5,
                   "evidence_ids": ["V-1"]},
        "questions": [{"kind": "other", "subject": "confirm the next infusion date",
                       "details": [], "evidence_ids": ["Q-1"]}],
    }  # fmt: skip
    texts = [s.text for s in write("visit_brief", facts).sentences]
    expected = [
        "Open adverse event: cough (Cough), began on 2026-10-01, marked resolved.",
        "Open adverse event: cough (Cough), still open.",
        "Open adverse event: cough (Cough).",
        'Medication change: the participant started "bevacizumab"; the protocol lists it as '
        "prohibited (section 7.7.1, page 69), a possible protocol deviation for the investigator "
        "to review.",
        'Medication change: the participant reported taking "bevacizumab"; the protocol lists it '
        "as prohibited, a possible protocol deviation for the investigator to review.",
        'Medication change: the participant stopped "dexamethasone"; the protocol discourages it '
        "(section 7.7.2, page 69).",
        'Medication change: the participant changed the dose of "dexamethasone"; the protocol '
        f'discourages it, with this exception: "{DISCOURAGED_EXCEPTION}".',
        'Medication change: the participant started "hydrocortisone"; the protocol discourages it.',
        'Medication change: the participant started "denosumab"; the protocol permits it '
        "(section 7.7.2, page 69).",
        'Medication change: the participant started "denosumab"; the protocol permits it.',
        'Medication change: the participant started "loratadine".',
        "Escalation on 2026-10-09: tier 3 (Urgent); acknowledged on 2026-10-09 08:05 UTC.",
        "Escalation on 2026-10-09: tier 2 (Nurse call today).",
        "Escalation: tier 2 (Nurse call today); acknowledged.",
        "Escalation: tier 1 (Coordinator review).",
        "Reporting clock (SAE report) for hospital admission: due 2026-10-10 06:15 UTC, "
        "reported (mock).",
        "Reporting clock (SAE report) for hospital admission: due 2026-10-10.",
        "Chart note ingested: ER note dated 2026-10-09 (possible side effects found: 2; "
        "medication mentions found: 0).",
        "Chart note ingested: ER note dated 2026-10-09 by Dr. B.",
        "Chart note ingested: ER note dated 2026-10-09.",
        "Chart note ingested: ER note.",
        "Vitals context (measured, source presage): pulse median 72.5 beats/min; vitals are "
        "context only.",
        "Ask: confirm the next infusion date.",
    ]
    assert texts == expected
    breathing_only = {"vitals": {"is_measured": False, "source": "mock", "breathing_median": 26,
                                 "evidence_ids": ["V-2"]}}  # fmt: skip
    assert [s.text for s in write("visit_brief", breathing_only).sentences] == [
        "Vitals context (simulated, source mock): breathing median 26 breaths/min; vitals are "
        "context only."
    ]


def test_derive_questions_rules() -> None:
    questions = derive_questions(BRIEF_FACTS)
    assert [(q["kind"], q["subject"]) for q in questions] == [
        ("cm_missing_fields", "Prednisone"),
        ("unresolved_ae", "rash"),
        ("unsigned_packet", "rash"),
    ]
    assert questions[0]["details"] == ["CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC"]
    assert questions[0]["evidence_ids"] == ["DRAFT-CM-3"]
    settled = copy.deepcopy(BRIEF_FACTS)
    settled["med_changes"][0]["missing_fields"] = []
    settled["open_aes"][0]["ongoing"] = False
    settled["clocks"][0]["status"] = "reported (mock)"
    assert derive_questions(settled) == []
    texts = [s.text for s in write("visit_brief", settled).sentences]
    assert not any(t.startswith(("Ask", "Make sure")) for t in texts)
    explicit = copy.deepcopy(BRIEF_FACTS)
    explicit["questions"] = []
    texts = [s.text for s in write("visit_brief", explicit).sentences]
    assert not any(t.startswith(("Ask", "Make sure")) for t in texts)


# --------------------------------------------------------------------------- #
# Malformed facts raise ValueError naming the field
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("kind", "patch", "message"),
    [
        ("sae_narrative", {"kind": "aesi"}, "facts.kind"),
        ("aesi_narrative", {"kind": "sae"}, "facts.kind"),
        ("sae_narrative", {"participant": "P-004"}, "participant: expected an object"),
        ("sae_narrative", {"participant": {"value": 4, "evidence_ids": ["X"]}}, ".value"),
        ("sae_narrative", {"participant": {"value": "P", "evidence_ids": "X"}}, "evidence_ids"),
        ("sae_narrative", {"participant": {"value": "P", "evidence_ids": [""]}}, "evidence_ids[0]"),
        ("sae_narrative", {"quotes": {"text": "x"}}, "quotes: expected a list"),
        ("sae_narrative", {"quotes": ["x"]}, "quotes[0]: expected an object"),
        ("sae_narrative", {"quotes": [None]}, "quotes[0]: expected an object"),
        ("sae_narrative", {"onset": {"value": "yesterday", "evidence_ids": ["X"]}}, "onset.value"),
        ("sae_narrative", {"onset": {"value": "2026-02-30", "evidence_ids": ["X"]}}, "valid date"),
        ("sae_narrative", {"provisional_grade": {"grade": 6, "evidence_ids": ["X"]}}, "0 to 5"),
        ("sae_narrative", {"provisional_grade": {"grade": True, "evidence_ids": ["X"]}}, "integer"),
        ("sae_narrative", {"deadline": {"due_at": "2026-10-11", "hours": "24",
                                        "evidence_ids": ["X"]}}, "deadline.hours"),
        ("sae_narrative", {"deadline": {"due_at": "2026-10-11", "hours": float("nan"),
                                        "evidence_ids": ["X"]}}, "finite"),
        ("sae_narrative", {"conmeds": [{"name": "x", "direction": "doubled",
                                        "evidence_ids": ["X"]}]}, "conmeds[0].direction"),
        ("sae_narrative", {"conmeds": [{"name": "x", "direction": "started",
                                        "protocol_flag": "banned", "evidence_ids": ["X"]}]},
         "protocol_flag"),
        ("sae_narrative", {"conmeds": [{"name": "x", "direction": "started",
                                        "missing_fields": "dose", "evidence_ids": ["X"]}]},
         "missing_fields"),
        ("sae_narrative", {"conmeds": [{"name": "x", "direction": "started",
                                        "missing_fields": [1], "evidence_ids": ["X"]}]},
         "missing_fields[0]"),
        ("sae_narrative", {"escalation": {"tier": 2, "tier_name": "x", "acknowledged": "yes",
                                          "evidence_ids": ["X"]}}, "acknowledged"),
        ("visit_brief", {"clocks": [{"kind": "ind", "event_label": "x", "due_at": "2026-10-10",
                                     "evidence_ids": ["X"]}]}, "clocks[0].kind"),
        ("visit_brief", {"clocks": [{"kind": "sae", "event_label": "x", "due_at": "2026-10-10",
                                     "status": "late", "evidence_ids": ["X"]}]}, "status"),
        ("visit_brief", {"questions": [{"kind": "why", "subject": "x", "details": [],
                                        "evidence_ids": ["X"]}]}, "questions[0].kind"),
    ],
)  # fmt: skip
def test_malformed_facts_raise(kind: str, patch: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=re.escape(message)):
        write(kind, patch)


def test_unknown_kind_and_non_mapping_facts_raise() -> None:
    with pytest.raises(ValueError, match="kind"):
        write("discharge_summary", {})
    with pytest.raises(ValueError, match="facts"):
        write("visit_brief", ["not", "a", "mapping"])  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# validate_written: the gate an LLM writer's output must pass
# --------------------------------------------------------------------------- #


def _llm_like(
    sentences: list[tuple[str, list[str]]], kind: str = "sae_narrative"
) -> dict[str, Any]:
    return {
        "kind": kind,
        "writer": "llm",
        "sentences": [{"text": t, "evidence_ids": ids} for t, ids in sentences],
        "text": " ".join(t for t, _ in sentences),
    }


def test_validate_accepts_faithful_llm_text() -> None:
    candidate = _llm_like(
        [
            ("Participant P-004, on cemiplimab, went to the emergency room.",
             ["PART-P004", "NOTE-ER-1"]),
            ('The note says "presented to the ED with worsening shortness of breath".',
             ["NOTE-ER-1"]),
            ("Its grade is 3 (provisional, investigator to confirm).", ["NOTE-ER-1"]),
        ]
    )  # fmt: skip
    assert validate_written(candidate, SAE_FACTS) == []


def test_validate_catches_fabricated_ids_and_quotes() -> None:
    candidate = _llm_like(
        [
            ("Participant P-004 was admitted.", ["PART-P004", "NOTE-ER-999"]),
            ("The note says “patient intubated in the ICU”.", ["NOTE-ER-1"]),
        ]
    )
    problems = validate_written(candidate, SAE_FACTS)
    assert "sentence 1: evidence id 'NOTE-ER-999' is not in the facts" in problems
    assert any("quoted text 'patient intubated in the ICU'" in p for p in problems)
    assert len(problems) == 2


def test_validate_catches_structure_and_wording_problems() -> None:
    candidate = {
        "kind": "discharge_summary",
        "writer": "gpt",
        "sentences": [
            {"text": "   ", "evidence_ids": ["PART-P004"]},
            "not an object",
            {"text": "The outcome is unknown.", "evidence_ids": ["CLOCK-1"]},
            {"text": "We recommend holding cemiplimab.", "evidence_ids": ["STUDY-1"]},
            {"text": "The event was grade 3.", "evidence_ids": ["NOTE-ER-1"]},
            {"text": "This is an AESI.", "evidence_ids": ["NOTE-ER-1"]},
            {"text": "No evidence here.", "evidence_ids": []},
            {"text": "Bad id type.", "evidence_ids": [7]},
        ],
        "text": "something else",
    }
    problems = validate_written(candidate, SAE_FACTS)
    assert "kind 'discharge_summary' is not one of ['sae_narrative', 'aesi_narrative', " \
        "'visit_brief']" in problems  # fmt: skip
    assert "writer 'gpt' is not one of ['template', 'llm']" in problems
    assert "sentence 1: empty sentence" in problems
    assert "sentence 2: expected an object with text and evidence_ids" in problems
    assert any(p.startswith("sentence 3: forbidden wording") for p in problems)
    assert any(p.startswith("sentence 4: forbidden wording") for p in problems)
    assert any(p.startswith("sentence 5: missing 'investigator to confirm'") for p in problems)
    assert any(
        p.startswith("sentence 6: missing 'possible AESI, investigator to confirm'")
        for p in problems
    )
    assert "sentence 7: cites no evidence id" in problems
    assert "sentence 8: evidence id 7 is not in the facts" in problems
    assert "text does not equal the sentences joined in order" in problems


def test_validate_ignores_wording_inside_verbatim_quotes() -> None:
    facts = {"quotes": [{"text": "cause unknown, diagnosis pending", "evidence_ids": ["N-1"]}]}
    candidate = _llm_like([('The note reads: "cause unknown, diagnosis pending".', ["N-1"])])
    assert validate_written(candidate, facts) == []


def test_validate_requires_sentences() -> None:
    assert validate_written(_llm_like([]), SAE_FACTS) == ["there are no sentences"]
    assert "there are no sentences" in validate_written({"kind": "visit_brief"}, SAE_FACTS)


def test_collect_helpers() -> None:
    ids = collect_evidence_ids(BRIEF_FACTS)
    assert ids[0] == "PART-P002"
    assert "DRAFT-AE-5" in ids and "VS-SUM-9" in ids
    strings = collect_fact_strings(BRIEF_FACTS)
    assert DISCOURAGED_EXCEPTION in strings
    assert "PART-P002" not in strings
    assert quoted_passages('a "b" c “d”') == ["b", "d"]


# --------------------------------------------------------------------------- #
# Property tests over generated fact bundles
# --------------------------------------------------------------------------- #

_WORDS = st.sampled_from(["alpha", "bravo", "delta", "echo", "kilo", "lima", "oscar", "tango"])
_TEXT = st.lists(_WORDS, min_size=1, max_size=3).map(" ".join)
_IDS = st.lists(st.sampled_from([f"EV-{i}" for i in range(10)]), max_size=3)
_DATE = st.dates().map(lambda d: d.isoformat()).filter(lambda s: len(s) == 10)
_STAMP = (
    st.datetimes()
    .map(lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    .filter(lambda s: len(s) == 24)
)
_WHEN = st.one_of(_DATE, _STAMP)


def _text_fact(value: st.SearchStrategy[str] = _TEXT) -> st.SearchStrategy[dict[str, Any]]:
    return st.fixed_dictionaries({"value": value, "evidence_ids": _IDS})


def _optional(**fields: st.SearchStrategy[Any]) -> dict[str, st.SearchStrategy[Any]]:
    return fields


_CONMED = st.fixed_dictionaries(
    {"name": _TEXT, "direction": st.sampled_from(["started", "stopped", "taking", "changed"]),
     "evidence_ids": _IDS},
    optional=_optional(
        date=_WHEN,
        protocol_flag=st.sampled_from(["prohibited", "discouraged", "permitted"]),
        protocol_section=_TEXT,
        printed_page=st.integers(1, 200),
        exception_text=_TEXT,
        missing_fields=st.lists(st.sampled_from(["CMDOSE", "CMINDC", "route"]), max_size=3),
    ),
)  # fmt: skip
_ESCALATION = st.fixed_dictionaries(
    {"tier": st.integers(0, 3), "tier_name": _TEXT, "evidence_ids": _IDS},
    optional=_optional(date=_WHEN, reason=_TEXT, acknowledged=st.booleans(),
                       acknowledged_at=_WHEN),
)  # fmt: skip

SAE_STRATEGY = st.fixed_dictionaries(
    {},
    optional=_optional(
        participant=_text_fact(),
        study_id=_text_fact(),
        study_drug=_text_fact(),
        last_dose=_text_fact(_WHEN),
        event=st.fixed_dictionaries({"term": _TEXT, "plain_label": _TEXT, "evidence_ids": _IDS}),
        onset=_text_fact(_WHEN),
        quotes=st.lists(
            st.fixed_dictionaries({"text": _TEXT, "evidence_ids": _IDS},
                                  optional=_optional(source_label=_TEXT)),
            max_size=2,
        ),
        provisional_grade=st.fixed_dictionaries(
            {"grade": st.integers(0, 3), "evidence_ids": _IDS}
        ),
        site_awareness_at=_text_fact(_WHEN),
        awareness_source=_text_fact(),
        seriousness_criteria=st.lists(_text_fact(), max_size=2),
        aesi_reasons=st.lists(_text_fact(), max_size=2),
        deadline=st.fixed_dictionaries(
            {"due_at": _WHEN, "evidence_ids": _IDS},
            optional=_optional(hours=st.integers(1, 48), protocol_section=_TEXT,
                               printed_page=st.integers(1, 200)),
        ),
        conmeds=st.lists(_CONMED, max_size=3),
        escalation=_ESCALATION,
        action_taken=_text_fact(),
        outcome=_text_fact(),
        causality=_text_fact(),
        reporter_role=_text_fact(),
        missing_information=st.lists(_text_fact(), max_size=3),
    ),
)  # fmt: skip

BRIEF_STRATEGY = st.fixed_dictionaries(
    {},
    optional=_optional(
        participant=_text_fact(),
        since=_text_fact(_WHEN),
        next_visit=_text_fact(_WHEN),
        new_side_effects=st.lists(
            st.fixed_dictionaries(
                {"term": _TEXT, "plain_label": _TEXT, "evidence_ids": _IDS},
                optional=_optional(grades=st.lists(
                    st.fixed_dictionaries({"grade": st.integers(0, 3), "evidence_ids": _IDS},
                                          optional=_optional(date=_WHEN)),
                    max_size=3,
                )),
            ),
            max_size=2,
        ),
        open_aes=st.lists(
            st.fixed_dictionaries(
                {"term": _TEXT, "plain_label": _TEXT, "evidence_ids": _IDS},
                optional=_optional(onset=_WHEN, last_reported=_WHEN, ongoing=st.booleans()),
            ),
            max_size=2,
        ),
        med_changes=st.lists(_CONMED, max_size=2),
        escalations=st.lists(_ESCALATION, max_size=2),
        clocks=st.lists(
            st.fixed_dictionaries(
                {"kind": st.sampled_from(["sae", "aesi"]), "event_label": _TEXT, "due_at": _WHEN,
                 "evidence_ids": _IDS},
                optional=_optional(hours=st.integers(1, 48), status=st.sampled_from(
                    ["running", "reported (mock)", "stopped"])),
            ),
            max_size=2,
        ),
        notes=st.lists(
            st.fixed_dictionaries(
                {"note_type": _TEXT, "evidence_ids": _IDS},
                optional=_optional(note_date=_WHEN, author=_TEXT, n_symptoms=st.integers(0, 5),
                                   n_meds=st.integers(0, 5)),
            ),
            max_size=2,
        ),
        vitals=st.fixed_dictionaries(
            {"is_measured": st.booleans(), "source": _TEXT, "evidence_ids": _IDS},
            optional=_optional(pulse_median=st.floats(30, 200), breathing_median=st.integers(5, 45),
                               date=_WHEN),
        ),
        missing_information=st.lists(_text_fact(), max_size=2),
    ),
)  # fmt: skip

PROPERTY_SETTINGS = settings(
    max_examples=150, deadline=None, suppress_health_check=[HealthCheck.too_slow]
)


def _check_invariants(kind: str, facts: dict[str, Any]) -> None:
    written = write(kind, facts)
    known = set(collect_evidence_ids(facts))
    for sentence in written.sentences:
        assert sentence.evidence_ids, sentence.text
        assert set(sentence.evidence_ids) <= known
        assert sentence.text.strip()
        for token in ("{", "}", "None", "unknown"):
            assert token not in sentence.text
    assert written.text == " ".join(s.text for s in written.sentences)
    assert write(kind, copy.deepcopy(facts)) == written
    if written.sentences:
        assert validate_written(written, facts) == []


@PROPERTY_SETTINGS
@given(SAE_STRATEGY, st.sampled_from(["sae_narrative", "aesi_narrative"]))
def test_property_sae_sentences_cite_facts(facts: dict[str, Any], kind: str) -> None:
    _check_invariants(kind, facts)


@PROPERTY_SETTINGS
@given(BRIEF_STRATEGY)
def test_property_brief_sentences_cite_facts(facts: dict[str, Any]) -> None:
    _check_invariants("visit_brief", facts)


@PROPERTY_SETTINGS
@given(SAE_STRATEGY, st.data())
def test_property_removing_a_fact_never_adds_its_ids(facts: dict[str, Any], data: Any) -> None:
    """Dropping one top-level fact can only remove citations of ids that fact alone carried."""
    if not facts:
        return
    key = data.draw(st.sampled_from(sorted(facts)))
    reduced = _without(facts, key)
    cited = {i for s in write("sae_narrative", reduced).sentences for i in s.evidence_ids}
    assert cited <= set(collect_evidence_ids(reduced))


# --------------------------------------------------------------------------- #
# The template table
# --------------------------------------------------------------------------- #


def test_table_has_provenance_and_protocol_refs() -> None:
    assert NARRATIVE_TABLE_NAMES == ("narrative_templates",)
    raw = load_table("narrative_templates")
    assert raw["source"].strip() and raw["rationale"].strip()
    assert (data_dir() / "narrative_templates.json").is_file()
    refs = [
        s["protocol_ref"]
        for kind in raw["kinds"].values()
        for s in kind.get("sentences", [])
        if "protocol_ref" in s
    ]
    assert {"section": "9.4.2", "printed_page": 91} in refs
    assert {"section": "9.4.3", "printed_page": 92} in refs
    assert raw["kinds"]["aesi_narrative"]["protocol_ref"] == {"section": "9.4.3",
                                                              "printed_page": 92}  # fmt: skip


def _slot_names(kind: str) -> set[str]:
    """Every slot name a maximal bundle can produce for ``kind`` (with list aliases)."""
    tpl = narrative_templates()
    spec = tpl.kinds[kind]
    if spec.facts_kind is None:
        maximal_brief = {**BRIEF_FACTS, "missing_information": SAE_FACTS["missing_information"]}
        scope, lists = narrative._brief_context(maximal_brief, tpl)
    else:
        maximal = copy.deepcopy(SAE_FACTS)
        maximal.update(
            kind=spec.facts_kind,
            aesi_reasons=AESI_FACTS["aesi_reasons"],
            action_taken={"value": "x", "evidence_ids": ["X"]},
            outcome={"value": "x", "evidence_ids": ["X"]},
            causality={"value": "x", "evidence_ids": ["X"]},
        )
        maximal["escalation"]["reason"] = "x"
        scope, lists = narrative._sae_context(maximal, spec.facts_kind, tpl)
    names = set(scope.slots)
    for sentence in spec.sentences:
        if sentence.for_each and sentence.alias:
            for element in lists.get(sentence.for_each, ((), 0))[0]:
                names |= {f"{sentence.alias}.{n}" for n in element.slots}
    return names


@pytest.mark.parametrize("kind", KINDS)
def test_every_placeholder_is_a_slot_the_writer_fills(kind: str) -> None:
    names = _slot_names(kind)
    spec = narrative_templates().kinds[kind]
    for sentence in spec.sentences:
        for variant in (*sentence.variants, *sentence.if_empty):
            missing = set(variant.slot_names) - names
            assert not missing, f"{kind}.{sentence.id}: {missing}"


def test_fragment_placeholders_are_known() -> None:
    allowed = {
        "grade_point": {"grade", "date"},
        "conmed_action": {"verb", "name", "date"},
        "conmed_protocol": {"section", "page", "exception"},
        "acknowledgement": {"acked_at"},
    }
    for name, variants in narrative_templates().fragments.items():
        for variant in variants:
            assert set(variant.slot_names) <= allowed[name], name


def test_render_skips_variants_without_evidence() -> None:
    scope = Scope({"a": Slot("x", ())}, {})
    variants = (Variant("{a}", (), ()),)
    assert render(variants, scope, require_evidence=True) is None
    assert render(variants, scope, require_evidence=False) == Slot("x", ())
    assert PLACEHOLDER.findall("{a} {b.c} {D}") == ["a", "b.c"]


def _raw_table() -> dict[str, Any]:
    return copy.deepcopy(load_table("narrative_templates"))


def _mutations() -> list[tuple[str, Any]]:
    def drop_formats(t: dict[str, Any]) -> None:
        del t["formats"]

    def bad_placeholder(t: dict[str, Any]) -> None:
        t["kinds"]["sae_narrative"]["sentences"][0]["variants"][0]["template"] = "{Bad Slot}"

    def unknown_section(t: dict[str, Any]) -> None:
        t["kinds"]["visit_brief"]["sentences"][0]["section"] = "nowhere"

    def for_each_without_as(t: dict[str, Any]) -> None:
        del t["kinds"]["visit_brief"]["sentences"][2]["as"]

    def bad_regex(t: dict[str, Any]) -> None:
        t["validation"]["forbidden_patterns"][0]["pattern"] = "("

    def no_variants(t: dict[str, Any]) -> None:
        t["kinds"]["sae_narrative"]["sentences"][0]["variants"] = []

    def variants_not_list(t: dict[str, Any]) -> None:
        t["fragments"]["grade_point"] = "grade {grade}"

    def empty_template(t: dict[str, Any]) -> None:
        t["fragments"]["grade_point"][0]["template"] = ""

    def missing_kind(t: dict[str, Any]) -> None:
        del t["kinds"]["visit_brief"]

    def missing_label_group(t: dict[str, Any]) -> None:
        del t["labels"]["trend"]

    def qualifier_without_must(t: dict[str, Any]) -> None:
        del t["validation"]["qualifiers"][0]["must_contain"]

    return [
        ("formats", drop_formats),
        ("malformed placeholder", bad_placeholder),
        ("is not in 'sections'", unknown_section),
        ("'for_each' and 'as' go together", for_each_without_as),
        ("forbidden_patterns[0].pattern", bad_regex),
        ("needs at least one variant", no_variants),
        ("fragments.grade_point: expected list", variants_not_list),
        ("expected non-empty string", empty_template),
        ("kinds.visit_brief", missing_kind),
        ("labels.trend", missing_label_group),
        ("must_contain", qualifier_without_must),
    ]


@pytest.mark.parametrize(("message", "mutate"), _mutations())
def test_malformed_table_is_rejected(message: str, mutate: Any) -> None:
    raw = _raw_table()
    mutate(raw)
    with pytest.raises(TableError, match=re.escape(message)):
        parse_templates(raw)


def test_shipped_table_parses_with_every_kind() -> None:
    parsed = parse_templates(_raw_table())
    assert tuple(parsed.kinds) == KINDS
    assert parsed.kinds["aesi_narrative"].sentences == parsed.kinds["sae_narrative"].sentences
    assert parsed.kinds["aesi_narrative"].facts_kind == "aesi"
    assert parsed.kinds["visit_brief"].facts_kind is None


# --------------------------------------------------------------------------- #
# Integration fixes (stage 1): source-bound quotes, decision words, punctuation
# --------------------------------------------------------------------------- #


def test_validate_rejects_a_quote_attributed_to_the_wrong_source() -> None:
    facts: dict[str, Any] = {
        "quotes": [
            {"text": "feeling itchy all week", "evidence_ids": ["ev_free"]},
            {"text": "pt reports rash on arms", "evidence_ids": ["ev_note"]},
        ]
    }
    wrong = _llm_like([('The kiosk answer said "pt reports rash on arms".', ["ev_free"])])
    problems = validate_written(wrong, facts)
    assert problems == [
        "sentence 1: quoted text 'pt reports rash on arms' does not appear in the facts it cites"
    ]
    right = _llm_like([('The ER note said "pt reports rash on arms".', ["ev_note"])])
    assert validate_written(right, facts) == []
    both = _llm_like([('The records say "pt reports rash on arms".', ["ev_free", "ev_note"])])
    assert validate_written(both, facts) == []


def test_strings_by_evidence_id_maps_each_id_to_its_own_fact() -> None:
    by_id = strings_by_evidence_id(SAE_FACTS)
    assert "presented to the ED with worsening shortness of breath" in by_id["NOTE-ER-1"]
    assert "presented to the ED with worsening shortness of breath" not in by_id["STUDY-1"]
    assert by_id["PART-P004"] == ("P-004",)
    assert "PART-P004" not in by_id["PART-P004"]


def test_validate_requires_qualifier_on_short_grades_and_decision_words() -> None:
    candidate = _llm_like(
        [
            ("Pruritus G3, serious and related to cemiplimab.", ["NOTE-ER-1"]),
            ("Shortness of breath at CTCAE 3.", ["NOTE-ER-1"]),
            ("The event was life-threatening.", ["NOTE-ER-1"]),
            ("The event was caused by the study drug.", ["NOTE-ER-1"]),
            ("This event is serious.", ["NOTE-ER-1"]),
        ]
    )
    problems = validate_written(candidate, SAE_FACTS)
    assert any(p.startswith("sentence 1: missing 'investigator to confirm'") for p in problems)
    assert any(p.startswith("sentence 1: missing 'investigator'") for p in problems)
    assert any(p.startswith("sentence 2: missing 'investigator to confirm'") for p in problems)
    for n in (3, 4, 5):
        assert any(p.startswith(f"sentence {n}: missing 'investigator'") for p in problems)
    accepted = _llm_like(
        [
            ("Shortness of breath G3 (provisional, investigator to confirm).", ["NOTE-ER-1"]),
            ("The investigator assessed it as related to cemiplimab.", ["NOTE-ER-1"]),
            ("Suspected serious: it was serious per the note (investigator to confirm).",
             ["NOTE-ER-1"]),
        ]
    )  # fmt: skip
    assert validate_written(accepted, SAE_FACTS) == []


def test_validate_checks_single_quoted_passages_but_not_apostrophes() -> None:
    fabricated = _llm_like([("The note says 'patient intubated'.", ["NOTE-ER-1"])])
    assert any(
        "quoted text 'patient intubated'" in p for p in validate_written(fabricated, SAE_FACTS)
    )
    curly = _llm_like([("The note says \u2018patient intubated\u2019.", ["NOTE-ER-1"])])
    assert any("patient intubated" in p for p in validate_written(curly, SAE_FACTS))
    verbatim = _llm_like(
        [("The note says 'presented to the ED with worsening shortness of breath'.",
          ["NOTE-ER-1"])]
    )  # fmt: skip
    assert validate_written(verbatim, SAE_FACTS) == []
    apostrophes = _llm_like([("The participant's note and the nurses' log.", ["NOTE-ER-1"])])
    assert validate_written(apostrophes, SAE_FACTS) == []
    assert quoted_passages("it's 'a' and \u2018b\u2019") == ["a", "b"]


def test_quote_ending_in_a_period_does_not_double_the_stop() -> None:
    exception = DISCOURAGED_EXCEPTION + "."
    facts: dict[str, Any] = {
        "participant": {"value": "P-002", "evidence_ids": ["PART-P002"]},
        "med_changes": [
            {"name": "prednisone", "direction": "started", "protocol_flag": "discouraged",
             "exception_text": exception, "evidence_ids": ["CM-4"]},
        ],
    }  # fmt: skip
    written = write("visit_brief", facts)
    text = next(s.text for s in written.sentences if s.section == "med_changes")
    assert text.endswith('to treat an irAE."')
    assert '.".' not in written.text
    assert validate_written(written, facts) == []
    sae = {**SAE_FACTS, "quotes": [{"text": "Short of breath.", "evidence_ids": ["NOTE-ER-1"]}]}
    sae_written = write("sae_narrative", sae)
    assert any(s.text.endswith('"Short of breath."') for s in sae_written.sentences)
    assert '.".' not in sae_written.text


def test_quote_in_a_sentence_without_an_id_list_is_unverifiable() -> None:
    candidate = _llm_like([])
    candidate["sentences"] = [{"text": 'The note says "P-004".', "evidence_ids": "PART-P004"}]
    candidate["text"] = 'The note says "P-004".'
    problems = validate_written(candidate, SAE_FACTS)
    assert problems == [
        "sentence 1: cites no evidence id",
        "sentence 1: quoted text 'P-004' does not appear in the facts it cites",
    ]
