"""Protocol-aware rules (CONTRACTS.md R3.1, CLAUDE.md §00.1): AESI, con-med levels, CM fields.

Every criterion and every con-med level is exercised through the real engine; the
property tests pin the three promises: the protocol never changes a grade, never lowers
a tier, and only suspects an AESI on items ``irae_mapping.json`` marks potentially
immune-related.
"""

from __future__ import annotations

import json
from collections.abc import Mapping

import pytest
from helpers import SESSION, T0, build, drafts, gates, merged_values, rule_ids, sample
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from interim_rules import evaluate_checkin
from interim_rules.engine import validate_input
from interim_rules.escalation import compute_tier
from interim_rules.models import (
    CheckInInput,
    CheckInResult,
    ConMedDirection,
    GateAnswers,
    OpenAE,
    ProtocolContext,
    RuleSettings,
)
from interim_rules.protocol import (
    assess_protocol,
    classify_conmed,
    cm_missing_fields,
    parse_last_dose_date,
    start_aesi_clock,
)
from interim_rules.serialize import input_from_dict, input_to_dict, result_to_dict
from interim_rules.seriousness import build_clock
from interim_rules.tables import (
    PROTOCOL_LEVELS,
    irae_mapping,
    items,
    protocol_rules,
    rules_catalog,
)
from interim_rules.timefmt import shift

PI3K = ProtocolContext(prior_pi3k_inhibitor=True)
NO_CONTEXT = ProtocolContext()
IMMUNE = {i for i, row in irae_mapping().items() if row.potentially_immune_related}
NOT_IMMUNE = {item.id for item in items()} - IMMUNE
ALWAYS_MISSING = ["CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC"]

G3_VALUES: dict[str, dict[str, int]] = {
    "shortness_of_breath": {"severity": 4, "interference": 4},
    "cough": {"severity": 4, "interference": 4},
    "fatigue": {"severity": 4, "interference": 4},
    "nausea": {"frequency": 4, "severity": 4},
    "diarrhea": {"frequency": 4},
    "itching": {"severity": 3},
    "joint_pain": {"severity": 4, "interference": 4},
    "mouth_sores": {"severity": 4, "interference": 4},
}
"""Answers that give provisional grade 3 for every item that can reach it."""
G2_VALUES: dict[str, dict[str, int]] = {
    "shortness_of_breath": {"severity": 2, "interference": 2},
    "cough": {"severity": 2, "interference": 2},
    "fatigue": {"severity": 2, "interference": 2},
    "nausea": {"frequency": 2, "severity": 2},
    "diarrhea": {"frequency": 3},
    "itching": {"severity": 2},
    "joint_pain": {"severity": 2, "interference": 2},
    "mouth_sores": {"severity": 2, "interference": 2},
}
G1_VALUES: dict[str, dict[str, int]] = {
    "shortness_of_breath": {"severity": 1, "interference": 0},
    "cough": {"severity": 1, "interference": 0},
    "fatigue": {"severity": 1, "interference": 1},
    "nausea": {"frequency": 1, "severity": 1},
    "diarrhea": {"frequency": 1},
    "rash": {"presence": 1},
    "itching": {"severity": 1},
    "joint_pain": {"severity": 1, "interference": 0},
    "fever_or_chills": {"presence": 1},
    "mouth_sores": {"severity": 1, "interference": 0},
}


def run_ctx(
    values: Mapping[str, Mapping[str, int]] | None = None,
    *,
    context: ProtocolContext = NO_CONTEXT,
    conmed: str | None = None,
    direction: ConMedDirection | None = "started",
    hospitalization: bool = False,
    vitals: tuple[object, ...] = (),
    settings_: RuleSettings | None = None,
) -> CheckInResult:
    inp = build(
        values,
        gate_answers=gates(
            hospitalization=hospitalization,
            conmed_changed=conmed is not None,
            conmed_text=conmed,
            conmed_direction=direction if conmed is not None else None,
        ),
        vitals=vitals,  # type: ignore[arg-type]
        settings=settings_,
    )
    return evaluate_checkin(_with_context(inp, context))


def _with_context(inp: CheckInInput, context: ProtocolContext) -> CheckInInput:
    data = input_to_dict(inp)
    data["protocol_context"] = {
        "prior_pi3k_inhibitor": context.prior_pi3k_inhibitor,
        "last_dose_date": context.last_dose_date,
        "new_anticancer_therapy_date": context.new_anticancer_therapy_date,
    }
    return input_from_dict(data)


