"""``POST /auth/login`` (CONTRACTS.md §2)."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends

from interim_rules.timefmt import format_iso_utc

from ..audit import Actor, append_event
from ..auth import check_password, issue_token
from ..db import Database
from ..deps import get_database, get_settings
from ..models import User
from ..problems import problem
from ..schemas import LoginRequest
from ..settings import Settings

router = APIRouter(tags=["auth"])


@router.post("/auth/login")
def login(
    body: LoginRequest,
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    with database.write_scope() as db:
        user = db.get(User, body.username.strip().lower())
        if user is None or not check_password(settings, body.password):
            raise problem(401, "Unknown user or wrong password", title="Login failed")
        now = time.time()
        token = issue_token(settings, user.username, user.role, now=now)
        expires_at = format_iso_utc(
            datetime.fromtimestamp(now + settings.token_ttl_hours * 3600, tz=UTC)
        )
        append_event(
            db,
            Actor(id=user.username, role=user.role),
            "auth.login",
            "user",
            user.username,
            {"role": user.role, "expires_at": expires_at, "auth_model": "demo shared password"},
        )
        return {
            "token": token,
            "role": user.role,
            "username": user.username,
            "display_name": user.display_name,
            "expires_at": expires_at,
        }
