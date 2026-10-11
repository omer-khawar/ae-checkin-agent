"""The demo check-in end to end (CLAUDE.md §11, CONTRACTS.md §6 persona T1-dyspnea-moderate)."""

from __future__ import annotations

from conftest import (
    DEMO_GATES,
    DEMO_RESPONSES,
    DEMO_SAMPLE_CAMEL,
    QUIET_GATES,
    ZERO_RESPONSES,
    add_participant,
    login,
    post_answers_and_gates,
    run_kiosk_checkin,
)

from interim_api.util import now_iso


def test_health_study_items_and_public_settings(client) -> None:
    health = client.get("/api/v1/health").json()
    assert health["status"] == "ok" and health["db"] == "ok" and health["vitals_source"] == "mock"
    study = client.get("/api/v1/study").json()
    assert study["study_id"] == "R2810-ONC-1624" and study["nct_id"] == "NCT03088540"
    assert study["participants_note"] == "All participants are synthetic."
    items = client.get("/api/v1/items").json()
    assert [i["id"] for i in items["items"]][:2] == ["shortness_of_breath", "cough"]
    assert len(items["items"]) == 10 and len(items["gates"]) == 4
    public = client.get("/api/v1/settings/public").json()
    assert public["simulated_as_measured"] is False
    assert public["min_confidence"] == 0.6
    assert public["timing_gates"] == {"pulse_s": 12, "breathing_s": 30, "hrv_s": 60}


