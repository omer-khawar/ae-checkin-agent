"""Kiosk endpoints (CONTRACTS.md §2.1 + R2.3). No token required.

An admin token may accompany ``POST /sessions`` and ``POST /sessions/{id}/complete``
to use the override fields (backdating, per-session rule settings, participant
creation for the eval harness); anyone else sending them gets a 403 (D-004).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header

from interim_rules.tables import load_table, vitals_config

from .. import API_VERSION
from ..audit import Actor
from ..auth import check_bridge_token, optional_actor, require_admin_for
from ..db import Database
from ..deps import get_database, get_settings
from ..schemas import (
    AnswerRequest,
    CompleteRequest,
    CreateSessionRequest,
    GatesRequest,
    UrgentRequest,
    VitalsPostRequest,
)
from ..services.common import (
    answer_to_dict,
    get_session_or_404,
    get_study,
    session_to_dict,
    study_to_dict,
)
from ..services.messages import send_checkin_confirmation
from ..services.sessions import (
    complete_session,
    create_session,
    end_session_early,
    record_answer,
    record_gates,
    record_vitals,
)
from ..services.settings_svc import get_admin_settings, public_settings
from ..settings import Settings
from ..util import now_iso

router = APIRouter(tags=["kiosk"])


@router.get("/health")
def health(
    database: Database = Depends(get_database), settings: Settings = Depends(get_settings)
) -> dict[str, Any]:
    with database.read_scope() as db:
        try:
            admin = get_admin_settings(db, settings)
            db_state = "ok"
        except Exception:  # pragma: no cover - only when the DB is unreachable
            admin = {"vitals_source": settings.vitals_source}
            db_state = "error"
    return {
        "status": "ok",
        "version": API_VERSION,
        "time_utc": now_iso(),
        "vitals_source": admin["vitals_source"],
        "db": db_state,
        "database": settings.database_label,
    }


@router.get("/study")
def study(database: Database = Depends(get_database)) -> dict[str, Any]:
    with database.read_scope() as db:
        return study_to_dict(get_study(db))


@router.get("/items")
def items_endpoint() -> dict[str, Any]:
    """The instrument, straight from the rules tables (R2.1)."""
    items_table = load_table("proctcae_items")
    gates_table = load_table("gate_questions")
    return {
        "items": items_table["items"],
        "gates": gates_table["questions"],
        "optional_fields": gates_table.get("optional_fields", []),
        "recall_window": items_table["recall_window"],
        "response_scales": items_table.get("response_scales", {}),
        "source_note": items_table["source"],
    }


@router.get("/settings/public")
def settings_public(
    database: Database = Depends(get_database), settings: Settings = Depends(get_settings)
) -> dict[str, Any]:
    with database.read_scope() as db:
        return public_settings(db, settings)


@router.post("/sessions", status_code=201)
def post_session(
    body: CreateSessionRequest,
    actor: Actor | None = Depends(optional_actor),
    database: Database = Depends(get_database),
) -> dict[str, Any]:
    override_actor: Actor | None = None
    if (
        body.started_at_override is not None
        or body.create_participant
        or body.is_eval
        or body.protocol_context is not None
    ):
        override_actor = require_admin_for(
            actor, "started_at_override / create_participant / is_eval / protocol_context"
        )
    with database.write_scope() as db:
        session = create_session(
            db,
            usubjid=body.usubjid,
            consent_camera=body.consent_camera,
            override_actor=override_actor,
            started_at_override=body.started_at_override,
            create_participant_if_missing=body.create_participant,
            is_eval=body.is_eval,
            protocol_context=body.protocol_context,
        )
        return session_to_dict(session)


@router.get("/sessions/{session_id}")
def get_session(session_id: str, database: Database = Depends(get_database)) -> dict[str, Any]:
    with database.read_scope() as db:
        return session_to_dict(get_session_or_404(db, session_id))


@router.post("/sessions/{session_id}/answers")
def post_answer(
    session_id: str, body: AnswerRequest, database: Database = Depends(get_database)
) -> dict[str, Any]:
    with database.write_scope() as db:
        session = get_session_or_404(db, session_id)
        row, created = record_answer(
            db,
            session,
            item_id=body.item_id,
            attribute=body.attribute,
            value=body.value,
            value_text=body.value_text,
            ts_client=body.ts_client,
        )
        out = answer_to_dict(row)
        out["created"] = created
        return out


@router.post("/sessions/{session_id}/gates")
def post_gates(
    session_id: str, body: GatesRequest, database: Database = Depends(get_database)
) -> dict[str, Any]:
    with database.write_scope() as db:
        session = get_session_or_404(db, session_id)
        rows = record_gates(
            db,
            session,
            hospitalization=body.hospitalization,
            conmed_changed=body.conmed_changed,
            conmed_text=body.conmed_text,
            conmed_direction=body.conmed_direction,
            other_text=body.other_text,
            temp_c=body.temp_c,
            ts_client=body.ts_client,
            urgent_now=body.urgent_now,
            conmeds=([c.model_dump() for c in body.conmeds] if body.conmeds is not None else None),
        )
        return {"answers": [answer_to_dict(r) for r in rows]}


@router.post("/sessions/{session_id}/vitals")
def post_vitals(
    session_id: str,
    body: VitalsPostRequest,
    x_bridge_token: str | None = Header(default=None, alias="X-Bridge-Token"),
    actor: Actor | None = Depends(optional_actor),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    check_bridge_token(settings, x_bridge_token)
    # A sample may say isMeasured=true only when the API can vouch for the caller: the bridge
    # presented the configured shared secret, or an admin token is attached (eval over HTTP).
    bridge_verified = bool(settings.bridge_token) and x_bridge_token is not None
    measured_allowed = bridge_verified or (actor is not None and actor.is_admin)
    samples = [s.model_dump(by_alias=False) for s in body.samples]
    with database.write_scope() as db:
        session = get_session_or_404(db, session_id)
        accepted, status = record_vitals(
            db, session, samples, posted_by=actor, measured_allowed=measured_allowed
        )
        return {
            "accepted": accepted,
            "session_id": session.id,
            "vitals_status": status,
            "min_confidence": vitals_config().min_confidence,
        }


@router.post("/sessions/{session_id}/complete")
def post_complete(
    session_id: str,
    body: CompleteRequest,
    actor: Actor | None = Depends(optional_actor),
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    override_actor: Actor | None = None
    if body.completed_at_override is not None or body.settings_override is not None:
        override_actor = require_admin_for(actor, "completed_at_override / settings_override")
    with database.write_scope() as db:
        session = get_session_or_404(db, session_id)
        response, _ = complete_session(
            db,
            settings,
            session,
            ts_client=body.ts_client,
            override_actor=override_actor,
            completed_at_override=body.completed_at_override,
            settings_override=(
                body.settings_override.model_dump(exclude_none=True)
                if body.settings_override is not None
                else None
            ),
        )
    # R6: after the commit, outside the write lock; never fails the check-in.
    response["confirmation"] = send_checkin_confirmation(database, settings, session_id)
    return response


@router.post("/sessions/{session_id}/urgent")
def post_urgent(
    session_id: str,
    body: UrgentRequest,
    database: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """R5.1: the kiosk stopped at once. Completes with the answers so far, tier 3, stop screen.

    Same body as ``/complete`` plus ``ended_early``. Idempotent per session and trigger.
    """
    with database.write_scope() as db:
        session = get_session_or_404(db, session_id)
        response = end_session_early(
            db, settings, session, trigger=body.trigger, ts_client=body.ts_client
        )
    response["confirmation"] = send_checkin_confirmation(database, settings, session_id)
    return response
