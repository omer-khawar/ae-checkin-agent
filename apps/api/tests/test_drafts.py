"""Review desk: confirm / edit / reject / attribution, dedup follow-ups, Tier 3 + SAE clock."""

from __future__ import annotations

from conftest import DEMO_GATES, DEMO_RESPONSES, add_participant, login, run_kiosk_checkin


def _drafts(client, session_id: str, headers: dict[str, str]) -> list[dict]:
    return client.get(f"/api/v1/checkins/{session_id}", headers=headers).json()["drafts"]


def test_confirm_edit_reject_and_versions(client) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    coord = login(client, "coordinator")
    drafts = _drafts(client, done["session_id"], coord)
    dyspnea = next(d for d in drafts if d["domain"] == "AE" and d["fields"]["AEDECOD"] == "Dyspnea")
    cough = next(d for d in drafts if d["domain"] == "AE" and d["fields"]["AEDECOD"] == "Cough")
    cm = next(d for d in drafts if d["domain"] == "CM")

    confirmed = client.post(
        f"/api/v1/drafts/{dyspnea['id']}/confirm", json={"note": "ok"}, headers=coord
    )
    assert confirmed.status_code == 200 and confirmed.json()["status"] == "confirmed"
    assert confirmed.json()["status_changed_by"] == "coordinator"
    again = client.post(f"/api/v1/drafts/{dyspnea['id']}/confirm", json={}, headers=coord)
    assert again.status_code == 409

    # Edit: new version row, old row superseded, diff audited, edit evidence attached.
    edited = client.patch(
        f"/api/v1/drafts/{cm['id']}",
        json={"fields": {"CMDECOD": "loratadine 10 mg"}, "note": "dose added"},
        headers=coord,
    )
    assert edited.status_code == 200, edited.text
    new = edited.json()
    assert new["version"] == 2 and new["supersedes_id"] == cm["id"] and new["status"] == "draft"
    assert new["fields"]["CMDECOD"] == "loratadine 10 mg" and new["lineage_id"] == cm["id"]
    edit_pointer = new["evidence"]["CMDECOD"][-1]
    assert edit_pointer["kind"] == "edit" and "loratadine 10 mg" in edit_pointer["note"]
    old = client.get(f"/api/v1/drafts/{cm['id']}", headers=coord).json()
    assert old["status"] == "superseded" and old["fields"]["CMDECOD"] == "loratadine"
    versions = client.get(f"/api/v1/drafts/{cm['id']}/versions", headers=coord).json()
    assert [v["version"] for v in versions] == [1, 2]
    events = client.get(
        f"/api/v1/audit?entity_id={cm['id']}&action=draft.edited", headers=coord
    ).json()
    assert events["total"] == 1
    assert events["items"][0]["payload"]["diff"]["CMDECOD"] == {
        "before": "loratadine",
        "after": "loratadine 10 mg",
    }
    # The edit's evidence pointer resolves to that audit event in the detail index.
    detail = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()
    assert detail["evidence_index"][edit_pointer["id"]]["audit_event"]["action"] == "draft.edited"
    # Acting on the superseded row is refused; unknown fields are refused.
    assert (
        client.post(f"/api/v1/drafts/{cm['id']}/confirm", json={}, headers=coord).status_code == 409
    )
    bad = client.patch(f"/api/v1/drafts/{new['id']}", json={"fields": {"NOPE": 1}}, headers=coord)
    assert bad.status_code == 422

    # Reject the cough AE: its open AE closes.
    rejected = client.post(
        f"/api/v1/drafts/{cough['id']}/reject",
        json={"reason": "participant retracted"},
        headers=coord,
    )
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected"
    timeline = client.get("/api/v1/participants/P-007/timeline", headers=coord).json()
    assert [a["aedecod"] for a in timeline["open_aes"]] == ["Dyspnea"]
    queue_item = client.get("/api/v1/queue", headers=coord).json()["items"][0]
    assert queue_item["draft_status_summary"] == "3 draft, 1 confirmed, 1 rejected"
    assert client.get("/api/v1/queue?status=open", headers=coord).json()["total"] == 1