def test_demo_checkin_tier1_with_drafts_evidence_queue_and_audit(client) -> None:
    usubjid = add_participant(client, "P-007")
    # The kiosk sends the display label (R2.3); the API resolves it.
    done = run_kiosk_checkin(client, "p-007")
    assert done["tier"] == 1 and done["stop_screen"] is False
    assert done["tier_name"] == "Coordinator review"
    assert "stop_screen_text" not in done
    session_id = done["session_id"]
    assert done["checkin_url"] == f"/dashboard/checkins/{session_id}"

    headers = login(client, "coordinator")
    detail = client.get(f"/api/v1/checkins/{session_id}", headers=headers).json()
    assert detail["session"]["usubjid"] == usubjid
    assert detail["session"]["vitals_status"] == "simulated_ignored"
    assert detail["result"]["escalation_tier"] == 1
    assert detail["result"]["max_grade"] == 2

    by_domain: dict[str, list[dict]] = {}
    for d in detail["drafts"]:
        by_domain.setdefault(d["domain"], []).append(d)
    assert {k: len(v) for k, v in by_domain.items()} == {"AE": 2, "VS": 2, "CM": 1}
    ae = next(d for d in by_domain["AE"] if d["fields"]["AEDECOD"] == "Dyspnea")
    assert ae["fields"]["AETOXGR"] == 2 and ae["fields"]["AESER"] is None
    assert ae["fields"]["INTERIM_TIER"] == 1 and ae["fields"]["INTERIM_PROVISIONAL"] is True
    assert ae["fields"]["INTERIM_RECORD_SOURCE"] == "check_in" and ae["source"] == "check_in"
    assert (
        ae["fields"]["STUDYID"] == "R2810-ONC-1624"
        and ae["fields"]["INTERIM_NCT_ID"] == "NCT03088540"
    )
    vs = {d["fields"]["VSTESTCD"]: d["fields"] for d in by_domain["VS"]}
    assert vs["PULSE"]["VSORRES"] == 72 and vs["RESP"]["VSORRES"] == 14
    assert vs["PULSE"]["VSMETHOD"] == "Simulated" and vs["PULSE"]["INTERIM_SOURCE"] == "mock"
    cm = by_domain["CM"][0]["fields"]
    assert cm["CMTRT"] == "loratadine" and cm["CMDECOD"] == "loratadine"
    assert cm["INTERIM_MATCH_CONFIDENCE"] == 1.0 and cm["INTERIM_MATCH_KIND"] == "exact"

    # Every evidence id on the AETOXGR field resolves to a real answer row or rule.
    index = detail["evidence_index"]
    answer_ids = {a["id"] for a in detail["answers"]}
    for pointer in ae["evidence"]["AETOXGR"]:
        entry = index[pointer["id"]]
        assert entry["resolved"] is True, pointer
        if pointer["kind"] == "pro_response":
            assert (
                pointer["id"] in answer_ids and entry["answer"]["item_id"] == "shortness_of_breath"
            )
        elif pointer["kind"] == "rule":
            assert entry["rule"]["rule_id"] == "grade.provisional.shortness_of_breath"
    for pointer in vs["PULSE"] and by_domain["VS"][0]["evidence"]["VSORRES"]:
        assert index[pointer["id"]]["resolved"] is True
    assert all(entry["resolved"] for entry in index.values()), [
        k for k, v in index.items() if not v["resolved"]
    ]
    rule_ids = [r["rule_id"] for r in detail["rules_fired"]]
    assert "grade.provisional.shortness_of_breath" in rule_ids
    assert "vitals.simulated_ignored" in rule_ids and "conmed.exact" in rule_ids
    assert len(detail["why"]) == len(rule_ids)

    queue = client.get("/api/v1/queue", headers=headers).json()
    assert queue["total"] == 1
    item = queue["items"][0]
    assert item["session_id"] == session_id and item["display_label"] == "P-007"
    assert item["tier"] == 1 and item["tier_name"] == "Coordinator review"
    assert item["draft_counts"] == {"AE": 2, "VS": 2, "CM": 1}
    assert item["is_measured"] is False and item["has_sae_clock"] is False
    assert item["source"] == "check_in" and item["note_id"] is None
    assert client.get("/api/v1/queue?min_tier=2", headers=headers).json()["total"] == 0

    audit = client.get("/api/v1/audit?limit=500", headers=headers).json()
    actions = {e["action"] for e in audit["items"]}
    for expected in (
        "session.started",
        "session.consent",
        "answer.recorded",
        "gates.recorded",
        "vitals.batch",
        "session.completed",
        "rule.fired",
        "draft.created",
        "auth.login",
    ):
        assert expected in actions, expected
    fired = [e for e in audit["items"] if e["action"] == "rule.fired"]
    assert len(fired) == len(rule_ids)
    assert fired[0]["payload"]["rule_id"] in rule_ids
    verify = client.get("/api/v1/audit/verify", headers=headers).json()
    assert verify["ok"] is True and verify["checked"] == audit["total"]
    assert verify["first_broken"] is None and len(verify["head_hash"]) == 64

    timeline = client.get(f"/api/v1/participants/{usubjid}/timeline", headers=headers).json()
    assert timeline["symptom_series"]["shortness_of_breath"][0]["grade"] == 2
    assert timeline["vitals_series"][0]["pulse_median"] == 72
    assert [a["aedecod"] for a in timeline["open_aes"]] == ["Dyspnea", "Cough"]
    assert timeline["conmed_changes"][0]["cmdecod"] == "loratadine"
    assert client.get("/api/v1/participants/P-007/timeline", headers=headers).status_code == 200


def test_answers_are_idempotent_and_updates_are_audited(client, coordinator) -> None:
    add_participant(client, "P-001")
    sid = client.post(
        "/api/v1/sessions", json={"usubjid": "P-001", "consent_camera": False}
    ).json()["id"]
    body = {"item_id": "fatigue", "attribute": "severity", "value": 1, "ts_client": now_iso()}
    first = client.post(f"/api/v1/sessions/{sid}/answers", json=body).json()
    second = client.post(f"/api/v1/sessions/{sid}/answers", json={**body, "value": 3}).json()
    assert first["id"] == second["id"] and first["created"] is True and second["created"] is False
    assert second["value_int"] == 3
    events = client.get(f"/api/v1/audit?entity_id={first['id']}", headers=coordinator).json()
    assert [e["action"] for e in events["items"]] == ["answer.updated", "answer.recorded"]
    assert events["items"][0]["payload"]["before"]["value_int"] == 1
    bad = client.post(f"/api/v1/sessions/{sid}/answers", json={**body, "attribute": "frequency"})
    assert bad.status_code == 422 and bad.headers["content-type"].startswith(
        "application/problem+json"
    )
    assert (
        client.post(f"/api/v1/sessions/{sid}/answers", json={**body, "value": 9}).status_code == 422
    )


