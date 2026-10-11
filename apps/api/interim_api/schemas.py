"""Pydantic request bodies (CONTRACTS.md §2.1, §2.2, R2.3).

Responses are built as plain dicts by the service layer (their shapes are the
contract's, mirrored in ``apps/web/src/lib/types.ts``); requests are validated
here so a malformed body is a 422 problem before any service code runs.

The one deliberate naming exception: the bridge's ``VitalsSample`` is camelCase
(CLAUDE.md §7.1), so :class:`VitalsSampleBody` uses a camelCase alias generator
with ``populate_by_name=True`` and the API stores/returns snake_case (D-002).
"""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from .constants import MOCK_SCENARIOS, VITALS_SOURCES

Attribute = Literal["frequency", "severity", "interference", "presence"]
ConmedDirection = Literal["started", "stopped", "both"]
Domain = Literal["AE", "VS", "CM"]
VitalsSourceName = Literal["mock", "presage", "arduino"]
"""CLAUDE.md §7.1; must agree with :data:`interim_api.constants.VITALS_SOURCES`."""
assert set(VitalsSourceName.__args__) == set(VITALS_SOURCES)  # type: ignore[attr-defined]


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class RuleSettingsOverride(BaseModel):
    """Partial ``RuleSettings``; ``None`` keeps the stored/table value."""

    model_config = ConfigDict(extra="forbid")

    simulated_as_measured: bool | None = None
    min_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    dedup_window_days: int | None = Field(default=None, ge=0, le=365)


class CreateSessionRequest(BaseModel):
    usubjid: str = Field(min_length=1, max_length=128, description="USUBJID or display label")
    consent_camera: bool = Field(
        default=True,
        description="CLAUDE.md §00 / D-026: camera use is covered by the enrollment ICF, so "
        "this defaults to true; false only when the participant turned the camera off",
    )
    started_at_override: str | None = Field(default=None, description="admin only")
    create_participant: bool = Field(
        default=False,
        description="admin only: create the participant if unknown (eval harness)",
    )
    is_eval: bool = Field(
        default=False,
        description="admin only: mark the session (and a "
        "participant created on the fly) as eval data, hidden from the queue",
    )
    # [seed agent] CONTRACTS R3.1 ProtocolContext ({prior_pi3k_inhibitor, last_dose_date}).
    protocol_context: dict[str, Any] | None = Field(
        default=None,
        description="admin only: the participant's protocol context (CONTRACTS R3.1), stored on "
        "the participant and read by the rules engine at completion (eval harness)",
    )


class AnswerRequest(BaseModel):
    item_id: str = Field(min_length=1, max_length=64)
    attribute: Attribute
    value: int = Field(ge=0, le=4)
    value_text: str | None = Field(default=None, max_length=2000)
    ts_client: str


class ConmedEntryBody(BaseModel):
    """One medication from the kiosk's "Add another medication" list (CONTRACTS R5.2)."""

    text: str = Field(max_length=200)
    direction: ConmedDirection


class GatesRequest(BaseModel):
    hospitalization: bool
    conmed_changed: bool
    conmed_text: str | None = Field(default=None, max_length=500)
    conmed_direction: ConmedDirection | None = None
    other_text: str | None = Field(default=None, max_length=4000)
    temp_c: float | None = Field(default=None, ge=25.0, le=45.0)
    ts_client: str
    # R5.1: the kiosk's first question; true here (no early stop) is still a tier-3 red flag.
    urgent_now: bool | None = None
    # R5.2: several medications. When present it is the source of truth for the CM drafts;
    # conmed_text / conmed_direction stay accepted for old clients.
    conmeds: list[ConmedEntryBody] | None = Field(default=None, max_length=10)


UrgentTrigger = Literal["urgent_now", "severe_dyspnea"]


class UrgentRequest(BaseModel):
    """R5.1: the kiosk stopped the check-in at once; the answers given so far are kept."""

    trigger: UrgentTrigger
    ts_client: str