def cm(result: CheckInResult) -> Mapping[str, object]:
    (draft,) = drafts(result, "CM")
    return {f.name: f.value for f in draft.fields}


def assert_evidence_complete(result: CheckInResult) -> None:
    for draft in result.drafts:
        for field in draft.fields:
            if field.value is not None:
                assert field.evidence, (draft.domain, field.name)
                assert all(e.id and e.note for e in field.evidence), (draft.domain, field.name)
    for rule in result.rules_fired:
        assert rule.evidence, rule.rule_id
        assert rule.rule_id in rules_catalog(), rule.rule_id


# --------------------------------------------------------------------------- #
# AESI criteria
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("item_id", sorted(G3_VALUES))
def test_grade3_aesi_only_on_potentially_immune_related_items(item_id: str) -> None:
    result = run_ctx({item_id: G3_VALUES[item_id]})
    assert result.items[[i.item_id for i in result.items].index(item_id)].provisional_grade == 3
    assert result.protocol is not None
    expected = item_id in IMMUNE
    assert result.protocol.aesi_suspected is expected
    assert (result.aesi_clock is not None) is expected
    assert ("protocol.aesi_suspected" in rule_ids(result)) is expected
    assert ("aesi.clock_started" in rule_ids(result)) is expected
    # G3 -> tier 2 with or without the AESI (severe dyspnea is also a tier-3 red flag).
    assert result.escalation_tier == (3 if item_id == "shortness_of_breath" else 2)
    assert result.sae_clock is None
    (ae,) = drafts(result, "AE")
    assert (ae.value("INTERIM_AESI_SUSPECTED") is True) is expected
    assert_evidence_complete(result)


@pytest.mark.parametrize("item_id", sorted(G2_VALUES))
def test_grade2_is_not_an_aesi_without_pi3k_history(item_id: str) -> None:
    """The AESI boundary: grade 2 never, grade 3 always (on an immune-related item)."""
    result = run_ctx({item_id: G2_VALUES[item_id]})
    assert max(i.provisional_grade for i in result.items) == 2
    assert result.protocol is not None and not result.protocol.aesi_suspected
    assert result.aesi_clock is None
    assert all(f.name != "INTERIM_AESI_SUSPECTED" for d in result.drafts for f in d.fields)


@pytest.mark.parametrize("item_id", sorted(G1_VALUES))
def test_any_grade_aesi_after_a_pi3k_inhibitor(item_id: str) -> None:
    with_pi3k = run_ctx({item_id: G1_VALUES[item_id]}, context=PI3K)
    without = run_ctx({item_id: G1_VALUES[item_id]})
    assert with_pi3k.protocol is not None and without.protocol is not None
    assert without.protocol.aesi_suspected is False
    assert with_pi3k.protocol.aesi_suspected is (item_id in IMMUNE)
    if item_id in IMMUNE:
        assert with_pi3k.protocol.aesi_items == (item_id,)
        assert "PI 3-K inhibitor" in with_pi3k.protocol.aesi_reasons[0]
        assert "provisional, investigator to confirm" in with_pi3k.protocol.aesi_reasons[0]
    assert with_pi3k.escalation_tier == without.escalation_tier == 0
    assert [i.provisional_grade for i in with_pi3k.items] == [
        i.provisional_grade for i in without.items
    ]


def test_aesi_clock_uses_the_sae_machinery_with_kind_aesi() -> None:
    result = run_ctx({"diarrhea": {"frequency": 4}})
    clock = result.aesi_clock
    assert clock is not None and clock.kind == "aesi"
    assert clock.site_awareness_at == T0
    assert clock.due_at == shift(T0, hours=protocol_rules().aesi.reporting_hours)
    assert clock.informational["label"] == "possible AESI, investigator to confirm"
    assert "9.4.3" in clock.informational["protocol_ref"]
    rule = next(r for r in result.rules_fired if r.rule_id == "aesi.clock_started")
    assert rule.inputs["due_at"] == clock.due_at and rule.category == "protocol"
    aesi_rule = next(r for r in result.rules_fired if r.rule_id == "protocol.aesi_suspected")
    assert "possible AESI, investigator to confirm" in aesi_rule.description
    assert "provisional, investigator to confirm" in aesi_rule.description
    assert "Grade 3 or greater irAEs" in aesi_rule.description
    (ae,) = drafts(result, "AE")
    rules = ae.value("INTERIM_RULES_FIRED")
    assert isinstance(rules, list)
    assert "protocol.aesi_suspected" in rules and "aesi.clock_started" in rules


