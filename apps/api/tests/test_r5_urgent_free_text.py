"""CONTRACTS.md R5.1 / R5.2 over HTTP: the urgent path, the comment box, several medications."""

from __future__ import annotations

from typing import Any

from conftest import (
    DEMO_RESPONSES,
    QUIET_GATES,
    ZERO_RESPONSES,
    add_participant,
    login,
    make_settings,
    post_answers_and_gates,
    run_kiosk_checkin,
)
from fastapi.testclient import TestClient

from interim_api.main import create_app
from interim_api.util import now_iso

BASE = "/api/v1/sessions"
TIGHT = "He says his chest feels tight and he can't catch his breath RIGHT NOW"
STOP_START = "If you are having trouble breathing or chest pain right now, call 911 now."


def start(client: TestClient, label: str = "P-007") -> str:
    add_participant(client, label)
    res = client.post(BASE, json={"usubjid": label, "consent_camera": True})
    assert res.status_code == 201, res.text
    return str(res.json()["id"])


def detail_of(client: TestClient, session_id: str) -> dict[str, Any]:
    out = client.get(f"/api/v1/checkins/{session_id}", headers=login(client, "coordinator"))
    assert out.status_code == 200, out.text
    return dict(out.json())


def audit_actions(client: TestClient) -> list[str]:
    audit = client.get("/api/v1/audit?limit=500", headers=login(client, "coordinator")).json()
    return [e["action"] for e in audit["items"]]


def answer(client: TestClient, session_id: str, item: str, attribute: str, value: int) -> None:
    res = client.post(
        f"{BASE}/{session_id}/answers",
        json={"item_id": item, "attribute": attribute, "value": value, "ts_client": now_iso()},
    )
    assert res.status_code == 200, res.text