def test_declined_camera_completes_without_vitals(client) -> None:
    add_participant(client, "P-012")
    done = run_kiosk_checkin(
        client,
        "P-012",
        responses={**DEMO_RESPONSES, "shortness_of_breath": {"severity": 0, "interference": 0}},
        gates={
            **DEMO_GATES,
            "conmed_changed": False,
            "conmed_text": None,
            "conmed_direction": None,
        },
        consent_camera=False,
    )
    assert done["tier"] == 0
    session = client.get(f"/api/v1/sessions/{done['session_id']}").json()
    assert session["vitals_status"] == "declined" and session["consent_camera"] is False
    headers = login(client, "investigator")
    detail = client.get(f"/api/v1/checkins/{done['session_id']}", headers=headers).json()
    assert [d["domain"] for d in detail["drafts"]] == ["AE"]
    assert "vitals.unavailable" in [r["rule_id"] for r in detail["rules_fired"]]


def test_vitals_post_accepts_camelcase_and_stores_snake_case(client, coordinator) -> None:
    add_participant(client, "P-003")
    sid = client.post("/api/v1/sessions", json={"usubjid": "P-003", "consent_camera": True}).json()[
        "id"
    ]
    now = now_iso()
    res = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={
            "samples": [
                {
                    **DEMO_SAMPLE_CAMEL,
                    "tsUtc": now,
                    "hrvRmssdMs": 41.5,
                    "hrvConf": 0.8,
                    "windowS": 60,
                },
                {**DEMO_SAMPLE_CAMEL, "tsUtc": now, "qualityFlags": ["motion", "low_conf_pulse"]},
            ]
        },
    )
    assert res.status_code == 200, res.text
    assert res.json() == {
        "accepted": 2,
        "session_id": sid,
        "vitals_status": "pending",
        "min_confidence": 0.6,
    }
    post_answers_and_gates(client, sid, responses=ZERO_RESPONSES, gates=QUIET_GATES)
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()}).json()
    detail = client.get(f"/api/v1/checkins/{sid}", headers=coordinator).json()
    samples = detail["vitals"]["samples"]
    assert samples[0]["hrv_rmssd_ms"] == 41.5 and samples[0]["window_s"] == 60
    assert samples[1]["quality_flags"] == ["motion", "low_conf_pulse"]
    assert "pulseBpm" not in samples[0] and samples[0]["pulse_bpm"] == 72
    # Every answer was "none": tier 0, and three VS rows (PULSE, RESP, HRV_RMSSD) all simulated.
    assert done["tier"] == 0
    vs_rows = {
        d["fields"]["VSTESTCD"]: d["fields"] for d in detail["drafts"] if d["domain"] == "VS"
    }
    assert set(vs_rows) == {"PULSE", "RESP", "HRV_RMSSD"}
    assert all(f["VSMETHOD"] == "Simulated" for f in vs_rows.values())
    late = client.post(
        f"/api/v1/sessions/{sid}/vitals", json={"samples": [{**DEMO_SAMPLE_CAMEL, "tsUtc": now}]}
    )
    assert late.status_code == 409


def test_unknown_participant_is_a_problem_json_404(client) -> None:
    res = client.post("/api/v1/sessions", json={"usubjid": "P-999", "consent_camera": True})
    assert res.status_code == 404
    assert res.headers["content-type"] == "application/problem+json"
    body = res.json()
    assert body["title"] == "Participant not found" and body["status"] == 404
    assert body["detail"] == "No participant with usubjid P-999"
    assert body["instance"] == "/api/v1/sessions"