def test_hospitalization_and_aesi_start_both_clocks() -> None:
    result = run_ctx({"diarrhea": {"frequency": 4}}, hospitalization=True)
    assert result.sae_clock is not None and result.sae_clock.kind == "sae"
    assert result.aesi_clock is not None and result.aesi_clock.kind == "aesi"
    assert result.escalation_tier == 3
    data = result_to_dict(result)
    assert data["sae_clock"]["kind"] == "sae" and data["aesi_clock"]["kind"] == "aesi"


def test_aesi_reason_lists_every_item_in_instrument_order() -> None:
    result = run_ctx({"itching": {"severity": 3}, "diarrhea": {"frequency": 4}})
    assert result.protocol is not None
    assert result.protocol.aesi_items == ("diarrhea", "itching")
    flagged = [
        d.value("AEDECOD") for d in drafts(result, "AE") if d.value("INTERIM_AESI_SUSPECTED")
    ]
    assert flagged == ["Diarrhea", "Pruritus"]


def test_start_aesi_clock_does_nothing_without_suspicion() -> None:
    result = run_ctx()
    assert result.protocol is not None
    assert start_aesi_clock(result.protocol, T0) == (None, ())


def test_build_clock_keeps_its_old_behavior_and_needs_hours_for_aesi() -> None:
    sae = build_clock(T0)
    assert sae.kind == "sae" and sae.due_at == shift(T0, hours=24)
    assert "sponsor_other_serious_due" in sae.informational
    with pytest.raises(ValueError, match="hours"):
        build_clock(T0, kind="aesi")


# --------------------------------------------------------------------------- #
# Con-med levels
# --------------------------------------------------------------------------- #


def _all_names(level: str) -> list[tuple[str, str]]:
    return [
        (drug.drug, name)
        for drug in protocol_rules().drugs
        if drug.level == level
        for name in (*drug.names, *drug.match_terms)
    ]


@pytest.mark.parametrize(("drug", "typed"), _all_names("prohibited"))
def test_every_prohibited_name_floors_the_tier_at_2(drug: str, typed: str) -> None:
    result = run_ctx({"fatigue": G1_VALUES["fatigue"]}, conmed=typed.upper())
    assert result.base_tier == 0 and result.red_flag_tier_floor == 0
    assert result.protocol_tier_floor == 2 and result.escalation_tier == 2
    ids = rule_ids(result)
    assert "protocol.conmed_prohibited" in ids and "tier.protocol_floor" in ids
    fields = cm(result)
    assert fields["INTERIM_PROTOCOL_FLAG"] == "prohibited"
    assert fields["CMTRT"] == typed.upper()
    is_category = next(d for d in protocol_rules().drugs if d.drug == drug).is_category
    assert fields["CMDECOD"] == (None if is_category else drug)
    rule = next(r for r in result.rules_fired if r.rule_id == "protocol.conmed_prohibited")
    assert "possible protocol deviation, coordinator to confirm" in rule.description.lower()
    assert result.stop_screen is False
    assert_evidence_complete(result)


@pytest.mark.parametrize(("drug", "typed"), _all_names("discouraged"))
def test_every_discouraged_name_flags_without_moving_the_tier(drug: str, typed: str) -> None:
    result = run_ctx({"cough": G1_VALUES["cough"]}, conmed=f"{typed} 10 mg")
    assert result.escalation_tier == 0 and result.protocol_tier_floor == 0
    assert result.protocol is not None
    (flag,) = result.protocol.conmed_flags
    assert (flag.level, flag.drug) == ("discouraged", drug)
    assert flag.exception_text == (
        "except in the case of a life-threatening emergency and/or to treat an irAE."
    )
    rule = next(r for r in result.rules_fired if r.rule_id == "protocol.conmed_discouraged")
    assert flag.exception_text in rule.description and "tier unchanged" in rule.description
    assert cm(result)["INTERIM_PROTOCOL_FLAG"] == "discouraged"
    assert "tier.protocol_floor" not in rule_ids(result)
    assert_evidence_complete(result)


