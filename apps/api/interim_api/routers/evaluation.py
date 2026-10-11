"""Eval endpoints (CONTRACTS.md §2.2 + R2.2): personas, run, run-custom, results."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Response

from ..audit import Actor
from ..auth import require_role
from ..db import Database
from ..deps import get_database, get_settings
from ..problems import problem
from ..schemas import EvalCustomRequest, EvalRunRequest
from ..services.evaluation import latest_results, persona_summaries, run_custom, run_eval
from ..settings import Settings

router = APIRouter(tags=["eval"])


@router.get("/eval/personas")
def get_personas(_actor: Actor = Depends(require_role())) -> list[dict[str, Any]]:
    return persona_summaries()


@router.post("/eval/run")
def post_run(
    body: EvalRunRequest | None = None,
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    body = body or EvalRunRequest()
    with database.write_scope() as db:
        return run_eval(
            db, settings, actor, include_hidden=body.include_hidden, persona_ids=body.persona_ids
        )


@router.post("/eval/run-custom")
def post_run_custom(
    body: EvalCustomRequest,
    actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    with database.write_scope() as db:
        return run_custom(db, settings, actor, body.persona)


@router.get("/eval/results", response_model=None)
def get_results(
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
    if_any: bool = Query(
        False, description="Answer 204 instead of 404 when no evaluation has been run yet."
    ),
) -> dict[str, Any] | Response:
    with database.read_scope() as db:
        results = latest_results(db)
    if results is None:
        if if_any:
            # The dashboard's Eval page asks this way so an empty page logs no failed request.
            return Response(status_code=204)
        raise problem(404, "No evaluation has been run yet; POST /eval/run", title="No results")
    return results
