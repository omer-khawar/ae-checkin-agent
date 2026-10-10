"""JSON round trips and the persona-style input parser."""

from __future__ import annotations

import json

import pytest
from helpers import SESSION, T0, build, gates, sample

from interim_rules import evaluate_checkin
from interim_rules.models import GateAnswers, OpenAE, RuleSettings, VitalsSampleIn
from interim_rules.serialize import (
    build_input,
    input_from_dict,
    input_to_dict,
    result_to_dict,
    to_jsonable,
)

PERSONA = {
    "session_id": "S-DEMO",
    "studyid": "R2810-ONC-1624",
    "usubjid": "R2810-ONC-1624-P-007",
    "completed_at": "2026-10-10T18:04:12.345Z",
    "started_at": "2026-10-10T18:00:00Z",
    "nct_id": "NCT03088540",
    "responses": {
        "shortness_of_breath": {"severity": 2, "interference": 2},
        "cough": {"severity": 1, "interference": 0},
        "rash": {"presence": 0},
    },
    "gates": {
        "hospitalization": False,
        "conmed_changed": True,
        "conmed_text": "loratadine",
        "conmed_direction": "started",
        "other_text": "",
    },
    "vitals_samples": [
        {
            "tsOffsetS": 30,
            "source": "mock",
            "isMeasured": False,
            "pulseBpm": 72,
            "pulseConf": 0.9,
            "breathingBpm": 14,
            "breathingConf": 0.85,
            "windowS": 30,
            "qualityFlags": [],
        }
    ],
    "settings": {"simulated_as_measured": False},
}


def test_persona_style_input() -> None:
    inp = input_from_dict(PERSONA)
    assert inp.session_id == "S-DEMO" and inp.nct_id == "NCT03088540"
    assert inp.completed_at == "2026-10-10T18:04:12.345Z"
    assert len(inp.responses) == 5
    sob = next(
        r for r in inp.responses if r.item_id == "shortness_of_breath" and r.attribute == "severity"
    )
    assert sob.answer_id == "S-DEMO:shortness_of_breath.severity" and sob.value == 2
    assert sob.ts == inp.completed_at
    assert inp.gates.conmed_text == "loratadine" and inp.gates.conmed_direction == "started"
    assert inp.gates.hospitalization_answer_id == "S-DEMO:gate_hospitalization"
    assert inp.gates.other_text == "" and inp.gates.temp_c is None
    sample_in = inp.vitals[0]
    assert sample_in.sample_id == "S-DEMO:vs0000"
    assert sample_in.ts_utc == "2026-10-10T18:00:30.000Z"  # started_at + 30 s
    assert sample_in.pulse_bpm == 72.0 and sample_in.is_measured is False
    assert sample_in.quality_flags == () and sample_in.window_s == 30.0
    assert inp.settings == RuleSettings()
    result = evaluate_checkin(inp)
    assert result.escalation_tier == 1


def test_offset_without_started_at_uses_completed_at() -> None:
    persona = {**PERSONA}
    del persona["started_at"]
    inp = input_from_dict(persona)
    assert inp.vitals[0].ts_utc == "2026-10-10T18:04:42.345Z"


def test_snake_case_samples_and_list_responses() -> None:
    data = {
        "session_id": "S2",
        "study_id": "X",
        "usubjid": "X-P-001",
        "completed_at": T0,
        "responses": [
            {"answer_id": "a1", "item_id": "cough", "attribute": "severity", "value": 3, "ts": T0},
            {"item_id": "cough", "attribute": "interference", "value_int": 1},
        ],
        "vitals": [
            {
                "sample_id": "v1",
                "ts_utc": T0,
                "source": "presage",
                "is_measured": True,
                "pulse_bpm": 80,
                "pulse_conf": 0.7,
                "breathing_bpm": None,
                "window_s": 12,
                "quality_flags": ["talking"],
            }
        ],
        "open_aes": [
            {
                "ae_open_id": "AE1",
                "aedecod": "Cough",
                "first_reported_at": "2026-10-01T00:00:00Z",
                "last_reported_at": "2026-10-08T00:00:00Z",
                "last_session_id": "S1",
            }
        ],
        "settings": {"simulatedAsMeasured": True, "min_confidence": 0.5, "dedup_window_days": 10},
        "next_aeseq": 4,
    }
    inp = input_from_dict(data)
    assert inp.studyid == "X" and inp.next_aeseq == 4
    assert (
        inp.responses[0].answer_id == "a1" and inp.responses[1].answer_id == "S2:cough.interference"
    )
    assert inp.responses[1].ts == T0
    v = inp.vitals[0]
    assert v.sample_id == "v1" and v.source == "presage" and v.is_measured
    assert v.pulse_bpm == 80.0 and v.breathing_bpm is None and v.quality_flags == ("talking",)
    assert inp.open_aes[0].first_reported_at == "2026-10-01T00:00:00.000Z"
    assert inp.settings == RuleSettings(
        simulated_as_measured=True, min_confidence=0.5, dedup_window_days=10
    )
    result = evaluate_checkin(inp)
    assert result.vitals.status == "ok" and result.drafts[0].value("AESEQ") == 4
    assert result.drafts[0].is_followup