def test_dedup_links_repeat_symptom_within_seven_days_as_followup(client) -> None:
    add_participant(client, "P-007")
    coord = login(client, "coordinator")
    first = run_kiosk_checkin(client, "P-007")
    first_drafts = _drafts(client, first["session_id"], coord)
    first_dyspnea = next(d for d in first_drafts if d["fields"].get("AEDECOD") == "Dyspnea")
    assert first_dyspnea["is_followup"] is False and first_dyspnea["ae_open_id"]
    client.post(f"/api/v1/drafts/{first_dyspnea['id']}/confirm", json={}, headers=coord)

    second = run_kiosk_checkin(client, "P-007")
    detail = client.get(f"/api/v1/checkins/{second['session_id']}", headers=coord).json()
    ae = [d for d in detail["drafts"] if d["domain"] == "AE"]
    assert all(d["is_followup"] for d in ae), ae
    dyspnea = next(d for d in ae if d["fields"]["AEDECOD"] == "Dyspnea")
    assert dyspnea["linked_ae_open_id"] == first_dyspnea["ae_open_id"]
    assert dyspnea["fields"]["INTERIM_FOLLOWUP_OF"] == first_dyspnea["ae_open_id"]
    assert dyspnea["fields"]["AESTDTC"] == first_dyspnea["fields"]["AESTDTC"]
    assert dyspnea["fields"]["AESEQ"] == 3  # sequence continues per participant
    link = next(link for link in detail["ae_links"] if link["draft_id"] == dyspnea["id"])
    assert link["first_session_id"] == first["session_id"]
    rule_ids = [r["rule_id"] for r in detail["rules_fired"]]
    assert "dedup.followup_linked" in rule_ids and "dedup.new_ae" not in rule_ids
    timeline = client.get("/api/v1/participants/P-007/timeline", headers=coord).json()
    open_aes = {a["aedecod"]: a for a in timeline["open_aes"]}
    assert len(open_aes) == 2  # still one Dyspnea and one Cough, not four
    assert open_aes["Dyspnea"]["last_session_id"] == second["session_id"]
    assert open_aes["Dyspnea"]["first_session_id"] == first["session_id"]


def test_hospitalization_is_tier3_with_page_sae_clock_and_investigator_stops_it(client) -> None:
    add_participant(client, "P-005")
    done = run_kiosk_checkin(
        client,
        "P-005",
        responses=DEMO_RESPONSES,
        gates={**DEMO_GATES, "hospitalization": True, "conmed_changed": False, "conmed_text": None},
    )
    assert done["tier"] == 3 and done["stop_screen"] is True
    assert done["stop_screen_text"].startswith(
        "If you are having trouble breathing or chest pain right now, call 911 now."
    )
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    detail = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()
    assert detail["result"]["seriousness_suspected"] is True
    assert detail["escalation"]["tier"] == 3 and detail["escalation"]["paged_at"]
    assert any("hospital" in r.lower() for r in detail["escalation"]["reasons"])
    clock = detail["sae_clock"]
    assert clock and clock["stopped_at"] is None and clock["seconds_remaining"] > 86000
    assert clock["informational"]["source"] == "21 CFR 312.32(c)"
    pages = client.get("/api/v1/pages", headers=coord).json()
    assert pages["total"] == 1 and pages["items"][0]["tier"] == 3 and pages["items"][0]["delivered"]
    queue_item = client.get("/api/v1/queue", headers=coord).json()["items"][0]
    assert queue_item["has_sae_clock"] is True and queue_item["sae_due_at"] == clock["due_at"]
    assert queue_item["escalation_acked"] is False
    active = client.get("/api/v1/sae-clocks?active=true", headers=coord).json()
    assert active["total"] == 1

    # Acknowledge the escalation.
    ack = client.post(
        f"/api/v1/escalations/{detail['escalation']['id']}/ack", json={}, headers=coord
    )
    assert ack.status_code == 200 and ack.json()["acked_by"] == "coordinator"
    assert ack.json()["seconds_to_ack"] is not None and ack.json()["seconds_to_ack"] >= 0
    assert (
        client.post(
            f"/api/v1/escalations/{detail['escalation']['id']}/ack", json={}, headers=coord
        ).status_code
        == 409
    )
    escalations = client.get("/api/v1/escalations?acked=true", headers=coord).json()
    assert escalations["total"] == 1

    # Only the investigator may set AESER/AEREL; doing so stops the clock.
    ae = next(d for d in detail["drafts"] if d["domain"] == "AE")
    forbidden = client.patch(
        f"/api/v1/drafts/{ae['id']}/attribution", json={"AESER": "Y"}, headers=coord
    )
    assert forbidden.status_code == 403
    attributed = client.patch(
        f"/api/v1/drafts/{ae['id']}/attribution",
        json={
            "AESER": "Y",
            "AEREL": "POSSIBLY RELATED",
            "note": "admitted for pneumonitis work-up",
        },
        headers=inv,
    )
    assert attributed.status_code == 200, attributed.text
    body = attributed.json()
    assert body["fields"]["AESER"] == "Y" and body["fields"]["AEREL"] == "POSSIBLY RELATED"
    assert body["version"] == 2 and body["status"] == "draft"
    assert body["evidence"]["AESER"][-1]["kind"] == "edit"
    after = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()
    assert after["sae_clock"]["stopped_at"] and after["sae_clock"]["stopped_by"] == "investigator"
    assert (
        after["sae_clock"]["decision"] == "AESER = Y"
        and after["sae_clock"]["seconds_remaining"] is None
    )
    assert client.get("/api/v1/sae-clocks?active=true", headers=coord).json()["total"] == 0
    actions = {
        e["action"] for e in client.get("/api/v1/audit?limit=500", headers=coord).json()["items"]
    }
    for expected in (
        "escalation.created",
        "escalation.paged",
        "escalation.acked",
        "sae_clock.started",
        "sae_clock.stopped",
        "draft.attribution",
    ):
        assert expected in actions, expected
    assert client.get("/api/v1/audit/verify", headers=coord).json()["ok"] is True


