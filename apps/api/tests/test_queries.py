"""Sponsor queries (CONTRACTS.md R4.4, CLAUDE.md §00 step 7).

Edit checks run when confirmed records reach the mock EDC and on an admin re-run; a re-run
never duplicates a live query; the coordinator answers from the template writer's suggested
answer (optionally correcting the record as a new draft version); the sponsor closes.
"""

from __future__ import annotations

from typing import Any

from conftest import add_participant, login, run_kiosk_checkin
from fastapi.testclient import TestClient

CM_CHECK = "query.cm_required_fields_missing"


def _drafts(client: TestClient, session_id: str, headers: dict[str, str]) -> list[dict[str, Any]]:
    detail = client.get(f"/api/v1/checkins/{session_id}", headers=headers)
    assert detail.status_code == 200, detail.text
    return list(detail.json()["drafts"])


def _confirmed_cm(client: TestClient, coordinator: dict[str, str]) -> tuple[str, dict[str, Any]]:
    """P-007's demo check-in (loratadine started), its CM draft confirmed."""
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    cm = next(d for d in _drafts(client, done["session_id"], coordinator) if d["domain"] == "CM")
    res = client.post(f"/api/v1/drafts/{cm['id']}/confirm", json={}, headers=coordinator)
    assert res.status_code == 200, res.text
    return done["session_id"], res.json()


def _post_confirmed(client: TestClient, domain: str, headers: dict[str, str]) -> dict[str, Any]:
    exported = client.get(f"/api/v1/export/{domain}.json?status=confirmed", headers=headers)
    assert exported.status_code == 200, exported.text
    records = exported.json()["records"]
    res = client.post(f"/api/v1/mock-edc/{domain}", json={"records": records}, headers=headers)
    assert res.status_code == 200, res.text
    return dict(res.json())


def test_mock_edc_post_raises_a_query_once(client: TestClient, coordinator, admin) -> None:
    _, cm = _confirmed_cm(client, coordinator)
    ack = _post_confirmed(client, "CM", coordinator)
    assert ack["queries"]["records_checked"] == 1
    assert ack["queries"]["raised"] == 1 and ack["queries"]["already_open"] == 0

    page = client.get("/api/v1/queries?status=open", headers=coordinator).json()
    assert page["total"] == 1 and page["counts"] == {"open": 1, "answered": 0, "closed": 0}
    row = page["items"][0]
    assert row["check_id"] == CM_CHECK and row["domain"] == "CM"
    assert row["draft_id"] == cm["id"] and row["lineage_id"] == cm["lineage_id"]
    assert row["field"] == "CMDOSE" and row["field_label"] and row["display_label"] == "P-007"
    assert row["severity"] == "data" and row["status"] == "open"
    assert row["raised_by"] == "edit-check" and row["trigger"] == "mock_edc"
    assert row["edc_ack_id"] == ack["ack_id"]
    assert isinstance(row["age_hours"], float) and row["age_hours"] >= 0
    assert "loratadine" in row["text"] and "dose" in row["text"].lower()
    assert any(e["kind"] == "rule" and e["id"] == CM_CHECK for e in row["evidence"])
    assert row["check_sentence"] and "{" not in row["check_sentence"]

    # A re-post and an admin re-run do not duplicate the open query.
    again = _post_confirmed(client, "CM", coordinator)
    assert again["queries"]["raised"] == 0 and again["queries"]["already_open"] == 1
    rerun = client.post("/api/v1/queries/run-checks", json={}, headers=admin)
    assert rerun.status_code == 200, rerun.text
    assert rerun.json()["raised"] == 0 and rerun.json()["already_open"] == 1
    assert client.get("/api/v1/queries", headers=coordinator).json()["total"] == 1

    raised = client.get("/api/v1/audit?action=query.raised", headers=coordinator).json()
    assert raised["total"] == 1
    payload = raised["items"][0]["payload"]
    assert payload["check_id"] == CM_CHECK and payload["triggered_by"] == "coordinator"
    assert raised["items"][0]["actor_id"] == "edit-check"


