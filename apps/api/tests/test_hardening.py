"""Review fixes: provenance of vitals, consent, gate re-submission, input validation.

Each test here pins one path a reviewer demonstrated against the live API
(see the finding ids in the comments). They are written against the HTTP
surface so they protect the contract, not the implementation.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from conftest import (
    DEMO_GATES,
    DEMO_RESPONSES,
    DEMO_SAMPLE_CAMEL,
    QUIET_GATES,
    ZERO_RESPONSES,
    add_participant,
    login,
    make_settings,
    post_answers_and_gates,
    run_kiosk_checkin,
)
from fastapi.testclient import TestClient

from interim_api.audit import AUDIT_ACTIONS, Actor, append_event
from interim_api.constants import MOCK_SCENARIOS, VITALS_SOURCES
from interim_api.main import create_app
from interim_api.seed import seed_study, seed_users
from interim_api.services.exports import validate_edc_records
from interim_api.services.sdtm_fields import field_problems
from interim_api.services.settings_svc import ensure_defaults
from interim_api.settings import REPO_ROOT, Settings
from interim_api.util import now_iso

BRIDGE_SECRET = "bridge-secret-for-tests"
PRESAGE_SAMPLE = {
    **DEMO_SAMPLE_CAMEL,
    "source": "presage",
    "isMeasured": True,
    "pulseBpm": 98,
    "breathingBpm": 27,
    "breathingConf": 0.9,
}


def _open_session(client: TestClient, label: str = "P-007", *, consent: bool = True) -> str:
    add_participant(client, label)
    res = client.post("/api/v1/sessions", json={"usubjid": label, "consent_camera": consent})
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _vs_rows(client: TestClient, session_id: str, headers: dict[str, str]) -> dict[str, dict]:
    detail = client.get(f"/api/v1/checkins/{session_id}", headers=headers).json()
    return {d["fields"]["VSTESTCD"]: d["fields"] for d in detail["drafts"] if d["domain"] == "VS"}


# --------------------------------------------------------------------------- #
# Finding 1 (blocker): unknown sources and unverifiable "measured" claims
# --------------------------------------------------------------------------- #


def test_unknown_vitals_source_is_rejected(client) -> None:
    sid = _open_session(client)
    res = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={"samples": [{**PRESAGE_SAMPLE, "source": "webcam-x", "tsUtc": now_iso()}]},
    )
    assert res.status_code == 422, res.text
    assert res.headers["content-type"] == "application/problem+json"
    assert any("source" in e["loc"] for e in res.json()["errors"])


def test_mock_sample_can_never_claim_measured(client, coordinator) -> None:
    sid = _open_session(client)
    res = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={"samples": [{**DEMO_SAMPLE_CAMEL, "isMeasured": True, "tsUtc": now_iso()}]},
    )
    assert res.status_code == 422, res.text
    assert res.json()["title"] == "Simulated source claims measured"
    rejected = client.get(
        f"/api/v1/audit?action=vitals.rejected&entity_id={sid}", headers=coordinator
    )
    assert rejected.json()["total"] == 1
    assert "simulated source 'mock' claims" in rejected.json()["items"][0]["payload"]["reason"]
    # Nothing was stored; the session completes with a plain simulated batch and says Simulated.
    ok = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={"samples": [{**DEMO_SAMPLE_CAMEL, "tsUtc": now_iso()}]},
    )
    assert ok.status_code == 200 and ok.json()["accepted"] == 1
    post_answers_and_gates(client, sid)
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()}).json()
    assert done["tier"] == 1
    rows = _vs_rows(client, sid, coordinator)
    assert all(
        r["VSMETHOD"] == "Simulated" and r["INTERIM_IS_MEASURED"] is False for r in rows.values()
    )
    export = client.get("/api/v1/export/VS.json?status=all", headers=coordinator).json()["records"]
    assert export and all(r["VSMETHOD"] == "Simulated" for r in export)


def test_measured_claim_without_bridge_token_is_refused_and_cannot_bump_tier(
    client, coordinator
) -> None:
    """The reviewer's live probe: with BRIDGE_TOKEN empty, a measured claim must not land."""
    sid = _open_session(client)
    res = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={"samples": [{**PRESAGE_SAMPLE, "tsUtc": now_iso()}]},
    )
    assert res.status_code == 403, res.text
    assert res.json()["title"] == "Measured claim not verifiable"
    assert "BRIDGE_TOKEN" in res.json()["detail"]
    post_answers_and_gates(client, sid)  # dyspnea moderate: tier 1 without corroboration
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()}).json()
    assert done["tier"] == 1
    detail = client.get(f"/api/v1/checkins/{sid}", headers=coordinator).json()
    assert detail["session"]["vitals_status"] == "unavailable"
    assert "corr.tachypnea_dyspnea" not in [r["rule_id"] for r in detail["rules_fired"]]
    assert _vs_rows(client, sid, coordinator) == {}


