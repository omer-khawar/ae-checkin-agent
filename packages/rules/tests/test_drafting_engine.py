"""SDTM drafts, evidence completeness, and end-to-end engine behaviour."""

from __future__ import annotations

import pytest
from helpers import (
    SESSION,
    STUDY,
    SUBJECT,
    T0,
    build,
    drafts,
    field_evidence,
    gates,
    response,
    rule_ids,
    run,
    sample,
)

from interim_rules import evaluate_checkin
from interim_rules.engine import validate_input
from interim_rules.models import CheckInResult, DraftRecord, OpenAE, VitalsSampleIn
from interim_rules.tables import rules_catalog

AE_FIELDS = [
    "STUDYID", "INTERIM_NCT_ID", "USUBJID", "AESEQ", "AETERM", "AEDECOD", "AESTDTC", "AEENDTC",
    "AEONGO", "AETOXGR", "AESER", "AEREL", "AEACN", "AEOUT", "INTERIM_TIER",
    "INTERIM_RULES_FIRED", "INTERIM_PROVISIONAL", "INTERIM_FOLLOWUP_OF",
]  # fmt: skip
VS_FIELDS = [
    "STUDYID", "INTERIM_NCT_ID", "USUBJID", "VSSEQ", "VSTESTCD", "VSTEST", "VSORRES", "VSORRESU",
    "VSDTC", "VSMETHOD", "VSSTAT", "INTERIM_CONFIDENCE", "INTERIM_SOURCE", "INTERIM_N_SAMPLES",
    "INTERIM_IS_MEASURED",
]  # fmt: skip
CM_FIELDS = [
    "STUDYID", "INTERIM_NCT_ID", "USUBJID", "CMSEQ", "CMTRT", "CMDECOD", "CMSTDTC", "CMENDTC",
    "CMSTAT", "INTERIM_MATCH_CONFIDENCE", "INTERIM_MATCH_KIND", "INTERIM_DIRECTION",
]  # fmt: skip

DEMO = {
    "shortness_of_breath": {"severity": 2, "interference": 2},
    "cough": {"severity": 1, "interference": 0},
}


def assert_evidence_complete(result: CheckInResult) -> None:
    for draft in result.drafts:
        for field in draft.fields:
            if field.value is not None:
                assert field.evidence, (draft.domain, field.name)
                assert all(e.id and e.note for e in field.evidence), (draft.domain, field.name)
    for rule in result.rules_fired:
        assert rule.evidence, rule.rule_id
        assert rule.rule_id in rules_catalog(), rule.rule_id


def test_demo_persona_end_to_end() -> None:
    result = run(
        DEMO,
        gate_answers=gates(
            conmed_changed=True, conmed_text="loratadine", conmed_direction="started"
        ),
        vitals=[sample(0)],
    )
    assert result.max_grade == 2 and result.escalation_tier == 1 and not result.stop_screen
    assert (
        result.base_tier == 1 and result.red_flag_tier_floor == 0 and result.corroboration_bump == 0
    )
    ids = rule_ids(result)
    for expected in (
        "grade.provisional.shortness_of_breath",
        "tier.base",
        "conmed.exact",
        "vitals.simulated_ignored",
    ):
        assert expected in ids
    for excluded in ("corr.tachypnea_dyspnea", "sae.clock_started", "tier.redflag_floor"):
        assert excluded not in ids
    assert not result.seriousness_suspected and result.sae_clock is None
    assert [d.domain for d in result.drafts] == ["AE", "AE", "VS", "VS", "CM"]
    assert len(result.why) == len(result.rules_fired)
    assert result.why == tuple(r.description for r in result.rules_fired)
    assert_evidence_complete(result)


def test_rules_are_ordered_by_pipeline_stage() -> None:
    result = run(
        {**DEMO, "fever_or_chills": {"presence": 1}, "mouth_sores": {"severity": 3}},
        gate_answers=gates(hospitalization=True, conmed_changed=True, conmed_text="advil"),
        vitals=[sample(0, pulse=120, measured=True)],
    )
    categories = [r.category for r in result.rules_fired]
    order = [
        "scoring", "grading", "red_flag", "vitals_quality", "corroboration", "escalation",
        "seriousness", "conmed", "dedup", "drafting",
    ]  # fmt: skip
    assert categories == sorted(categories, key=order.index)
    assert set(categories) == set(order)