class VitalsSampleBody(BaseModel):
    """One bridge sample, camelCase on the wire (CLAUDE.md §7.1).

    ``source`` is a closed vocabulary: the rules engine decides "measured vs
    simulated" from the source label (``simulated_sources`` in
    ``vitals_corroboration.json``), so an unknown label would default to
    "measured". Refusing it here is the only place that can close that gap.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    ts_utc: str
    source: VitalsSourceName
    is_measured: bool = False
    pulse_bpm: float | None = None
    pulse_conf: float | None = None
    breathing_bpm: float | None = None
    breathing_conf: float | None = None
    hrv_rmssd_ms: float | None = None
    hrv_conf: float | None = None
    window_s: float = 0.0
    quality_flags: list[str] = Field(default_factory=list)

    @field_validator(
        "pulse_bpm",
        "pulse_conf",
        "breathing_bpm",
        "breathing_conf",
        "hrv_rmssd_ms",
        "hrv_conf",
        "window_s",
    )
    @classmethod
    def _finite(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be a finite number")
        return value


class VitalsPostRequest(BaseModel):
    samples: list[VitalsSampleBody] = Field(min_length=1, max_length=2000)


class CompleteRequest(BaseModel):
    ts_client: str
    completed_at_override: str | None = Field(default=None, description="admin only")
    settings_override: RuleSettingsOverride | None = Field(default=None, description="admin only")


class ConfirmRequest(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class RejectRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class PatchDraftRequest(BaseModel):
    fields: dict[str, Any] = Field(min_length=1)
    note: str | None = Field(default=None, max_length=2000)


class AttributionRequest(BaseModel):
    """Investigator-only. ``AESER`` Y/N stops the session's SAE clock."""

    AEREL: str | None = Field(default=None, max_length=64)
    AESER: str | None = Field(default=None, max_length=8)
    INTERIM_IRAE: Literal["Y", "N"] | None = Field(
        default=None,
        description="[packets agent] R4.3: the investigator's immune-related assessment "
        "(protocol p. 91). Send null explicitly to clear it. 'N' stops a running possible-AESI "
        "clock of the same source.",
    )
    note: str | None = Field(default=None, max_length=2000)


class AckRequest(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


class StopSaeClockRequest(BaseModel):
    """Investigator-only ``PATCH /sae-clocks/{id}/stop`` (D-023): the seriousness decision
    recorded directly on a clock whose source drafted no AE (hospitalization cue only)."""

    decision: str = Field(
        min_length=1,
        max_length=200,
        description="the investigator's seriousness decision, e.g. 'AESER = N: fall, "
        "not related to study treatment' or 'AESER = Y'",
    )
    note: str | None = Field(default=None, max_length=2000)


class MockEdcRequest(BaseModel):
    records: list[dict[str, Any]] = Field(min_length=1, max_length=10000)


class EvalRunRequest(BaseModel):
    include_hidden: bool = False
    persona_ids: list[str] | None = None


# --------------------------------------------------------------------------- #
# Custom persona (the judge's "build your own" form; CONTRACTS.md §2.2 + R2.6)
# --------------------------------------------------------------------------- #

ResponseValue = Annotated[int, Field(ge=0, le=4)]
PersonaResponses = dict[
    Annotated[str, Field(min_length=1, max_length=64)], dict[Attribute, ResponseValue]
]
"""``{item_id: {attribute: 0..4}}``; item ids and per-item attribute sets are checked by the
service against the instrument table (unknown item / attribute -> 422)."""


class PersonaGates(BaseModel):
    """A persona's gate answers (same fields as :class:`GatesRequest`, no timestamp)."""

    model_config = ConfigDict(extra="forbid")

    hospitalization: bool = False
    conmed_changed: bool = False
    conmed_text: str | None = Field(default=None, max_length=500)
    conmed_direction: ConmedDirection | None = None
    other_text: str | None = Field(default=None, max_length=4000)
    temp_c: float | None = Field(default=None, ge=25.0, le=45.0)


class PersonaSample(VitalsSampleBody):
    """A bridge sample whose time may be relative to session start (``tsOffsetS``, §6)."""

    ts_utc: str | None = None
    ts_offset_s: float | None = Field(default=None, ge=0.0, le=86400.0)

    @model_validator(mode="after")
    def _needs_a_time(self) -> PersonaSample:
        if self.ts_utc is None and self.ts_offset_s is None:
            raise ValueError("a sample needs tsUtc or tsOffsetS")
        return self


class PersonaPriorCheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    days_ago: float = Field(ge=0.0, le=3650.0)
    responses: PersonaResponses = Field(default_factory=dict)
    gates: PersonaGates = Field(default_factory=PersonaGates)
    vitals_samples: list[PersonaSample] = Field(default_factory=list, max_length=2000)


class PersonaSetup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prior_checkins: list[PersonaPriorCheckIn] = Field(default_factory=list, max_length=20)


class CustomPersona(BaseModel):
    """One ad-hoc persona. Unknown top-level keys are ignored (the form may send
    display-only fields); every value that reaches the service layer is typed."""

    model_config = ConfigDict(extra="ignore")

    id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    name: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=64)
    description: str | None = Field(default=None, max_length=2000)
    hidden: bool = False
    consent_camera: bool | None = None
    vitals_scenario: str | None = Field(default=None, max_length=64)
    settings: RuleSettingsOverride | None = None
    setup: PersonaSetup = Field(default_factory=PersonaSetup)
    responses: PersonaResponses
    gates: PersonaGates = Field(default_factory=PersonaGates)
    vitals_samples: list[PersonaSample] = Field(default_factory=list, max_length=2000)
    expected: dict[str, Any] | None = None
    # [seed agent] CONTRACTS R3.1 ProtocolContext for the eval participant (prior PI3K
    # inhibitor, last dose date); validated by the rules package when the persona is replayed.
    protocol_context: dict[str, Any] | None = None