def test_unlinked_and_unconfirmed_records_are_not_checked(client: TestClient, coordinator) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    exported = client.get("/api/v1/export/CM.json?status=all", headers=coordinator).json()
    records = exported["records"]
    assert records and records[0]["INTERIM_DRAFT_STATUS"] == "draft"
    unlinked = {k: v for k, v in records[0].items() if k != "INTERIM_DRAFT_ID"}
    res = client.post(
        "/api/v1/mock-edc/CM", json={"records": [records[0], unlinked]}, headers=coordinator
    )
    assert res.status_code == 200, res.text
    summary = res.json()["queries"]
    assert summary["raised"] == 0 and summary["records_checked"] == 0
    assert summary["skipped_not_confirmed"] == 1 and summary["skipped_unlinked"] == 1
    assert done["session_id"]


def test_detail_has_a_template_suggestion_with_resolvable_evidence(
    client: TestClient, coordinator
) -> None:
    _confirmed_cm(client, coordinator)
    _post_confirmed(client, "CM", coordinator)
    qid = client.get("/api/v1/queries", headers=coordinator).json()["items"][0]["id"]
    detail = client.get(f"/api/v1/queries/{qid}", headers=coordinator)
    assert detail.status_code == 200, detail.text
    body = detail.json()
    suggestion = body["suggested_answer"]
    assert suggestion["writer"] == "template" and suggestion["kind"] == "query_answer"
    assert suggestion["text"] and suggestion["sentences"]
    for sentence in suggestion["sentences"]:
        assert sentence["evidence_ids"], sentence
        for ident in sentence["evidence_ids"]:
            assert ident in body["evidence_index"], ident
    assert body["draft"]["domain"] == "CM" and body["current_value"] is None
    assert body["check"]["id"] == CM_CHECK and body["check"]["protocol_ref"]
    assert body["record_label"] and "loratadine" in body["record_label"]
    assert client.get("/api/v1/queries/NOPE", headers=coordinator).status_code == 404


