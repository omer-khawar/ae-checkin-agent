"""Red flags and the condition evaluator."""

from __future__ import annotations

import pytest
from helpers import T0, build, gates, rule_ids, run

from interim_rules import conditions
from interim_rules.conditions import ConditionContext, VitalMax
from interim_rules.engine import gate_evidence_ids
from interim_rules.grading import grade_items
from interim_rules.red_flags import evaluate_red_flags
from interim_rules.scoring import score_responses
from interim_rules.tables import TableError, red_flag_table


def _ctx(
    values: dict[str, dict[str, int]] | None = None, **gate_kwargs: object
) -> ConditionContext:
    inp = build(values, gate_answers=gates(**gate_kwargs))  # type: ignore[arg-type]
    results = grade_items(score_responses(inp.responses))
    return ConditionContext(
        items={r.item_id: r for r in results},
        gates=inp.gates,
        gate_ids=gate_evidence_ids(inp),
        vitals_max={},
        severe_item=red_flag_table().severe_item,
    )


def test_no_flags_when_nothing_is_wrong() -> None:
    outcome = evaluate_red_flags(_ctx())
    assert outcome.rules_fired == () and outcome.tier_floor == 0 and not outcome.seriousness


@pytest.mark.parametrize("severity", [3, 4])
def test_severe_dyspnea(severity: int) -> None:
    outcome = evaluate_red_flags(_ctx({"shortness_of_breath": {"severity": severity}}))
    assert [r.rule_id for r in outcome.rules_fired] == ["redflag.severe_dyspnea"]
    assert outcome.tier_floor == 3 and not outcome.seriousness
    rule = outcome.rules_fired[0]
    assert rule.inputs["shortness_of_breath.severity"] == severity
    assert rule.evidence[0].kind == "pro_response"


def test_moderate_dyspnea_is_not_a_red_flag() -> None:
    outcome = evaluate_red_flags(_ctx({"shortness_of_breath": {"severity": 2, "interference": 4}}))
    assert outcome.rules_fired == ()


def test_fever_with_severe_item() -> None:
    ctx = _ctx({"fever_or_chills": {"presence": 1}, "joint_pain": {"severity": 3}})
    outcome = evaluate_red_flags(ctx)
    assert [r.rule_id for r in outcome.rules_fired] == ["redflag.fever_with_severe"]
    assert outcome.tier_floor == 2
    assert outcome.rules_fired[0].inputs["severe_items"] == ["joint_pain"]


def test_fever_alone_or_severe_alone_do_not_fire_fever_rule() -> None:
    assert evaluate_red_flags(_ctx({"fever_or_chills": {"presence": 1}})).rules_fired == ()
    assert evaluate_red_flags(_ctx({"joint_pain": {"severity": 3}})).rules_fired == ()


def test_severe_item_definition_for_items_without_severity() -> None:
    # diarrhea has no severity attribute: severe only when composite == 3 (frequency 4).
    assert (
        evaluate_red_flags(
            _ctx({"fever_or_chills": {"presence": 1}, "diarrhea": {"frequency": 3}})
        ).rules_fired
        == ()
    )
    outcome = evaluate_red_flags(
        _ctx({"fever_or_chills": {"presence": 1}, "diarrhea": {"frequency": 4}})
    )
    assert outcome.rules_fired[0].inputs["severe_items"] == ["diarrhea"]
    assert outcome.rules_fired[0].evidence[1].note.startswith("diarrhea.frequency = 4")


def test_hospitalization() -> None:
    outcome = evaluate_red_flags(_ctx(hospitalization=True))
    assert [r.rule_id for r in outcome.rules_fired] == ["redflag.hospitalization"]
    assert outcome.tier_floor == 3 and outcome.seriousness
    assert outcome.rules_fired[0].evidence[0].kind == "gate_answer"


def test_other_text_with_severe_item_flags_for_human_read() -> None:
    outcome = evaluate_red_flags(
        _ctx({"mouth_sores": {"severity": 3}}, other_text="I feel much worse since Tuesday")
    )
    assert [r.rule_id for r in outcome.rules_fired] == ["redflag.other_text_with_severe"]
    assert outcome.tier_floor == 2
    rule = outcome.rules_fired[0]
    assert "never parsed" in rule.effect
    # The free text itself never appears in the explanation.
    assert "Tuesday" not in rule.description and all("Tuesday" not in e.note for e in rule.evidence)
    assert rule.inputs["other_text_length"] == len("I feel much worse since Tuesday")


def test_other_text_without_severe_item_is_not_a_flag() -> None:
    assert evaluate_red_flags(_ctx(other_text="all good")).rules_fired == ()
    assert (
        evaluate_red_flags(_ctx({"mouth_sores": {"severity": 3}}, other_text="   ")).rules_fired
        == ()
    )