@pytest.mark.parametrize(("drug", "typed"), _all_names("permitted"))
def test_every_permitted_name_is_informational(drug: str, typed: str) -> None:
    result = run_ctx(conmed=f"started {typed} last week")
    assert result.escalation_tier == 0
    assert result.protocol is not None
    (flag,) = result.protocol.conmed_flags
    assert (flag.level, flag.drug) == ("permitted", drug)
    assert "protocol.conmed_permitted" in rule_ids(result)
    assert cm(result)["INTERIM_PROTOCOL_FLAG"] == "permitted"
    if drug == "pemetrexed":
        assert (
            flag.condition == "Pemetrexed maintenance therapy is permitted for non-squamous NSCLC."
        )
        rule = next(r for r in result.rules_fired if r.rule_id == "protocol.conmed_permitted")
        assert "non-squamous" in rule.description


def test_unlisted_medication_has_no_flag_but_missing_fields() -> None:
    result = run_ctx(conmed="loratadine")
    fields = cm(result)
    assert fields["INTERIM_PROTOCOL_FLAG"] is None
    assert fields["INTERIM_CM_MISSING_FIELDS"] == ALWAYS_MISSING
    ids = rule_ids(result)
    assert not any(i.startswith("protocol.conmed_") for i in ids)
    assert "protocol.cm_fields_missing" in ids
    flag_field = next(
        f for f in drafts(result, "CM")[0].fields if f.name == "INTERIM_PROTOCOL_FLAG"
    )
    assert flag_field.evidence == ()


def test_no_conmed_change_means_no_cm_rules() -> None:
    result = run_ctx({"cough": G1_VALUES["cough"]})
    assert result.protocol is not None
    assert result.protocol.conmed_flags == () and result.protocol.cm_missing_fields == ()
    assert not any(i.startswith("protocol.") for i in rule_ids(result))


def test_topical_corticosteroid_is_not_flagged_and_says_why() -> None:
    for text in ("hydrocortisone cream", "Prednisolone eye drops", "dexamethasone nasal spray"):
        result = run_ctx(conmed=text)
        assert result.protocol is not None
        assert result.protocol.conmed_flags == (), text
        assert result.protocol.conmed_flag is None
        assert "systemic" in result.protocol.conmed_notes[0], text
        assert cm(result)["INTERIM_PROTOCOL_FLAG"] is None


def test_qualifier_does_not_hide_a_prohibited_drug() -> None:
    """Only discouraged (systemic-only) entries honor the topical qualifiers."""
    result = run_ctx(conmed="avastin gel")
    assert result.protocol_tier_floor == 2


def test_typed_name_wins_over_a_fuzzy_medlist_neighbour() -> None:
    """'prednisolone' is a Levenshtein neighbour of the medlist's 'prednisone'; flag it once."""
    result = run_ctx(conmed="prednisolone")
    assert result.conmed is not None and result.conmed.matched_name == "prednisone"
    assert result.protocol is not None
    assert [f.drug for f in result.protocol.conmed_flags] == ["prednisolone"]
    assert result.protocol.conmed_flags[0].matched_by == "verbatim_name"


def test_typed_protocol_name_beats_a_fuzzy_medlist_neighbour_for_cmdecod() -> None:
    """The CM draft must not say CMDECOD='prednisone' while the flag says prednisolone."""
    result = run_ctx(conmed="prednisolone")
    fields = cm(result)
    assert fields["CMDECOD"] == "prednisolone"
    assert fields["INTERIM_MATCH_KIND"] == "levenshtein"  # the medlist result is still shown
    assert fields["INTERIM_PROTOCOL_FLAG"] == "discouraged"
    (draft,) = drafts(result, "CM")
    decod = next(f for f in draft.fields if f.name == "CMDECOD")
    assert any("edit-distance match" in e.note for e in decod.evidence)
    draft_rule = next(r for r in result.rules_fired if r.rule_id == "draft.cm")
    assert draft_rule.inputs["cmdecod"] == "prednisolone"
    assert "edit-distance neighbour 'prednisone'" in draft_rule.description
    assert_evidence_complete(result)


def test_exact_medlist_match_keeps_its_cmdecod() -> None:
    fields = cm(run_ctx(conmed="prednisone"))
    assert fields["CMDECOD"] == "prednisone" and fields["INTERIM_MATCH_KIND"] != "levenshtein"


def test_medlist_match_alone_is_enough() -> None:
    flags, notes = classify_conmed("solumedrl", matched_name="methylprednisolone")
    assert [(f.drug, f.matched_by) for f in flags] == [("methylprednisolone", "medlist")]
    assert notes == ()
    assert classify_conmed("   ", matched_name="prednisone") == ((), ())


