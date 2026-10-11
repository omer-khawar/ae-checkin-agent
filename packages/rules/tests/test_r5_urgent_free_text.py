"""CONTRACTS.md R5.1 / R5.2: the urgent path, the comment box is read, several medications."""

from __future__ import annotations

import dataclasses

import pytest
from helpers import (
    SESSION,
    T0,
    build,
    drafts,
    gates,
    grades,
    response,
    rule_ids,
    run,
)

from interim_rules import chartscan
from interim_rules.conmed import conmed_entries, split_conmed_text
from interim_rules.engine import evaluate_checkin
from interim_rules.free_text import assess_free_text
from interim_rules.models import ConMedEntry
from interim_rules.serialize import input_from_dict, input_to_dict
from interim_rules.timefmt import shift

TIGHT = "He says his chest feels tight and he can't catch his breath RIGHT NOW"


def fields(draft: object) -> dict[str, object]:
    return {f.name: f.value for f in draft.fields}  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- R5.1 urgent_now


def test_urgent_now_gate_is_a_tier_three_red_flag() -> None:
    g = dataclasses.replace(gates(), urgent_now=True)
    result = run(gate_answers=g)
    assert result.escalation_tier == 3
    assert result.stop_screen and result.page_oncall
    assert result.red_flag_tier_floor == 3
    assert "redflag.urgent_now" in rule_ids(result)
    assert "redflag.ended_early" not in rule_ids(result)
    # Urgent symptoms are not a seriousness trigger by themselves.
    assert result.sae_clock is None and not result.seriousness_suspected


def test_urgent_now_no_changes_nothing() -> None:
    g = dataclasses.replace(gates(), urgent_now=False)
    result = run(gate_answers=g)
    assert result.escalation_tier == 0
    assert "redflag.urgent_now" not in rule_ids(result)


def test_urgent_now_rule_cites_the_gate_answer() -> None:
    g = dataclasses.replace(gates(), urgent_now=True, urgent_now_answer_id="ANS-URGENT")
    result = run(gate_answers=g)
    rule = next(r for r in result.rules_fired if r.rule_id == "redflag.urgent_now")
    assert any(e.kind == "gate_answer" and e.id == "ANS-URGENT" for e in rule.evidence)
    assert rule.inputs["tier_floor"] == 3


# --------------------------------------------------------------------------- R5.1 early stop


def test_ended_early_forces_tier_three_and_names_the_trigger() -> None:
    inp = dataclasses.replace(
        build(responses=[response("shortness_of_breath", "severity", 3)]),
        ended_early="severe_dyspnea",
    )
    result = evaluate_checkin(inp)
    assert result.escalation_tier == 3 and result.stop_screen and result.page_oncall
    assert result.ended_early == "severe_dyspnea"
    rule = next(r for r in result.rules_fired if r.rule_id == "redflag.ended_early")
    assert rule.inputs["ended_early"] == "severe_dyspnea"
    assert "severe_dyspnea" in rule.description
    assert "redflag.severe_dyspnea" in rule_ids(result)


def test_ended_early_with_no_answers_is_still_tier_three_and_grades_nothing() -> None:
    inp = dataclasses.replace(
        build(responses=[], gate_answers=dataclasses.replace(gates(), urgent_now=True)),
        ended_early="urgent_now",
    )
    result = evaluate_checkin(inp)
    assert result.escalation_tier == 3
    assert {"redflag.urgent_now", "redflag.ended_early"} <= set(rule_ids(result))
    # Unanswered items are "not reported": no grade, no AE draft, never an invented symptom.
    assert set(grades(result).values()) == {0}
    assert drafts(result, "AE") == []
    assert result.max_grade == 0


def test_ended_early_none_does_not_fire() -> None:
    assert "redflag.ended_early" not in rule_ids(run())


def test_ended_early_round_trips_through_the_input_dict() -> None:
    inp = dataclasses.replace(build(), ended_early="urgent_now")
    again = input_from_dict(input_to_dict(inp))
    assert again.ended_early == "urgent_now"
    assert again.gates.urgent_now is False and again.gates.conmeds == ()


# --------------------------------------------------------------------------- R5.2 free text


def test_scanner_reads_the_playtest_phrasings_as_emergency() -> None:
    scan = chartscan.scan_text(TIGHT, None, detect_human_request=True)
    categories = {f.category for f in scan.red_flags}
    assert {"chest_pain", "cannot_breathe"} <= categories
    assert chartscan.escalation_level(scan, "utterance") == "emergency"


