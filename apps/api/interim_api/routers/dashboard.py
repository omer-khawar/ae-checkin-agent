"""Dashboard read endpoints + escalation acknowledgment (CONTRACTS.md §2.2)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlmodel import select

from ..audit import Actor
from ..auth import require_clinical, require_role
from ..db import Database
from ..deps import Pagination, get_database, get_settings
from ..models import Participant
from ..problems import problem
from ..schemas import AckRequest, StopSaeClockRequest
from ..services.clock_alerts import clock_breach_summary, sweep_if_needed
from ..services.common import (
    escalation_to_dict,
    get_session_or_404,
    get_study,
    participant_to_dict,
    sae_clock_to_dict,
)
from ..services.dashboard import (
    ack_escalation,
    checkin_detail,
    list_escalations,
    list_pages,
    list_sae_clocks,
    queue,
    stop_sae_clock,
    timeline,
)
from ..services.messages import send_review_ack
from ..services.participants import require_participant
from ..settings import Settings

router = APIRouter(tags=["dashboard"], dependencies=[Depends(require_role())])


@router.get("/queue")
def get_queue(
    usubjid: str | None = Query(default=None),
    min_tier: int | None = Query(default=None, ge=0, le=3),
    status: Literal["open", "all"] = Query(default="all"),
    include_eval: bool = Query(default=False),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    sweep_if_needed(database)  # 24 h clock alerts are written on read (clock_alerts.py)
    with database.read_scope() as db:
        return queue(
            db,
            get_study(db),
            usubjid=usubjid,
            min_tier=min_tier,
            status=status,
            include_eval=include_eval,
            limit=page.limit,
            offset=page.offset,
        )


@router.get("/checkins/{session_id}")
def get_checkin(session_id: str, database: Database = Depends(get_database)) -> dict[str, Any]:
    with database.read_scope() as db:
        session = get_session_or_404(db, session_id)
        if session.completed_at is None:
            raise problem(
                409, f"Session {session_id} is still in progress", title="Check-in not completed"
            )
        return checkin_detail(db, session)


@router.get("/participants")
def get_participants(
    include_eval: bool = Query(default=False),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        stmt = select(Participant)
        if not include_eval:
            stmt = stmt.where(Participant.is_eval == False)  # noqa: E712
        rows = sorted(db.exec(stmt).all(), key=lambda p: (p.is_eval, p.display_label))
        return page.page([participant_to_dict(p) for p in rows])


@router.get("/participants/{usubjid}")
def get_participant(usubjid: str, database: Database = Depends(get_database)) -> dict[str, Any]:
    with database.read_scope() as db:
        return participant_to_dict(require_participant(db, get_study(db), usubjid))


@router.get("/participants/{usubjid}/timeline")
def get_timeline(usubjid: str, database: Database = Depends(get_database)) -> dict[str, Any]:
    with database.read_scope() as db:
        return timeline(db, require_participant(db, get_study(db), usubjid))


@router.get("/escalations")
def get_escalations(
    acked: bool | None = Query(default=None),
    usubjid: str | None = Query(default=None),
    include_eval: bool = Query(default=False),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    sweep_if_needed(database)
    with database.read_scope() as db:
        out = list_escalations(
            db,
            acked=acked,
            usubjid=usubjid,
            limit=page.limit,
            offset=page.offset,
            include_eval=include_eval,
        )
        out["clock_breaches"] = clock_breach_summary(db, include_eval=include_eval)
        return out


@router.post("/escalations/{escalation_id}/ack")
def post_ack(
    escalation_id: str,
    body: AckRequest | None = None,
    actor: Actor = Depends(require_clinical()),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    with database.write_scope() as db:
        row = ack_escalation(db, actor, escalation_id, note=body.note if body else None)
        out = escalation_to_dict(row)
    # R6: "Your study nurse has reviewed your check-in." (check-in escalations only)
    out["message"] = send_review_ack(database, settings, actor, escalation_id)
    return out


_ACTIVE_VALUES: dict[str, bool | None] = {
    "true": True,
    "1": True,
    "yes": True,
    "false": False,
    "0": False,
    "no": False,
    "all": None,
    "any": None,
}


@router.get("/sae-clocks")
def get_sae_clocks(
    active: str = Query(
        default="true",
        description="true = running clocks (default), false = stopped clocks only, "
        "all = every clock, running and stopped",
    ),
    include_eval: bool = Query(default=False),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    key = active.strip().lower()
    if key not in _ACTIVE_VALUES:
        raise problem(
            422,
            f"active must be true, false or all, got {active!r}",
            title="Invalid active filter",
        )
    sweep_if_needed(database)
    with database.read_scope() as db:
        return list_sae_clocks(
            db,
            active=_ACTIVE_VALUES[key],
            limit=page.limit,
            offset=page.offset,
            include_eval=include_eval,
        )


@router.post("/sae-clocks/sweep")
def post_sweep_clocks(database: Database = Depends(get_database)) -> dict[str, Any]:
    """Write any due ``clock.due_soon`` / ``clock.breached`` alerts now (for a site cron;
    the dashboard reads also run this sweep)."""
    return {"written": sweep_if_needed(database)}


@router.patch("/sae-clocks/{clock_id}/stop")
def patch_stop_sae_clock(
    clock_id: str,
    body: StopSaeClockRequest,
    actor: Actor = Depends(require_role("investigator")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    """Investigator-only: record a seriousness decision on a clock that has no AE draft to
    attribute (D-023). ``PATCH /drafts/{id}/attribution`` remains the usual path."""
    with database.write_scope() as db:
        row = stop_sae_clock(db, actor, clock_id, decision=body.decision, note=body.note)
        return sae_clock_to_dict(row)


@router.get("/pages")
def get_pages(
    include_eval: bool = Query(default=False),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    sweep_if_needed(database)
    with database.read_scope() as db:
        return list_pages(db, limit=page.limit, offset=page.offset, include_eval=include_eval)
