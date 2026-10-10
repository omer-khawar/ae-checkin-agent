"""Dashboard read endpoints + escalation acknowledgment (CONTRACTS.md §2.2)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlmodel import select

from ..audit import Actor
from ..auth import require_role
from ..db import Database
from ..deps import Pagination, get_database
from ..models import Participant
from ..problems import problem
from ..schemas import AckRequest
from ..services.common import escalation_to_dict, get_session_or_404, get_study, participant_to_dict
from ..services.dashboard import (
    ack_escalation,
    checkin_detail,
    list_escalations,
    list_pages,
    list_sae_clocks,
    queue,
    timeline,
)
from ..services.participants import require_participant

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
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return list_escalations(
            db, acked=acked, usubjid=usubjid, limit=page.limit, offset=page.offset
        )


@router.post("/escalations/{escalation_id}/ack")
def post_ack(
    escalation_id: str,
    body: AckRequest | None = None,
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        row = ack_escalation(db, actor, escalation_id, note=body.note if body else None)
        return escalation_to_dict(row)


@router.get("/sae-clocks")
def get_sae_clocks(
    active: bool | None = Query(default=True),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return list_sae_clocks(db, active=active, limit=page.limit, offset=page.offset)


@router.get("/pages")
def get_pages(
    page: Pagination = Depends(), database: Database = Depends(get_database)
) -> dict[str, Any]:
    with database.read_scope() as db:
        return list_pages(db, limit=page.limit, offset=page.offset)
