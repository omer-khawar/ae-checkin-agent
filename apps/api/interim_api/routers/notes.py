"""Chart-note endpoints (CONTRACTS.md R2.4): scan (dry run), ingest, list, detail.

Every route needs a dashboard token. ``POST /notes`` is open to every dashboard
role (coordinator, investigator, admin); only an admin may send
``ingested_at_override`` (the seed backdates with it; anyone else gets a 403,
D-004). ``POST /scan`` stores nothing and writes no audit event: it is the
"what would this note produce?" preview on the Notes page.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from ..audit import Actor
from ..auth import require_admin_for, require_role
from ..db import Database
from ..deps import Pagination, get_database, get_settings
from ..schemas import NoteIngestRequest, ScanRequest
from ..services.common import get_study
from ..services.notes import get_note_or_404, ingest_note, list_notes, note_detail, scan_only
from ..settings import Settings

router = APIRouter(tags=["notes"])


@router.post("/scan")
def post_scan(body: ScanRequest, _actor: Actor = Depends(require_role())) -> dict[str, Any]:
    return scan_only(body.text, body.ref_date)


@router.post("/notes", status_code=201)
def post_note(
    body: NoteIngestRequest,
    actor: Actor = Depends(require_role("coordinator", "investigator", "admin")),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    override_actor: Actor | None = None
    if body.ingested_at_override is not None:
        override_actor = require_admin_for(actor, "ingested_at_override")
    with database.write_scope() as db:
        return ingest_note(
            db,
            settings,
            actor,
            usubjid=body.usubjid,
            note_date=body.note_date,
            author=body.author,
            note_type=body.note_type,
            text=body.text,
            ingested_at_override=body.ingested_at_override,
            override_actor=override_actor,
        )


@router.get("/notes")
def get_notes(
    usubjid: str | None = Query(default=None, description="USUBJID or display label"),
    include_eval: bool = Query(default=False),
    page: Pagination = Depends(),
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return list_notes(
            db,
            get_study(db),
            usubjid=usubjid,
            include_eval=include_eval,
            limit=page.limit,
            offset=page.offset,
        )


@router.get("/notes/{note_id}")
def get_note(
    note_id: str,
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return note_detail(db, get_note_or_404(db, note_id))
