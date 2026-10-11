"""Shared fixtures: one fresh SQLite file per test, the app built from ``create_app``.

``client`` is an unseeded app (study + users only, so logins and sessions work
without the 34 seeded check-ins); ``seeded_client`` runs the full demo seed.
Helpers log in and attach bearer tokens.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from interim_api.audit import Actor
from interim_api.main import create_app
from interim_api.seed import seed_database, seed_study, seed_users
from interim_api.services.settings_svc import ensure_defaults
from interim_api.settings import REPO_ROOT, Settings
from interim_api.util import now_iso

DEMO_PASSWORD = "test-demo-password"
REPO_PUBLIC = REPO_ROOT / "data" / "public"


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    db_path = (tmp_path / "interim-test.db").as_posix()
    values: dict[str, Any] = {
        "database_url": f"sqlite:///{db_path}",
        "demo_password": DEMO_PASSWORD,
        "auth_secret": "test-secret",
        "bridge_token": "",
        "seed_on_start": False,
        "allow_demo_reset": True,
        "public_data_dir": REPO_PUBLIC,
        "log_level": "warning",
    }
    values.update(overrides)
    # Keep the developer's .env out of the test process.
    os.environ.pop("DATABASE_URL", None)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def app(settings: Settings):
    return create_app(settings)


@pytest.fixture
def client(app) -> Iterator[TestClient]:
    """Study + users + default settings, no participants (tests add their own)."""
    with TestClient(app) as c:
        database = app.state.database
        with database.write_scope() as db:
            seed_study(db, app.state.settings)
            seed_users(db, now_iso())
            ensure_defaults(db, app.state.settings)
        yield c


@pytest.fixture
def seeded_client(app) -> Iterator[TestClient]:
    """The full demo seed (12 participants, 34 prior check-ins)."""
    with TestClient(app) as c:
        database = app.state.database
        with database.write_scope() as db:
            seed_database(db, app.state.settings)
        yield c


def login(client: TestClient, username: str) -> dict[str, str]:
    res = client.post("/api/v1/auth/login", json={"username": username, "password": DEMO_PASSWORD})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


@pytest.fixture
def coordinator(client: TestClient) -> dict[str, str]:
    return login(client, "coordinator")


@pytest.fixture
def investigator(client: TestClient) -> dict[str, str]:
    return login(client, "investigator")


@pytest.fixture
def admin(client: TestClient) -> dict[str, str]:
    return login(client, "admin")


def add_participant(client: TestClient, label: str = "P-007") -> str:
    """Create a kiosk participant through the service layer; returns its USUBJID."""
    from interim_api.services.common import get_study
    from interim_api.services.participants import create_participant

    database = client.app.state.database  # type: ignore[attr-defined]
    with database.write_scope() as db:
        study = get_study(db)
        participant = create_participant(db, study, display_label=label, now=now_iso())
        return participant.usubjid


ADMIN_ACTOR = Actor(id="admin", role="admin")

# The CONTRACTS.md §6 demo persona answers (T1-dyspnea-moderate).
DEMO_RESPONSES: dict[str, dict[str, int]] = {
    "shortness_of_breath": {"severity": 2, "interference": 2},
    "cough": {"severity": 1, "interference": 0},
    "fatigue": {"severity": 0, "interference": 0},
    "nausea": {"frequency": 0, "severity": 0},
    "diarrhea": {"frequency": 0},
    "rash": {"presence": 0},
    "itching": {"severity": 0},
    "joint_pain": {"severity": 0, "interference": 0},
    "fever_or_chills": {"presence": 0},
    "mouth_sores": {"severity": 0, "interference": 0},
}
DEMO_GATES: dict[str, Any] = {
    "hospitalization": False,
    "conmed_changed": True,
    "conmed_text": "loratadine",
    "conmed_direction": "started",
    "other_text": "",
}
DEMO_SAMPLE_CAMEL: dict[str, Any] = {
    "source": "mock",
    "isMeasured": False,
    "pulseBpm": 72,
    "pulseConf": 0.9,
    "breathingBpm": 14,
    "breathingConf": 0.85,
    "windowS": 30,
    "qualityFlags": [],
}


ZERO_RESPONSES: dict[str, dict[str, int]] = {
    item: dict.fromkeys(attrs, 0) for item, attrs in DEMO_RESPONSES.items()
}
QUIET_GATES: dict[str, Any] = {"hospitalization": False, "conmed_changed": False}


def post_answers_and_gates(
    client: TestClient,
    session_id: str,
    *,
    responses: dict[str, dict[str, int]] | None = None,
    gates: dict[str, Any] | None = None,
    ts_client: str | None = None,
) -> None:
    """Answer every item attribute and the gates for an open session."""
    base = "/api/v1/sessions"
    now = ts_client or now_iso()
    for item_id, attrs in (responses or DEMO_RESPONSES).items():
        for attribute, value in attrs.items():
            r = client.post(
                f"{base}/{session_id}/answers",
                json={"item_id": item_id, "attribute": attribute, "value": value, "ts_client": now},
            )
            assert r.status_code == 200, r.text
    r = client.post(f"{base}/{session_id}/gates", json={**(gates or DEMO_GATES), "ts_client": now})
    assert r.status_code == 200, r.text


def run_kiosk_checkin(
    client: TestClient,
    usubjid: str,
    *,
    responses: dict[str, dict[str, int]] | None = None,
    gates: dict[str, Any] | None = None,
    samples: list[dict[str, Any]] | None = None,
    consent_camera: bool = True,
    headers: dict[str, str] | None = None,
    complete_extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Drive the kiosk endpoints end to end; returns the ``/complete`` response."""
    base = "/api/v1/sessions"
    res = client.post(
        base, json={"usubjid": usubjid, "consent_camera": consent_camera}, headers=headers or {}
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]
    now = now_iso()
    post_answers_and_gates(client, session_id, responses=responses, gates=gates, ts_client=now)
    if samples is None and consent_camera:
        samples = [{**DEMO_SAMPLE_CAMEL, "tsUtc": now}]
    if samples:
        r = client.post(f"{base}/{session_id}/vitals", json={"samples": samples})
        assert r.status_code == 200, r.text
    r = client.post(
        f"{base}/{session_id}/complete",
        json={"ts_client": now_iso(), **(complete_extra or {})},
        headers=headers or {},
    )
    assert r.status_code == 200, r.text
    return r.json()
