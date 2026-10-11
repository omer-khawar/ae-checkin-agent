"""Vitals corroboration rules (CLAUDE.md §3.4(d)).

Corroboration can raise the escalation tier by at most one step and never
touches a grade. Rules are evaluated only when the session's vitals status is
``ok`` (at least one measured-or-toggled, confident, plausible reading), and
each rule compares the **maximum** eligible value of the session against its
threshold. Rules, thresholds and reason texts are data in
``data/vitals_corroboration.json``.
"""

from __future__ import annotations

from dataclasses import dataclass

from .conditions import ConditionContext, evaluate
from .evidence import table_evidence
from .models import RuleFired, VitalsAssessment
from .tables import vitals_config
from .vitals import VITALS_TABLE_FILE


@dataclass(frozen=True)
class CorroborationOutcome:
    rules_fired: tuple[RuleFired, ...]
    bump: int
    """0 or 1: the tier step to apply (capped at the table's ``max_tier_bump``)."""


def _format_inputs(inputs: dict[str, object]) -> str:
    return ", ".join(f"{k} = {v}" for k, v in inputs.items() if not k.endswith(".threshold"))


def evaluate_corroboration(
    ctx: ConditionContext, assessment: VitalsAssessment
) -> CorroborationOutcome:
    """Fire the corroboration rules whose conditions hold; empty unless vitals status is ``ok``."""
    if assessment.status != "ok":
        return CorroborationOutcome((), 0)
    cfg = vitals_config()
    fired: list[RuleFired] = []
    requested_bump = 0
    for rule in cfg.rules:
        outcome = evaluate(rule.condition, ctx)
        if not outcome.matched:
            continue
        requested_bump = max(requested_bump, rule.tier_bump)
        fired.append(
            RuleFired(
                rule_id=rule.id,
                category="corroboration",
                description=(
                    f"Corroboration: {rule.description} ({_format_inputs(outcome.inputs)}) -> "
                    f"{rule.reason}"
                ),
                inputs={**outcome.inputs, "reason": rule.reason, "tier_bump": rule.tier_bump},
                effect=f"tier +{rule.tier_bump} (at most {cfg.max_tier_bump} step in total, cap 3)",
                evidence=(
                    *outcome.evidence,
                    table_evidence(VITALS_TABLE_FILE, f"{rule.id}: {rule.reason}"),
                ),
            )
        )
    return CorroborationOutcome(tuple(fired), min(requested_bump, cfg.max_tier_bump))
