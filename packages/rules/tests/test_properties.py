"""Property-style tests (hypothesis) for the invariants CLAUDE.md §8 asks for.

* raising any attribute never lowers the composite or the grade;
* vitals never change a grade;
* the tier is always 0..3, and corroboration adds at most one step;
* implausible, low-confidence or simulated (toggle off) vitals never fire corroboration;
* hospitalization always means Tier 3 plus a started SAE clock;
* every rule id is in the catalog and every valued draft field has evidence;
* inputs survive a JSON round trip and results are deterministic.
"""

from __future__ import annotations

import json
from collections.abc import Mapping

from helpers import SESSION, STUDY, SUBJECT, T0, responses_from_values
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from interim_rules import evaluate_checkin
from interim_rules.grading import grade_for_composite
from interim_rules.models import (
    Attribute,
    CheckInInput,
    GateAnswers,
    ItemResult,
    OpenAE,
    RuleSettings,
    VitalsSampleIn,
)
from interim_rules.scoring import composite_for_values
from interim_rules.serialize import input_from_dict, input_to_dict, result_to_dict
from interim_rules.tables import ItemDef, items, rules_catalog, vitals_config
from interim_rules.timefmt import shift

ITEMS = items()
MAX_EXAMPLES = 120
SETTINGS = settings(
    max_examples=MAX_EXAMPLES,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)


@st.composite
def attribute_values(draw: st.DrawFn, item: ItemDef) -> dict[Attribute, int]:
    return {attr: draw(st.integers(0, item.max_value(attr))) for attr in item.attributes}


@st.composite
def values_for(draw: st.DrawFn, item: ItemDef) -> dict[str, int]:
    return {str(attr): value for attr, value in draw(attribute_values(item)).items()}


@st.composite
def all_values(draw: st.DrawFn) -> dict[str, dict[str, int]]:
    return {item.id: draw(values_for(item)) for item in ITEMS}


@st.composite
def vitals_sample(draw: st.DrawFn, index: int) -> VitalsSampleIn:
    def maybe(strategy: st.SearchStrategy[float]) -> float | None:
        return draw(st.one_of(st.none(), strategy))

    return VitalsSampleIn(
        sample_id=f"{SESSION}:vs{index:04d}",
        ts_utc=shift(T0, seconds=-200 + index),
        source=draw(st.sampled_from(["mock", "presage", "arduino"])),
        is_measured=draw(st.booleans()),
        pulse_bpm=maybe(st.floats(0, 260, allow_nan=False)),
        pulse_conf=maybe(st.floats(0, 1, allow_nan=False)),
        breathing_bpm=maybe(st.floats(0, 70, allow_nan=False)),
        breathing_conf=maybe(st.floats(0, 1, allow_nan=False)),
        hrv_rmssd_ms=maybe(st.floats(0, 300, allow_nan=False)),
        hrv_conf=maybe(st.floats(0, 1, allow_nan=False)),
        window_s=draw(st.sampled_from([0.0, 12.0, 30.0, 60.0])),
        quality_flags=tuple(
            draw(st.lists(st.sampled_from(["motion", "talking", "low_light"]), max_size=2))
        ),
    )


@st.composite
def vitals_list(draw: st.DrawFn) -> tuple[VitalsSampleIn, ...]:
    n = draw(st.integers(0, 6))
    return tuple(draw(vitals_sample(i)) for i in range(n))


@st.composite
def gate_answers(draw: st.DrawFn) -> GateAnswers:
    changed = draw(st.booleans())
    return GateAnswers(
        hospitalization=draw(st.booleans()),
        hospitalization_answer_id=None,
        conmed_changed=changed,
        conmed_text=draw(
            st.one_of(st.none(), st.sampled_from(["", "advil", "Claritin", "loratadin", "xyz"]))
        ),
        conmed_direction=draw(
            st.one_of(st.none(), st.sampled_from(["started", "stopped", "both"]))
        ),
        conmed_answer_id=None,
        other_text=draw(st.one_of(st.none(), st.text(max_size=20))),
        other_answer_id=None,
        temp_c=draw(st.one_of(st.none(), st.floats(35, 41, allow_nan=False))),
        temp_answer_id=None,
    )


@st.composite
def open_aes(draw: st.DrawFn) -> tuple[OpenAE, ...]:
    out = []
    for i in range(draw(st.integers(0, 2))):
        days = draw(st.floats(0, 14, allow_nan=False))
        out.append(
            OpenAE(
                ae_open_id=f"AE{i}",
                aedecod=draw(st.sampled_from([it.ctcae_term for it in ITEMS])),
                first_reported_at=shift(T0, days=-days - 3),
                last_reported_at=shift(T0, days=-days),
                last_session_id=draw(st.sampled_from(["S0", SESSION])),
            )
        )
    return tuple(out)


