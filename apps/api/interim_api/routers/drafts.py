"""Draft review endpoints (CONTRACTS.md §2.2): get, versions, confirm, reject, edit, attribution."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..audit import Actor
from ..auth import require_role
from ..db import Database
from ..deps import get_database
from ..schemas import AttributionRequest, ConfirmRequest, PatchDraftRequest, RejectRequest
from ..services.common import draft_to_dict, get_draft_or_404
from ..services.drafts import (
    confirm_draft,
    edit_draft,
    record_attribution,
    reject_draft,
    versions_of,
)

router = APIRouter(tags=["drafts"])


@router.get("/drafts/{draft_id}")
def get_draft(
    draft_id: str,
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.read_scope() as db:
        return draft_to_dict(get_draft_or_404(db, draft_id))


@router.get("/drafts/{draft_id}/versions")
def get_versions(
    draft_id: str,
    _actor: Actor = Depends(require_role()),
    database: Database = Depends(get_database),
) -> list[dict[str, Any]]:
    with database.read_scope() as db:
        return [draft_to_dict(d) for d in versions_of(db, get_draft_or_404(db, draft_id))]


@router.post("/drafts/{draft_id}/confirm")
def post_confirm(
    draft_id: str,
    body: ConfirmRequest | None = None,
    actor: Actor = Depends(require_role("coordinator", "investigator", "admin")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        draft = get_draft_or_404(db, draft_id)
        return draft_to_dict(confirm_draft(db, actor, draft, note=body.note if body else None))


@router.post("/drafts/{draft_id}/reject")
def post_reject(
    draft_id: str,
    body: RejectRequest,
    actor: Actor = Depends(require_role("coordinator", "investigator", "admin")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        draft = get_draft_or_404(db, draft_id)
        return draft_to_dict(reject_draft(db, actor, draft, reason=body.reason))


@router.patch("/drafts/{draft_id}")
def patch_draft(
    draft_id: str,
    body: PatchDraftRequest,
    actor: Actor = Depends(require_role("coordinator", "investigator", "admin")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        draft = get_draft_or_404(db, draft_id)
        return draft_to_dict(edit_draft(db, actor, draft, changes=body.fields, note=body.note))


@router.patch("/drafts/{draft_id}/attribution")
def patch_attribution(
    draft_id: str,
    body: AttributionRequest,
    actor: Actor = Depends(require_role("investigator")),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    with database.write_scope() as db:
        draft = get_draft_or_404(db, draft_id)
        return draft_to_dict(
            record_attribution(db, actor, draft, aerel=body.AEREL, aeser=body.AESER, note=body.note)
        )