def test_highest_floor_wins_and_all_matching_flags_fire() -> None:
    ctx = _ctx(
        {"shortness_of_breath": {"severity": 4}, "fever_or_chills": {"presence": 1}},
        hospitalization=True,
        other_text="help",
    )
    outcome = evaluate_red_flags(ctx)
    assert [r.rule_id for r in outcome.rules_fired] == [
        "redflag.severe_dyspnea",
        "redflag.fever_with_severe",
        "redflag.hospitalization",
        "redflag.other_text_with_severe",
    ]
    assert outcome.tier_floor == 3 and outcome.seriousness


def test_red_flags_in_full_engine_run() -> None:
    result = run({"shortness_of_breath": {"severity": 3, "interference": 0}})
    assert result.max_grade == 1  # severe but not interfering -> composite 1
    assert result.base_tier == 0 and result.red_flag_tier_floor == 3
    assert result.escalation_tier == 3 and result.stop_screen and result.page_oncall
    assert "tier.redflag_floor" in rule_ids(result)
    assert not result.seriousness_suspected and result.sae_clock is None


# --------------------------------------------------------------------------- #
# Condition evaluator edge cases
# --------------------------------------------------------------------------- #


def test_condition_on_attribute_the_item_does_not_ask_is_false() -> None:
    ctx = _ctx({"diarrhea": {"frequency": 4}})
    outcome = conditions.evaluate(
        {
            "kind": "item_attribute",
            "item": "diarrhea",
            "attribute": "severity",
            "op": ">=",
            "value": 1,
        },
        ctx,
    )
    assert not outcome.matched and outcome.inputs == {"diarrhea.severity": None}


def test_condition_errors() -> None:
    ctx = _ctx()
    with pytest.raises(TableError, match="unknown condition kind"):
        conditions.evaluate({"kind": "nope"}, ctx)
    with pytest.raises(TableError, match="unknown item"):
        conditions.evaluate({"kind": "item_composite", "item": "nope", "op": ">=", "value": 1}, ctx)
    with pytest.raises(TableError, match="unknown attribute"):
        conditions.evaluate(
            {"kind": "item_attribute", "item": "cough", "attribute": "x", "op": ">=", "value": 1},
            ctx,
        )
    with pytest.raises(TableError, match="operator"):
        conditions.evaluate({"kind": "item_composite", "item": "cough", "op": "~", "value": 1}, ctx)
    with pytest.raises(TableError, match="unknown field"):
        conditions.evaluate({"kind": "gate_bool", "field": "x", "equals": True}, ctx)
    with pytest.raises(TableError, match="unknown field"):
        conditions.evaluate({"kind": "gate_text_nonempty", "field": "x"}, ctx)


def test_vital_condition_with_and_without_a_maximum() -> None:
    ctx = _ctx()
    cond = {"kind": "vital", "metric": "breathing", "op": ">=", "value": 24}
    missing = conditions.evaluate(cond, ctx)
    assert not missing.matched and missing.inputs["breathing_max"] is None
    with_max = ConditionContext(
        items=ctx.items,
        gates=ctx.gates,
        gate_ids=ctx.gate_ids,
        vitals_max={"breathing": VitalMax(26.0, "s1", T0)},
        severe_item=ctx.severe_item,
    )
    hit = conditions.evaluate(cond, with_max)
    assert hit.matched and hit.inputs["breathing_max"] == 26.0
    assert hit.evidence[0].kind == "vitals_sample" and hit.evidence[0].id == "s1"
    hrv = conditions.evaluate(
        {"kind": "vital", "metric": "hrv", "op": ">=", "value": 1},
        ConditionContext(
            ctx.items, ctx.gates, ctx.gate_ids, {"hrv": VitalMax(30.0, "s2", T0)}, ctx.severe_item
        ),
    )
    assert hit.matched and hrv.evidence[0].note.endswith("= 30.0")


def test_all_combinator_collects_evidence_and_inputs() -> None:
    ctx = _ctx({"cough": {"severity": 2}}, conmed_changed=True, conmed_text="x")
    outcome = conditions.evaluate(
        {
            "all": [
                {"kind": "item_composite", "item": "cough", "op": ">=", "value": 1},
                {"kind": "gate_bool", "field": "conmed_changed", "equals": True},
                {"kind": "gate_text_nonempty", "field": "conmed_text"},
            ]
        },
        ctx,
    )
    assert outcome.matched
    assert {e.kind for e in outcome.evidence} == {"pro_response", "gate_answer"}
    assert outcome.inputs["cough.composite"] == 1 and outcome.inputs["conmed_changed"] is True
    assert outcome.inputs["conmed_text_present"] is True
