"""Audit chain: canonical hashing, append-only guard, verify, and tamper detection."""

from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest
from conftest import add_participant, login, run_kiosk_checkin
from sqlalchemy import delete, update
from sqlmodel import select

from interim_api.audit import GENESIS_PREV_HASH, canonical_json, event_hash
from interim_api.db import AuditImmutableError
from interim_api.models import AuditEvent


def test_hash_formula_matches_the_contract() -> None:
    event = {
        "id": "01TEST",
        "seq": 1,
        "ts_utc": "2026-10-10T18:04:12.345Z",
        "actor_id": "P-007",
        "actor_role": "participant",
        "action": "session.started",
        "entity_type": "session",
        "entity_id": "S1",
        "payload": {"z": 1, "a": "é", "nested": {"b": [1, 2]}},
    }
    expected = hashlib.sha256(
        (
            GENESIS_PREV_HASH
            + json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        ).encode("utf-8")
    ).hexdigest()
    assert event_hash(GENESIS_PREV_HASH, event) == expected
    assert canonical_json({"b": 1, "a": "é"}) == '{"a":"é","b":1}'


def test_chain_is_sequential_and_verifies(client, coordinator) -> None:
    add_participant(client, "P-004")
    run_kiosk_checkin(client, "P-004")
    page = client.get("/api/v1/audit?limit=500", headers=coordinator).json()
    events = sorted(page["items"], key=lambda e: e["seq"])
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert events[0]["prev_hash"] == GENESIS_PREV_HASH
    for prev, cur in zip(events, events[1:], strict=False):
        assert cur["prev_hash"] == prev["hash"]
        body = {
            k: cur[k]
            for k in (
                "id",
                "seq",
                "ts_utc",
                "actor_id",
                "actor_role",
                "action",
                "entity_type",
                "entity_id",
                "payload",
            )
        }
        assert cur["hash"] == event_hash(prev["hash"], body)
    verify = client.get("/api/v1/audit/verify", headers=coordinator).json()
    assert (
        verify["ok"]
        and verify["checked"] == len(events)
        and verify["head_hash"] == events[-1]["hash"]
    )
    filtered = client.get("/api/v1/audit?action=session.completed", headers=coordinator).json()
    assert filtered["total"] == 1 and filtered["items"][0]["actor_role"] == "participant"


def test_audit_rows_cannot_be_updated_or_deleted_through_sqlalchemy(client) -> None:
    login(client, "admin")  # writes the first event (auth.login) of this fresh chain
    database = client.app.state.database
    with database.read_scope() as db:
        row = db.exec(select(AuditEvent).order_by(AuditEvent.seq)).first()
        assert row is not None
        row.action = "tampered"
        db.add(row)
        with pytest.raises(AuditImmutableError):
            db.flush()
        db.rollback()
    with database.read_scope() as db:
        row = db.exec(select(AuditEvent).order_by(AuditEvent.seq)).first()
        db.delete(row)
        with pytest.raises(AuditImmutableError):
            db.flush()
        db.rollback()
    with database.read_scope() as db, pytest.raises(AuditImmutableError):
        db.execute(update(AuditEvent).values(action="tampered"))
    with database.read_scope() as db, pytest.raises(AuditImmutableError):
        db.execute(delete(AuditEvent))


def test_tampering_in_the_database_is_reported_at_the_right_index(client, settings) -> None:
    add_participant(client, "P-006")
    run_kiosk_checkin(client, "P-006")
    headers = login(client, "coordinator")
    assert client.get("/api/v1/audit/verify", headers=headers).json()["ok"] is True
    # Edit a payload behind the API's back (plain sqlite3, outside SQLAlchemy's guard).
    path = settings.resolved_database_url.removeprefix("sqlite:///")
    conn = sqlite3.connect(path)
    try:
        seq_target = 5
        (payload,) = conn.execute(
            "SELECT payload_json FROM audit_events WHERE seq = ?", (seq_target,)
        ).fetchone()
        tampered = json.loads(payload)
        tampered["tampered"] = True
        conn.execute(
            "UPDATE audit_events SET payload_json = ? WHERE seq = ?",
            (json.dumps(tampered, separators=(",", ":")), seq_target),
        )
        conn.commit()
    finally:
        conn.close()
    verify = client.get("/api/v1/audit/verify", headers=headers).json()
    assert verify["ok"] is False
    broken = verify["first_broken"]
    assert broken["seq"] == seq_target and broken["index"] == seq_target - 1
    assert broken["expected_hash"] != broken["actual_hash"]
    assert "recomputed" in broken["reason"]
    assert verify["checked"] == seq_target - 1
