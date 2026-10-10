"""``GET /audit`` (paginated, newest first, filters) and ``GET /audit/verify``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlmodel import select

from ..audit import event_to_dict, verify_chain
from ..auth import require_role
from ..db import Database
from ..deps import Pagination, get_database
from ..models import AuditEvent

router = APIRouter(tags=["audit"], dependencies=[Depends(require_role())])


@router.get("/audit")
def list_audit(
    entity_type: str | None = Query(default=None),
    entity_id: str | None = Query(default=None),
    action: str | None = Query(default=None),
    actor_id: str | None = Query(default=None),
    page: Pagination = Depends(),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        stmt = select(AuditEvent)
        count = select(func.count()).select_from(AuditEvent)
        for column, value in (
            (AuditEvent.entity_type, entity_type),
            (AuditEvent.entity_id, entity_id),
            (AuditEvent.action, action),
            (AuditEvent.actor_id, actor_id),
        ):
            if value:
                stmt = stmt.where(column == value)
                count = count.where(column == value)
        total = int(db.exec(count).one())
        rows = db.exec(
            stmt.order_by(AuditEvent.seq.desc()).offset(page.offset).limit(page.limit)  # type: ignore[attr-defined]
        ).all()
        return {
            "items": [event_to_dict(r) for r in rows],
            "total": total,
            "limit": page.limit,
            "offset": page.offset,
        }


@router.get("/audit/verify")
def verify(database: Database = Depends(get_database)) -> dict[str, Any]:
    with database.read_scope() as db:
        return verify_chain(db)
