"""Auth: login, token validation, and the server-side role matrix (CONTRACTS.md §2)."""

from __future__ import annotations

import pytest
from conftest import (
    DEMO_PASSWORD,
    QUIET_GATES,
    ZERO_RESPONSES,
    add_participant,
    login,
    post_answers_and_gates,
)

from interim_api.auth import issue_token, parse_token
from interim_api.problems import Problem
from interim_api.settings import Settings
from interim_api.util import now_iso


def test_login_returns_token_role_and_expiry(client) -> None:
    res = client.post(
        "/api/v1/auth/login", json={"username": "investigator", "password": DEMO_PASSWORD}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["role"] == "investigator" and body["display_name"]
    assert body["token"].count(".") == 3 and body["expires_at"].endswith("Z")
    bad = client.post("/api/v1/auth/login", json={"username": "admin", "password": "nope"})
    assert bad.status_code == 401
    assert bad.headers["content-type"] == "application/problem+json"
    assert bad.json()["title"] == "Login failed"


def test_token_signature_and_expiry_are_checked() -> None:
    settings = Settings(_env_file=None, auth_secret="s1")  # type: ignore[call-arg]
    token = issue_token(settings, "coordinator", "coordinator", now=1_000_000.0)
    actor = parse_token(settings, token, now=1_000_000.0 + 60)
    assert actor.id == "coordinator" and actor.role == "coordinator"
    with pytest.raises(Problem) as exc:
        parse_token(settings, token, now=1_000_000.0 + settings.token_ttl_hours * 3600 + 1)
    assert exc.value.status_code == 401
    tampered = token.replace("coordinator.coordinator", "coordinator.admin", 1)
    with pytest.raises(Problem):
        parse_token(settings, tampered, now=1_000_000.0 + 60)
    other = Settings(_env_file=None, auth_secret="s2")  # type: ignore[call-arg]
    with pytest.raises(Problem):
        parse_token(other, token, now=1_000_000.0 + 60)


def test_dashboard_requires_a_token(client) -> None:
    res = client.get("/api/v1/queue")
    assert res.status_code == 401
    assert res.headers["content-type"] == "application/problem+json"
    res = client.get("/api/v1/queue", headers={"Authorization": "Bearer not.a.valid.token"})
    assert res.status_code == 401


def test_role_matrix(client) -> None:
    """Every mutating dashboard endpoint is role-gated server-side; 403 for the wrong role."""
    add_participant(client, "P-001")
    tokens = {role: login(client, role) for role in ("coordinator", "investigator", "admin")}
    # Admin-only: settings PUT, reset.
    for role in ("coordinator", "investigator"):
        res = client.put(
            "/api/v1/admin/settings", json={"mock_scenario": "tachypnea"}, headers=tokens[role]
        )
        assert res.status_code == 403, role
        res = client.post("/api/v1/admin/reset", json={"reseed": False}, headers=tokens[role])
        assert res.status_code == 403, role
    assert client.get("/api/v1/admin/settings", headers=tokens["coordinator"]).status_code == 200
    ok = client.put(
        "/api/v1/admin/settings", json={"mock_scenario": "tachypnea"}, headers=tokens["admin"]
    )
    assert ok.status_code == 200 and ok.json()["mock_scenario"] == "tachypnea"
    # Admin-only override fields on kiosk endpoints: 403 for coordinator and for anonymous.
    body = {"usubjid": "P-001", "consent_camera": False, "started_at_override": now_iso()}
    assert client.post("/api/v1/sessions", json=body).status_code == 403
    assert (
        client.post("/api/v1/sessions", json=body, headers=tokens["coordinator"]).status_code == 403
    )
    created = client.post("/api/v1/sessions", json=body, headers=tokens["admin"])
    assert created.status_code == 201 and created.json()["backdated"] is True
    sid = created.json()["id"]
    post_answers_and_gates(client, sid, responses=ZERO_RESPONSES, gates=QUIET_GATES)
    complete = {"ts_client": now_iso(), "settings_override": {"simulated_as_measured": True}}
    assert client.post(f"/api/v1/sessions/{sid}/complete", json=complete).status_code == 403
    assert (
        client.post(
            f"/api/v1/sessions/{sid}/complete", json=complete, headers=tokens["investigator"]
        ).status_code
        == 403
    )
    done = client.post(f"/api/v1/sessions/{sid}/complete", json=complete, headers=tokens["admin"])
    assert done.status_code == 200
    # Investigator-only attribution.
    detail = client.get(f"/api/v1/checkins/{sid}", headers=tokens["coordinator"]).json()
    assert detail["drafts"] == []  # nothing graded, camera declined: no drafts at all
    # Any dashboard role may read; eval and exports are open to all three roles.
    for role, headers in tokens.items():
        assert client.get("/api/v1/escalations", headers=headers).status_code == 200, role
        assert client.get("/api/v1/eval/personas", headers=headers).status_code == 200, role
        assert client.get("/api/v1/export/AE.json", headers=headers).status_code == 200, role


def test_bridge_token_enforced_only_when_configured(tmp_path) -> None:
    from conftest import make_settings
    from fastapi.testclient import TestClient

    from interim_api.main import create_app
    from interim_api.seed import seed_study, seed_users

    settings = make_settings(tmp_path, bridge_token="shh")
    app = create_app(settings)
    with TestClient(app) as client:
        with app.state.database.write_scope() as db:
            seed_study(db, settings)
            seed_users(db, now_iso())
        add_participant(client, "P-001")
        sid = client.post(
            "/api/v1/sessions", json={"usubjid": "P-001", "consent_camera": True}
        ).json()["id"]
        sample = {
            "tsUtc": now_iso(),
            "source": "mock",
            "isMeasured": False,
            "windowS": 12,
            "qualityFlags": [],
        }
        res = client.post(f"/api/v1/sessions/{sid}/vitals", json={"samples": [sample]})
        assert res.status_code == 401
        res = client.post(
            f"/api/v1/sessions/{sid}/vitals",
            json={"samples": [sample]},
            headers={"X-Bridge-Token": "wrong"},
        )
        assert res.status_code == 401
        res = client.post(
            f"/api/v1/sessions/{sid}/vitals",
            json={"samples": [sample]},
            headers={"X-Bridge-Token": "shh"},
        )
        assert res.status_code == 200 and res.json()["accepted"] == 1
