"""Escalation ladder arithmetic and the SAE clock."""

from __future__ import annotations

import dataclasses

import pytest
from helpers import T0, gates, rule_ids, run

from interim_rules import escalation
from interim_rules.escalation import compute_tier
from interim_rules.seriousness import assess_seriousness, build_clock
from interim_rules.tables import vitals_config
from interim_rules.timefmt import shift

STOP_SCREEN_TEXT = (
    "Thank you. A member of the study team will contact you today. If you feel you need "
    "urgent help right now, call 911 or go to the nearest emergency room."
)


@pytest.mark.parametrize(
    ("max_grade", "floor", "bump", "expected"),
    [
        (0, 0, 0, 0),
        (1, 0, 0, 0),
        (2, 0, 0, 1),
        (3, 0, 0, 2),
        (0, 2, 0, 2),
        (2, 3, 0, 3),
        (2, 0, 1, 2),
        (3, 0, 1, 3),
        (3, 3, 1, 3),
        (0, 0, 1, 1),
    ],
)
def test_tier_algorithm(max_grade: int, floor: int, bump: int, expected: int) -> None:
    outcome = compute_tier(
        max_grade=max_grade,
        grade_rule_ids=["grade.provisional.cough"] if max_grade else [],
        red_flag_floor=floor,
        red_flag_rule_ids=["redflag.hospitalization"] if floor else [],
        corroboration_bump=bump,
        corroboration_rule_ids=["corr.tachypnea_dyspnea"] if bump else [],
    )
    assert outcome.final_tier == expected
    assert outcome.stop_screen == outcome.page_oncall == (expected == 3)
    ids = [r.rule_id for r in outcome.rules_fired]
    assert ids[0] == "tier.base" and ids[-1] == "tier.final"
    assert ("tier.redflag_floor" in ids) == (floor > outcome.base_tier)
    assert ("tier.corroboration_bump" in ids) == (bump == 1)
    assert outcome.stop_screen_text == (STOP_SCREEN_TEXT if expected == 3 else None)


def test_tier_rules_explain_themselves() -> None:
    outcome = compute_tier(
        max_grade=2,
        grade_rule_ids=["grade.provisional.shortness_of_breath"],
        red_flag_floor=2,
        red_flag_rule_ids=["redflag.fever_with_severe"],
        corroboration_bump=1,
        corroboration_rule_ids=["corr.tachycardia_fever"],
    )
    base, floor, bump, final = outcome.rules_fired
    assert base.description == "Base tier 1 from highest provisional grade 2"
    assert floor.description == "Red-flag floor 2 raises tier 1 -> 2"
    assert bump.effect == "tier +1 (2 -> 3)"
    assert final.inputs["name"] == "Urgent" and "paged" in final.effect
    assert {e.id for e in final.evidence if e.kind == "rule"} == {
        "tier.base",
        "tier.redflag_floor",
        "tier.corroboration_bump",
    }


def _tier_with_bump(bump: int) -> escalation.TierOutcome:
    return compute_tier(
        max_grade=0,
        grade_rule_ids=[],
        red_flag_floor=0,
        red_flag_rule_ids=[],
        corroboration_bump=bump,
        corroboration_rule_ids=["corr.tachypnea_dyspnea"],
    )


def test_bump_cap_is_read_from_the_vitals_table_not_hardcoded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The step size is ``vitals_corroboration.json: max_tier_bump``; code carries no literal."""
    table_cap = vitals_config().max_tier_bump
    assert table_cap == 1
    outcome = _tier_with_bump(2)  # a caller asking for more than the table allows
    assert outcome.bump == table_cap and outcome.final_tier == table_cap
    bump_rule = next(r for r in outcome.rules_fired if r.rule_id == "tier.corroboration_bump")
    assert bump_rule.inputs["max_tier_bump"] == table_cap
    assert any(
        e.kind == "table" and e.id == "vitals_corroboration.json" for e in bump_rule.evidence
    )
    # Change the table value and the escalation module follows it without any code change.
    two_step = dataclasses.replace(vitals_config(), max_tier_bump=2)
    monkeypatch.setattr(escalation, "vitals_config", lambda: two_step)
    widened = _tier_with_bump(2)
    assert widened.bump == 2 and widened.final_tier == 2
    assert (
        "adds 2 steps"
        in next(
            r for r in widened.rules_fired if r.rule_id == "tier.corroboration_bump"
        ).description
    )
    assert _tier_with_bump(1).bump == 1  # a smaller request is never inflated


def test_unknown_grade_rejected() -> None:
    with pytest.raises(ValueError):
        compute_tier(
            max_grade=4,
            grade_rule_ids=[],
            red_flag_floor=0,
            red_flag_rule_ids=[],
            corroboration_bump=0,
            corroboration_rule_ids=[],
        )


def test_clock_arithmetic_and_format() -> None:
    clock = build_clock("2026-10-10T18:04:12.345678+00:00")
    assert clock.site_awareness_at == "2026-10-10T18:04:12.345Z"
    assert clock.due_at == "2026-10-11T18:04:12.345Z"
    assert (
        clock.informational["sponsor_fatal_or_life_threatening_due"] == "2026-10-17T18:04:12.345Z"
    )
    assert clock.informational["sponsor_other_serious_due"] == "2026-10-25T18:04:12.345Z"
    assert clock.informational["source"] == "21 CFR 312.32(c)"
    assert "sponsor" in clock.informational["note"]


def test_no_clock_without_hospitalization() -> None:
    outcome = assess_seriousness(gates(), {"hospitalization": "x"}, T0)
    assert not outcome.suspected and outcome.clock is None and outcome.rules_fired == ()


def test_hospitalization_starts_the_clock_in_a_full_run() -> None:
    result = run(gate_answers=gates(hospitalization=True), completed_at="2026-10-10T18:30:00Z")
    assert result.seriousness_suspected
    assert result.sae_clock is not None
    assert result.sae_clock.site_awareness_at == "2026-10-10T18:30:00.000Z"
    assert result.sae_clock.due_at == shift("2026-10-10T18:30:00Z", hours=24)
    assert result.escalation_tier == 3 and result.stop_screen and result.page_oncall
    ids = rule_ids(result)
    assert "sae.clock_started" in ids and "redflag.hospitalization" in ids
    rule = next(r for r in result.rules_fired if r.rule_id == "sae.clock_started")
    assert rule.evidence[0].kind == "gate_answer"
    assert rule.inputs["due_at"] == result.sae_clock.due_at
    assert result.max_grade == 0 and result.drafts == ()  # nothing graded, no vitals, no con-med
