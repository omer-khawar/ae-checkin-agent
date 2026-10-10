"""Seriousness suspicion and the SAE clock (CLAUDE.md §3.4(f)).

A ``yes`` to the hospital/ER gate meets the ICH E2A hospitalization criterion,
so seriousness is marked *suspected* (the investigator decides) and the site's
24-hour reporting clock starts at ``completed_at``, the moment the site became
aware. Sponsor-side 7/15-day clocks are computed as informational deadlines
only. All numbers come from ``data/seriousness.json``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from .evidence import gate_evidence, table_evidence
from .models import GateAnswers, RuleFired, SAEClock
from .tables import seriousness_config
from .timefmt import normalize_iso, shift

SERIOUSNESS_TABLE_FILE = "seriousness.json"


@dataclass(frozen=True)
class SeriousnessOutcome:
    suspected: bool
    clock: SAEClock | None
    rules_fired: tuple[RuleFired, ...]


def build_clock(site_awareness_at: str) -> SAEClock:
    """Start the site clock at ``site_awareness_at`` and derive every deadline from it."""
    cfg = seriousness_config()
    awareness = normalize_iso(site_awareness_at)
    return SAEClock(
        site_awareness_at=awareness,
        due_at=shift(awareness, hours=cfg.site_to_sponsor_hours),
        informational={
            "sponsor_fatal_or_life_threatening_due": shift(
                awareness, days=cfg.fatal_or_life_threatening_days
            ),
            "sponsor_other_serious_due": shift(awareness, days=cfg.other_serious_days),
            "source": cfg.sponsor_clock_source,
            "note": "Informational sponsor deadlines computed from site awareness; owned by the "
            "sponsor, not by Interim. The site clock stops only when an investigator records a "
            "seriousness decision.",
        },
    )


def assess_seriousness(
    gates: GateAnswers, gate_ids: Mapping[str, str], completed_at: str
) -> SeriousnessOutcome:
    """Check the trigger gates in the table; start the clock when one is answered yes."""
    cfg = seriousness_config()
    triggered = [gate for gate in cfg.trigger_gates if bool(getattr(gates, gate))]
    if not triggered:
        return SeriousnessOutcome(False, None, ())
    clock = build_clock(completed_at)
    rule = RuleFired(
        rule_id="sae.clock_started",
        category="seriousness",
        description=(
            f"Seriousness suspected ({', '.join(triggered)} = yes; ICH E2A hospitalization "
            f"criterion). Site became aware at {clock.site_awareness_at}; investigator-to-sponsor "
            f"report due {clock.due_at} ({cfg.site_to_sponsor_hours:g} h)"
        ),
        inputs={
            "triggers": triggered,
            "site_awareness_at": clock.site_awareness_at,
            "due_at": clock.due_at,
            "site_to_sponsor_hours": cfg.site_to_sponsor_hours,
            "informational": dict(clock.informational),
        },
        effect="seriousness_suspected = true; SAE clock started (stops on investigator decision)",
        evidence=(
            *(gate_evidence(gate_ids[gate], f"{gate} = True") for gate in triggered),
            table_evidence(SERIOUSNESS_TABLE_FILE, "site_to_sponsor_hours; ICH E2A criteria"),
        ),
    )
    return SeriousnessOutcome(True, clock, (rule,))