def test_ae_draft_fields_and_evidence() -> None:
    result = run(DEMO, next_aeseq=5)
    ae = drafts(result, "AE")
    assert [f.name for f in ae[0].fields] == AE_FIELDS
    first = ae[0]
    assert isinstance(first, DraftRecord)
    assert first.value("STUDYID") == STUDY and first.value("USUBJID") == SUBJECT
    assert first.value("INTERIM_NCT_ID") == "NCT03088540"
    assert [d.value("AESEQ") for d in ae] == [5, 6]
    assert first.value("AETERM") == "Shortness of breath" and first.value("AEDECOD") == "Dyspnea"
    assert first.value("AESTDTC") == T0 and first.value("AEONGO") == "Y"
    assert first.value("AETOXGR") == 2 and first.value("INTERIM_PROVISIONAL") is True
    for null_field in ("AEENDTC", "AESER", "AEREL", "AEACN", "AEOUT", "INTERIM_FOLLOWUP_OF"):
        field = next(f for f in first.fields if f.name == null_field)
        assert field.value is None and field.evidence == ()
    assert first.value("INTERIM_TIER") == 1
    rules = first.value("INTERIM_RULES_FIRED")
    assert isinstance(rules, list)
    assert rules[:2] == [
        "score.composite.shortness_of_breath",
        "grade.provisional.shortness_of_breath",
    ]
    assert "tier.final" in rules and "dedup.new_ae" in rules
    assert "grade.provisional.cough" not in rules
    aetoxgr = next(f for f in first.fields if f.name == "AETOXGR")
    assert aetoxgr.evidence[0].kind == "rule" and aetoxgr.evidence[1].kind == "pro_response"
    aedecod = next(f for f in first.fields if f.name == "AEDECOD")
    assert any(e.kind == "table" and e.id == "ctcae_terms.json" for e in aedecod.evidence)
    assert_evidence_complete(result)


def test_ae_draft_uses_earliest_answer_timestamp_and_typed_temperature() -> None:
    responses = (
        response("fever_or_chills", "presence", 1, ts="2026-10-10T17:58:00.000Z"),
        response("cough", "severity", 2, ts="2026-10-10T17:55:00.000Z"),
        response("cough", "interference", 1, ts="2026-10-10T17:56:00.000Z"),
    )
    result = evaluate_checkin(
        build(responses=responses, gate_answers=gates(temp_c=38.4), nct_id=None)
    )
    ae = {str(d.value("AEDECOD")): d for d in drafts(result, "AE")}
    assert ae["Cough"].value("AESTDTC") == "2026-10-10T17:55:00.000Z"
    fever_term = next(f for f in ae["Fever"].fields if f.name == "AETERM")
    assert any(e.kind == "gate_answer" and "temp_c = 38.4" in e.note for e in fever_term.evidence)
    cough_term = next(f for f in ae["Cough"].fields if f.name == "AETERM")
    assert not any(e.kind == "gate_answer" for e in cough_term.evidence)
    nct = next(f for f in ae["Cough"].fields if f.name == "INTERIM_NCT_ID")
    assert nct.value is None and nct.evidence == ()


def test_no_ae_drafts_for_grade_zero_items() -> None:
    result = run({"cough": {"severity": 0, "interference": 4}})  # zero rule -> composite 0
    assert drafts(result, "AE") == [] and result.max_grade == 0


def test_vs_draft_fields() -> None:
    result = run(
        vitals=[
            sample(0, measured=True, source="presage"),
            sample(1, measured=True, source="presage"),
        ]
    )
    vs = drafts(result, "VS")
    assert [f.name for f in vs[0].fields] == VS_FIELDS
    pulse = vs[0]
    assert isinstance(pulse, DraftRecord)
    assert pulse.value("VSSEQ") == 1 and pulse.value("VSTESTCD") == "PULSE"
    assert pulse.value("VSTEST") == "Pulse Rate" and pulse.value("VSORRESU") == "beats/min"
    assert pulse.value("VSORRES") == 72.0 and pulse.value("VSSTAT") is None
    assert result.vitals.summary is not None
    assert pulse.value("VSDTC") == result.vitals.summary.last_ts
    assert pulse.value("VSMETHOD") == "Contactless optical, camera-based"
    assert pulse.value("INTERIM_CONFIDENCE") == 0.9 and pulse.value("INTERIM_SOURCE") == "presage"
    assert pulse.value("INTERIM_N_SAMPLES") == 2 and pulse.value("INTERIM_IS_MEASURED") is True
    vsorres = next(f for f in pulse.fields if f.name == "VSORRES")
    assert {e.kind for e in vsorres.evidence} == {"vitals_sample", "rule"}
    assert len([e for e in vsorres.evidence if e.kind == "vitals_sample"]) == 2
    # VSDTC points at the last usable reading; the label fields at the summary rule + span.
    vsdtc = field_evidence(pulse, "VSDTC")
    assert len(vsdtc) == 1
    method = field_evidence(pulse, "VSMETHOD")
    assert [getattr(e, "kind", None) for e in method] == ["rule", "vitals_sample", "vitals_sample"]
    assert getattr(method[0], "id", None) == "vitals.summary"
    resp = vs[1]
    assert resp.value("VSTESTCD") == "RESP" and resp.value("VSORRESU") == "breaths/min"
    assert_evidence_complete(result)


