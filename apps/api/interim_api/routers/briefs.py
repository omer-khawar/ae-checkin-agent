"""Visit-prep brief, visit dates and the time-saved estimate (CONTRACTS.md R3.2, CLAUDE.md
§00.4-§00.5).

* ``GET /participants/{usubjid}/brief?since=YYYY-MM-DD`` (any dashboard role): the brief
  as JSON. Generating it is an audit event (``brief.generated``), so it runs in a write
  scope even though it changes no record.
* ``GET /participants/{usubjid}/brief/print?since=`` : the same brief as one self-contained,
  printable HTML page (no scripts, no external assets; the not-a-medical-device footer).
* ``GET /participants/{usubjid}/visits`` / ``POST`` (coordinator, investigator, admin):
  visit dates; the latest completed one is the brief's default cut-off, the next scheduled
  one is shown as "next visit". ``visit.recorded`` audit event.
* ``GET /metrics/time-saved?since=&include_eval=false`` (any role): the estimate from
  ``interim_rules.time_saved.estimate`` with its basis.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse

from ..audit import Actor
from ..auth import require_role
from ..db import Database
from ..deps import get_database, get_settings
from ..schemas_briefs import VisitRequest
from ..services.briefs import (
    generate_brief,
    record_visit,
    render_brief_html,
    strip_internal,
    visit_to_dict,
    visits_for,
)
from ..services.common import get_study
from ..services.metrics import resolve_since, time_saved
from ..services.participants import require_participant
from ..settings import Settings
from ..util import now_iso

router = APIRouter(tags=["briefs"])

SINCE_DOC = "YYYY-MM-DD; default: the participant's latest completed visit, else 14 days back"


@router.get("/participants/{usubjid}/brief")
def get_brief(
    usubjid: str,
    since: str | None = Query(default=None, description=SINCE_DOC),
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    with database.write_scope() as db:
        participant = require_participant(db, get_study(db), usubjid)
        brief = generate_brief(db, actor, participant, since=since, settings=settings)
        return strip_internal(brief)


@router.get("/participants/{usubjid}/brief/print", response_class=HTMLResponse)
def get_brief_print(
    usubjid: str,
    since: str | None = Query(default=None, description=SINCE_DOC),
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> HTMLResponse:
    with database.write_scope() as db:
        participant = require_participant(db, get_study(db), usubjid)
        brief = generate_brief(
            db, actor, participant, since=since, printable=True, settings=settings
        )
    return HTMLResponse(render_brief_html(brief))


@router.get("/participants/{usubjid}/visits")
def get_visits(
    usubjid: str,
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        participant = require_participant(db, get_study(db), usubjid)
        rows = [visit_to_dict(v) for v in visits_for(db, participant.usubjid)]
        return {"items": rows, "total": len(rows)}


@router.post("/participants/{usubjid}/visits", status_code=201)
def post_visit(
    usubjid: str,
    body: VisitRequest,
    actor: Actor = Depends(require_role("coordinator", "investigator", "admin")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        participant = require_participant(db, get_study(db), usubjid)
        row = record_visit(
            db, actor, participant, visit_date=body.visit_date, status=body.status, label=body.label
        )
        return visit_to_dict(row)


@router.get("/metrics/time-saved")
def get_time_saved(
    since: str | None = Query(default=None, description="YYYY-MM-DD or ISO; default 7 days"),
    include_eval: bool = Query(default=False),
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return time_saved(db, since=resolve_since(since, now=now_iso()), include_eval=include_eval)