def test_measured_claim_with_admin_token_is_accepted(client, admin, coordinator) -> None:
    sid = _open_session(client)
    res = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={"samples": [{**PRESAGE_SAMPLE, "tsUtc": now_iso()}]},
        headers=admin,
    )
    assert res.status_code == 200, res.text
    post_answers_and_gates(client, sid)
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()}).json()
    assert done["tier"] == 2  # measured tachypnea corroborates the reported dyspnea
    rows = _vs_rows(client, sid, coordinator)
    assert rows["RESP"]["VSMETHOD"] == "Contactless optical, camera-based"
    assert (
        rows["RESP"]["INTERIM_SOURCE"] == "presage" and rows["RESP"]["INTERIM_IS_MEASURED"] is True
    )


def test_measured_claim_with_configured_bridge_token(tmp_path: Path) -> None:
    app = create_app(make_settings(tmp_path, bridge_token=BRIDGE_SECRET))
    with TestClient(app) as client:
        database = app.state.database
        with database.write_scope() as db:
            seed_study(db, app.state.settings)
            seed_users(db, now_iso())
            ensure_defaults(db, app.state.settings)
        sid = _open_session(client)
        body = {"samples": [{**PRESAGE_SAMPLE, "tsUtc": now_iso()}]}
        missing = client.post(f"/api/v1/sessions/{sid}/vitals", json=body)
        assert missing.status_code == 401  # token configured, header absent
        wrong = client.post(
            f"/api/v1/sessions/{sid}/vitals", json=body, headers={"X-Bridge-Token": "nope"}
        )
        assert wrong.status_code == 401
        ok = client.post(
            f"/api/v1/sessions/{sid}/vitals", json=body, headers={"X-Bridge-Token": BRIDGE_SECRET}
        )
        assert ok.status_code == 200, ok.text
        post_answers_and_gates(client, sid)
        done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()})
        assert done.json()["tier"] == 2
        coord = login(client, "coordinator")
        assert (
            _vs_rows(client, sid, coord)["RESP"]["VSMETHOD"] == "Contactless optical, camera-based"
        )


# --------------------------------------------------------------------------- #
# Finding 2 (major): no camera consent means no vitals, ever
# --------------------------------------------------------------------------- #


def test_vitals_for_a_declined_session_are_refused_and_status_stays_declined(
    client, coordinator
) -> None:
    sid = _open_session(client, "P-012", consent=False)
    res = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={"samples": [{**DEMO_SAMPLE_CAMEL, "tsUtc": now_iso()}]},
    )
    assert res.status_code == 409, res.text
    assert res.json()["title"] == "No camera consent"
    events = client.get(
        f"/api/v1/audit?entity_id={sid}&action=vitals.rejected", headers=coordinator
    )
    assert events.json()["total"] == 1
    assert events.json()["items"][0]["payload"]["reason"] == "no_camera_consent"
    post_answers_and_gates(client, sid)
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()}).json()
    detail = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coordinator).json()
    assert detail["session"]["vitals_status"] == "declined"
    assert detail["session"]["consent_camera"] is False
    assert detail["vitals"]["samples"] == [] and _vs_rows(client, sid, coordinator) == {}
    assert client.get("/api/v1/queue", headers=coordinator).json()["items"][0]["vitals_status"] == (
        "declined"
    )


# --------------------------------------------------------------------------- #
# Finding 3 (major): gate re-submission never deletes an answer row
# --------------------------------------------------------------------------- #