def test_words_match_whole_words_only() -> None:
    assert classify_conmed("gelatin capsules")[0] == ()
    assert classify_conmed("prednisonex")[0] == ()
    assert [f.drug for f in classify_conmed("Solu-Medrol IV")[0]] == ["methylprednisolone"]


def test_two_drugs_most_restrictive_first() -> None:
    result = run_ctx(conmed="Xgeva and Avastin")
    assert result.protocol is not None
    assert [f.level for f in result.protocol.conmed_flags] == ["prohibited", "permitted"]
    assert result.protocol.conmed_flag == "prohibited"
    assert cm(result)["INTERIM_PROTOCOL_FLAG"] == "prohibited"


def test_stopped_prohibited_drug_still_floors() -> None:
    """Stopping it since the last visit means it was taken during the study."""
    result = run_ctx(conmed="bevacizumab", direction="stopped")
    assert result.escalation_tier == 2
    rule = next(r for r in result.rules_fired if r.rule_id == "protocol.conmed_prohibited")
    assert rule.inputs["direction"] == "stopped"


def test_protocol_floor_never_lowers_a_red_flag_or_grade_tier() -> None:
    red = run_ctx({"shortness_of_breath": {"severity": 3, "interference": 3}}, conmed="bevacizumab")
    assert red.escalation_tier == 3 and red.protocol_tier_floor == 2
    assert "tier.protocol_floor" not in rule_ids(red)
    g3 = run_ctx({"fatigue": G3_VALUES["fatigue"]}, conmed="bevacizumab")
    assert g3.escalation_tier == 2 and "tier.protocol_floor" not in rule_ids(g3)


def test_vitals_bump_applies_after_the_protocol_floor() -> None:
    vitals = tuple(sample(i, breathing=26.0, measured=True) for i in range(6))
    dyspnea = {"shortness_of_breath": {"severity": 2, "interference": 2}}
    without = run_ctx(dyspnea, vitals=vitals)
    with_floor = run_ctx(dyspnea, vitals=vitals, conmed="bevacizumab")
    assert without.escalation_tier == 2 and without.corroboration_bump == 1
    assert with_floor.escalation_tier == 3 and with_floor.corroboration_bump == 1
    ids = rule_ids(with_floor)
    assert ids.index("tier.protocol_floor") < ids.index("tier.corroboration_bump")
    final = next(r for r in with_floor.rules_fired if r.rule_id == "tier.final")
    assert any(e.id == "tier.protocol_floor" for e in final.evidence)


def test_compute_tier_protocol_floor_directly() -> None:
    outcome = compute_tier(
        max_grade=1,
        grade_rule_ids=["grade.provisional.cough"],
        red_flag_floor=0,
        red_flag_rule_ids=[],
        corroboration_bump=0,
        corroboration_rule_ids=[],
        protocol_floor=2,
        protocol_rule_ids=["protocol.conmed_prohibited"],
    )
    assert outcome.final_tier == 2 and outcome.protocol_floor == 2
    floor_rule = next(r for r in outcome.rules_fired if r.rule_id == "tier.protocol_floor")
    assert floor_rule.evidence[0].id == "protocol.conmed_prohibited"


# --------------------------------------------------------------------------- #
# CM completeness
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("direction", "text", "missing"),
    [
        ("started", "ibuprofen", ALWAYS_MISSING),
        ("stopped", "ibuprofen", [*ALWAYS_MISSING, "CMSTDTC"]),
        ("both", "ibuprofen", ALWAYS_MISSING),
        (None, "ibuprofen", [*ALWAYS_MISSING, "CMSTDTC", "CMENDTC"]),
        ("started", "", ["CMTRT", *ALWAYS_MISSING]),
    ],
)
def test_cm_missing_fields_follow_as_appropriate(
    direction: ConMedDirection | None, text: str, missing: list[str]
) -> None:
    gate = gates(conmed_changed=True, conmed_text=text, conmed_direction=direction)
    order = list(protocol_rules().cm_required_fields)
    assert list(cm_missing_fields(gate)) == sorted(missing, key=order.index)
    result = run_ctx(conmed=text, direction=direction)
    assert cm(result)["INTERIM_CM_MISSING_FIELDS"] == sorted(missing, key=order.index)
    rule = next(r for r in result.rules_fired if r.rule_id == "protocol.cm_fields_missing")
    assert "§7.7, p. 69" in rule.description and "Coordinator to ask" in rule.description
    if not text:
        assert "no name typed" in rule.description


# --------------------------------------------------------------------------- #
# AE reporting window, context validation, serialization
# --------------------------------------------------------------------------- #