@st.composite
def checkin_input(draw: st.DrawFn) -> CheckInInput:
    return CheckInInput(
        session_id=SESSION,
        studyid=STUDY,
        usubjid=SUBJECT,
        completed_at=T0,
        responses=responses_from_values(draw(all_values())),
        gates=draw(gate_answers()),
        vitals=draw(vitals_list()),
        open_aes=draw(open_aes()),
        settings=RuleSettings(
            simulated_as_measured=draw(st.booleans()),
            min_confidence=draw(st.one_of(st.none(), st.floats(0.1, 0.95, allow_nan=False))),
        ),
        next_aeseq=draw(st.integers(1, 50)),
        nct_id=draw(st.one_of(st.none(), st.just("NCT03088540"))),
    )


def _grades(result_items: tuple[ItemResult, ...]) -> dict[str, int]:
    return {it.item_id: it.provisional_grade for it in result_items}


@SETTINGS
@given(st.sampled_from(ITEMS), st.data())
def test_raising_an_attribute_never_lowers_composite_or_grade(
    item: ItemDef, data: st.DataObject
) -> None:
    values = data.draw(attribute_values(item))
    attr = data.draw(st.sampled_from(list(item.attributes)))
    if values[attr] >= item.max_value(attr):
        return
    base, _ = composite_for_values(item, values)
    higher, _ = composite_for_values(item, {**values, attr: values[attr] + 1})
    assert higher >= base
    assert grade_for_composite(higher) >= grade_for_composite(base)
    assert 0 <= higher <= 3


@SETTINGS
@given(checkin_input())
def test_tier_bounds_and_single_step_bump(inp: CheckInInput) -> None:
    result = evaluate_checkin(inp)
    assert 0 <= result.escalation_tier <= 3
    assert result.stop_screen == result.page_oncall == (result.escalation_tier == 3)
    assert result.corroboration_bump in (0, 1)
    assert result.escalation_tier <= max(result.base_tier, result.red_flag_tier_floor) + 1
    assert result.escalation_tier >= max(result.base_tier, result.red_flag_tier_floor)
    fired_corr = any(r.rule_id.startswith("corr.") for r in result.rules_fired)
    assert (result.corroboration_bump == 1) == fired_corr
    if fired_corr:
        assert result.vitals.status == "ok"
    assert all(0 <= it.provisional_grade <= 3 for it in result.items)
    assert result.max_grade == max(it.provisional_grade for it in result.items)


@SETTINGS
@given(checkin_input())
def test_vitals_never_change_a_grade(inp: CheckInInput) -> None:
    with_vitals = evaluate_checkin(inp)
    without = evaluate_checkin(
        CheckInInput(**{**inp.__dict__, "vitals": (), "settings": RuleSettings()})
    )
    assert _grades(with_vitals.items) == _grades(without.items)
    assert with_vitals.max_grade == without.max_grade
    assert with_vitals.red_flag_tier_floor == without.red_flag_tier_floor


@SETTINGS
@given(checkin_input())
def test_ineligible_vitals_never_fire_corroboration(inp: CheckInInput) -> None:
    """Make every sample ineligible in one of three ways; no corr.* rule may fire."""
    result = evaluate_checkin(inp)
    for rule in result.rules_fired:
        if rule.rule_id.startswith("corr."):
            assert result.vitals.status == "ok"
    # (a) all simulated, toggle off
    simulated = CheckInInput(
        **{
            **inp.__dict__,
            "vitals": tuple(
                VitalsSampleIn(**{**s.__dict__, "is_measured": False}) for s in inp.vitals
            ),
            "settings": RuleSettings(min_confidence=inp.settings.min_confidence),
        }
    )
    sim_result = evaluate_checkin(simulated)
    assert not any(r.rule_id.startswith("corr.") for r in sim_result.rules_fired)
    assert sim_result.vitals.status != "ok"
    # (b) all low confidence
    low = CheckInInput(
        **{
            **inp.__dict__,
            "vitals": tuple(
                VitalsSampleIn(
                    **{**s.__dict__, "pulse_conf": 0.1, "breathing_conf": 0.1, "hrv_conf": 0.1}
                )
                for s in inp.vitals
            ),
            "settings": RuleSettings(simulated_as_measured=True),
        }
    )
    low_result = evaluate_checkin(low)
    assert not any(r.rule_id.startswith("corr.") for r in low_result.rules_fired)
    assert low_result.vitals.status in ("unavailable", "low_quality")
    # (c) all implausible (pulse/breathing); hrv has no bounds, so drop it
    implausible = CheckInInput(
        **{
            **inp.__dict__,
            "vitals": tuple(
                VitalsSampleIn(
                    **{
                        **s.__dict__,
                        "pulse_bpm": 300.0,
                        "pulse_conf": 0.99,
                        "breathing_bpm": 80.0,
                        "breathing_conf": 0.99,
                        "hrv_rmssd_ms": None,
                        "is_measured": True,
                    }
                )
                for s in inp.vitals
            ),
        }
    )
    imp_result = evaluate_checkin(implausible)
    assert not any(r.rule_id.startswith("corr.") for r in imp_result.rules_fired)
    assert imp_result.vitals.status in ("unavailable", "implausible", "low_quality")
    assert imp_result.vitals.summary is None
    # (d) every window too short (the serialize default of 0 s)
    short = CheckInInput(
        **{
            **inp.__dict__,
            "vitals": tuple(
                VitalsSampleIn(**{**s.__dict__, "window_s": 0.0, "is_measured": True})
                for s in inp.vitals
            ),
        }
    )
    short_result = evaluate_checkin(short)
    assert not any(r.rule_id.startswith("corr.") for r in short_result.rules_fired)
    assert short_result.vitals.status in ("unavailable", "low_quality")
    assert short_result.vitals.summary is None
    # (e) every sample from a simulated source, whatever the flag says
    mock = CheckInInput(
        **{
            **inp.__dict__,
            "vitals": tuple(
                VitalsSampleIn(**{**s.__dict__, "source": "mock", "is_measured": True})
                for s in inp.vitals
            ),
            "settings": RuleSettings(min_confidence=inp.settings.min_confidence),
        }
    )
    mock_result = evaluate_checkin(mock)
    assert not any(r.rule_id.startswith("corr.") for r in mock_result.rules_fired)
    assert mock_result.vitals.status != "ok"


