"""Builders for engine inputs used across the test-suite."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast

from interim_rules.engine import evaluate_checkin
from interim_rules.models import (
    Attribute,
    CheckInInput,
    CheckInResult,
    ConMedDirection,
    DraftRecord,
    GateAnswers,
    OpenAE,
    ProResponse,
    RuleSettings,
    VitalsSampleIn,
)
from interim_rules.tables import items
from interim_rules.timefmt import shift

T0 = "2026-10-10T18:00:00.000Z"
SESSION = "01SESSION0000000000000000"
STUDY = "R2810-ONC-1624"
SUBJECT = f"{STUDY}-P-007"

Values = Mapping[str, Mapping[str, int]]


def zero_values() -> dict[str, dict[str, int]]:
    """Every shipped item answered with 0 on every attribute."""
    return {item.id: dict.fromkeys(item.attributes, 0) for item in items()}


def merged_values(overrides: Values | None = None) -> dict[str, dict[str, int]]:
    values = zero_values()
    for item_id, attrs in (overrides or {}).items():
        values.setdefault(item_id, {}).update(attrs)
    return values


def responses_from_values(
    values: Values, session_id: str = SESSION, ts: str = T0
) -> tuple[ProResponse, ...]:
    out: list[ProResponse] = []
    for item_id, attrs in values.items():
        for attribute, value in attrs.items():
            out.append(
                ProResponse(
                    answer_id=f"{session_id}:{item_id}.{attribute}",
                    item_id=item_id,
                    attribute=cast(Attribute, attribute),
                    value=value,
                    ts=ts,
                )
            )
    return tuple(out)


def response(
    item_id: str, attribute: Attribute, value: int, ts: str = T0, answer_id: str | None = None
) -> ProResponse:
    return ProResponse(
        answer_id=answer_id or f"{SESSION}:{item_id}.{attribute}",
        item_id=item_id,
        attribute=attribute,
        value=value,
        ts=ts,
    )


def gates(
    *,
    hospitalization: bool = False,
    conmed_changed: bool = False,
    conmed_text: str | None = None,
    conmed_direction: ConMedDirection | None = None,
    other_text: str | None = None,
    temp_c: float | None = None,
) -> GateAnswers:
    return GateAnswers(
        hospitalization=hospitalization,
        hospitalization_answer_id=f"{SESSION}:gate_hospitalization",
        conmed_changed=conmed_changed,
        conmed_text=conmed_text,
        conmed_direction=conmed_direction,
        conmed_answer_id=f"{SESSION}:gate_conmed",
        other_text=other_text,
        other_answer_id=f"{SESSION}:gate_other",
        temp_c=temp_c,
        temp_answer_id=f"{SESSION}:gate_temp_c",
    )


def sample(
    index: int = 0,
    *,
    pulse: float | None = 72.0,
    pulse_conf: float | None = 0.9,
    breathing: float | None = 14.0,
    breathing_conf: float | None = 0.85,
    hrv: float | None = None,
    hrv_conf: float | None = None,
    measured: bool = False,
    source: str | None = None,
    ts: str | None = None,
    window_s: float = 30.0,
    flags: Sequence[str] = (),
) -> VitalsSampleIn:
    """One vitals sample. A measured sample defaults to the ``presage`` source (a ``mock``
    source is simulated by definition, whatever the flag says); a simulated one to ``mock``.
    The default 30 s window satisfies the pulse and breathing gates; pass ``window_s=60`` for
    HRV."""
    return VitalsSampleIn(
        sample_id=f"{SESSION}:vs{index:04d}",
        ts_utc=ts or shift(T0, seconds=-120 + index),
        source=source if source is not None else ("presage" if measured else "mock"),
        is_measured=measured,
        pulse_bpm=pulse,
        pulse_conf=pulse_conf,
        breathing_bpm=breathing,
        breathing_conf=breathing_conf,
        hrv_rmssd_ms=hrv,
        hrv_conf=hrv_conf,
        window_s=window_s,
        quality_flags=tuple(flags),
    )


def build(
    values: Values | None = None,
    *,
    gate_answers: GateAnswers | None = None,
    vitals: Sequence[VitalsSampleIn] = (),
    open_aes: Sequence[OpenAE] = (),
    settings: RuleSettings | None = None,
    completed_at: str = T0,
    next_aeseq: int = 1,
    nct_id: str | None = "NCT03088540",
    responses: Sequence[ProResponse] | None = None,
    session_id: str = SESSION,
    usubjid: str = SUBJECT,
) -> CheckInInput:
    return CheckInInput(
        session_id=session_id,
        studyid=STUDY,
        usubjid=usubjid,
        completed_at=completed_at,
        responses=tuple(responses)
        if responses is not None
        else responses_from_values(merged_values(values)),
        gates=gate_answers or gates(),
        vitals=tuple(vitals),
        open_aes=tuple(open_aes),
        settings=settings or RuleSettings(),
        next_aeseq=next_aeseq,
        nct_id=nct_id,
    )


def run(
    values: Values | None = None,
    *,
    gate_answers: GateAnswers | None = None,
    vitals: Sequence[VitalsSampleIn] = (),
    open_aes: Sequence[OpenAE] = (),
    settings: RuleSettings | None = None,
    completed_at: str = T0,
    next_aeseq: int = 1,
    nct_id: str | None = "NCT03088540",
    responses: Sequence[ProResponse] | None = None,
) -> CheckInResult:
    return evaluate_checkin(
        build(
            values,
            gate_answers=gate_answers,
            vitals=vitals,
            open_aes=open_aes,
            settings=settings,
            completed_at=completed_at,
            next_aeseq=next_aeseq,
            nct_id=nct_id,
            responses=responses,
        )
    )


def rule_ids(result: CheckInResult) -> list[str]:
    return [rule.rule_id for rule in result.rules_fired]


def grades(result: CheckInResult) -> dict[str, int]:
    return {item.item_id: item.provisional_grade for item in result.items}


def drafts(result: CheckInResult, domain: str) -> list[DraftRecord]:
    return [d for d in result.drafts if d.domain == domain]


def vs_by_test(result: CheckInResult) -> dict[str, DraftRecord]:
    """VS drafts keyed by ``VSTESTCD`` (``PULSE`` / ``RESP`` / ``HRV_RMSSD``)."""
    return {str(d.value("VSTESTCD")): d for d in drafts(result, "VS")}


def field_evidence(draft: DraftRecord, name: str) -> tuple[object, ...]:
    """The evidence tuple behind field ``name`` of a draft."""
    return next(f.evidence for f in draft.fields if f.name == name)
