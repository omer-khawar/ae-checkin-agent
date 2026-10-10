"""Typed inputs and outputs of the rules engine (CONTRACTS.md §1.2 and §1.3).

Everything here is a frozen dataclass so that a :class:`CheckInResult` is a
pure function of its :class:`CheckInInput`: same input, same output, forever.
The API converts these to and from JSON with :mod:`interim_rules.serialize`.

Timestamps are ISO-8601 UTC strings (``2026-10-10T18:04:12.345Z``); the engine
parses them only where arithmetic is needed (SAE clock, de-duplication window)
and never calls ``datetime.now()``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# --------------------------------------------------------------------------- #
# Shared literals
# --------------------------------------------------------------------------- #

Attribute = Literal["frequency", "severity", "interference", "presence"]
"""The four PRO-CTCAE-style attributes an item can ask about."""

ATTRIBUTES: tuple[Attribute, ...] = ("frequency", "severity", "interference", "presence")

ConMedDirection = Literal["started", "stopped", "both"]
EvidenceKind = Literal["pro_response", "vitals_sample", "gate_answer", "rule", "table"]
RuleCategory = Literal[
    "scoring",
    "grading",
    "red_flag",
    "vitals_quality",
    "corroboration",
    "escalation",
    "seriousness",
    "conmed",
    "dedup",
    "drafting",
]
VitalsStatus = Literal["ok", "unavailable", "low_quality", "implausible", "simulated_ignored"]
MatchKind = Literal["exact", "case_insensitive", "levenshtein", "unmatched"]
Domain = Literal["AE", "VS", "CM"]


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ProResponse:
    """One participant answer to one attribute of one item.

    ``answer_id`` is the evidence pointer (``Answer.id`` in the API database).
    ``ts`` is the server receipt time of the answer.
    """

    answer_id: str
    item_id: str
    attribute: Attribute
    value: int
    ts: str


@dataclass(frozen=True)
class GateAnswers:
    """The three gate questions plus the optional typed temperature.

    Free text (``conmed_text``, ``other_text``) is carried verbatim; the engine
    never alters ``conmed_text`` and never parses ``other_text``.
    """

    hospitalization: bool
    hospitalization_answer_id: str | None
    conmed_changed: bool
    conmed_text: str | None
    conmed_direction: ConMedDirection | None
    conmed_answer_id: str | None
    other_text: str | None
    other_answer_id: str | None
    temp_c: float | None
    temp_answer_id: str | None


@dataclass(frozen=True)
class VitalsSampleIn:
    """One raw vitals sample as stored by the API (snake_case form of the bridge contract)."""

    sample_id: str
    ts_utc: str
    source: str
    is_measured: bool
    pulse_bpm: float | None
    pulse_conf: float | None
    breathing_bpm: float | None
    breathing_conf: float | None
    hrv_rmssd_ms: float | None
    hrv_conf: float | None
    window_s: float
    quality_flags: tuple[str, ...]


@dataclass(frozen=True)
class OpenAE:
    """An existing, still-open AE for this participant (de-duplication input)."""

    ae_open_id: str
    aedecod: str
    first_reported_at: str
    last_reported_at: str
    last_session_id: str


@dataclass(frozen=True)
class RuleSettings:
    """Run-time knobs the admin panel can change. ``None`` means 'use the table default'."""

    simulated_as_measured: bool = False
    min_confidence: float | None = None
    dedup_window_days: int | None = None


@dataclass(frozen=True)
class CheckInInput:
    """Everything the engine needs to evaluate one completed check-in."""

    session_id: str
    studyid: str
    usubjid: str
    completed_at: str
    responses: tuple[ProResponse, ...]
    gates: GateAnswers
    vitals: tuple[VitalsSampleIn, ...]
    open_aes: tuple[OpenAE, ...]
    settings: RuleSettings = RuleSettings()
    next_aeseq: int = 1
    nct_id: str | None = None
    """Public registry id of the demo study, carried into drafts as ``INTERIM_NCT_ID``."""


# --------------------------------------------------------------------------- #
# Outputs
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Evidence:
    """A pointer from an output back to the exact input or rule that produced it."""

    kind: EvidenceKind
    id: str
    ts: str | None
    note: str


@dataclass(frozen=True)
class RuleFired:
    """One rule that fired, in plain English, with the inputs it used."""

    rule_id: str
    category: RuleCategory
    description: str
    inputs: dict[str, object]
    effect: str
    evidence: tuple[Evidence, ...]


@dataclass(frozen=True)
class ItemResult:
    """Composite score and provisional grade for one symptom item."""

    item_id: str
    label: str
    aedecod: str
    composite: int
    provisional_grade: int
    responses: tuple[ProResponse, ...]
    evidence: tuple[Evidence, ...]


@dataclass(frozen=True)
class VitalsSummary:
    """Medians and maxima over the usable (confident + plausible) samples."""

    n_samples: int
    n_eligible: int
    pulse_median: float | None
    pulse_max: float | None
    breathing_median: float | None
    breathing_max: float | None
    hrv_median: float | None
    is_measured: bool
    source: str | None
    first_ts: str | None
    last_ts: str | None


@dataclass(frozen=True)
class VitalsAssessment:
    """Quality verdict on the session's vitals plus the summary and the rules that explain it."""

    status: VitalsStatus
    eligible_sample_ids: tuple[str, ...]
    ignored: tuple[tuple[str, str], ...]
    summary: VitalsSummary | None
    rules_fired: tuple[RuleFired, ...]


@dataclass(frozen=True)
class ConMedMatch:
    """Deterministic string match of the verbatim medication text against the bundled list."""

    verbatim: str
    matched_name: str | None
    match_kind: MatchKind
    confidence: float
    distance: int | None
    candidates: tuple[tuple[str, int], ...]


@dataclass(frozen=True)
class SAEClock:
    """The site's 24-hour reporting clock, started when the site became aware."""

    site_awareness_at: str
    due_at: str
    informational: dict[str, str]


@dataclass(frozen=True)
class DraftField:
    """One SDTM variable on a draft record with the evidence behind its value."""

    name: str
    value: object
    evidence: tuple[Evidence, ...]


@dataclass(frozen=True)
class DraftRecord:
    """One drafted AE, VS or CM record. Drafts stay drafts until a coordinator confirms them."""

    domain: Domain
    fields: tuple[DraftField, ...]
    linked_ae_open_id: str | None
    is_followup: bool

    def value(self, name: str) -> object:
        """Value of field ``name`` (``None`` if absent); a convenience for callers and tests."""
        for f in self.fields:
            if f.name == name:
                return f.value
        return None


@dataclass(frozen=True)
class CheckInResult:
    """The complete, explainable outcome of one check-in."""

    items: tuple[ItemResult, ...]
    max_grade: int
    base_tier: int
    red_flag_tier_floor: int
    corroboration_bump: int
    escalation_tier: int
    stop_screen: bool
    page_oncall: bool
    seriousness_suspected: bool
    sae_clock: SAEClock | None
    conmed: ConMedMatch | None
    vitals: VitalsAssessment
    drafts: tuple[DraftRecord, ...]
    rules_fired: tuple[RuleFired, ...]
    why: tuple[str, ...]
