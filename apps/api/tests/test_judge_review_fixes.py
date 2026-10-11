"""Fixes from the judge / safety review (2026-10-11).

* attribution fields (AESER / AEREL / INTERIM_IRAE) cannot be set through PATCH /drafts/{id},
  by any role: only the investigator's /attribution endpoint writes them;
* the admin/dev role cannot make clinical decisions (ack, confirm, reject, edit, packet edit,
  query answer);
* demo reset is gated by ALLOW_DEMO_RESET and the new genesis records the destroyed chain;
* running 24 h clocks page once at T-4 h and once at breach; every clock stop records
  ``within_24h``.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import ZERO_RESPONSES, add_participant, login, make_settings, run_kiosk_checkin
from fastapi.testclient import TestClient
from sqlmodel import select

from interim_api.main import create_app
from interim_api.models import SAEClock
from interim_api.seed import seed_users
from interim_api.services.clock_alerts import BREACHED, DUE_SOON, sweep_clock_alerts
from interim_api.util import now_iso, shift

API = "/api/v1"


def _responses(**overrides: dict[str, int]) -> dict[str, dict[str, int]]:
    out = {k: dict(v) for k, v in ZERO_RESPONSES.items()}
    out.update(overrides)
    return out


def _sae_checkin(client: TestClient, label: str = "P-003") -> dict[str, Any]:
    add_participant(client, label)
    return run_kiosk_checkin(
        client,
        label,
        responses=_responses(diarrhea={"frequency": 4}),
        gates={
            "hospitalization": True,
            "conmed_changed": False,
            "conmed_text": "",
            "other_text": "",
        },
    )


def _ae_draft(client: TestClient, session_id: str, headers: dict[str, str]) -> dict[str, Any]:
    detail = client.get(f"{API}/checkins/{session_id}", headers=headers).json()
    return next(d for d in detail["drafts"] if d["domain"] == "AE")


def _audit(client: TestClient, headers: dict[str, str], action: str) -> list[dict[str, Any]]:
    res = client.get(f"{API}/audit", params={"action": action, "limit": 500}, headers=headers)
    return [e for e in res.json()["items"] if e["action"] == action]


def test_coordinator_cannot_set_attribution_through_patch(client: TestClient) -> None:
    done = _sae_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    draft = _ae_draft(client, done["session_id"], coord)
    for headers in (coord, inv):
        for fields in ({"AESER": "N"}, {"AEREL": "NOT RELATED"}, {"AESER": "N", "AEREL": "X"}):
            res = client.patch(
                f"{API}/drafts/{draft['id']}", json={"fields": fields}, headers=headers
            )
            assert res.status_code == 403, res.text
            assert "/attribution" in res.json()["detail"]
    # Nothing was written: the draft is still version 1 with no AESER, and the clock runs.
    again = _ae_draft(client, done["session_id"], coord)
    assert again["id"] == draft["id"] and again["fields"].get("AESER") is None
    # Confirm and export cannot carry an AESER the investigator did not set.
    assert client.post(f"{API}/drafts/{draft['id']}/confirm", json={}, headers=coord).is_success
    exported = client.get(f"{API}/export/AE.json", headers=coord).json()["records"]
    mine = [r for r in exported if r["INTERIM_DRAFT_ID"] == draft["id"]]
    assert mine and mine[0].get("AESER") is None and mine[0].get("AEREL") is None


@pytest.mark.parametrize(
    "method,path_fn,body",
    [
        ("post", lambda ids: f"/drafts/{ids['draft']}/confirm", {}),
        ("post", lambda ids: f"/drafts/{ids['draft']}/reject", {"reason": "x"}),
        ("patch", lambda ids: f"/drafts/{ids['draft']}", {"fields": {"AETERM": "x"}}),
        ("post", lambda ids: f"/escalations/{ids['escalation']}/ack", {}),
        ("post", lambda ids: "/packets", {"clock_id": "__clock__"}),
        ("post", lambda ids: "/queries/nope/answer", {"text": "x"}),
    ],
)
def test_admin_role_cannot_make_clinical_decisions(
    client: TestClient, method: str, path_fn: Any, body: dict[str, Any]
) -> None:
    done = _sae_checkin(client)
    coord = login(client, "coordinator")
    admin = login(client, "admin")
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()
    escalations = client.get(f"{API}/escalations", headers=coord).json()["items"]
    ids = {
        "draft": _ae_draft(client, done["session_id"], coord)["id"],
        "escalation": escalations[0]["id"],
        "clock": detail["clocks"][0]["id"],
    }
    payload = {k: (ids["clock"] if v == "__clock__" else v) for k, v in body.items()}
    res = getattr(client, method)(f"{API}{path_fn(ids)}", json=payload, headers=admin)
    assert res.status_code == 403, res.text


def test_demo_reset_is_gated_and_genesis_records_previous_chain(tmp_path) -> None:
    app = create_app(make_settings(tmp_path, allow_demo_reset=False))
    with TestClient(app) as locked:
        with app.state.database.write_scope() as db:
            seed_users(db, now_iso())
        admin = login(locked, "admin")
        res = locked.post(f"{API}/admin/reset", json={"reseed": False}, headers=admin)
        assert res.status_code == 403 and "ALLOW_DEMO_RESET" in res.json()["detail"]


def test_reset_genesis_carries_the_destroyed_chain_head(client: TestClient) -> None:
    _sae_checkin(client)
    admin = login(client, "admin")
    before = client.get(f"{API}/audit/verify", headers=admin).json()
    res = client.post(f"{API}/admin/reset", json={"reseed": False}, headers=admin)
    assert res.status_code == 200, res.text
    previous = res.json()["previous_chain"]
    assert previous["head_hash"] == before["head_hash"] and previous["events"] >= 1
    assert previous["running_clocks"] >= 1
    admin = login(client, "admin")
    genesis = _audit(client, admin, "demo.reset")
    assert genesis and genesis[0]["payload"]["previous_chain"]["head_hash"] == before["head_hash"]
    assert client.get(f"{API}/audit/verify", headers=admin).json()["ok"] is True


def test_clock_sweep_pages_once_at_due_soon_and_once_at_breach(client: TestClient) -> None:
    done = _sae_checkin(client)
    database = client.app.state.database  # type: ignore[attr-defined]
    with database.read_scope() as db:
        clock = db.exec(select(SAEClock).where(SAEClock.session_id == done["session_id"])).first()
        assert clock is not None
        due = clock.due_at
    with database.write_scope() as db:
        assert sweep_clock_alerts(db, now=shift(due, hours=-10)) == []
        soon = sweep_clock_alerts(db, now=shift(due, hours=-3))
        assert {a["action"] for a in soon} == {DUE_SOON}
        assert sweep_clock_alerts(db, now=shift(due, hours=-2)) == []  # once per threshold
        late = sweep_clock_alerts(db, now=shift(due, hours=1))
        assert {a["action"] for a in late} == {BREACHED}
        assert sweep_clock_alerts(db, now=shift(due, hours=2)) == []
    coord = login(client, "coordinator")
    assert _audit(client, coord, DUE_SOON) and _audit(client, coord, BREACHED)
    pages = client.get(f"{API}/pages", headers=coord).json()["items"]
    assert any("overdue" in p["message"] for p in pages)
    summary = client.get(f"{API}/escalations", headers=coord).json()["clock_breaches"]
    assert set(summary) == {"running_overdue", "stopped_late"}


def test_every_clock_stop_records_within_24h(client: TestClient) -> None:
    done = _sae_checkin(client)
    inv = login(client, "investigator")
    draft = _ae_draft(client, done["session_id"], inv)
    res = client.patch(
        f"{API}/drafts/{draft['id']}/attribution",
        json={"AESER": "Y", "AEREL": "POSSIBLE"},
        headers=inv,
    )
    assert res.status_code == 200, res.text
    stops = _audit(client, inv, "clock.stopped")
    assert stops and all(e["payload"]["within_24h"] is True for e in stops)
    assert all(e["payload"]["late"] is False for e in stops)


# --------------------------------------------------------------------------- #
# Recovery pass (2026-10-11): every write path, per-item sign attestation, breach reason
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("field", ["AESER", "AEREL", "INTERIM_IRAE"])
def test_investigator_only_fields_on_every_write_path(client: TestClient, field: str) -> None:
    """Drafts PATCH refuses the field for every role (the /attribution endpoint is the one
    writer); the packet PATCH lets only an investigator set it; admin is refused everywhere."""
    done = _sae_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    admin = login(client, "admin")
    draft = _ae_draft(client, done["session_id"], coord)
    value = {"AESER": "N", "AEREL": "NOT RELATED", "INTERIM_IRAE": "N"}[field]
    for headers in (coord, inv, admin):
        res = client.patch(
            f"{API}/drafts/{draft['id']}", json={"fields": {field: value}}, headers=headers
        )
        assert res.status_code == 403, (field, res.text)
    # Packet PATCH: coordinator and admin refused, investigator accepted.
    clock = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()["clocks"][0]
    packet = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()
    names = {f["name"] for f in packet["fields"]}
    if field in names:
        url = f"{API}/packets/{packet['id']}"
        packet_value = {"AESER": "Y", "AEREL": "possibly related", "INTERIM_IRAE": "Y"}[field]
        for headers in (coord, admin):
            res = client.patch(url, json={"fields": {field: packet_value}}, headers=headers)
            assert res.status_code == 403, (field, res.text)
        res = client.patch(url, json={"fields": {field: packet_value}}, headers=inv)
        assert res.status_code == 200, (field, res.text)


def test_query_answer_cannot_set_attribution(
    client: TestClient, coordinator: dict[str, str], investigator: dict[str, str]
) -> None:
    add_participant(client, "P-007")
    done = run_kiosk_checkin(client, "P-007")
    detail = client.get(f"{API}/checkins/{done['session_id']}", headers=coordinator).json()
    ae = next(d for d in detail["drafts"] if d["domain"] == "AE")
    attributed = client.patch(
        f"{API}/drafts/{ae['id']}/attribution", json={"AESER": "Y"}, headers=investigator
    )
    assert attributed.status_code == 200, attributed.text
    client.post(f"{API}/drafts/{attributed.json()['id']}/confirm", json={}, headers=coordinator)
    admin = login(client, "admin")
    rerun = client.post(f"{API}/queries/run-checks", json={"domains": ["AE"]}, headers=admin)
    query = next(
        q for q in rerun.json()["queries"] if q["check_id"] == "query.ae_serious_no_signed_report"
    )
    url = f"{API}/queries/{query['id']}/answer"
    for headers in (coordinator, investigator):
        res = client.post(
            url,
            json={"answer_text": "Changed.", "also_edit": {"field": "AESER", "value": "N"}},
            headers=headers,
        )
        assert res.status_code == 403, res.text
        assert "/attribution" in res.json()["detail"]
    res = client.post(url, json={"answer_text": "x"}, headers=admin)
    assert res.status_code == 403
    # The record still carries the investigator's AESER.
    current = client.get(f"{API}/drafts/{attributed.json()['id']}", headers=coordinator).json()
    assert current["fields"]["AESER"] == "Y"


def test_sign_needs_each_missing_item_marked_not_available(client: TestClient) -> None:
    done = _sae_checkin(client)
    coord = login(client, "coordinator")
    inv = login(client, "investigator")
    clock = client.get(f"{API}/checkins/{done['session_id']}", headers=coord).json()["clocks"][0]
    packet = client.post(f"{API}/packets", json={"clock_id": clock["id"]}, headers=coord).json()
    pid, missing = packet["id"], packet["missing_information"]
    assert len(missing) >= 2
    sign = f"{API}/packets/{pid}/sign"
    # Not reviewed -> 422; reviewed but one item left unacknowledged -> 422 naming it.
    assert (
        client.post(sign, json={"missing_info_not_available": missing}, headers=inv).status_code
        == 422
    )
    partial = client.post(
        sign,
        json={"narrative_reviewed": True, "missing_info_not_available": missing[:-1]},
        headers=inv,
    )
    assert partial.status_code == 422 and missing[-1] in partial.json()["detail"]
    stray = client.post(
        sign,
        json={"narrative_reviewed": True, "missing_info_not_available": [*missing, "nope"]},
        headers=inv,
    )
    assert stray.status_code == 422 and "nope" in stray.json()["detail"]
    assert client.get(f"{API}/packets/{pid}", headers=inv).json()["status"] == "draft"
    ok = client.post(
        sign,
        json={"narrative_reviewed": True, "missing_info_not_available": missing},
        headers=inv,
    )
    assert ok.status_code == 200, ok.text
    attestation = ok.json()["sign_attestation"]
    assert attestation["narrative_reviewed"] is True
    assert attestation["narrative_source"] == "generated"
    assert attestation["narrative_edited_by_person"] is False
    assert attestation["missing_info_acknowledged_by"] == "item_list"
    assert [m["item"] for m in attestation["missing_info_not_available"]] == missing
    assert {m["status"] for m in attestation["missing_info_not_available"]} == {"not available"}
    signed = _audit(client, inv, "packet.signed")
    payload = signed[-1]["payload"]
    assert payload["narrative_edited_by_person"] is False
    assert [m["item"] for m in payload["missing_info_not_available"]] == missing


def test_clock_breach_adds_one_escalation_reason(client: TestClient) -> None:
    done = _sae_checkin(client)
    database = client.app.state.database  # type: ignore[attr-defined]
    with database.read_scope() as db:
        clock = db.exec(select(SAEClock).where(SAEClock.session_id == done["session_id"])).first()
        assert clock is not None
        due = clock.due_at
    with database.write_scope() as db:
        late = sweep_clock_alerts(db, now=shift(due, hours=1))
        breached = [a for a in late if a["action"] == BREACHED]
        assert breached  # one per running clock of the session (SAE and possible AESI)
        assert sweep_clock_alerts(db, now=shift(due, hours=5)) == []
    coord = login(client, "coordinator")
    rows = client.get(f"{API}/escalations", headers=coord).json()["items"]
    mine = [e for e in rows if e["session_id"] == done["session_id"]]
    assert len(mine) == 1
    overdue = [r for r in mine[0]["reasons"] if "clock overdue" in str(r)]
    assert len(overdue) == len(breached)  # exactly once per clock, not once per sweep
    breach = _audit(client, coord, BREACHED)
    assert len(breach) == len(breached)
    assert all(e["payload"]["escalation_id"] == mine[0]["id"] for e in breach)
    pages = client.get(f"{API}/pages", headers=coord).json()["items"]
    overdue_pages = [
        p for p in pages if p.get("escalation_id") == mine[0]["id"] and "overdue" in p["message"]
    ]
    assert len(overdue_pages) == len(breached)