def test_round_trip_input() -> None:
    inp = build(
        {"nausea": {"frequency": 2, "severity": 2}},
        gate_answers=gates(
            conmed_changed=True, conmed_text="Advil", conmed_direction="both", temp_c=37.5
        ),
        vitals=[sample(0, hrv=40, hrv_conf=0.8, flags=["motion"]), sample(1, measured=True)],
        open_aes=[
            OpenAE("AE1", "Nausea", "2026-10-05T00:00:00.000Z", "2026-10-08T00:00:00.000Z", "S0")
        ],
        settings=RuleSettings(simulated_as_measured=True, min_confidence=0.7, dedup_window_days=5),
        next_aeseq=3,
    )
    as_dict = input_to_dict(inp)
    json.dumps(as_dict)  # JSON-safe
    assert input_from_dict(as_dict) == inp
    rebuilt = build_input(
        session_id=inp.session_id,
        studyid=inp.studyid,
        usubjid=inp.usubjid,
        completed_at=inp.completed_at,
        responses=inp.responses,
        gates=inp.gates,
        vitals=inp.vitals,
        open_aes=inp.open_aes,
        settings=inp.settings,
        next_aeseq=3,
        nct_id=inp.nct_id,
    )
    assert rebuilt == inp


def test_result_to_dict_is_json_safe_and_complete() -> None:
    result = evaluate_checkin(
        build({"cough": {"severity": 2, "interference": 2}}, vitals=[sample(0)])
    )
    data = result_to_dict(result)
    text = json.dumps(data, allow_nan=False)
    assert '"escalation_tier": 1' in text
    assert isinstance(data["drafts"], list) and isinstance(data["rules_fired"][0]["evidence"], list)
    assert data["items"][0]["responses"][0]["item_id"] == "shortness_of_breath"
    assert data["vitals"]["ignored"] == [] and data["sae_clock"] is None
    assert data["why"] == list(result.why)


def test_to_jsonable_rejects_unknown_types() -> None:
    with pytest.raises(TypeError):
        to_jsonable(object())
    assert to_jsonable({"a": (1, 2)}) == {"a": [1, 2]}


def test_to_jsonable_never_emits_a_non_finite_float() -> None:
    out = to_jsonable({"nan": float("nan"), "inf": float("inf"), "ok": 1.5})
    assert out == {"nan": "nan", "inf": "inf", "ok": 1.5}
    json.dumps(out, allow_nan=False)


def test_input_errors() -> None:
    with pytest.raises(ValueError, match="completed_at"):
        input_from_dict({"usubjid": "x"})
    with pytest.raises(ValueError, match="usubjid"):
        input_from_dict({"completed_at": T0})
    base = {"usubjid": "x", "completed_at": T0}
    with pytest.raises(ValueError, match="unknown attribute"):
        input_from_dict({**base, "responses": {"cough": {"colour": 1}}})
    with pytest.raises(ValueError, match="attribute -> value"):
        input_from_dict({**base, "responses": {"cough": 1}})
    with pytest.raises(ValueError, match="must be an object"):
        input_from_dict({**base, "responses": [1]})
    with pytest.raises(ValueError, match="mapping or a list"):
        input_from_dict({**base, "responses": "cough"})
    with pytest.raises(ValueError, match="conmed_direction"):
        input_from_dict({**base, "gates": {"conmed_direction": "sideways"}})
    with pytest.raises(ValueError, match="tsOffsetS"):
        input_from_dict({**base, "vitals": [{"pulseBpm": 70}]})
    with pytest.raises(ValueError, match="must be an object"):
        input_from_dict({**base, "vitals": [7]})
    with pytest.raises(ValueError, match="must be an object"):
        input_from_dict({**base, "open_aes": [7]})
    with pytest.raises(ValueError, match="expected a number"):
        input_from_dict({**base, "gates": {"temp_c": True}})
    with pytest.raises(ValueError, match="expected a number"):
        input_from_dict({**base, "gates": {"temp_c": "warm"}})
    with pytest.raises(ValueError, match="ISO-8601"):
        input_from_dict({**base, "completed_at": "yesterday"})


@pytest.mark.parametrize("bad", ["nan", "inf", "-Infinity", float("nan"), float("inf")])
def test_non_finite_numbers_are_rejected_at_the_boundary(bad: object) -> None:
    """NaN/Infinity would pass ``conf < min`` checks and break strict JSON consumers."""
    base = {"usubjid": "x", "completed_at": T0}
    sample_with = {"tsUtc": T0, "source": "presage", "isMeasured": True, "windowS": 30}
    for key in ("pulseBpm", "pulseConf", "breathingBpm", "breathingConf", "hrvConf", "windowS"):
        with pytest.raises(ValueError, match="finite"):
            input_from_dict({**base, "vitals": [{**sample_with, key: bad}]})
    with pytest.raises(ValueError, match="finite"):
        input_from_dict({**base, "gates": {"temp_c": bad}})
    with pytest.raises(ValueError, match="finite"):
        input_from_dict({**base, "settings": {"min_confidence": bad}})


def test_dataclass_instances_pass_through() -> None:
    g = gates(hospitalization=True)
    s = sample(0)
    inp = input_from_dict(
        {
            "usubjid": "x",
            "completed_at": T0,
            "gates": g,
            "vitals": [s],
            "responses": [],
            "session_id": SESSION,
        }
    )
    assert inp.gates is g and inp.vitals[0] is s
    assert isinstance(inp.gates, GateAnswers) and isinstance(inp.vitals[0], VitalsSampleIn)
    assert (
        input_from_dict({"usubjid": "x", "completed_at": T0, "gates": None}).gates.hospitalization
        is False
    )