def test_severe_dyspnea_stops_the_kiosk_and_grade_stays_two(client) -> None:
    add_participant(client, "P-002")
    done = run_kiosk_checkin(
        client,
        "P-002",
        responses={**DEMO_RESPONSES, "shortness_of_breath": {"severity": 3, "interference": 2}},
        gates={
            **DEMO_GATES,
            "conmed_changed": False,
            "conmed_text": None,
            "conmed_direction": None,
        },
    )
    assert done["tier"] == 3 and done["stop_screen"]
    coord = login(client, "coordinator")
    detail = client.get(f"/api/v1/checkins/{done['session_id']}", headers=coord).json()
    ae = next(d for d in detail["drafts"] if d["fields"].get("AEDECOD") == "Dyspnea")
    assert ae["fields"]["AETOXGR"] == 2  # severity 3 + interference 2 -> composite 2
    assert "redflag.severe_dyspnea" in [r["rule_id"] for r in detail["rules_fired"]]
    assert detail["sae_clock"] is None and detail["escalation"]["tier"] == 3


def test_simulated_as_measured_override_bumps_tier_but_not_grade(client) -> None:
    add_participant(client, "P-009")
    admin = login(client, "admin")
    tachypnea = {
        "tsUtc": None,
        "source": "mock",
        "isMeasured": False,
        "pulseBpm": 98,
        "pulseConf": 0.9,
        "breathingBpm": 26,
        "breathingConf": 0.9,
        "windowS": 30,
        "qualityFlags": [],
    }
    from interim_api.util import now_iso

    samples = [{**tachypnea, "tsUtc": now_iso()}]
    baseline = run_kiosk_checkin(client, "P-009", samples=samples)
    assert baseline["tier"] == 1
    bumped = run_kiosk_checkin(
        client,
        "P-009",
        samples=samples,
        headers=admin,
        complete_extra={"settings_override": {"simulated_as_measured": True}},
    )
    assert bumped["tier"] == 2
    detail = client.get(f"/api/v1/checkins/{bumped['session_id']}", headers=admin).json()
    rule_ids = [r["rule_id"] for r in detail["rules_fired"]]
    assert "corr.tachypnea_dyspnea" in rule_ids and "vitals.simulated_as_measured" in rule_ids
    ae = next(d for d in detail["drafts"] if d["fields"].get("AEDECOD") == "Dyspnea")
    assert ae["fields"]["AETOXGR"] == 2
    vs = next(d for d in detail["drafts"] if d["domain"] == "VS")
    assert vs["fields"]["VSMETHOD"] == "Simulated"  # the toggle never changes the label
    assert detail["session"]["vitals_status"] == "ok"
    assert detail["escalation"]["tier"] == 2 and detail["escalation"]["paged_at"] is None