def test_ae_reporting_window_is_informational() -> None:
    inside = run_ctx({"cough": G1_VALUES["cough"]}, context=ProtocolContext(False, "2026-09-01"))
    outside = run_ctx({"cough": G1_VALUES["cough"]}, context=ProtocolContext(False, "2026-07-01"))
    unknown = run_ctx({"cough": G1_VALUES["cough"]})
    assert inside.protocol is not None and outside.protocol is not None
    assert unknown.protocol is not None
    assert inside.protocol.ae_reporting_window_end == "2026-11-30"
    assert inside.protocol.within_ae_reporting_window is True
    assert outside.protocol.ae_reporting_window_end == "2026-09-29"
    assert outside.protocol.within_ae_reporting_window is False
    assert len(drafts(outside, "AE")) == 1  # never suppresses a draft
    assert unknown.protocol.ae_reporting_window_end is None
    assert unknown.protocol.within_ae_reporting_window is None


def test_window_without_completed_at_and_parse_errors() -> None:
    result = run_ctx()
    assessment = assess_protocol(
        result.items, None, gates(), ProtocolContext(last_dose_date="2026-10-01")
    )
    assert assessment.ae_reporting_window_end == "2026-12-30"
    assert assessment.within_ae_reporting_window is None
    assert parse_last_dose_date(None) is None
    assert str(parse_last_dose_date("2026-10-01T00:00:00Z")) == "2026-10-01"
    with pytest.raises(ValueError, match="YYYY-MM-DD"):
        parse_last_dose_date("10/01/2026")


def test_validate_input_rejects_a_bad_last_dose_date() -> None:
    inp = _with_context(build(), ProtocolContext(False, "not a date"))
    with pytest.raises(ValueError, match="protocol_context.last_dose_date"):
        validate_input(inp)


def test_assess_protocol_accepts_a_finished_result() -> None:
    result = run_ctx({"itching": {"severity": 3}}, conmed="Avastin", context=PI3K)
    assert result.protocol is not None
    again = assess_protocol(
        result,
        result.conmed,
        result_gates(),
        PI3K,
        completed_at=T0,
        gate_ids={"conmed_text": f"{SESSION}:gate_conmed"},
    )
    assert again == result.protocol


def result_gates() -> GateAnswers:
    return gates(conmed_changed=True, conmed_text="Avastin", conmed_direction="started")


def test_conmed_without_a_match_object_uses_the_gate_text() -> None:
    gate = gates(conmed_changed=True, conmed_text="Portrazza", conmed_direction="started")
    assessment = assess_protocol((), None, gate, ProtocolContext())
    assert assessment.tier_floor == 2 and assessment.conmed_flags[0].drug == "necitumumab"


def test_serialization_round_trip_and_old_keys() -> None:
    inp = _with_context(
        build({"rash": {"presence": 1}}), ProtocolContext(prior_pi3k_inhibitor=True)
    )
    assert input_from_dict(input_to_dict(inp)) == inp
    camel = input_to_dict(inp)
    camel["protocolContext"] = {"priorPi3kInhibitor": True, "lastDoseDate": "2026-10-01"}
    del camel["protocol_context"]
    rebuilt = input_from_dict(camel)
    assert rebuilt.protocol_context == ProtocolContext(True, "2026-10-01")
    legacy = input_to_dict(build())
    del legacy["protocol_context"]
    assert input_from_dict(legacy).protocol_context == ProtocolContext()

    data = result_to_dict(evaluate_checkin(inp))
    json.dumps(data, allow_nan=False)
    for key in ("escalation_tier", "sae_clock", "conmed", "drafts", "rules_fired", "why"):
        assert key in data
    assert data["protocol"]["aesi_suspected"] is True and data["aesi_clock"]["kind"] == "aesi"
    assert data["protocol_tier_floor"] == 0


@pytest.mark.parametrize("bad", [["x"], {"prior_pi3k_inhibitor": "yes"}, {"priorPi3kInhibitor": 1}])
def test_bad_protocol_context_is_rejected(bad: object) -> None:
    data = input_to_dict(build())
    data["protocol_context"] = bad
    with pytest.raises(ValueError, match="protocol_context"):
        input_from_dict(data)


# --------------------------------------------------------------------------- #
# Properties
# --------------------------------------------------------------------------- #

PROPS = settings(
    max_examples=80,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)