class EvalCustomRequest(BaseModel):
    persona: CustomPersona


# --------------------------------------------------------------------------- #
# Chart notes (CONTRACTS.md R2.4)
# --------------------------------------------------------------------------- #

IsoDate = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$", description="YYYY-MM-DD")]


class ScanRequest(BaseModel):
    """``POST /scan`` dry run: nothing is stored."""

    text: str = Field(min_length=1, max_length=20000)
    ref_date: IsoDate | None = Field(
        default=None, description="the note date; onset dates are computed relative to it"
    )


class NoteIngestRequest(BaseModel):
    """``POST /notes``: the note is stored verbatim, scanned and drafted."""

    usubjid: str = Field(min_length=1, max_length=128, description="USUBJID or display label")
    note_date: IsoDate
    author: str = Field(min_length=1, max_length=200)
    note_type: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=20000)
    ingested_at_override: str | None = Field(
        default=None, description="admin only: backdate the moment the site read the note"
    )
    # [queries agent] R4.1 phone-call intake: only with note_type "phone_call".
    caller: Literal["participant", "caregiver", "other"] | None = Field(
        default=None, description="phone calls only: who called or was called"
    )
    call_direction: Literal["inbound", "outbound"] | None = Field(
        default=None, description="phone calls only: inbound (they called) or outbound"
    )

    @model_validator(mode="after")
    def _call_fields_need_phone_call(self) -> NoteIngestRequest:
        is_call = self.note_type.strip() == "phone_call"
        if not is_call and (self.caller is not None or self.call_direction is not None):
            raise ValueError(
                'caller and call_direction are only accepted with note_type "phone_call"'
            )
        return self


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vitals_source: VitalsSourceName | None = None
    mock_scenario: str | None = Field(default=None, min_length=1, max_length=64)
    simulated_as_measured: bool | None = None

    @field_validator("mock_scenario")
    @classmethod
    def _known_scenario(cls, value: str | None) -> str | None:
        if value is not None and value not in MOCK_SCENARIOS:
            raise ValueError(f"unknown mock scenario; use one of {', '.join(MOCK_SCENARIOS)}")
        return value


class ResetRequest(BaseModel):
    reseed: bool = True