@pytest.mark.parametrize(
    ("text", "category"),
    [
        ("I can't breathe", "cannot_breathe"),
        ("she cannot breathe at all", "cannot_breathe"),
        ("I can't catch my breath", "cannot_breathe"),
        ("he can’t catch his breath", "cannot_breathe"),
        ("she can't catch her breath", "cannot_breathe"),
        ("trouble breathing right now", "cannot_breathe"),
        ("my chest feels tight", "chest_pain"),
        ("chest feels heavy", "chest_pain"),
        ("some chest tightness", "chest_pain"),
        ("his chest is really tight", "chest_pain"),
    ],
)
def test_participant_phrasings_are_emergency_red_flags(text: str, category: str) -> None:
    scan = chartscan.scan_text(text, None, detect_human_request=True)
    assert category in {f.category for f in scan.red_flags}, text
    assert chartscan.escalation_level(scan, "utterance") == "emergency"


@pytest.mark.parametrize(
    "text",
    [
        "no chest pain",
        "denies chest tightness",
        "I can catch my breath fine",
        "my chest feels fine",
    ],
)
def test_negated_or_benign_phrasings_do_not_fire(text: str) -> None:
    scan = chartscan.scan_text(text, None, detect_human_request=True)
    assert scan.red_flags == (), text


def test_free_text_red_flag_raises_floor_to_three_with_a_quote() -> None:
    result = run(gate_answers=gates(other_text=TIGHT))
    assert result.escalation_tier == 3 and result.stop_screen
    assert result.red_flag_tier_floor == 3
    rule = next(r for r in result.rules_fired if r.rule_id == "redflag.free_text")
    assert rule.category == "red_flag"
    quotes = rule.inputs["quotes"]
    assert isinstance(quotes, list) and any("tight" in q for q in quotes)
    assert any(
        e.kind == "gate_answer" and e.id == f"{SESSION}:gate_other" and "tight" in e.note
        for e in rule.evidence
    )
    # The tier ladder explains the floor.
    assert "tier.redflag_floor" in rule_ids(result)


def test_free_text_without_a_phrase_changes_nothing() -> None:
    result = run(gate_answers=gates(other_text="I would like a parking pass for the next visit"))
    assert result.escalation_tier == 0
    assert "redflag.free_text" not in rule_ids(result)
    assert "redflag.free_text_human_request" not in rule_ids(result)


def test_free_text_human_request_raises_floor_to_two() -> None:
    outcome = assess_free_text(gates(other_text="I want to talk to a person"), "gate")
    assert outcome.human_requested
    assert outcome.tier_floor == 2
    assert [r.rule_id for r in outcome.rules_fired] == ["redflag.free_text_human_request"]
    assert outcome.rules_fired[0].inputs["tier_floor"] == 2
    result = run(gate_answers=gates(other_text="I want to talk to a person"))
    assert result.escalation_tier == 2
    assert "redflag.free_text_human_request" in rule_ids(result)


def test_free_text_never_lowers_the_tier() -> None:
    values = {"shortness_of_breath": {"severity": 3, "interference": 3}}
    base = run(values)
    with_text = run(values, gate_answers=gates(other_text="all good, thanks"))
    assert with_text.escalation_tier >= base.escalation_tier == 3


def test_hospital_mention_conflicting_with_a_no_starts_the_sae_clock() -> None:
    text = "I went to the ER on Sunday night for the vomiting"
    result = run(gate_answers=gates(hospitalization=False, other_text=text))
    assert result.seriousness_suspected
    assert result.sae_clock is not None and result.sae_clock.kind == "sae"
    assert result.sae_clock.due_at == shift(T0, hours=24)
    assert result.escalation_tier == 3
    clock_rule = next(r for r in result.rules_fired if r.rule_id == "sae.clock_started")
    assert clock_rule.inputs["triggers"] == ["other_text"]
    flag = next(r for r in result.rules_fired if r.rule_id == "redflag.free_text")
    assert "conflicts with the No answer" in flag.description
    assert flag.inputs["hospital_conflict"] is True


def test_hospital_mention_with_a_yes_gate_is_not_a_conflict() -> None:
    text = "I went to the ER on Sunday night"
    result = run(gate_answers=gates(hospitalization=True, other_text=text))
    flag = next(r for r in result.rules_fired if r.rule_id == "redflag.free_text")
    assert flag.inputs["hospital_conflict"] is False
    assert "conflicts" not in flag.description
    # One clock, from the gate, not a second one from the text.
    assert [r.rule_id for r in result.rules_fired].count("sae.clock_started") == 1


def test_empty_free_text_is_ignored() -> None:
    outcome = assess_free_text(gates(other_text="   "), "gate")
    assert outcome.tier_floor == 0 and outcome.rules_fired == ()


# --------------------------------------------------------------------------- R5.2 medications