CONMED_POOL = [
    None,
    "loratadine",
    "bevacizumab",
    "Avastin",
    "prednisone",
    "hydrocortisone cream",
    "Xgeva",
    "joined another trial",
    "",
]


@st.composite
def answers(draw: st.DrawFn) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for item in items():
        out[item.id] = {
            attr: draw(st.integers(0, item.max_value(attr))) for attr in item.attributes
        }
    return out


@PROPS
@given(
    values=answers(),
    conmed=st.sampled_from(CONMED_POOL),
    pi3k=st.booleans(),
    hospital=st.booleans(),
)
def test_protocol_properties(
    values: dict[str, dict[str, int]], conmed: str | None, pi3k: bool, hospital: bool
) -> None:
    context = ProtocolContext(prior_pi3k_inhibitor=pi3k)
    result = run_ctx(values, context=context, conmed=conmed, hospitalization=hospital)
    baseline = run_ctx(values, hospitalization=hospital)
    protocol = result.protocol
    assert protocol is not None

    # 1. Never changes a grade.
    assert [i.provisional_grade for i in result.items] == [
        i.provisional_grade for i in baseline.items
    ]
    # 2. Never lowers a tier: at least the no-medication, no-context tier; floors respected.
    assert result.escalation_tier >= baseline.escalation_tier
    assert result.escalation_tier >= max(
        result.base_tier, result.red_flag_tier_floor, result.protocol_tier_floor
    )
    assert result.escalation_tier <= 3
    assert result.protocol_tier_floor in (0, 2)
    if not any(f.level == "prohibited" for f in protocol.conmed_flags):
        assert result.escalation_tier == baseline.escalation_tier
    # 3. AESI only on mapped items, exactly per the criteria.
    grades = {i.item_id: i.provisional_grade for i in result.items}
    assert set(protocol.aesi_items) <= IMMUNE
    expected = {
        item_id for item_id in IMMUNE if grades[item_id] >= 3 or (pi3k and grades[item_id] >= 1)
    }
    assert set(protocol.aesi_items) == expected
    assert (result.aesi_clock is not None) is bool(expected)
    flagged = {
        str(d.value("AEDECOD")) for d in drafts(result, "AE") if d.value("INTERIM_AESI_SUSPECTED")
    }
    by_item = {i.item_id: i.aedecod for i in result.items}
    assert flagged == {by_item[i] for i in expected}
    # 4. The SAE clock is untouched by the protocol rules.
    assert (result.sae_clock is not None) is hospital
    assert (baseline.sae_clock is None) is (result.sae_clock is None)
    assert_evidence_complete(result)


def test_protocol_levels_are_ordered_most_restrictive_first() -> None:
    assert PROTOCOL_LEVELS == ("prohibited", "discouraged", "permitted")
    assert NOT_IMMUNE == {"cough", "nausea", "fever_or_chills", "mouth_sores"}
    assert merged_values({"rash": {"presence": 1}})["rash"] == {"presence": 1}


def test_legacy_callers_still_work() -> None:
    """build_cm_draft without a protocol assessment and build_input with a context object."""
    from interim_rules.conmed import match_conmed
    from interim_rules.drafting import build_cm_draft
    from interim_rules.serialize import build_input, protocol_context_from

    inp = build(
        gate_answers=gates(conmed_changed=True, conmed_text="Avastin", conmed_direction="started")
    )
    draft, rule = build_cm_draft(inp, match_conmed("Avastin"), f"{SESSION}:gate_conmed")
    names = [f.name for f in draft.fields]
    assert "INTERIM_PROTOCOL_FLAG" not in names and draft.value("CMDECOD") is None
    assert rule.inputs["protocol_flag"] is None
    context = ProtocolContext(prior_pi3k_inhibitor=True)
    assert protocol_context_from(context) is context
    rebuilt = build_input(
        session_id=SESSION,
        studyid="S",
        usubjid="U",
        completed_at=T0,
        responses={},
        gates={},
        protocol_context=context,
    )
    assert rebuilt.protocol_context == context


# --------------------------------------------------------------------------- #
# Integration fixes (stage 1): one AESI clock per event; new-therapy window clause
# --------------------------------------------------------------------------- #


def _open_diarrhea(*, clocked: bool) -> OpenAE:
    return OpenAE(
        "AE-DIA-1",
        "Diarrhea",
        shift(T0, days=-2),
        shift(T0, days=-2),
        "S-PREV",
        aesi_clock_started=clocked,
    )