def test_gates_resubmission_keeps_every_answer_id_resolvable(client, coordinator) -> None:
    sid = _open_session(client)
    now = now_iso()
    first = client.post(f"/api/v1/sessions/{sid}/gates", json={**DEMO_GATES, "ts_client": now})
    assert first.status_code == 200, first.text
    first_ids = {a["item_id"]: a["id"] for a in first.json()["answers"]}
    assert set(first_ids) == {
        "gate_hospitalization",
        "gate_conmed",
        "gate_conmed_text",
        "gate_conmed_direction",
    }

    # The participant goes Back and says "no medication change" after all, with a note.
    second = client.post(
        f"/api/v1/sessions/{sid}/gates",
        json={
            "hospitalization": True,
            "conmed_changed": False,
            "other_text": "felt dizzy on Tuesday",
            "ts_client": now_iso(),
        },
    )
    assert second.status_code == 200, second.text
    second_ids = {a["item_id"]: a["id"] for a in second.json()["answers"]}
    # Same rows, updated in place; the withdrawn con-med rows still exist (blanked).
    assert second_ids["gate_hospitalization"] == first_ids["gate_hospitalization"]
    assert second_ids["gate_conmed"] == first_ids["gate_conmed"]
    assert "gate_other" in second_ids and "gate_conmed_text" not in second_ids

    post_answers_and_gates(
        client,
        sid,
        responses=DEMO_RESPONSES,
        gates={"hospitalization": True, "conmed_changed": False},
    )
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()}).json()
    detail = client.get(f"/api/v1/checkins/{sid}", headers=coordinator).json()
    stored = {a["id"]: a for a in detail["answers"]}
    for item_id, answer_id in first_ids.items():
        assert answer_id in stored, item_id  # nothing was deleted
    assert stored[first_ids["gate_conmed_text"]]["value_text"] is None  # blanked, not removed
    assert stored[first_ids["gate_conmed"]]["value_int"] == 0
    # The engine saw the second answers: hospitalization -> Tier 3, no CM draft.
    assert done["tier"] == 3 and not [d for d in detail["drafts"] if d["domain"] == "CM"]
    # And the chain tells the story: before/after on the flipped gate, "cleared" on the name.
    flipped = client.get(
        f"/api/v1/audit?entity_id={first_ids['gate_conmed']}&action=answer.updated",
        headers=coordinator,
    ).json()["items"]
    assert flipped and flipped[0]["payload"]["before"]["value_int"] == 1
    cleared = client.get(
        f"/api/v1/audit?entity_id={first_ids['gate_conmed_text']}&action=answer.updated",
        headers=coordinator,
    ).json()["items"]
    assert cleared and cleared[0]["payload"]["cleared"] is True
    assert cleared[0]["payload"]["before"]["value_text"] == "loratadine"
    gates_events = client.get(
        f"/api/v1/audit?entity_id={sid}&action=gates.recorded", headers=coordinator
    ).json()["items"]
    assert [e["payload"]["resubmission"] for e in gates_events] == [True, True, False]


# --------------------------------------------------------------------------- #
# Finding 4 (major): the judge's custom persona is validated, never a 500
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "mutation",
    [
        {"responses": {**DEMO_RESPONSES, "cough": {"severity": "moderate"}}},
        {"responses": {**DEMO_RESPONSES, "cough": {"colour": 1}}},
        {"responses": {**DEMO_RESPONSES, "not_an_item": {"severity": 1}}},
        {"responses": {**DEMO_RESPONSES, "cough": {"severity": 7}}},
        {"gates": {**DEMO_GATES, "temp_c": "hot"}},
        {"gates": {**DEMO_GATES, "conmed_direction": "sideways"}},
        {"vitals_samples": [{"pulseBpm": 72}]},  # neither tsUtc nor tsOffsetS
        {"vitals_samples": [{"tsOffsetS": 0, "source": "webcam-x", "pulseBpm": 72}]},
        {"vitals_samples": [{"tsOffsetS": 0, "pulseBpm": "inf"}]},  # not finite
        {"setup": {"prior_checkins": [{"days_ago": "five", "responses": {}}]}},
        {"setup": {"prior_checkins": [{"days_ago": -1, "responses": {}}]}},
        {"settings": {"simulated_as_measured": "yes please"}},
        {"id": "../../etc"},
    ],
)
def test_malformed_custom_persona_is_a_422_problem(client, coordinator, mutation) -> None:
    persona = {
        "id": "custom-bad",
        "consent_camera": True,
        "responses": DEMO_RESPONSES,
        "gates": DEMO_GATES,
        "vitals_samples": [{**DEMO_SAMPLE_CAMEL, "tsOffsetS": 30}],
        **mutation,
    }
    res = client.post("/api/v1/eval/run-custom", json={"persona": persona}, headers=coordinator)
    assert res.status_code == 422, (mutation, res.text)
    assert res.headers["content-type"] == "application/problem+json"


