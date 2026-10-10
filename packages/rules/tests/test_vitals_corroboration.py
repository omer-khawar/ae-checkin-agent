"""Vitals eligibility, status precedence, summary, corroboration and the tier bump."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping

import pytest
from helpers import SESSION, T0, build, drafts, grades, rule_ids, run, sample, vs_by_test

from interim_rules.models import DraftRecord, Evidence, RuleSettings, VitalsSampleIn
from interim_rules.serialize import result_to_dict
from interim_rules.timefmt import shift
from interim_rules.vitals import (
    assess_vitals,
    build_summary,
    classify_samples,
    corroboration_maxima,
    effective_is_measured,
    effective_min_confidence,
    measured_flag_inconsistent,
    span_evidence,
)

SOB2 = {"shortness_of_breath": {"severity": 2, "interference": 2}}  # composite 2 -> tier 1
SOB3 = {"shortness_of_breath": {"severity": 2, "interference": 4}}  # composite 3 -> tier 2
FEVER = {"fever_or_chills": {"presence": 1}}  # composite 1 -> tier 0
ON = RuleSettings(simulated_as_measured=True)


def _field(vs: Mapping[str, DraftRecord], code: str, name: str) -> tuple[Evidence, ...]:
    """Evidence behind field ``name`` of the VS draft ``code``."""
    return next(f.evidence for f in vs[code].fields if f.name == name)


# --------------------------------------------------------------------------- #
# Eligibility and status
# --------------------------------------------------------------------------- #


def test_no_samples_is_unavailable_and_produces_no_vs_rows() -> None:
    result = run(SOB2)
    assert result.vitals.status == "unavailable"
    assert result.vitals.summary is None and result.vitals.eligible_sample_ids == ()
    assert "vitals.unavailable" in rule_ids(result)
    assert drafts(result, "VS") == []
    assert result.escalation_tier == 1


def test_low_quality_when_no_metric_reaches_confidence() -> None:
    vitals = [sample(i, pulse_conf=0.3, breathing_conf=0.5) for i in range(3)]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "low_quality"
    assert "vitals.low_quality" in rule_ids(result) and "vitals.summary" not in rule_ids(result)
    assert len(result.vitals.ignored) == 6  # 3 samples x 2 metrics
    assert all("below minimum" in reason for _, reason in result.vitals.ignored)
    vs = drafts(result, "VS")
    assert [d.value("VSSTAT") for d in vs] == ["NOT DONE", "NOT DONE"]
    assert all(d.value("VSORRES") is None for d in vs)
    low = next(r for r in result.rules_fired if r.rule_id == "vitals.low_quality")
    assert low.inputs["n_low_confidence_readings"] == 6
    assert low.inputs["n_window_too_short_readings"] == 0
    # Session-level evidence cites the first and last sample, not every sample.
    assert [e.id for e in low.evidence if e.kind == "vitals_sample"] == [
        vitals[0].sample_id,
        vitals[2].sample_id,
    ]


def test_missing_confidence_counts_as_low_confidence() -> None:
    result = run(SOB2, vitals=[sample(0, pulse_conf=None, breathing_conf=None)])
    assert result.vitals.status == "low_quality"
    assert "confidence missing" in result.vitals.ignored[0][1]


@pytest.mark.parametrize("bad_conf", [math.nan, math.inf, -math.inf, 1.5, -0.1])
def test_non_finite_or_out_of_range_confidence_is_low_confidence(bad_conf: float) -> None:
    """``conf < min_conf`` is False for NaN/inf, so they must be rejected explicitly."""
    vitals = [sample(0, breathing=26, breathing_conf=bad_conf, pulse=None, measured=True)]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "low_quality"
    assert not any(r.startswith("corr.") for r in rule_ids(result))
    assert result.escalation_tier == 1
    reason = result.vitals.ignored[0][1]
    assert "not a finite number" in reason or "outside 0..1" in reason
    # The result must survive a strict JSON encoder (Starlette / browsers reject NaN).
    json.dumps(result_to_dict(result), allow_nan=False)


def test_non_finite_values_are_implausible_even_without_bounds() -> None:
    vitals = [
        sample(
            0,
            pulse=math.nan,
            breathing=math.inf,
            hrv=math.nan,
            hrv_conf=0.9,
            measured=True,
            window_s=60,
        )
    ]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "implausible"
    assert all("not a finite number" in reason for _, reason in result.vitals.ignored)
    assert len(result.vitals.ignored) == 3
    json.dumps(result_to_dict(result), allow_nan=False)


def test_implausible_values_are_ignored_with_a_reason() -> None:
    vitals = [
        sample(0, pulse=200, breathing=60, measured=True),
        sample(1, pulse=25, breathing=2, measured=True),
    ]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "implausible"
    assert rule_ids(result).count("vitals.implausible") == 2
    assert all("outside plausibility" in reason for _, reason in result.vitals.ignored)
    assert result.vitals.summary is None
    assert "corr.tachypnea_dyspnea" not in rule_ids(result) and result.corroboration_bump == 0
    assert result.escalation_tier == 1


def test_partially_implausible_sample_keeps_its_good_metric() -> None:
    vitals = [sample(0, pulse=250, breathing=14, measured=True, source="presage")]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "ok"
    assert result.vitals.ignored == (
        (vitals[0].sample_id, "pulse: 250 beats/min outside plausibility 35-180"),
    )
    summary = result.vitals.summary
    assert summary is not None
    assert summary.pulse_median is None and summary.breathing_median == 14.0
    assert summary.is_measured and summary.source == "presage"
    vs = vs_by_test(result)
    assert vs["PULSE"].value("VSSTAT") == "NOT DONE"
    assert vs["RESP"].value("VSORRES") == 14.0
    assert vs["RESP"].value("VSMETHOD") == "Contactless optical, camera-based"


# --------------------------------------------------------------------------- #
# Averaging-window gate (CLAUDE.md §3.4(d) "the sample window is valid")
# --------------------------------------------------------------------------- #


def test_zero_second_window_cannot_corroborate() -> None:
    """A sample posted straight to the API with windowS 0 must not bump the tier."""
    vitals = [sample(0, breathing=26, measured=True, window_s=0.0)]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "low_quality"
    assert "corr.tachypnea_dyspnea" not in rule_ids(result)
    assert result.escalation_tier == 1 and result.corroboration_bump == 0
    reasons = dict(result.vitals.ignored)
    assert reasons[vitals[0].sample_id].endswith("shorter than minimum 30 s") or any(
        "averaging window 0 s shorter than minimum" in r for _, r in result.vitals.ignored
    )
    low = next(r for r in result.rules_fired if r.rule_id == "vitals.low_quality")
    assert low.inputs["n_window_too_short_readings"] == 2  # pulse (12 s) and breathing (30 s)
    assert low.inputs["min_window_s"] == {"pulse": 12.0, "breathing": 30.0, "hrv": 60.0}


def test_window_gate_is_per_metric_and_inclusive() -> None:
    # A 12 s window is enough for pulse but not for breathing: pulse usable, breathing ignored.
    short = sample(0, pulse=120, breathing=26, measured=True, window_s=12.0)
    result = run(SOB2, vitals=[short])
    assert result.vitals.status == "ok"
    assert result.vitals.ignored == (
        (short.sample_id, "breathing: averaging window 12 s shorter than minimum 30 s"),
    )
    ids = rule_ids(result)
    assert "corr.tachycardia_dyspnea" in ids and "corr.tachypnea_dyspnea" not in ids
    vs = vs_by_test(result)
    assert vs["PULSE"].value("VSORRES") == 120.0 and vs["RESP"].value("VSSTAT") == "NOT DONE"
    resp_stat = _field(vs, "RESP", "VSSTAT")
    assert "shorter than minimum 30 s" in resp_stat[0].note
    # Exactly the minimum is valid; just under is not.
    assert (
        run(SOB2, vitals=[sample(0, breathing=26, measured=True, window_s=30.0)]).escalation_tier
        == 2
    )
    assert (
        run(SOB2, vitals=[sample(0, breathing=26, measured=True, window_s=29.9)]).escalation_tier
        == 1
    )


def test_hrv_needs_a_sixty_second_window() -> None:
    thirty = run(vitals=[sample(0, hrv=40, hrv_conf=0.9, measured=True, window_s=30)])
    assert thirty.vitals.summary is not None and thirty.vitals.summary.hrv_median is None
    assert vs_by_test(thirty)["HRV_RMSSD"].value("VSSTAT") == "NOT DONE"
    sixty = run(vitals=[sample(0, hrv=40, hrv_conf=0.9, measured=True, window_s=60)])
    assert sixty.vitals.summary is not None and sixty.vitals.summary.hrv_median == 40.0
    assert vs_by_test(sixty)["HRV_RMSSD"].value("VSORRES") == 40.0


# --------------------------------------------------------------------------- #
# Measured vs simulated: the source label wins
# --------------------------------------------------------------------------- #


def test_mock_source_is_simulated_even_when_the_flag_says_measured() -> None:
    lying = sample(0, breathing=30, measured=True, source="mock")
    assert measured_flag_inconsistent(lying) and not effective_is_measured(lying)
    result = run(SOB2, vitals=[lying])
    assert result.vitals.status == "simulated_ignored"
    assert not any(r.startswith("corr.") for r in rule_ids(result))
    assert result.escalation_tier == 1
    vs = vs_by_test(result)
    for code in ("PULSE", "RESP"):
        assert vs[code].value("VSMETHOD") == "Simulated"
        assert vs[code].value("INTERIM_IS_MEASURED") is False
        assert vs[code].value("INTERIM_SOURCE") == "mock"
    ignored_rule = next(r for r in result.rules_fired if r.rule_id == "vitals.simulated_ignored")
    assert "the source label wins" in ignored_rule.description
    assert ignored_rule.inputs["measured_flag_inconsistent_samples"] == [lying.sample_id]
    summary_rule = next(r for r in result.rules_fired if r.rule_id == "vitals.summary")
    assert summary_rule.inputs["measured_flag_inconsistent_samples"] == [lying.sample_id]
    assert summary_rule.inputs["is_measured"] is False
    # With the demo toggle ON the sample becomes eligible, but it is still labeled simulated.
    toggled = run(SOB2, vitals=[lying], settings=ON)
    assert toggled.vitals.status == "ok" and toggled.escalation_tier == 2
    assert vs_by_test(toggled)["RESP"].value("VSMETHOD") == "Simulated"


def test_measured_source_with_flag_false_is_simulated_too() -> None:
    """The conservative direction: a real source whose flag says simulated stays simulated."""
    cautious = sample(0, breathing=30, measured=False, source="presage")
    assert not effective_is_measured(cautious) and not measured_flag_inconsistent(cautious)
    result = run(SOB2, vitals=[cautious])
    assert result.vitals.status == "simulated_ignored" and result.escalation_tier == 1
    assert vs_by_test(result)["RESP"].value("VSMETHOD") == "Simulated"


def test_not_done_rows_use_the_effective_measured_flag() -> None:
    """No usable reading at all: the VS labels still come from the source, not the flag."""
    lying = sample(0, pulse_conf=0.1, breathing_conf=0.1, measured=True, source="mock")
    result = run(vitals=[lying])
    vs = vs_by_test(result)
    assert vs["PULSE"].value("VSSTAT") == "NOT DONE"
    assert vs["PULSE"].value("VSMETHOD") == "Simulated"
    assert vs["PULSE"].value("INTERIM_IS_MEASURED") is False


def test_simulated_samples_are_summarized_but_ignored_for_corroboration() -> None:
    result = run(SOB2, vitals=[sample(0, breathing=30)])
    assert result.vitals.status == "simulated_ignored"
    assert "vitals.simulated_ignored" in rule_ids(result) and "vitals.summary" in rule_ids(result)
    assert result.vitals.summary is not None and result.vitals.summary.breathing_max == 30.0
    assert result.corroboration_bump == 0 and result.escalation_tier == 1
    vs = vs_by_test(result)
    assert vs["RESP"].value("VSMETHOD") == "Simulated"
    assert vs["RESP"].value("INTERIM_IS_MEASURED") is False


def test_toggle_treats_simulated_as_measured_with_a_warning() -> None:
    result = run(SOB2, vitals=[sample(0, breathing=30)], settings=ON)
    assert result.vitals.status == "ok"
    ids = rule_ids(result)
    assert "vitals.simulated_as_measured" in ids and "corr.tachypnea_dyspnea" in ids
    assert result.corroboration_bump == 1 and result.escalation_tier == 2
    assert grades(result)["shortness_of_breath"] == 2  # grade untouched
    warning = next(r for r in result.rules_fired if r.rule_id == "vitals.simulated_as_measured")
    assert warning.description.startswith("WARNING")
    assert vs_by_test(result)["RESP"].value("VSMETHOD") == "Simulated"  # label still says so


def test_min_confidence_override_from_settings() -> None:
    vitals = [sample(0, pulse_conf=0.5, breathing_conf=0.5, measured=True)]
    assert run(SOB2, vitals=vitals).vitals.status == "low_quality"
    lenient = run(SOB2, vitals=vitals, settings=RuleSettings(min_confidence=0.4))
    assert lenient.vitals.status == "ok"
    assert effective_min_confidence(RuleSettings()) == 0.6
    assert effective_min_confidence(RuleSettings(min_confidence=0.4)) == 0.4


def test_status_precedence_low_quality_beats_implausible() -> None:
    vitals = [sample(0, pulse=250, pulse_conf=0.2, breathing=None)]
    assert assess_vitals(vitals, RuleSettings()).status == "low_quality"


def test_summary_statistics_and_mixed_sources() -> None:
    vitals = [
        sample(0, pulse=70, breathing=12, hrv=40, hrv_conf=0.9, measured=True, window_s=60),
        sample(1, pulse=74, breathing=16, hrv=50, hrv_conf=0.9, measured=True, window_s=60),
        sample(2, pulse=90, breathing=20, measured=False, source="mock"),
    ]
    readings = classify_samples(vitals, RuleSettings())
    summary = build_summary(vitals, [r for r in readings if r.state == "usable"])
    assert summary is not None
    assert summary.n_samples == 3 and summary.n_eligible == 3
    assert summary.pulse_median == 74.0 and summary.pulse_max == 90.0
    assert summary.breathing_median == 16.0 and summary.breathing_max == 20.0
    assert summary.hrv_median == 45.0
    assert summary.is_measured is False and summary.source == "mixed"
    assert summary.first_ts == vitals[0].ts_utc and summary.last_ts == vitals[2].ts_utc
    assert build_summary(vitals, []) is None
    # Corroboration maxima only use measured samples when the toggle is off.
    maxima = corroboration_maxima(readings)
    assert maxima["pulse"].value == 74.0 and maxima["breathing"].value == 16.0
    assert maxima["pulse"].sample_id == vitals[1].sample_id


def test_hrv_row_is_drafted_only_when_present_and_never_implausible() -> None:
    result = run(vitals=[sample(0, hrv=5000, hrv_conf=0.9, measured=True, window_s=60)])
    vs = vs_by_test(result)
    assert set(vs) == {"PULSE", "RESP", "HRV_RMSSD"}
    assert vs["HRV_RMSSD"].value("VSORRES") == 5000.0
    assert vs["HRV_RMSSD"].value("VSORRESU") == "ms"
    without = run(vitals=[sample(0)])
    assert set(vs_by_test(without)) == {"PULSE", "RESP"}


def test_metric_absent_from_every_sample_gets_not_done_with_evidence() -> None:
    result = run(vitals=[sample(0, breathing=None, measured=True)])
    resp = vs_by_test(result)["RESP"]
    assert resp.value("VSSTAT") == "NOT DONE"
    field = next(f for f in resp.fields if f.name == "VSSTAT")
    assert field.evidence and "no breathing value" in field.evidence[0].note


# --------------------------------------------------------------------------- #
# Evidence economy: a long 1 Hz capture must not blow up the result
# --------------------------------------------------------------------------- #


def test_evidence_is_bounded_for_a_long_capture() -> None:
    n = 180  # a 3-minute check-in at 1 Hz
    vitals = [
        sample(i, measured=True, source="presage", ts=shift(T0, seconds=-n + i)) for i in range(n)
    ]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "ok" and len(result.vitals.eligible_sample_ids) == n
    text = json.dumps(result_to_dict(result))
    assert len(text) < 100_000, f"{len(text)} bytes for {n} samples"
    vs = vs_by_test(result)
    pulse = dict(vs)
    # VSORRES is a median: one pointer per reading plus the summary rule.
    assert len(_field(pulse, "PULSE", "VSORRES")) == n + 1
    # Everything else cites the summary rule and the first/last sample only.
    for name in ("VSMETHOD", "INTERIM_SOURCE", "INTERIM_IS_MEASURED", "INTERIM_N_SAMPLES"):
        ev = _field(pulse, "PULSE", name)
        assert len(ev) == 3, name
        assert {e.kind for e in ev} == {"rule", "vitals_sample"}
        assert [e.id for e in ev if e.kind == "vitals_sample"] == [
            vitals[0].sample_id,
            vitals[-1].sample_id,
        ]
    conf_ev = _field(pulse, "PULSE", "INTERIM_CONFIDENCE")
    assert len(conf_ev) == 3 and conf_ev[0].id == "vitals.summary"
    dtc_ev = _field(pulse, "PULSE", "VSDTC")
    assert [e.id for e in dtc_ev] == [vitals[-1].sample_id]
    assert vs["PULSE"].value("VSDTC") == vitals[-1].ts_utc
    summary_rule = next(r for r in result.rules_fired if r.rule_id == "vitals.summary")
    assert len(summary_rule.evidence) == 3
    assert summary_rule.inputs["first_sample_id"] == vitals[0].sample_id
    assert summary_rule.inputs["last_sample_id"] == vitals[-1].sample_id
    draft_rules = [r for r in result.rules_fired if r.rule_id == "draft.vs"]
    assert all(len(r.evidence) == 3 for r in draft_rules)


def test_single_sample_span_cites_one_pointer() -> None:
    result = run(vitals=[sample(0, measured=True)])
    method_ev = _field(vs_by_test(result), "PULSE", "VSMETHOD")
    assert [e.kind for e in method_ev] == ["rule", "vitals_sample"]
    assert "the only" in method_ev[1].note
    assert span_evidence([], "nothing") == ()
    two = span_evidence([("b", shift(T0, seconds=5)), ("a", T0)], "reading(s)")
    assert [e.id for e in two] == ["a", "b"] and two[0].note == "first of 2 reading(s)"


# --------------------------------------------------------------------------- #
# Corroboration rules and the +1 step
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("values", "pulse", "breathing", "expected_rule", "tier_before", "tier_after"),
    [
        (SOB2, 72.0, 24.0, "corr.tachypnea_dyspnea", 1, 2),
        (SOB2, 110.0, 14.0, "corr.tachycardia_dyspnea", 1, 2),
        (FEVER, 110.0, 14.0, "corr.tachycardia_fever", 0, 1),
        (SOB3, 72.0, 26.0, "corr.tachypnea_dyspnea", 2, 3),
    ],
)
def test_corroboration_raises_tier_by_one(
    values: dict[str, dict[str, int]],
    pulse: float,
    breathing: float,
    expected_rule: str,
    tier_before: int,
    tier_after: int,
) -> None:
    baseline = run(values)
    assert baseline.escalation_tier == tier_before
    result = run(values, vitals=[sample(0, measured=True, pulse=pulse, breathing=breathing)])
    ids = rule_ids(result)
    assert expected_rule in ids and "tier.corroboration_bump" in ids
    assert result.corroboration_bump == 1 and result.escalation_tier == tier_after
    assert grades(result) == grades(baseline)
    rule = next(r for r in result.rules_fired if r.rule_id == expected_rule)
    reason = rule.inputs["reason"]
    assert isinstance(reason, str) and reason in rule.description
    assert any(e.kind == "vitals_sample" for e in rule.evidence)
    if tier_after == 3:
        assert result.stop_screen and result.page_oncall


def test_thresholds_are_inclusive() -> None:
    assert run(SOB2, vitals=[sample(0, breathing=23.9, measured=True)]).escalation_tier == 1
    assert run(SOB2, vitals=[sample(0, breathing=24.0, measured=True)]).escalation_tier == 2
    assert run(SOB2, vitals=[sample(0, pulse=109.9, measured=True)]).escalation_tier == 1
    assert run(SOB2, vitals=[sample(0, pulse=110, measured=True)]).escalation_tier == 2


def test_two_corroboration_rules_still_bump_once() -> None:
    result = run(SOB2, vitals=[sample(0, pulse=120, breathing=30, measured=True)])
    ids = rule_ids(result)
    assert "corr.tachypnea_dyspnea" in ids and "corr.tachycardia_dyspnea" in ids
    assert ids.count("tier.corroboration_bump") == 1
    assert result.corroboration_bump == 1 and result.escalation_tier == 2


def test_corroboration_uses_the_session_maximum() -> None:
    vitals = [sample(i, breathing=14, measured=True) for i in range(5)] + [
        sample(9, breathing=25, measured=True)
    ]
    result = run(SOB2, vitals=vitals)
    assert "corr.tachypnea_dyspnea" in rule_ids(result)
    assert result.vitals.summary is not None and result.vitals.summary.breathing_median == 14.0


def test_simulated_values_never_raise_the_maximum() -> None:
    vitals = [sample(0, breathing=14, measured=True), sample(1, breathing=40, measured=False)]
    result = run(SOB2, vitals=vitals)
    assert result.vitals.status == "ok"
    assert "corr.tachypnea_dyspnea" not in rule_ids(result)
    assert result.vitals.summary is not None and result.vitals.summary.breathing_max == 40.0


def test_no_corroboration_without_a_reported_symptom() -> None:
    result = run(vitals=[sample(0, pulse=130, breathing=30, measured=True)])
    assert result.vitals.status == "ok"
    assert not any(r.startswith("corr.") for r in rule_ids(result))
    assert result.escalation_tier == 0


def test_mild_dyspnea_does_not_corroborate() -> None:
    result = run(
        {"shortness_of_breath": {"severity": 1}}, vitals=[sample(0, breathing=30, measured=True)]
    )
    assert "corr.tachypnea_dyspnea" not in rule_ids(result)


def test_capped_at_tier_three() -> None:
    from helpers import gates as make_gates

    hospital = build(SOB3, vitals=[sample(0, breathing=30, measured=True)])
    result = run(
        SOB3,
        gate_answers=make_gates(hospitalization=True),
        vitals=[sample(0, breathing=30, measured=True)],
    )
    assert result.escalation_tier == 3 and result.corroboration_bump == 1
    bump = next(r for r in result.rules_fired if r.rule_id == "tier.corroboration_bump")
    assert "capped" in bump.description and bump.inputs == {
        "before": 3,
        "after": 3,
        "bump": 1,
        "max_tier_bump": 1,
        "max_tier": 3,
    }
    assert hospital.completed_at == T0


def test_direct_sample_without_window_is_rejected_by_the_gate() -> None:
    """A hand-built dataclass with window_s 0 (the serialize default) never corroborates."""
    raw = VitalsSampleIn(
        sample_id=f"{SESSION}:raw",
        ts_utc=T0,
        source="presage",
        is_measured=True,
        pulse_bpm=None,
        pulse_conf=None,
        breathing_bpm=26.0,
        breathing_conf=0.85,
        hrv_rmssd_ms=None,
        hrv_conf=None,
        window_s=0.0,
        quality_flags=(),
    )
    result = run(SOB2, vitals=[raw])
    assert result.escalation_tier == 1 and result.vitals.status == "low_quality"