def test_followup_of_an_ae_with_an_aesi_clock_starts_no_second_clock() -> None:
    values = {"diarrhea": G3_VALUES["diarrhea"]}
    repeat = evaluate_checkin(build(values, open_aes=[_open_diarrhea(clocked=True)]))
    assert repeat.protocol is not None and repeat.protocol.aesi_suspected
    assert repeat.aesi_clock is None
    ids = [r.rule_id for r in repeat.rules_fired]
    assert "aesi.clock_not_restarted" in ids and "aesi.clock_started" not in ids
    rule = next(r for r in repeat.rules_fired if r.rule_id == "aesi.clock_not_restarted")
    assert rule.inputs["ae_open_ids"] == ["AE-DIA-1"] and rule.inputs["labels"] == [
        "Diarrhea or loose stools"
    ]
    assert "one event, one clock" in rule.description
    (ae,) = drafts(repeat, "AE")
    assert ae.is_followup and ae.value("INTERIM_AESI_SUSPECTED") is True
    assert_evidence_complete(repeat)

    first_clock = evaluate_checkin(build(values, open_aes=[_open_diarrhea(clocked=False)]))
    assert first_clock.aesi_clock is not None and first_clock.aesi_clock.kind == "aesi"
    assert "aesi.clock_not_restarted" not in rule_ids(first_clock)


def test_a_new_aesi_item_still_starts_a_clock_next_to_a_clocked_followup() -> None:
    values = {"diarrhea": G3_VALUES["diarrhea"], "itching": G3_VALUES["itching"]}
    result = evaluate_checkin(build(values, open_aes=[_open_diarrhea(clocked=True)]))
    assert result.aesi_clock is not None
    started = next(r for r in result.rules_fired if r.rule_id == "aesi.clock_started")
    assert started.inputs["aesi_items"] == ["itching"]
    ids = [r.rule_id for r in result.rules_fired]
    assert ids.index("aesi.clock_not_restarted") < ids.index("aesi.clock_started")


def test_open_ae_aesi_flag_serializes() -> None:
    inp = build(open_aes=[_open_diarrhea(clocked=True)])
    data = input_to_dict(inp)
    assert data["open_aes"][0]["aesi_clock_started"] is True
    assert input_from_dict(data) == inp
    data["open_aes"][0] = {k: v for k, v in data["open_aes"][0].items()
                           if k != "aesi_clock_started"}  # fmt: skip
    assert input_from_dict(data).open_aes[0].aesi_clock_started is False
    data["open_aes"][0]["aesiClockStarted"] = "yes"
    with pytest.raises(ValueError, match="aesi_clock_started"):
        input_from_dict(data)


def test_new_anticancer_therapy_ends_the_window_when_earlier() -> None:
    cough = {"cough": G1_VALUES["cough"]}
    earlier = run_ctx(cough, context=ProtocolContext(False, "2026-09-01", "2026-09-21"))
    later = run_ctx(cough, context=ProtocolContext(False, "2026-09-01", "2027-01-15"))
    therapy_only = run_ctx(cough, context=ProtocolContext(False, None, "2026-09-21"))
    assert earlier.protocol is not None and later.protocol is not None
    assert therapy_only.protocol is not None
    assert earlier.protocol.ae_reporting_window_end == "2026-09-21"
    assert earlier.protocol.within_ae_reporting_window is False
    assert later.protocol.ae_reporting_window_end == "2026-11-30"
    assert later.protocol.within_ae_reporting_window is True
    assert therapy_only.protocol.ae_reporting_window_end is None
    assert len(drafts(earlier, "AE")) == 1  # still informational only
    quote = protocol_rules().ae_reporting_window.quote
    assert "whichever is earlier" in quote and "another anti-cancer systemic therapy" in quote


def test_new_anticancer_therapy_date_is_validated_and_serialized() -> None:
    inp = _with_context(build(), ProtocolContext(False, "2026-09-01", "2026-09-21"))
    assert input_from_dict(input_to_dict(inp)).protocol_context.new_anticancer_therapy_date == (
        "2026-09-21"
    )
    data = input_to_dict(build())
    data["protocolContext"] = {"newAnticancerTherapyDate": "2026-09-21"}
    data.pop("protocol_context", None)
    assert input_from_dict(data).protocol_context.new_anticancer_therapy_date == "2026-09-21"
    bad = _with_context(build(), ProtocolContext(False, None, "21/09/2026"))
    with pytest.raises(ValueError, match="new_anticancer_therapy_date"):
        validate_input(bad)