def test_cm_draft_fields_and_direction_dates() -> None:
    started = run(
        gate_answers=gates(conmed_changed=True, conmed_text="zofran", conmed_direction="started")
    )
    cm = drafts(started, "CM")[0]
    assert [f.name for f in cm.fields] == CM_FIELDS
    assert cm.value("CMSEQ") == 1 and cm.value("CMTRT") == "zofran"
    assert cm.value("CMDECOD") == "ondansetron"
    assert cm.value("CMSTDTC") == "2026-10-10" and cm.value("CMENDTC") is None
    assert cm.value("CMSTAT") is None and cm.value("INTERIM_DIRECTION") == "started"
    stopped = run(
        gate_answers=gates(conmed_changed=True, conmed_text="zofran", conmed_direction="stopped")
    )
    cm2 = drafts(stopped, "CM")[0]
    assert cm2.value("CMSTDTC") is None and cm2.value("CMENDTC") == "2026-10-10"
    unknown = run(gate_answers=gates(conmed_changed=True, conmed_text="mystery herb"))
    cm3 = drafts(unknown, "CM")[0]
    assert cm3.value("CMDECOD") is None and cm3.value("INTERIM_MATCH_KIND") == "unmatched"
    assert cm3.value("INTERIM_MATCH_CONFIDENCE") == 0.0
    assert cm3.value("CMSTDTC") is None and cm3.value("INTERIM_DIRECTION") is None
    assert_evidence_complete(unknown)
    assert_evidence_complete(started)


def test_tier_three_stop_screen_from_severe_dyspnea() -> None:
    result = run({"shortness_of_breath": {"severity": 4, "interference": 4}})
    assert result.max_grade == 3 and result.base_tier == 2 and result.red_flag_tier_floor == 3
    assert result.escalation_tier == 3 and result.stop_screen and result.page_oncall
    final = next(r for r in result.rules_fired if r.rule_id == "tier.final")
    assert final.inputs["name"] == "Urgent"
    assert drafts(result, "AE")[0].value("INTERIM_TIER") == 3


def test_tier_two_from_grade_three_without_red_flag() -> None:
    result = run({"nausea": {"frequency": 3, "severity": 3}})
    assert result.max_grade == 3 and result.escalation_tier == 2 and not result.stop_screen
    assert "tier.redflag_floor" not in rule_ids(result)


def test_engine_is_deterministic() -> None:
    inp = build(
        DEMO,
        vitals=[sample(0), sample(1)],
        gate_answers=gates(conmed_changed=True, conmed_text="advil"),
    )
    assert evaluate_checkin(inp) == evaluate_checkin(inp)


def test_session_context_evidence_mentions_the_session() -> None:
    result = run(DEMO)
    studyid = drafts(result, "AE")[0].fields[0]
    assert studyid.name == "STUDYID" and SESSION in studyid.evidence[0].note


# --------------------------------------------------------------------------- #
# Up-front input validation
# --------------------------------------------------------------------------- #


def test_bad_completed_at_is_rejected_even_when_nothing_is_graded() -> None:
    """Before: accepted for an all-zero check-in, rejected once something needed the date."""
    with pytest.raises(ValueError, match="completed_at"):
        evaluate_checkin(build(completed_at="nope"))
    with pytest.raises(ValueError, match="completed_at"):
        evaluate_checkin(build({"cough": {"severity": 1}}, completed_at="nope"))


def test_next_aeseq_must_start_at_one() -> None:
    with pytest.raises(ValueError, match="next_aeseq"):
        evaluate_checkin(build({"cough": {"severity": 1}}, next_aeseq=0))
    with pytest.raises(ValueError, match="next_aeseq"):
        evaluate_checkin(build(next_aeseq=-3))
    assert drafts(run({"cough": {"severity": 1}}, next_aeseq=1), "AE")[0].value("AESEQ") == 1


def test_every_timestamp_and_id_is_validated_with_its_field_name() -> None:
    with pytest.raises(ValueError, match=r"responses\[.*\]\.ts"):
        validate_input(build(responses=[response("cough", "severity", 1, ts="never")]))
    bad_sample = VitalsSampleIn(
        f"{SESSION}:bad", "soon", "presage", True, 70.0, 0.9, None, None, None, None, 12.0, ()
    )
    with pytest.raises(ValueError, match=r"vitals\[.*\]\.ts_utc"):
        validate_input(build(vitals=[bad_sample]))
    with pytest.raises(ValueError, match=r"open_aes\[AE1\]\.first_reported_at"):
        validate_input(build(open_aes=[OpenAE("AE1", "Cough", "x", T0, "S0")]))
    with pytest.raises(ValueError, match=r"open_aes\[AE1\]\.last_reported_at"):
        validate_input(build(open_aes=[OpenAE("AE1", "Cough", T0, "x", "S0")]))
    with pytest.raises(ValueError, match="session_id"):
        validate_input(build(session_id=" "))
    with pytest.raises(ValueError, match="usubjid"):
        validate_input(build(usubjid=""))
    validate_input(build())  # the defaults are valid
