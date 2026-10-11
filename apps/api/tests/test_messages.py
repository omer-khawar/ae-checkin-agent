"""CONTRACTS.md R6: participant confirmation texts (mock outbox, Twilio, the "reviewed" text)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from conftest import (
    QUIET_GATES,
    ZERO_RESPONSES,
    add_participant,
    login,
    make_settings,
    run_kiosk_checkin,
)
from fastapi.testclient import TestClient

from interim_api.models import Participant
from interim_api.notifier import OutboxNotifier, TwilioNotifier, get_notifier
from interim_api.seed import demo_phone
from interim_api.services import messages as messages_svc
from interim_api.services.messages import REVIEW_ACK_TEXT, confirmation_text, mask_phone
from interim_api.util import now_iso

BASE = "/api/v1/sessions"
PHONE = "+17325554821"
COMPLETED_AT = "2026-10-11T13:14:00Z"  # 9:14 AM in New York
CLINICAL_WORDS = (
    "grade",
    "tier",
    "adverse",
    "ctcae",
    "serious",
    "provisional",
    "symptom",
    "escalat",
    "dyspnea",
    "toxicity",
    "severe",
)


def give_phone(client: TestClient, label: str = "P-007", phone: str = PHONE) -> str:
    usubjid = add_participant(client, label)
    database = client.app.state.database  # type: ignore[attr-defined]
    with database.write_scope() as db:
        row = db.get(Participant, usubjid)
        assert row is not None
        row.phone = phone
        db.add(row)
    return usubjid


def audit_events(client: TestClient, action: str) -> list[dict[str, Any]]:
    res = client.get("/api/v1/audit?limit=500", headers=login(client, "admin"))
    return [e for e in res.json()["items"] if e["action"] == action]


def detail(client: TestClient, session_id: str) -> dict[str, Any]:
    res = client.get(f"/api/v1/checkins/{session_id}", headers=login(client, "coordinator"))
    assert res.status_code == 200, res.text
    return res.json()


def urgent(client: TestClient, label: str = "P-007") -> dict[str, Any]:
    res = client.post(BASE, json={"usubjid": label, "consent_camera": True})
    session_id = res.json()["id"]
    res = client.post(
        f"{BASE}/{session_id}/urgent", json={"trigger": "urgent_now", "ts_client": now_iso()}
    )
    assert res.status_code == 200, res.text
    return dict(res.json())


# ---------------------------------------------------------------- message text per tier


@pytest.mark.parametrize("tier", [0, 1, 2, 3])
def test_confirmation_text_is_plain_language_for_every_tier(tmp_path, tier: int) -> None:
    settings = make_settings(tmp_path)
    text = confirmation_text(tier, COMPLETED_AT, settings)
    assert "We received your check-in at 9:14 AM on Sun, Oct 11." in text
    assert settings.site_phone in text
    assert "call 911" in text
    assert ("The study team will call you today." in text) is (tier == 3)
    assert not [w for w in CLINICAL_WORDS if w in text.lower()]


def test_review_text_and_masking() -> None:
    assert REVIEW_ACK_TEXT == "Your study nurse has reviewed your check-in."
    assert mask_phone(PHONE) == "•••-4821"
    assert demo_phone("P-007") == "+17325550167"  # fictional 555-01xx range
    assert demo_phone("no digits") is None


# ---------------------------------------------------------------- sender selection


def test_no_twilio_keys_means_the_mock_outbox(tmp_path) -> None:
    assert isinstance(get_notifier(make_settings(tmp_path)), OutboxNotifier)
    partial = make_settings(tmp_path, twilio_account_sid="AC1", twilio_auth_token="t")
    assert isinstance(get_notifier(partial), OutboxNotifier)
    full = make_settings(
        tmp_path, twilio_account_sid="AC1", twilio_auth_token="t", twilio_from="+15550100"
    )
    assert isinstance(get_notifier(full), TwilioNotifier)


def test_twilio_notifier_posts_the_message_and_never_raises() -> None:
    seen: dict[str, Any] = {}

    def ok(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["body"] = str(request.url), request.content.decode()
        return httpx.Response(201, json={"sid": "SM123"})

    sent = TwilioNotifier("AC1", "tok", "+15550100", transport=httpx.MockTransport(ok)).send(
        PHONE, "hello"
    )
    assert (sent.channel, sent.status, sent.provider_id) == ("twilio", "sent", "SM123")
    assert seen["url"].endswith("/Accounts/AC1/Messages.json")
    assert "Body=hello" in seen["body"] and "To=%2B17325554821" in seen["body"]

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    failed = TwilioNotifier("AC1", "tok", "+1", transport=httpx.MockTransport(down)).send(
        PHONE, "x"
    )
    assert failed.status == "failed" and "ConnectError" in (failed.error or "")


# ---------------------------------------------------------------- end to end


def test_completed_checkin_texts_a_confirmation_to_the_outbox(client) -> None:
    give_phone(client)
    done = run_kiosk_checkin(client, "P-007", responses=ZERO_RESPONSES, gates=QUIET_GATES)
    sent = done["confirmation"]
    assert sent["channel"] == "outbox" and sent["status"] == "outbox"
    assert sent["to_masked"] == "•••-4821" and "to" not in sent
    assert "call 911" in sent["body"] and "call you today" not in sent["body"]

    assert [m["id"] for m in detail(client, done["session_id"])["messages"]] == [sent["id"]]
    events = audit_events(client, "message.sent")
    assert len(events) == 1 and events[0]["payload"]["to_masked"] == "•••-4821"
    assert events[0]["payload"]["consent_basis"] == "enrollment_icf"

    outbox = client.get("/api/v1/admin/messages", headers=login(client, "admin")).json()
    assert outbox["channel"] == "outbox" and outbox["total"] == 1
    assert outbox["items"][0]["to"] == PHONE
    denied = client.get("/api/v1/admin/messages", headers=login(client, "coordinator"))
    assert denied.status_code == 403


def test_no_phone_on_file_sends_nothing(client) -> None:
    add_participant(client)
    done = run_kiosk_checkin(client, "P-007", responses=ZERO_RESPONSES, gates=QUIET_GATES)
    assert done["confirmation"] is None
    assert detail(client, done["session_id"])["messages"] == []


def test_a_failed_send_is_recorded_and_the_checkin_still_completes(client, monkeypatch) -> None:
    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "Authenticate"})

    monkeypatch.setattr(
        messages_svc,
        "get_notifier",
        lambda _s: TwilioNotifier("AC1", "tok", "+1", transport=httpx.MockTransport(down)),
    )
    give_phone(client)
    done = run_kiosk_checkin(client, "P-007", responses=ZERO_RESPONSES, gates=QUIET_GATES)
    assert done["tier"] == 0
    assert done["confirmation"]["status"] == "failed"
    assert "HTTP 401" in done["confirmation"]["error"]
    assert len(audit_events(client, "message.failed")) == 1


def test_urgent_checkin_text_says_the_team_will_call_today_and_is_sent_once(client) -> None:
    give_phone(client)
    first = urgent(client)
    assert first["tier"] == 3
    assert "The study team will call you today." in first["confirmation"]["body"]
    again = client.post(
        f"{BASE}/{first['session_id']}/urgent",
        json={"trigger": "urgent_now", "ts_client": now_iso()},
    ).json()
    assert again["confirmation"]["id"] == first["confirmation"]["id"]
    assert len(detail(client, first["session_id"])["messages"]) == 1


def test_acknowledging_the_checkin_texts_the_review_note(client) -> None:
    give_phone(client)
    first = urgent(client)
    escalation = detail(client, first["session_id"])["escalation"]
    res = client.post(
        f"/api/v1/escalations/{escalation['id']}/ack", headers=login(client, "coordinator")
    )
    assert res.status_code == 200, res.text
    message = res.json()["message"]
    assert message["body"] == REVIEW_ACK_TEXT and message["kind"] == "review_ack"
    kinds = [m["kind"] for m in detail(client, first["session_id"])["messages"]]
    assert kinds == ["checkin_confirmation", "review_ack"]
    assert len(audit_events(client, "message.sent")) == 2
