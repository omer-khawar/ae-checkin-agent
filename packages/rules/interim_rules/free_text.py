"""The kiosk's "anything else?" box is read (CONTRACTS.md R5.2).

The participant's free text is run through the deterministic chart-note scanner in
*utterance* mode (:func:`interim_rules.chartscan.scan_text` with ``detect_human_request``):

* any red flag, urgent or emergency level, sets a tier floor (``redflag.free_text``) with the
  matched phrase quoted as evidence;
* a request to talk to a person sets a lower floor (``redflag.free_text_human_request``);
* a hospital or ER mention while the hospital gate says No is a conflict: the engine suspects
  seriousness and starts the SAE clock exactly as the gate would (``sae.clock_started``).

Floors come from the ``free_text`` section of ``data/red_flags.json``. Free text never lowers
anything, and the participant never sees any of this (the kiosk shows no rule output).
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from .chartscan import RedFlag, escalation_level, scan_text
from .evidence import gate_evidence, table_evidence
from .models import GateAnswers, RuleFired, SAEClock
from .seriousness import SERIOUSNESS_TABLE_FILE, build_clock
from .tables import load_table, seriousness_config

RED_FLAGS_TABLE_FILE = "red_flags.json"
CHARTSCAN_TABLE_FILE = "chartscan_red_flags.json"


@dataclass(frozen=True)
class FreeTextConfig:
    red_flag_rule_id: str
    red_flag_tier_floor: int
    red_flag_effect: str
    human_request_rule_id: str
    human_request_tier_floor: int
    human_request_effect: str
    conflict_reason: str


@lru_cache(maxsize=1)
def free_text_config() -> FreeTextConfig:
    raw: dict[str, Any] = load_table("red_flags")["free_text"]
    flag, human = raw["red_flag"], raw["human_request"]
    return FreeTextConfig(
        red_flag_rule_id=str(flag["id"]),
        red_flag_tier_floor=int(flag["tier_floor"]),
        red_flag_effect=str(flag["effect"]),
        human_request_rule_id=str(human["id"]),
        human_request_tier_floor=int(human["tier_floor"]),
        human_request_effect=str(human["effect"]),
        conflict_reason=str(raw["hospital_conflict_reason"]),
    )


@dataclass(frozen=True)
class FreeTextOutcome:
    rules_fired: tuple[RuleFired, ...]
    tier_floor: int
    hospital_conflict: bool
    """True when the text mentions a hospital/ER visit while the hospital gate says No."""
    red_flags: tuple[RedFlag, ...]
    human_requested: bool
    level: str
    """Highest utterance-mode escalation level: none, human_requested, urgent or emergency."""

    def seriousness_clock(
        self, gate_id: str, completed_at: str
    ) -> tuple[SAEClock, RuleFired] | None:
        """The SAE clock a conflicting hospital mention starts, with its rule; else ``None``."""
        if not self.hospital_conflict:
            return None
        cfg = seriousness_config()
        clock = build_clock(completed_at)
        quote = next(
            (f.quote for f in self.red_flags if f.category == "hospitalization"), "hospital"
        )
        rule = RuleFired(
            rule_id="sae.clock_started",
            category="seriousness",
            description=(
                f"Seriousness suspected (free text mentions a hospital or ER visit: "
                f'"{quote}"; ICH E2A hospitalization criterion). Site became aware at '
                f"{clock.site_awareness_at}; investigator-to-sponsor report due {clock.due_at} "
                f"({cfg.site_to_sponsor_hours:g} h)"
            ),
            inputs={
                "triggers": ["other_text"],
                "quote": quote,
                "site_awareness_at": clock.site_awareness_at,
                "due_at": clock.due_at,
                "site_to_sponsor_hours": cfg.site_to_sponsor_hours,
                "informational": dict(clock.informational),
            },
            effect=(
                "seriousness_suspected = true; SAE clock started (stops on investigator decision)"
            ),
            evidence=(
                gate_evidence(gate_id, f'other_text: "{quote}" (hospital or ER visit)'),
                table_evidence(SERIOUSNESS_TABLE_FILE, "site_to_sponsor_hours; ICH E2A criteria"),
            ),
        )
        return clock, rule


_EMPTY = FreeTextOutcome((), 0, False, (), False, "none")


def assess_free_text(gates: GateAnswers, gate_id: str) -> FreeTextOutcome:
    """Scan ``gates.other_text``; pure, no clock, no network."""
    text = gates.other_text or ""
    if not text.strip():
        return _EMPTY
    cfg = free_text_config()
    scan = scan_text(text, None, detect_human_request=True)
    level = escalation_level(scan, "utterance")
    conflict = (not gates.hospitalization) and any(
        f.category == "hospitalization" for f in scan.red_flags
    )
    fired: list[RuleFired] = []
    floor = 0
    if scan.red_flags:
        floor = max(floor, cfg.red_flag_tier_floor)
        quotes = [f'"{f.quote}" ({f.category})' for f in scan.red_flags]
        fired.append(
            RuleFired(
                rule_id=cfg.red_flag_rule_id,
                category="red_flag",
                description=(
                    f"Red flag: the participant's own words in the comment box say "
                    f"{', '.join(quotes)} -> tier floor {cfg.red_flag_tier_floor}"
                    + (f"; {cfg.conflict_reason}" if conflict else "")
                ),
                inputs={
                    "quotes": [f.quote for f in scan.red_flags],
                    "categories": [f.category for f in scan.red_flags],
                    "level": level,
                    "tier_floor": cfg.red_flag_tier_floor,
                    "hospital_conflict": conflict,
                },
                effect=cfg.red_flag_effect,
                evidence=(
                    *(
                        gate_evidence(gate_id, f'other_text: "{f.quote}" ({f.reason})')
                        for f in scan.red_flags
                    ),
                    table_evidence(
                        RED_FLAGS_TABLE_FILE, f"free_text.red_flag: tier_floor = {floor}"
                    ),
                    table_evidence(CHARTSCAN_TABLE_FILE, "red-flag phrases (utterance mode)"),
                ),
            )
        )
    if scan.human_requested:
        floor = max(floor, cfg.human_request_tier_floor)
        fired.append(
            RuleFired(
                rule_id=cfg.human_request_rule_id,
                category="red_flag",
                description=(
                    "Red flag: the participant asked to talk to a person in the comment box "
                    f"-> tier floor {cfg.human_request_tier_floor}"
                ),
                inputs={"human_requested": True, "tier_floor": cfg.human_request_tier_floor},
                effect=cfg.human_request_effect,
                evidence=(
                    gate_evidence(gate_id, "other_text: asked to talk to a person"),
                    table_evidence(
                        RED_FLAGS_TABLE_FILE,
                        f"free_text.human_request: tier_floor = {cfg.human_request_tier_floor}",
                    ),
                ),
            )
        )
    return FreeTextOutcome(
        rules_fired=tuple(fired),
        tier_floor=floor,
        hospital_conflict=conflict,
        red_flags=scan.red_flags,
        human_requested=scan.human_requested,
        level=level,
    )