def test_answer_from_suggestion_with_a_correction_then_close(
    client: TestClient, coordinator, admin
) -> None:
    _, cm = _confirmed_cm(client, coordinator)
    _post_confirmed(client, "CM", coordinator)
    qid = client.get("/api/v1/queries", headers=coordinator).json()["items"][0]["id"]
    suggestion = client.get(f"/api/v1/queries/{qid}", headers=coordinator).json()[
        "suggested_answer"
    ]
    answer = suggestion["text"] + " Participant confirmed 10 mg once daily by phone."
    res = client.post(
        f"/api/v1/queries/{qid}/answer",
        json={"answer_text": answer, "also_edit": {"field": "CMDOSE", "value": "10"}},
        headers=coordinator,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "answered" and body["answered_by"] == "coordinator"
    assert body["answered_from_suggestion"] is True
    assert body["answer_text"] == answer
    cited = {e["id"] for e in body["answer_evidence"]}
    assert cited >= {i for s in suggestion["sentences"] for i in s["evidence_ids"]}
    new_id = body["answer_edit_draft_id"]
    assert new_id and new_id != cm["id"]
    assert any(e["kind"] == "draft_version" and e["id"] == new_id for e in body["answer_evidence"])

    # The correction is a new draft version through the ordinary edit path.
    new_version = client.get(f"/api/v1/drafts/{new_id}", headers=coordinator).json()
    assert new_version["fields"]["CMDOSE"] == "10" and new_version["version"] == cm["version"] + 1
    assert new_version["status"] == "draft" and new_version["supersedes_id"] == cm["id"]
    assert new_version["evidence"]["CMDOSE"][-1]["kind"] == "edit"
    assert body["current_draft_id"] == new_id and body["current_value"] == "10"

    again = client.post(
        f"/api/v1/queries/{qid}/answer", json={"answer_text": "again"}, headers=coordinator
    )
    assert again.status_code == 409

    assert client.post(f"/api/v1/queries/{qid}/close", headers=coordinator).status_code == 403
    closed = client.post(f"/api/v1/queries/{qid}/close", json={"note": "ok"}, headers=admin)
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "closed" and closed.json()["closed_by"] == "admin"
    assert client.post(f"/api/v1/queries/{qid}/close", headers=admin).status_code == 409
    counts = client.get("/api/v1/queries?status=closed", headers=coordinator).json()["counts"]
    assert counts == {"open": 0, "answered": 0, "closed": 1}

    actions = [
        e["action"]
        for e in client.get(f"/api/v1/audit?entity_id={qid}", headers=coordinator).json()["items"]
    ]
    assert actions == ["query.closed", "query.answered", "query.raised"]
    verify = client.get("/api/v1/audit/verify", headers=coordinator).json()
    assert verify["ok"] is True


def test_closed_query_is_raised_again_when_the_data_still_fails(
    client: TestClient, coordinator, admin
) -> None:
    _confirmed_cm(client, coordinator)
    _post_confirmed(client, "CM", coordinator)
    qid = client.get("/api/v1/queries", headers=coordinator).json()["items"][0]["id"]
    assert client.post(f"/api/v1/queries/{qid}/close", headers=admin).status_code == 200
    rerun = client.post("/api/v1/queries/run-checks", headers=admin).json()
    assert rerun["raised"] == 1 and rerun["already_open"] == 0
    assert rerun["queries"][0]["trigger"] == "run_checks"
    page = client.get("/api/v1/queries?status=all", headers=coordinator).json()
    assert page["counts"] == {"open": 1, "answered": 0, "closed": 1}
    assert client.post("/api/v1/queries/run-checks", headers=coordinator).status_code == 403


def test_manual_query_by_the_sponsor_monitor(client: TestClient, coordinator, admin) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    ae = next(d for d in _drafts(client, done["session_id"], coordinator) if d["domain"] == "AE")
    body = {"draft_id": ae["id"], "field": "AETOXGR", "text": "Please confirm the grade."}
    assert client.post("/api/v1/queries", json=body, headers=coordinator).status_code == 403
    bad = client.post("/api/v1/queries", json={**body, "field": "NOTAFIELD"}, headers=admin)
    assert bad.status_code == 422
    res = client.post("/api/v1/queries", json={**body, "severity": "safety"}, headers=admin)
    assert res.status_code == 201, res.text
    row = res.json()
    assert row["check_id"] is None and row["raised_by"] == "admin" and row["trigger"] == "manual"
    assert row["severity"] == "safety" and row["field_label"]
    assert row["evidence"], "the field's own evidence is attached"
    # Safety queries sort first.
    assert client.get("/api/v1/queries", headers=coordinator).json()["items"][0]["id"] == row["id"]

    unknown = client.post(
        f"/api/v1/queries/{row['id']}/answer",
        json={"answer_text": "Grade 2 confirmed.", "evidence_ids": ["does-not-exist"]},
        headers=coordinator,
    )
    assert unknown.status_code == 422
    some_id = row["evidence"][0]["id"]
    ok = client.post(
        f"/api/v1/queries/{row['id']}/answer",
        json={"answer_text": "Grade 2 confirmed with the participant.", "evidence_ids": [some_id]},
        headers=login(client, "investigator"),
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["answered_from_suggestion"] is False
    assert [e["id"] for e in ok.json()["answer_evidence"]] == [some_id]


def test_serious_ae_without_a_signed_report_is_a_safety_query(
    client: TestClient, coordinator, investigator, admin
) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    ae = next(d for d in _drafts(client, done["session_id"], coordinator) if d["domain"] == "AE")
    attributed = client.patch(
        f"/api/v1/drafts/{ae['id']}/attribution", json={"AESER": "Y"}, headers=investigator
    )
    assert attributed.status_code == 200, attributed.text
    confirmed = client.post(
        f"/api/v1/drafts/{attributed.json()['id']}/confirm", json={}, headers=coordinator
    )
    assert confirmed.status_code == 200, confirmed.text
    rerun = client.post("/api/v1/queries/run-checks", json={"domains": ["AE"]}, headers=admin)
    assert rerun.status_code == 200, rerun.text
    checks = {q["check_id"]: q for q in rerun.json()["queries"]}
    serious = checks["query.ae_serious_no_signed_report"]
    assert serious["severity"] == "safety" and serious["field"] == "AESER"
    filtered = client.get("/api/v1/queries?severity=safety&domain=AE", headers=coordinator).json()
    assert [q["id"] for q in filtered["items"]] == [serious["id"]]
    by_draft = client.get(f"/api/v1/queries?draft_id={ae['id']}", headers=coordinator).json()
    assert by_draft["total"] == 1  # any version of the record finds its queries
    by_label = client.get("/api/v1/queries?usubjid=P-007", headers=coordinator).json()
    assert by_label["total"] == 1
    assert client.get("/api/v1/queries?usubjid=P-999", headers=coordinator).json()["total"] == 0


def test_answered_from_suggestion_feeds_time_saved_helper() -> None:
    from interim_api.services.queries import from_suggestion

    assert from_suggestion("The record  says x.", "The record says x.")
    assert from_suggestion("The record says x. More.", "The record says x.")
    assert not from_suggestion("Something else.", "The record says x.")
    assert not from_suggestion("anything", "")