@pytest.mark.parametrize(
    ("text", "pieces"),
    [
        ("tylenol", ["tylenol"]),
        ("aspirin, ibuprofen", ["aspirin", "ibuprofen"]),
        ("aspirin; ibuprofen", ["aspirin", "ibuprofen"]),
        ("aspirin and ibuprofen", ["aspirin", "ibuprofen"]),
        ("aspirin AND ibuprofen", ["aspirin", "ibuprofen"]),
        ("aspirin & ibuprofen", ["aspirin", "ibuprofen"]),
        ("aspirin + ibuprofen", ["aspirin", "ibuprofen"]),
        ("a, b; c and d", ["a", "b", "c", "d"]),
        ("Vitamin D3 1000 IU", ["Vitamin D3 1000 IU"]),
        ("  , ; ", ["  , ; "]),
    ],
)
def test_split_conmed_text(text: str, pieces: list[str]) -> None:
    assert split_conmed_text(text) == pieces


def test_split_caps_the_number_of_entries() -> None:
    pieces = split_conmed_text(", ".join(f"drug{i}" for i in range(14)))
    assert len(pieces) == 10 and pieces[0] == "drug0"
    assert pieces[-1].startswith("drug9")


def test_conmed_entries_prefers_the_explicit_list() -> None:
    listed = (ConMedEntry("aspirin and ibuprofen", "started", "A1"),)
    g = dataclasses.replace(
        gates(conmed_changed=True, conmed_text="x, y", conmed_direction="stopped"), conmeds=listed
    )
    assert conmed_entries(g) == listed  # the list is the source of truth and is not split again
    assert conmed_entries(gates()) == ()


def test_two_medicines_in_one_box_are_two_cm_drafts() -> None:
    g = gates(
        conmed_changed=True,
        conmed_text="cefalexin antibiotic pill and hydrocortisone cream from urgent care",
        conmed_direction="started",
    )
    result = run(gate_answers=g)
    cms = drafts(result, "CM")
    assert [fields(d)["CMDECOD"] for d in cms] == ["cephalexin", "hydrocortisone"]
    assert [fields(d)["CMTRT"] for d in cms] == [
        "cefalexin antibiotic pill",
        "hydrocortisone cream from urgent care",
    ]
    assert [fields(d)["CMSEQ"] for d in cms] == [1, 2]
    assert all(fields(d)["INTERIM_DIRECTION"] == "started" for d in cms)
    assert len(result.conmeds) == 2
    assert result.conmed is not None and result.conmed.matched_name == "cephalexin"
    assert [r.rule_id for r in result.rules_fired].count("draft.cm") == 2
    # The evidence of every CM field still points at the one gate answer.
    for d in cms:
        trt = next(f for f in d.fields if f.name == "CMTRT")
        assert any(e.id == f"{SESSION}:gate_conmed" for e in trt.evidence)


def test_conmeds_list_matches_each_entry_with_its_own_direction_and_evidence() -> None:
    g = dataclasses.replace(
        gates(conmed_changed=True),
        conmeds=(
            ConMedEntry("loratadine", "started", "ANS-1"),
            ConMedEntry("prednisone", "stopped", "ANS-2"),
        ),
    )
    result = run(gate_answers=g)
    first, second = drafts(result, "CM")
    assert fields(first)["CMDECOD"] == "loratadine"
    assert fields(first)["INTERIM_DIRECTION"] == "started"
    assert fields(second)["INTERIM_DIRECTION"] == "stopped"
    assert fields(first)["CMSTDTC"] is not None and fields(first)["CMENDTC"] is None
    assert fields(second)["CMENDTC"] is not None and fields(second)["CMSTDTC"] is None
    trt = next(f for f in second.fields if f.name == "CMTRT")
    assert any(e.id == "ANS-2" for e in trt.evidence)
    # Prednisone is discouraged by the protocol: the flag follows the entry that named it.
    assert fields(second)["INTERIM_PROTOCOL_FLAG"] == "discouraged"
    assert fields(first)["INTERIM_PROTOCOL_FLAG"] is None
    assert result.protocol is not None and result.protocol.conmed_flag == "discouraged"


def test_a_prohibited_medicine_in_a_list_still_floors_the_tier() -> None:
    g = dataclasses.replace(
        gates(conmed_changed=True),
        conmeds=(
            ConMedEntry("loratadine", "started", "ANS-1"),
            ConMedEntry("bevacizumab", "started", "ANS-2"),
        ),
    )
    result = run(gate_answers=g)
    assert result.escalation_tier == 2 and result.protocol_tier_floor == 2
    assert "tier.protocol_floor" in rule_ids(result)


def test_conmeds_round_trip_through_the_input_dict() -> None:
    g = dataclasses.replace(
        gates(conmed_changed=True),
        conmeds=(ConMedEntry("loratadine", "started", "ANS-1"),),
    )
    inp = build(gate_answers=g)
    again = input_from_dict(input_to_dict(inp))
    assert again.gates.conmeds == g.conmeds
    assert again == inp
