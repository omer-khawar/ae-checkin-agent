"""Escalation ladder (CLAUDE.md §3.4(e), CONTRACTS.md §1.5).

::

    base  = base_tier_by_max_grade[max_grade]          # 0/1 -> 0, 2 -> 1, 3 -> 2
    tier  = max(base, red-flag floor, protocol floor)  # protocol floor: 2 for a prohibited con-med
    tier  = min(max_tier, tier + corroboration bump)   # bump is 0 or 1
    stop_screen = page_oncall = (tier == max_tier)

Tier names, actions, SLAs and the fixed Tier 3 stop-screen text are data in
``data/escalation_ladder.json``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .evidence import rule_evidence, table_evidence
from .models import RuleFired
from .tables import escalation_ladder, vitals_config

LADDER_TABLE_FILE = "escalation_ladder.json"
VITALS_TABLE_FILE = "vitals_corroboration.json"
PROTOCOL_TABLE_FILE = "protocol_rules.json"


@dataclass(frozen=True)
class TierOutcome:
    base_tier: int
    red_flag_floor: int
    bump: int
    final_tier: int
    stop_screen: bool
    page_oncall: bool
    stop_screen_text: str | None
    rules_fired: tuple[RuleFired, ...]
    protocol_floor: int = 0
    """Tier floor from the protocol rules (``protocol_rules.json``); 0 when none applies."""


def compute_tier(
    *,
    max_grade: int,
    grade_rule_ids: Sequence[str],
    red_flag_floor: int,
    red_flag_rule_ids: Sequence[str],
    corroboration_bump: int,
    corroboration_rule_ids: Sequence[str],
    protocol_floor: int = 0,
    protocol_rule_ids: Sequence[str] = (),
) -> TierOutcome:
    """Apply the ladder and explain every step as a rule.

    The protocol floor (CONTRACTS.md R3.1) joins the red-flag floor before the vitals
    bump: ``tier = max(base, red-flag floor, protocol floor)``, then ``+ bump``.
    """
    ladder = escalation_ladder()
    if max_grade not in ladder.base_tier_by_max_grade:
        raise ValueError(f"max_grade {max_grade!r} has no base tier")
    base = ladder.base_tier_by_max_grade[max_grade]
    rules: list[RuleFired] = [
        RuleFired(
            rule_id="tier.base",
            category="escalation",
            description=f"Base tier {base} from highest provisional grade {max_grade}",
            inputs={"max_grade": max_grade, "base_tier": base},
            effect=f"tier = {base}",
            evidence=(
                *(rule_evidence(rid, "grade that sets max_grade") for rid in grade_rule_ids),
                table_evidence(LADDER_TABLE_FILE, "base_tier_by_max_grade"),
            ),
        )
    ]

    tier = base
    if red_flag_floor > base:
        rules.append(
            RuleFired(
                rule_id="tier.redflag_floor",
                category="escalation",
                description=(
                    f"Red-flag floor {red_flag_floor} raises tier {base} -> {red_flag_floor}"
                ),
                inputs={"base_tier": base, "floor": red_flag_floor},
                effect=f"tier = {red_flag_floor}",
                evidence=(
                    *(
                        rule_evidence(rid, "red flag setting the floor")
                        for rid in red_flag_rule_ids
                    ),
                    table_evidence(LADDER_TABLE_FILE, "floor = max(red flag tier_floor)"),
                ),
            )
        )
        tier = red_flag_floor

    protocol_applied = protocol_floor > tier
    if protocol_applied:
        rules.append(
            RuleFired(
                rule_id="tier.protocol_floor",
                category="escalation",
                description=(
                    f"Protocol floor {protocol_floor} raises tier {tier} -> {protocol_floor} "
                    f"(possible protocol deviation, coordinator to confirm)"
                ),
                inputs={"tier_before": tier, "floor": protocol_floor},
                effect=f"tier = {protocol_floor}",
                evidence=(
                    *(
                        rule_evidence(rid, "protocol rule setting the floor")
                        for rid in protocol_rule_ids
                    ),
                    table_evidence(PROTOCOL_TABLE_FILE, "conmeds.prohibited_tier_floor"),
                ),
            )
        )
        tier = protocol_floor

    bump = 0
    if corroboration_bump > 0:
        # The size of the step is a clinical constant owned by the vitals table
        # (``max_tier_bump``); the corroboration stage already caps to it, and this
        # re-cap reads the same table so the two can never disagree.
        max_bump = vitals_config().max_tier_bump
        bump = min(corroboration_bump, max_bump)
        before = tier
        tier = min(ladder.max_tier, tier + bump)
        capped = " (capped at the maximum tier)" if tier == before else ""
        step = "one step" if bump == 1 else f"{bump} steps"
        rules.append(
            RuleFired(
                rule_id="tier.corroboration_bump",
                category="escalation",
                description=(
                    f"Vitals corroboration adds {step}: tier {before} -> {tier}"
                    f"{capped}; the grade is unchanged"
                ),
                inputs={
                    "before": before,
                    "after": tier,
                    "bump": bump,
                    "max_tier_bump": max_bump,
                    "max_tier": ladder.max_tier,
                },
                effect=f"tier +{bump} ({before} -> {tier})",
                evidence=(
                    *(rule_evidence(rid, "corroboration rule") for rid in corroboration_rule_ids),
                    table_evidence(VITALS_TABLE_FILE, f"max_tier_bump = {max_bump}"),
                    table_evidence(LADDER_TABLE_FILE, "capped at max_tier"),
                ),
            )
        )

    final = ladder.tiers[tier]
    rules.append(
        RuleFired(
            rule_id="tier.final",
            category="escalation",
            description=f"Final escalation tier {final.tier} ({final.name}): {final.action}",
            inputs={
                "tier": final.tier,
                "name": final.name,
                "sla": final.sla,
                "stop_screen": final.stop_screen,
                "page_oncall": final.page_oncall,
            },
            effect=f"escalation_tier = {final.tier}"
            + ("; kiosk stop screen shown; on-call paged" if final.stop_screen else ""),
            evidence=(
                rule_evidence("tier.base", f"base tier {base}"),
                *(
                    (rule_evidence("tier.redflag_floor", f"floor {red_flag_floor}"),)
                    if red_flag_floor > base
                    else ()
                ),
                *(
                    (rule_evidence("tier.protocol_floor", f"protocol floor {protocol_floor}"),)
                    if protocol_applied
                    else ()
                ),
                *((rule_evidence("tier.corroboration_bump", f"+{bump}"),) if bump else ()),
                table_evidence(LADDER_TABLE_FILE, f"tier {final.tier}: {final.name}"),
            ),
        )
    )
    return TierOutcome(
        base_tier=base,
        red_flag_floor=red_flag_floor,
        bump=bump,
        final_tier=tier,
        stop_screen=final.stop_screen,
        page_oncall=final.page_oncall,
        stop_screen_text=final.stop_screen_text,
        rules_fired=tuple(rules),
        protocol_floor=protocol_floor,
    )