@SETTINGS
@given(checkin_input())
def test_hospitalization_means_tier_three_and_a_clock(inp: CheckInInput) -> None:
    hospital = CheckInInput(
        **{**inp.__dict__, "gates": GateAnswers(**{**inp.gates.__dict__, "hospitalization": True})}
    )
    result = evaluate_checkin(hospital)
    assert result.escalation_tier == 3 and result.stop_screen and result.page_oncall
    assert result.seriousness_suspected and result.sae_clock is not None
    assert result.sae_clock.site_awareness_at == T0
    assert result.sae_clock.due_at == shift(T0, hours=24)
    ids = [r.rule_id for r in result.rules_fired]
    assert "sae.clock_started" in ids and "redflag.hospitalization" in ids
    calm = CheckInInput(
        **{**inp.__dict__, "gates": GateAnswers(**{**inp.gates.__dict__, "hospitalization": False})}
    )
    calm_result = evaluate_checkin(calm)
    assert not calm_result.seriousness_suspected and calm_result.sae_clock is None


@SETTINGS
@given(checkin_input())
def test_catalog_evidence_and_draft_invariants(inp: CheckInInput) -> None:
    result = evaluate_checkin(inp)
    catalog = rules_catalog()
    for rule in result.rules_fired:
        assert rule.rule_id in catalog
        assert catalog[rule.rule_id].category == rule.category
        assert rule.evidence and rule.description
    assert result.why == tuple(r.description for r in result.rules_fired)
    graded = [it for it in result.items if it.provisional_grade >= 1]
    ae = [d for d in result.drafts if d.domain == "AE"]
    assert len(ae) == len(graded)
    assert [d.value("AESEQ") for d in ae] == list(range(inp.next_aeseq, inp.next_aeseq + len(ae)))
    assert all(d.value("AETOXGR") == it.provisional_grade for d, it in zip(ae, graded, strict=True))
    vs = [d for d in result.drafts if d.domain == "VS"]
    assert (len(vs) > 0) == bool(inp.vitals)
    cm = [d for d in result.drafts if d.domain == "CM"]
    # A "yes" to the con-med gate always yields exactly one CM draft, named or not.
    assert len(cm) == (1 if inp.gates.conmed_changed else 0)
    assert (result.conmed is not None) == inp.gates.conmed_changed
    simulated_sources = vitals_config().simulated_sources
    for draft in result.drafts:
        for field in draft.fields:
            if field.value is not None:
                assert field.evidence, (draft.domain, field.name)
        if draft.domain == "VS":
            assert draft.value("VSMETHOD") in ("Simulated", "Contactless optical, camera-based")
            assert (draft.value("VSSTAT") == "NOT DONE") == (draft.value("VSORRES") is None)
            # The source label wins: a simulated source is never labeled as measured.
            if draft.value("INTERIM_SOURCE") in simulated_sources:
                assert draft.value("VSMETHOD") == "Simulated"
                assert draft.value("INTERIM_IS_MEASURED") is False
            # Label and count fields are bounded in size whatever the capture length.
            for name in ("VSMETHOD", "INTERIM_SOURCE", "INTERIM_IS_MEASURED", "VSDTC"):
                assert len(next(f.evidence for f in draft.fields if f.name == name)) <= 3
    for draft in ae:
        assert draft.is_followup == (draft.linked_ae_open_id is not None)
        assert draft.is_followup == (draft.value("INTERIM_FOLLOWUP_OF") is not None)
        # An AE can never be a follow-up of an AE last reported by this very session.
        if draft.linked_ae_open_id is not None:
            linked = next(a for a in inp.open_aes if a.ae_open_id == draft.linked_ae_open_id)
            assert linked.last_session_id != inp.session_id


@SETTINGS
@given(checkin_input())
def test_round_trip_and_determinism(inp: CheckInInput) -> None:
    as_dict = input_to_dict(inp)
    rebuilt = input_from_dict(as_dict)
    assert rebuilt == inp
    first = evaluate_checkin(inp)
    second = evaluate_checkin(rebuilt)
    assert first == second
    payload: Mapping[str, object] = result_to_dict(first)
    json.dumps(payload, allow_nan=False)  # strict: no NaN/Infinity ever reaches the API
