"""Red-flag rules (CLAUDE.md §3.4(c)).

Red flags bypass grading: each one that matches sets a floor on the escalation
tier (the highest floor wins) and may mark seriousness as suspected. The rules
and their thresholds are data in ``data/red_flags.json``; this module evaluates
them through :mod:`interim_rules.conditions`.
"""

from __future__ import annotations

from dataclasses import dataclass

from .conditions import ConditionContext, evaluate
from .evidence import table_evidence
from .models import RuleFired
from .tables import red_flag_table

RED_FLAG_TABLE_FILE = "red_flags.json"


@dataclass(frozen=True)
class RedFlagOutcome:
    rules_fired: tuple[RuleFired, ...]
    tier_floor: int
    seriousness: bool
    """True when a fired red flag is marked ``seriousness`` in the table (hospitalization)."""


def _format_inputs(inputs: dict[str, object]) -> str:
    return ", ".join(f"{k} = {v}" for k, v in inputs.items() if not k.endswith(".threshold"))


def evaluate_red_flags(ctx: ConditionContext) -> RedFlagOutcome:
    """Evaluate every red flag; returns the rules that fired and the resulting tier floor."""
    fired: list[RuleFired] = []
    floor = 0
    seriousness = False
    for rule in red_flag_table().rules:
        outcome = evaluate(rule.condition, ctx)
        if not outcome.matched:
            continue
        floor = max(floor, rule.tier_floor)
        seriousness = seriousness or rule.seriousness
        shown_inputs = _format_inputs(outcome.inputs)
        fired.append(
            RuleFired(
                rule_id=rule.id,
                category="red_flag",
                description=f"Red flag: {rule.description} ({shown_inputs}) -> {rule.effect}",
                inputs={**outcome.inputs, "tier_floor": rule.tier_floor},
                effect=rule.effect,
                evidence=(
                    *outcome.evidence,
                    table_evidence(
                        RED_FLAG_TABLE_FILE, f"{rule.id}: tier_floor = {rule.tier_floor}"
                    ),
                ),
            )
        )
    return RedFlagOutcome(tuple(fired), floor, seriousness)