def cm_drafts(detail: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(
        (d for d in detail["drafts"] if d["domain"] == "CM"), key=lambda d: d["fields"]["CMSEQ"]
    )


# ---------------------------------------------------------------- R5.1 settings and the gate


def test_public_settings_expose_the_site_phone_and_name(client) -> None:
    public = client.get("/api/v1/settings/public").json()
    assert public["site_phone"] == "(732) 555-0142"
    assert public["site_name"] == "Study team"


def test_site_phone_and_name_come_from_the_environment(tmp_path) -> None:
    app = create_app(make_settings(tmp_path, site_phone="(555) 010-0199", site_name="Rutgers site"))
    with TestClient(app) as c:
        public = c.get("/api/v1/settings/public").json()
    assert public["site_phone"] == "(555) 010-0199"
    assert public["site_name"] == "Rutgers site"


def test_items_endpoint_lists_urgent_now_first_with_yes_before_no(client) -> None:
    gates = client.get("/api/v1/items").json()["gates"]
    assert [g["id"] for g in gates] == ["urgent_now", "hospitalization", "conmed", "other"]
    assert gates[0]["order"] == 0
    assert gates[0]["label"] == (
        "Right now, are you having trouble breathing, or chest pain or tightness?"
    )
    for gate in gates:
        if "options" in gate:
            assert list(gate["options"]) == ["Yes", "No"], gate["id"]


# ---------------------------------------------------------------- R5.1 /urgent


def test_urgent_now_stops_the_check_in_with_the_answers_so_far(client) -> None:
    session_id = start(client)
    answer(client, session_id, "cough", "severity", 1)
    res = client.post(
        f"{BASE}/{session_id}/urgent", json={"trigger": "urgent_now", "ts_client": now_iso()}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["tier"] == 3 and body["stop_screen"] is True
    assert body["ended_early"] == "urgent_now"
    assert body["stop_screen_text"] == (
        "If you are having trouble breathing or chest pain right now, call 911 now. "
        "Your answers were saved. A member of the study team has been alerted and will "
        "contact you today."
    )
    assert body["checkin_url"] == f"/dashboard/checkins/{session_id}"
    assert body["session"]["completed_at"] is not None

    detail = detail_of(client, session_id)
    ids = [a["item_id"] for a in detail["answers"]]
    assert "gate_urgent_now" in ids
    urgent = next(a for a in detail["answers"] if a["item_id"] == "gate_urgent_now")
    assert urgent["value_int"] == 1
    rule_ids = [r["rule_id"] for r in detail["rules_fired"]]
    assert "redflag.urgent_now" in rule_ids and "redflag.ended_early" in rule_ids
    assert detail["escalation"]["tier"] == 3 and detail["escalation"]["paged_at"]
    reasons = " ".join(detail["escalation"]["reasons"])
    assert "urgent_now" in reasons
    # Unanswered items are "not reported": only the cough answer is graded, nothing else drafted.
    ae_terms = [d["fields"]["AEDECOD"] for d in detail["drafts"] if d["domain"] == "AE"]
    assert ae_terms == ["Cough"]
    assert detail["result"]["ended_early"] == "urgent_now"
    # Every evidence pointer still resolves.
    assert all(e["resolved"] for e in detail["evidence_index"].values())
    actions = audit_actions(client)
    assert actions.count("session.ended_early") == 1
    assert "escalation.paged" in actions
    verify = client.get("/api/v1/audit/verify", headers=login(client, "coordinator")).json()
    assert verify["ok"] is True


def test_urgent_with_no_answers_at_all_is_still_tier_three(client) -> None:
    session_id = start(client)
    res = client.post(
        f"{BASE}/{session_id}/urgent", json={"trigger": "urgent_now", "ts_client": now_iso()}
    )
    assert res.status_code == 200, res.text
    detail = detail_of(client, session_id)
    assert detail["result"]["escalation_tier"] == 3
    assert [d for d in detail["drafts"] if d["domain"] == "AE"] == []
    assert detail["result"]["max_grade"] == 0


def test_severe_dyspnea_trigger_records_no_urgent_gate_but_forces_tier_three(client) -> None:
    session_id = start(client)
    answer(client, session_id, "shortness_of_breath", "severity", 3)
    res = client.post(
        f"{BASE}/{session_id}/urgent", json={"trigger": "severe_dyspnea", "ts_client": now_iso()}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["tier"] == 3 and body["ended_early"] == "severe_dyspnea"
    assert body["stop_screen_text"].startswith(STOP_START)
    detail = detail_of(client, session_id)
    assert "gate_urgent_now" not in [a["item_id"] for a in detail["answers"]]
    rule_ids = [r["rule_id"] for r in detail["rules_fired"]]
    assert "redflag.severe_dyspnea" in rule_ids and "redflag.ended_early" in rule_ids
    assert "redflag.urgent_now" not in rule_ids
    ended = next(r for r in detail["rules_fired"] if r["rule_id"] == "redflag.ended_early")
    assert ended["inputs"]["ended_early"] == "severe_dyspnea"
    assert "severe_dyspnea" in " ".join(detail["escalation"]["reasons"])


def test_urgent_is_idempotent_per_session(client) -> None:
    session_id = start(client)
    payload = {"trigger": "urgent_now", "ts_client": now_iso()}
    first = client.post(f"{BASE}/{session_id}/urgent", json=payload).json()
    second = client.post(f"{BASE}/{session_id}/urgent", json=payload)
    assert second.status_code == 200, second.text
    assert second.json() == first
    actions = audit_actions(client)
    assert actions.count("session.ended_early") == 1
    assert actions.count("session.completed") == 1
    queue = client.get("/api/v1/queue", headers=login(client, "coordinator")).json()
    assert queue["total"] == 1


def test_urgent_after_a_normal_completion_or_with_another_trigger_is_a_409(client) -> None:
    add_participant(client, "P-001")
    done = run_kiosk_checkin(client, "P-001", responses=ZERO_RESPONSES, gates=QUIET_GATES)
    res = client.post(
        f"{BASE}/{done['session_id']}/urgent",
        json={"trigger": "urgent_now", "ts_client": now_iso()},
    )
    assert res.status_code == 409
    session_id = start(client, "P-002")
    ok = client.post(
        f"{BASE}/{session_id}/urgent", json={"trigger": "urgent_now", "ts_client": now_iso()}
    )
    assert ok.status_code == 200
    other = client.post(
        f"{BASE}/{session_id}/urgent", json={"trigger": "severe_dyspnea", "ts_client": now_iso()}
    )
    assert other.status_code == 409
    again = client.post(f"{BASE}/{session_id}/complete", json={"ts_client": now_iso()})
    assert again.status_code == 409


def test_urgent_validates_the_trigger_and_the_session(client) -> None:
    session_id = start(client)
    bad = client.post(
        f"{BASE}/{session_id}/urgent", json={"trigger": "panic", "ts_client": now_iso()}
    )
    assert bad.status_code == 422
    missing = client.post(
        f"{BASE}/NOPE/urgent", json={"trigger": "urgent_now", "ts_client": now_iso()}
    )
    assert missing.status_code == 404


def test_complete_still_demands_every_answer_without_the_urgent_path(client) -> None:
    session_id = start(client)
    answer(client, session_id, "cough", "severity", 1)
    res = client.post(f"{BASE}/{session_id}/complete", json={"ts_client": now_iso()})
    assert res.status_code == 422
    assert res.json()["title"] == "Check-in incomplete"


def test_urgent_now_true_on_the_gates_is_a_tier_three_red_flag_without_early_stop(client) -> None:
    add_participant(client, "P-003")
    done = run_kiosk_checkin(
        client,
        "P-003",
        responses=ZERO_RESPONSES,
        gates={**QUIET_GATES, "urgent_now": True},
    )
    assert done["tier"] == 3 and done["stop_screen"] is True
    assert "ended_early" not in done
    detail = detail_of(client, done["session_id"])
    rule_ids = [r["rule_id"] for r in detail["rules_fired"]]
    assert "redflag.urgent_now" in rule_ids and "redflag.ended_early" not in rule_ids
    assert any(a["item_id"] == "gate_urgent_now" and a["value_int"] == 1 for a in detail["answers"])


def test_urgent_now_false_on_the_gates_changes_nothing(client) -> None:
    add_participant(client, "P-004")
    done = run_kiosk_checkin(
        client,
        "P-004",
        responses=ZERO_RESPONSES,
        gates={**QUIET_GATES, "urgent_now": False},
    )
    assert done["tier"] == 0 and done["stop_screen"] is False


# ---------------------------------------------------------------- R5.2 free text


def test_caregiver_free_text_raises_tier_three_with_the_quote_as_evidence(client) -> None:
    add_participant(client, "P-005")
    done = run_kiosk_checkin(
        client,
        "P-005",
        responses=ZERO_RESPONSES,
        gates={**QUIET_GATES, "other_text": TIGHT},
    )
    assert done["tier"] == 3 and done["stop_screen"] is True
    detail = detail_of(client, done["session_id"])
    rule = next(r for r in detail["rules_fired"] if r["rule_id"] == "redflag.free_text")
    assert any("tight" in q for q in rule["inputs"]["quotes"])
    gate_other = next(a for a in detail["answers"] if a["item_id"] == "gate_other")
    pointers = [e for e in rule["evidence"] if e["kind"] == "gate_answer"]
    assert pointers and all(p["id"] == gate_other["id"] for p in pointers)
    assert all(e["resolved"] for e in detail["evidence_index"].values())
    assert detail["escalation"]["tier"] == 3 and detail["escalation"]["paged_at"]
    assert any("comment box" in r for r in detail["escalation"]["reasons"])


def test_free_text_asking_for_a_person_is_tier_two(client) -> None:
    add_participant(client, "P-006")
    done = run_kiosk_checkin(
        client,
        "P-006",
        responses=ZERO_RESPONSES,
        gates={**QUIET_GATES, "other_text": "I want to talk to a person please"},
    )
    assert done["tier"] == 2 and done["stop_screen"] is False
    detail = detail_of(client, done["session_id"])
    assert "redflag.free_text_human_request" in [r["rule_id"] for r in detail["rules_fired"]]


def test_harmless_free_text_changes_nothing(client) -> None:
    add_participant(client, "P-008")
    done = run_kiosk_checkin(
        client,
        "P-008",
        responses=ZERO_RESPONSES,
        gates={**QUIET_GATES, "other_text": "Is there parking near the clinic?"},
    )
    assert done["tier"] == 0


def test_free_text_hospital_mention_against_a_no_starts_the_sae_clock(client) -> None:
    add_participant(client, "P-009")
    done = run_kiosk_checkin(
        client,
        "P-009",
        responses=ZERO_RESPONSES,
        gates={**QUIET_GATES, "other_text": "I went to the ER on Sunday for the vomiting"},
    )
    assert done["tier"] == 3
    detail = detail_of(client, done["session_id"])
    assert detail["result"]["seriousness_suspected"] is True
    clock = detail["sae_clock"]
    assert clock and clock["kind"] == "sae" and clock["stopped_at"] is None
    reasons = " ".join(detail["escalation"]["reasons"])
    assert "conflicts with the No answer" in reasons


# ---------------------------------------------------------------- R5.2 several medications


def test_one_box_with_two_medicines_is_two_cm_drafts(client) -> None:
    add_participant(client, "P-010")
    done = run_kiosk_checkin(
        client,
        "P-010",
        responses=ZERO_RESPONSES,
        gates={
            "hospitalization": False,
            "conmed_changed": True,
            "conmed_text": "cefalexin antibiotic pill and hydrocortisone cream from urgent care",
            "conmed_direction": "started",
        },
    )
    detail = detail_of(client, done["session_id"])
    cms = cm_drafts(detail)
    assert [d["fields"]["CMDECOD"] for d in cms] == ["cephalexin", "hydrocortisone"]
    assert [d["fields"]["CMSEQ"] for d in cms] == [1, 2]
    assert [d["fields"]["CMTRT"] for d in cms] == [
        "cefalexin antibiotic pill",
        "hydrocortisone cream from urgent care",
    ]
    # The full text stays verbatim in the one gate answer both drafts cite.
    text_row = next(a for a in detail["answers"] if a["item_id"] == "gate_conmed_text")
    assert text_row["value_text"].startswith("cefalexin antibiotic pill and hydrocortisone")
    assert all(e["resolved"] for e in detail["evidence_index"].values())


def test_conmeds_list_is_the_source_of_truth_with_its_own_evidence(client) -> None:
    add_participant(client, "P-011")
    done = run_kiosk_checkin(
        client,
        "P-011",
        responses=ZERO_RESPONSES,
        gates={
            "hospitalization": False,
            "conmed_changed": False,  # the list wins: implied yes
            "conmed_text": "ignored",
            "conmeds": [
                {"text": "loratadine", "direction": "started"},
                {"text": "prednisone", "direction": "stopped"},
                {"text": "bevacizumab", "direction": "started"},
            ],
        },
    )
    detail = detail_of(client, done["session_id"])
    cms = cm_drafts(detail)
    assert [d["fields"]["CMTRT"] for d in cms] == ["loratadine", "prednisone", "bevacizumab"]
    assert [d["fields"]["INTERIM_DIRECTION"] for d in cms] == ["started", "stopped", "started"]
    by_id = {a["item_id"]: a for a in detail["answers"]}
    assert {"gate_conmed_text", "gate_conmed_text_2", "gate_conmed_text_3"} <= set(by_id)
    assert by_id["gate_conmed_text_3"]["value_text"] == "bevacizumab"
    trt = cms[2]["evidence"]["CMTRT"]
    assert any(p["id"] == by_id["gate_conmed_text_3"]["id"] for p in trt)
    assert done["tier"] == 2  # bevacizumab is prohibited: protocol floor
    assert "tier.protocol_floor" in [r["rule_id"] for r in detail["rules_fired"]]
    assert all(e["resolved"] for e in detail["evidence_index"].values())


def test_resubmitting_a_shorter_conmeds_list_blanks_the_removed_entries(client) -> None:
    session_id = start(client, "P-012")
    post_answers_and_gates(
        client,
        session_id,
        responses=ZERO_RESPONSES,
        gates={
            "hospitalization": False,
            "conmed_changed": True,
            "conmeds": [
                {"text": "loratadine", "direction": "started"},
                {"text": "aspirin", "direction": "started"},
            ],
        },
    )
    client.post(
        f"{BASE}/{session_id}/gates",
        json={
            "hospitalization": False,
            "conmed_changed": True,
            "conmeds": [{"text": "loratadine", "direction": "started"}],
            "ts_client": now_iso(),
        },
    )
    done = client.post(f"{BASE}/{session_id}/complete", json={"ts_client": now_iso()}).json()
    detail = detail_of(client, done["session_id"])
    assert [d["fields"]["CMTRT"] for d in cm_drafts(detail)] == ["loratadine"]
    blanked = next(a for a in detail["answers"] if a["item_id"] == "gate_conmed_text_2")
    assert blanked["value_text"] is None and blanked["value_int"] is None


def test_too_many_conmeds_is_rejected(client) -> None:
    session_id = start(client, "P-013")
    res = client.post(
        f"{BASE}/{session_id}/gates",
        json={
            "hospitalization": False,
            "conmed_changed": True,
            "conmeds": [{"text": f"drug{i}", "direction": "started"} for i in range(11)],
            "ts_client": now_iso(),
        },
    )
    assert res.status_code == 422


def test_a_normal_demo_checkin_is_unchanged(client) -> None:
    add_participant(client, "P-014")
    done = run_kiosk_checkin(client, "P-014", responses=DEMO_RESPONSES)
    assert done["tier"] == 1 and "ended_early" not in done


# ---------------------------------------------------------------- R5 kiosk personas in the harness


def test_kiosk_personas_run_through_the_eval_harness_including_early_stop(client) -> None:
    import json

    from interim_rules.tables import data_dir

    table = json.loads((data_dir() / "personas.json").read_text(encoding="utf-8"))
    ids = [p["id"] for p in table["kiosk_personas"]]
    assert len(ids) >= 6 and any(p.get("early_stop") for p in table["kiosk_personas"])
    coord = login(client, "coordinator")
    res = client.post("/api/v1/eval/run", json={"persona_ids": ids}, headers=coord)
    assert res.status_code == 200, res.text
    results = res.json()
    failed = [p for p in results["per_persona"] if not p["pass"]]
    assert not failed, "\n".join(f"{p['persona_id']}: {p['mismatches']}" for p in failed)
    assert results["n_personas"] == len(ids)
    early = next(
        p for p in results["per_persona"] if p["persona_id"] == "K-urgent-now-yes-early-stop"
    )
    assert early["actual"]["ended_early"] == "urgent_now" and early["actual"]["tier"] == 3
