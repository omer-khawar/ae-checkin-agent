"""Phone-call intake (CONTRACTS.md R4.1) and the removal of per-session camera consent
(CLAUDE.md §00 / D-026), both delivered with the sponsor-query track."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from conftest import (
    DEMO_SAMPLE_CAMEL,
    QUIET_GATES,
    ZERO_RESPONSES,
    add_participant,
    post_answers_and_gates,
)
from fastapi.testclient import TestClient
from sqlalchemy import inspect

from interim_api.db import create_all, make_engine
from interim_api.util import now_iso

CALL_TEXT = (
    "Caregiver (daughter) called: patient has had diarrhea for 3 days, about 6 episodes a "
    "day, and started loperamide yesterday."
)


def _log_call(client: TestClient, headers: dict[str, str], **extra: object):
    body = {
        "usubjid": "P-003",
        "note_date": now_iso()[:10],
        "author": "coordinator",
        "note_type": "phone_call",
        "text": CALL_TEXT,
        "caller": "caregiver",
        "call_direction": "inbound",
        **extra,
    }
    return client.post("/api/v1/notes", json=body, headers=headers)


# --------------------------------------------------------------------------- #
# R4.1 phone calls
# --------------------------------------------------------------------------- #


def test_phone_call_is_scanned_like_a_note_and_labelled(client: TestClient, coordinator) -> None:
    add_participant(client, "P-003")
    res = _log_call(client, coordinator)
    assert res.status_code == 201, res.text
    body = res.json()
    note = body["note"]
    assert note["note_type"] == "phone_call" and note["source_label"] == "phone_call"
    assert note["is_phone_call"] is True
    assert note["caller"] == "caregiver" and note["call_direction"] == "inbound"
    assert note["source"] == "chart_note"  # one scanner, one storage source
    terms = {d["fields"].get("AEDECOD") for d in body["drafts"] if d["domain"] == "AE"}
    assert "Diarrhea" in terms

    listed = client.get("/api/v1/notes", headers=coordinator).json()["items"]
    assert listed[0]["source_label"] == "phone_call" and listed[0]["caller"] == "caregiver"
    detail = client.get(f"/api/v1/notes/{note['id']}", headers=coordinator).json()
    assert detail["note"]["call_direction"] == "inbound"

    queue = client.get("/api/v1/queue?status=all", headers=coordinator).json()["items"]
    row = next(r for r in queue if r.get("note_id") == note["id"])
    assert row["source_label"] == "phone_call" and row["note_type"] == "phone_call"
    assert row["caller"] == "caregiver" and row["call_direction"] == "inbound"

    timeline = client.get("/api/v1/participants/P-003/timeline", headers=coordinator).json()
    entry = next(n for n in timeline["notes"] if n["id"] == note["id"])
    assert entry["source_label"] == "phone_call" and entry["caller"] == "caregiver"

    events = client.get(
        f"/api/v1/audit?entity_id={note['id']}&action=note.ingested", headers=coordinator
    ).json()["items"]
    payload = events[0]["payload"]
    assert payload["note_type"] == "phone_call" and payload["caller"] == "caregiver"
    assert payload["call_direction"] == "inbound"


def test_ordinary_note_has_chart_note_label_and_no_call_fields(
    client: TestClient, coordinator
) -> None:
    add_participant(client, "P-003")
    res = _log_call(client, coordinator, note_type="clinic_note", caller=None, call_direction=None)
    assert res.status_code == 201, res.text
    note = res.json()["note"]
    assert note["source_label"] == "chart_note" and note["is_phone_call"] is False
    assert note["caller"] is None and note["call_direction"] is None


def test_call_fields_are_validated(client: TestClient, coordinator) -> None:
    add_participant(client, "P-003")
    assert _log_call(client, coordinator, caller="neighbour").status_code == 422
    assert _log_call(client, coordinator, call_direction="sideways").status_code == 422
    wrong_type = _log_call(client, coordinator, note_type="er_note")
    assert wrong_type.status_code == 422
    # Caller and direction are optional on a call.
    ok = _log_call(client, coordinator, caller=None, call_direction=None)
    assert ok.status_code == 201, ok.text
    assert ok.json()["note"]["source_label"] == "phone_call"


# --------------------------------------------------------------------------- #
# CLAUDE.md §00 / D-026: no per-session camera consent
# --------------------------------------------------------------------------- #


def test_session_defaults_to_camera_on_with_enrollment_consent_basis(
    client: TestClient, coordinator
) -> None:
    add_participant(client, "P-001")
    res = client.post("/api/v1/sessions", json={"usubjid": "P-001"})
    assert res.status_code == 201, res.text
    session = res.json()
    assert session["consent_camera"] is True and session["consent_basis"] == "enrollment_icf"
    assert session["vitals_status"] == "pending"
    sid = session["id"]
    # Vitals are accepted straight away: no consent step in between.
    vitals = client.post(
        f"/api/v1/sessions/{sid}/vitals",
        json={"samples": [{**DEMO_SAMPLE_CAMEL, "tsUtc": now_iso()}]},
    )
    assert vitals.status_code == 200, vitals.text
    assert vitals.json()["accepted"] == 1
    consent = client.get(
        f"/api/v1/audit?entity_id={sid}&action=session.consent", headers=coordinator
    ).json()["items"][0]["payload"]
    assert consent["consent_basis"] == "enrollment_icf" and consent["consent_camera"] is True
    post_answers_and_gates(client, sid, responses=ZERO_RESPONSES, gates=QUIET_GATES)
    done = client.post(f"/api/v1/sessions/{sid}/complete", json={"ts_client": now_iso()})
    assert done.status_code == 200, done.text
    final = client.get(f"/api/v1/sessions/{sid}").json()
    assert final["vitals_status"] != "declined" and final["consent_basis"] == "enrollment_icf"


def test_camera_turned_off_is_the_only_declined_case(client: TestClient) -> None:
    add_participant(client, "P-001")
    res = client.post("/api/v1/sessions", json={"usubjid": "P-001", "consent_camera": False})
    session = res.json()
    assert session["vitals_status"] == "declined" and session["consent_basis"] == "enrollment_icf"
    refused = client.post(
        f"/api/v1/sessions/{session['id']}/vitals",
        json={"samples": [{**DEMO_SAMPLE_CAMEL, "tsUtc": now_iso()}]},
    )
    assert refused.status_code == 409 and refused.json()["title"] == "Camera turned off"


def test_existing_database_gains_the_new_columns(tmp_path: Path) -> None:
    """An earlier build's ``sessions`` table (no ``consent_basis``) is upgraded in place."""
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE sessions (id VARCHAR PRIMARY KEY, usubjid VARCHAR, study_id VARCHAR, "
            "started_at VARCHAR, completed_at VARCHAR, consent_camera BOOLEAN, "
            "vitals_status VARCHAR, tier INTEGER, stop_screen_shown BOOLEAN, is_eval BOOLEAN, "
            "max_grade INTEGER, is_measured BOOLEAN, backdated BOOLEAN, settings_json TEXT, "
            "result_json TEXT)"
        )
        conn.execute(
            "INSERT INTO sessions (id, usubjid, study_id, started_at, consent_camera, "
            "vitals_status, stop_screen_shown, is_eval, backdated) "
            "VALUES ('S1', 'U1', 'ST', '2026-10-01T00:00:00.000Z', 1, 'pending', 0, 0, 0)"
        )
    engine = make_engine(f"sqlite:///{path.as_posix()}")
    try:
        create_all(engine)
        columns = {c["name"] for c in inspect(engine).get_columns("sessions")}
        assert "consent_basis" in columns
        assert "queries" in inspect(engine).get_table_names()
        create_all(engine)  # idempotent
    finally:
        engine.dispose()
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT consent_basis FROM sessions").fetchone() == (None,)