def test_custom_persona_with_a_prior_checkin_links_a_followup(client, coordinator) -> None:
    persona = {
        "id": "custom-followup",
        "category": "custom",
        "consent_camera": False,
        "settings": {"simulated_as_measured": False},
        "setup": {
            "prior_checkins": [
                {"days_ago": 3, "responses": {"cough": {"severity": 1, "interference": 0}}}
            ]
        },
        "responses": {"cough": {"severity": 2, "interference": 2}},  # omitted items mean "none"
        "gates": {"hospitalization": False, "conmed_changed": False},
    }
    res = client.post("/api/v1/eval/run-custom", json={"persona": persona}, headers=coordinator)
    assert res.status_code == 200, res.text
    body = res.json()
    ae = [d for d in body["result"]["drafts"] if d["domain"] == "AE"]
    assert len(ae) == 1 and ae[0]["is_followup"] is True
    assert body["result"]["escalation_tier"] == 1
    assert body["persona"]["consent_camera"] is False and "expected" not in body["persona"]


# --------------------------------------------------------------------------- #
# Finding 5 (minor): PATCH /drafts validates typed fields; mock EDC agrees
# --------------------------------------------------------------------------- #


def test_patch_rejects_invalid_typed_values_and_mock_edc_uses_the_same_rules(client) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    coord = login(client, "coordinator")
    drafts = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()["drafts"]
    ae = next(d for d in drafts if d["domain"] == "AE" and d["fields"]["AEDECOD"] == "Dyspnea")
    vs = next(d for d in drafts if d["domain"] == "VS")
    cm = next(d for d in drafts if d["domain"] == "CM")

    def patch(draft_id: str, fields: dict) -> int:
        return client.patch(
            f"/api/v1/drafts/{draft_id}", json={"fields": fields}, headers=coord
        ).status_code

    for bad in (
        {"AETOXGR": "banana"},
        {"AETOXGR": 4},
        {"AETOXGR": "3"},  # strict: an edit must carry the stored type
        {"AETOXGR": True},
        {"AEONGO": "maybe"},
        {"AESTDTC": "yesterday"},
        {"INTERIM_TIER": 9},
    ):
        assert patch(ae["id"], bad) == 422, bad
    for bad in ({"VSORRES": "high"}, {"VSSTAT": "SKIPPED"}, {"VSDTC": "noon"}):
        assert patch(vs["id"], bad) == 422, bad
    assert patch(cm["id"], {"CMSTDTC": "2026-13-45"}) == 422
    assert patch(cm["id"], {"CMSTDTC": "2026-10-09T10:00:00.000Z"}) == 422  # CM dates are dates
    res = client.patch(
        f"/api/v1/drafts/{ae['id']}",
        json={"fields": {"AETOXGR": 3, "AEENDTC": "2026-10-10"}},
        headers=coord,
    )
    assert res.status_code == 200, res.text
    assert res.json()["fields"]["AETOXGR"] == 3 and res.json()["version"] == 2
    problem = client.patch(
        f"/api/v1/drafts/{res.json()['id']}", json={"fields": {"AETOXGR": 5}}, headers=coord
    ).json()
    assert problem["title"] == "Invalid field value" and "never assigned" in problem["errors"][0]

    # The mock EDC applies the same validator (lenient about CSV strings).
    assert validate_edc_records(
        "AE", [{"STUDYID": "S", "USUBJID": "U", "AETERM": "t", "AEDECOD": "d", "AETOXGR": "banana"}]
    )
    assert validate_edc_records(
        "AE", [{"STUDYID": "S", "USUBJID": "U", "AETERM": "t", "AEDECOD": "d", "AETOXGR": "4"}]
    )
    assert not validate_edc_records(
        "AE", [{"STUDYID": "S", "USUBJID": "U", "AETERM": "t", "AEDECOD": "d", "AETOXGR": "2"}]
    )
    assert not validate_edc_records(
        "VS", [{"STUDYID": "S", "USUBJID": "U", "VSTESTCD": "PULSE", "VSORRES": "72.0"}]
    )
    assert field_problems({"VSORRES": "72.0"}) and not field_problems(
        {"VSORRES": "72.0"}, lenient=True
    )
    assert field_problems({"AETOXGR": None, "AESER": None, "AEONGO": None}) == []


