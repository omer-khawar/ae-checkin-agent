"""Stage-3 integration extras: the small, cheap fields the stage-2 dashboard pages read.

Each assertion pins one web <-> API gap closed on the API side (stage2a_gaps.json):
query suggestions carry their resolved evidence, the time-saved strip gets a plain
``queries_answered`` count, brief escalation lines carry an ``acknowledged`` boolean,
timeline notes carry the participant label, and an escalation that vitals raised says
whether those vitals were measured or simulated (and says nothing when vitals played
no part).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from conftest import DEMO_RESPONSES, add_participant, login, run_kiosk_checkin
from fastapi.testclient import TestClient

API = "/api/v1"


def _get(client: TestClient, path: str, headers: dict[str, str], **params: Any) -> Any:
    res = client.get(f"{API}{path}", headers=headers, params=params)
    assert res.status_code == 200, res.text
    return res.json()


def test_seeded_pages_get_their_extras(seeded_client: TestClient) -> None:
    coord = login(seeded_client, "coordinator")

    # Queries: every id the suggested answer cites resolves to a pointer object.
    page = _get(seeded_client, "/queries", coord)
    assert page["items"], "the Monday-morning seed has sponsor queries"
    for row in page["items"]:
        detail = _get(seeded_client, f"/queries/{row['id']}", coord)
        suggestion = detail["suggested_answer"]
        assert suggestion is not None
        cited = {i for s in suggestion["sentences"] for i in s["evidence_ids"]}
        resolved = {e["id"] for e in suggestion["evidence"]}
        assert cited and cited == resolved
        assert all({"kind", "id", "note"} <= set(e) for e in suggestion["evidence"])

    # Time saved: a plain count of answered queries next to the from-suggestion count.
    since = (datetime.now(UTC) - timedelta(days=60)).date().isoformat()
    metrics = _get(seeded_client, "/metrics/time-saved", coord, since=since)
    answered = sum(1 for r in page["items"] if r["status"] in ("answered", "closed"))
    assert metrics["queries_answered"] == answered >= 1
    assert metrics["queries_answered"] >= metrics["queries_answered_from_suggestion"]
    assert metrics["is_estimate"] is True and metrics["disclaimer"]

    # Brief and timeline for the participant with the caregiver phone call.
    participants = _get(seeded_client, "/participants", coord, limit=100)["items"]
    usubjids = [p["usubjid"] for p in participants]
    saw_escalation = saw_note = False
    for usubjid in usubjids:
        brief = _get(seeded_client, f"/participants/{usubjid}/brief", coord)
        section = next(s for s in brief["sections"] if s["key"] == "escalations_and_clocks")
        for item in section["items"]:
            if "tier" in item:  # an escalation line, not a clock line
                saw_escalation = True
                assert isinstance(item["acknowledged"], bool)
                assert "status" not in item
                assert ("not yet acknowledged" in item["text"]) is (not item["acknowledged"])
        timeline = _get(seeded_client, f"/participants/{usubjid}/timeline", coord)
        label = timeline["participant"]["display_label"]
        for note in timeline["notes"]:
            saw_note = True
            assert note["display_label"] == label
    assert saw_escalation and saw_note

    # No seeded escalation was raised by vitals: no MEASURED/SIMULATED claim on any.
    escalations = _get(seeded_client, "/escalations", coord, limit=200)["items"]
    assert escalations and all(e["vitals_is_measured"] is None for e in escalations)


def test_escalation_says_simulated_when_simulated_vitals_raised_it(client: TestClient) -> None:
    add_participant(client, "P-009")
    admin = login(client, "admin")
    from interim_api.util import now_iso

    tachypnea = {
        "tsUtc": now_iso(),
        "source": "mock",
        "isMeasured": False,
        "pulseBpm": 98,
        "pulseConf": 0.9,
        "breathingBpm": 26,
        "breathingConf": 0.9,
        "windowS": 30,
        "qualityFlags": [],
    }
    severe = {**DEMO_RESPONSES, "fatigue": {"severity": 3, "interference": 3}}
    # G3 fatigue (tier 2) with tachypnea and the demo toggle on: corroboration fires.
    bumped = run_kiosk_checkin(
        client,
        "P-009",
        responses=severe,
        samples=[tachypnea],
        headers=admin,
        complete_extra={"settings_override": {"simulated_as_measured": True}},
    )
    # Same answers without the toggle: no corroboration, so no vitals claim.
    plain = run_kiosk_checkin(client, "P-009", responses=severe, samples=[tachypnea])
    rows = _get(client, "/escalations", admin, limit=50)["items"]
    by_session = {r["session_id"]: r for r in rows}
    assert by_session[bumped["session_id"]]["vitals_is_measured"] is False
    assert by_session[plain["session_id"]]["vitals_is_measured"] is None
