"""Sponsor-query endpoints (CONTRACTS.md R4.4, CLAUDE.md §00 step 7).

| Method & path | Who |
|---|---|
| ``GET /queries`` | any dashboard role |
| ``GET /queries/{id}`` | any dashboard role (with the template writer's suggested answer) |
| ``POST /queries`` | admin, acting as the sponsor's monitor (manual query) |
| ``POST /queries/run-checks`` | admin (re-run the edit checks on confirmed records) |
| ``POST /queries/{id}/answer`` | coordinator, investigator, admin |
| ``POST /queries/{id}/close`` | admin, acting as the sponsor |
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, Query

from ..audit import Actor
from ..auth import require_clinical, require_role
from ..db import Database
from ..deps import Pagination, get_database
from ..schemas_queries import (
    AnswerQueryRequest,
    CloseQueryRequest,
    RaiseQueryRequest,
    RunChecksRequest,
)
from ..services.queries import (
    answer_query,
    close_query,
    get_query_or_404,
    list_queries,
    query_detail,
    raise_manual_query,
    run_checks_on_confirmed,
)

router = APIRouter(tags=["queries"])


@router.get("/queries")
def get_queries(
    status: Literal["open", "answered", "closed", "all"] | None = Query(default=None),
    usubjid: str | None = Query(default=None, description="USUBJID or display label"),
    domain: Literal["AE", "VS", "CM"] | None = Query(default=None),
    severity: Literal["data", "safety"] | None = Query(default=None),
    check_id: str | None = Query(default=None, max_length=80),
    draft_id: str | None = Query(default=None, max_length=64, description="any version"),
    include_eval: bool = Query(default=False),
    page: Pagination = Depends(),
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return list_queries(
            db,
            status=status,
            usubjid=usubjid,
            domain=domain,
            severity=severity,
            check_id=check_id,
            draft_id=draft_id,
            include_eval=include_eval,
            limit=page.limit,
            offset=page.offset,
        )


@router.post("/queries/run-checks")
def post_run_checks(
    body: RunChecksRequest | None = Body(default=None),
    actor: Actor = Depends(require_role("admin")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    req = body or RunChecksRequest()
    with database.write_scope() as db:
        return run_checks_on_confirmed(
            db, actor, domains=req.domains, include_eval=req.include_eval
        )


@router.get("/queries/{query_id}")
def get_query(
    query_id: str,
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return query_detail(db, get_query_or_404(db, query_id))


@router.post("/queries", status_code=201)
def post_query(
    body: RaiseQueryRequest,
    actor: Actor = Depends(require_role("admin")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        row = raise_manual_query(
            db,
            actor,
            draft_id=body.draft_id,
            field=body.field,
            text=body.text,
            severity=body.severity,
        )
        return query_detail(db, row)


@router.post("/queries/{query_id}/answer")
def post_answer(
    query_id: str,
    body: AnswerQueryRequest,
    actor: Actor = Depends(require_clinical()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        row = answer_query(
            db,
            actor,
            get_query_or_404(db, query_id),
            answer_text=body.answer_text,
            evidence_ids=body.evidence_ids,
            also_edit=body.also_edit.model_dump() if body.also_edit else None,
        )
        return query_detail(db, row)


@router.post("/queries/{query_id}/close")
def post_close(
    query_id: str,
    body: CloseQueryRequest | None = Body(default=None),
    actor: Actor = Depends(require_role("admin")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        row = close_query(
            db, actor, get_query_or_404(db, query_id), note=body.note if body else None
        )
        return query_detail(db, row)
