"""Admin endpoints (CONTRACTS.md §2.2): settings GET/PUT and the demo reset."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..audit import Actor
from ..auth import require_role
from ..constants import MOCK_SCENARIOS, VITALS_SOURCES
from ..db import Database
from ..deps import Pagination, get_database, get_settings
from ..problems import problem
from ..schemas import ResetRequest, SettingsUpdate
from ..seed import reset_and_seed
from ..services.messages import list_messages
from ..services.settings_svc import get_admin_settings, update_settings
from ..settings import Settings

router = APIRouter(tags=["admin"])

SIMULATED_WARNING = (
    "Treat simulated as measured is a DEMO toggle: simulated vitals may then satisfy the "
    "corroboration gate (tier +1 at most). Exports and the UI still label every value Simulated. "
    "Default OFF."
)


@router.get("/admin/settings")
def get_settings_endpoint(
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    with database.read_scope() as db:
        out = get_admin_settings(db, settings)
    out["warning"] = SIMULATED_WARNING
    out["known_scenarios"] = list(MOCK_SCENARIOS)  # PUT validates against the same list
    out["known_sources"] = list(VITALS_SOURCES)
    return out


@router.put("/admin/settings")
def put_settings_endpoint(
    body: SettingsUpdate,
    actor: Actor = Depends(require_role("admin")),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    with database.write_scope() as db:
        out = update_settings(db, settings, actor, body.model_dump(exclude_none=True))
    out["warning"] = SIMULATED_WARNING
    out["known_scenarios"] = list(MOCK_SCENARIOS)
    out["known_sources"] = list(VITALS_SOURCES)
    return out


@router.post("/admin/reset")
def post_reset(
    body: ResetRequest | None = None,
    actor: Actor = Depends(require_role("admin")),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    if not settings.allow_demo_reset:
        raise problem(
            403,
            "Demo reset is disabled on this deployment (it would drop the audit chain). "
            "Set ALLOW_DEMO_RESET=true only on a demo instance.",
            title="Demo reset disabled",
        )
    reseed = body.reseed if body is not None else True
    return reset_and_seed(database, settings, actor, reseed=reseed)


@router.get("/admin/messages")
def get_messages(
    _actor: Actor = Depends(require_role("admin")),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """R6: every participant text, newest first. ``channel`` says where new texts go now."""
    with database.read_scope() as db:
        out = list_messages(db, limit=page.limit, offset=page.offset)
    out["channel"] = (
        "twilio"
        if settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_from
        else "outbox"
    )
    return out