# --------------------------------------------------------------------------- #
# Finding 7 (minor): mock_scenario is validated against one shared list
# --------------------------------------------------------------------------- #


def test_admin_settings_reject_unknown_scenario_and_list_matches_the_bridge(client, admin) -> None:
    bad = client.put("/api/v1/admin/settings", json={"mock_scenario": "banana"}, headers=admin)
    assert bad.status_code == 422 and "resting" in bad.json()["detail"]
    assert client.get("/api/v1/settings/public").json()["mock_scenario"] == "resting"
    listed = client.get("/api/v1/admin/settings", headers=admin).json()
    assert listed["known_scenarios"] == list(MOCK_SCENARIOS)
    assert listed["known_sources"] == list(VITALS_SOURCES)
    ok = client.put("/api/v1/admin/settings", json={"mock_scenario": "dropout"}, headers=admin)
    assert ok.status_code == 200 and ok.json()["mock_scenario"] == "dropout"

    scenarios_ts = REPO_ROOT / "apps" / "vitals-bridge" / "src" / "sources" / "scenarios.ts"
    if scenarios_ts.is_file():  # the API-side twin of the bridge's SCENARIO_NAMES
        text = scenarios_ts.read_text(encoding="utf-8")
        match = re.search(r"SCENARIO_NAMES[^=]*=\s*\[([^\]]*)\]", text)
        assert match, "SCENARIO_NAMES not found in scenarios.ts"
        names = re.findall(r"'([a-z_]+)'", match.group(1))
        assert names == list(MOCK_SCENARIOS)


def test_env_defaults_are_validated_at_startup(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="VITALS_SCENARIO"):
        make_settings(tmp_path, vitals_scenario="banana")
    with pytest.raises(ValueError, match="VITALS_SOURCE"):
        make_settings(tmp_path, vitals_source="laser")
    assert isinstance(make_settings(tmp_path, vitals_source="presage"), Settings)


# --------------------------------------------------------------------------- #
# Finding 8 (minor): an unanswered check-in cannot complete
# --------------------------------------------------------------------------- #


def test_complete_requires_every_item_and_the_gates(client) -> None:
    sid = _open_session(client)
    empty = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()})
    assert empty.status_code == 422, empty.text
    body = empty.json()
    assert body["title"] == "Check-in incomplete"
    n_attributes = sum(len(attrs) for attrs in DEMO_RESPONSES.values())
    assert len(body["missing"]) == n_attributes + 2  # every item attribute + 2 yes/no gates
    assert "shortness_of_breath.severity" in body["missing"] and "gate_conmed" in body["missing"]
    post_answers_and_gates(client, sid, responses=ZERO_RESPONSES)
    partial = client.post(
        f"/api/v1/sessions/{sid}/answers",
        json={"item_id": "cough", "attribute": "severity", "value": 1, "ts_client": now_iso()},
    )
    assert partial.status_code == 200
    r = client.post(f"/api/v1/sessions/{sid}/gates", json={**QUIET_GATES, "ts_client": now_iso()})
    assert r.status_code == 200
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()})
    assert done.status_code == 200 and done.json()["tier"] == 0


# --------------------------------------------------------------------------- #
# Finding 11 (minor): the audit vocabulary is closed
# --------------------------------------------------------------------------- #


def test_audit_actions_are_a_closed_registered_vocabulary(client, coordinator) -> None:
    add_participant(client, "P-007")
    run_kiosk_checkin(client, "P-007")
    audit = client.get("/api/v1/audit?limit=500", headers=coordinator).json()
    assert {e["action"] for e in audit["items"]} <= AUDIT_ACTIONS
    database = client.app.state.database
    with database.write_scope() as db, pytest.raises(ValueError, match="unregistered audit action"):
        append_event(db, Actor(id="x", role="system"), "made.up", "thing", "1", {})
    assert {
        "drafts.applied",
        "ae_open.closed",
        "demo.seed",
        "demo.seeded",
        "vitals.rejected",
    } <= AUDIT_ACTIONS
