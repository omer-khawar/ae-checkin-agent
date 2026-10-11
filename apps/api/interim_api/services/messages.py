"""Participant texts (CONTRACTS.md R6): a confirmation when a check-in completes and a
"reviewed" note when a coordinator acknowledges it.

Plain-language templates only: no grade, tier or clinical word ever reaches a text. Every
message is a ``messages`` row and one audit event. Sending runs outside the write lock and
never raises: a failed send is recorded with ``status="failed"``, the check-in stands.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlmodel import Session as DbSession
from sqlmodel import col, func, select

from ..audit import SYSTEM_ACTOR, Actor, append_event
from ..db import Database
from ..models import Escalation, Message, Participant, Session
from ..notifier import Notifier, get_notifier
from ..settings import Settings
from ..util import new_id, now_iso

log = logging.getLogger("interim_api.messages")

KIND_CONFIRMATION = "checkin_confirmation"
KIND_REVIEW_ACK = "review_ack"
REVIEW_ACK_TEXT = "Your study nurse has reviewed your check-in."
CONSENT_BASIS = "enrollment_icf"
"""Texting consent is covered by the informed consent form signed at enrollment (D-043)."""


def mask_phone(phone: str) -> str:
    """``+17325550161`` -> ``•••-0161``."""
    digits = re.sub(r"\D", "", phone)
    return f"•••-{digits[-4:]}" if len(digits) >= 4 else "•••"


def _received(completed_at: str, tz_name: str) -> tuple[str, str]:
    dt = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
    suffix = ""
    try:
        dt = dt.astimezone(ZoneInfo(tz_name))
    except Exception:  # unknown zone or no tz database: say UTC rather than guess
        suffix = " UTC"
    return dt.strftime("%I:%M %p").lstrip("0") + suffix, f"{dt:%a, %b} {dt.day}"


def confirmation_text(tier: int, completed_at: str, settings: Settings) -> str:
    """The completion text. Every tier: received time, the site phone and the 911 line;
    tier 3 also says the team will call today."""
    time, day = _received(completed_at, settings.site_timezone)
    head = f"{settings.site_name}: We received your check-in at {time} on {day}."
    if tier >= 3:
        return (
            f"{head} The study team will call you today. You can also reach them at "
            f"{settings.site_phone}. If you need urgent help right now, call 911."
        )
    return (
        f"{head} Questions? Call the study team at {settings.site_phone}. "
        "If you need urgent help, call 911."
    )


def message_to_dict(m: Message, *, full_number: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": m.id,
        "created_at": m.created_at,
        "usubjid": m.usubjid,
        "session_id": m.session_id,
        "escalation_id": m.escalation_id,
        "kind": m.kind,
        "to_masked": mask_phone(m.to_phone),
        "body": m.body,
        "channel": m.channel,
        "status": m.status,
        "error": m.error,
    }
    if full_number:
        out["to"] = m.to_phone
    return out


def session_messages(db: DbSession, session_id: str) -> list[dict[str, Any]]:
    rows = db.exec(
        select(Message).where(Message.session_id == session_id).order_by(col(Message.created_at))
    ).all()
    return [message_to_dict(m) for m in rows]


def list_messages(db: DbSession, *, limit: int, offset: int) -> dict[str, Any]:
    total = db.exec(select(func.count()).select_from(Message)).one()
    rows = db.exec(
        select(Message).order_by(col(Message.created_at).desc()).offset(offset).limit(limit)
    ).all()
    return {
        "items": [message_to_dict(m, full_number=True) for m in rows],
        "total": int(total),
        "limit": limit,
        "offset": offset,
    }


def _record(
    db: DbSession,
    actor: Actor,
    *,
    usubjid: str,
    session_id: str | None,
    escalation_id: str | None,
    kind: str,
    to: str,
    body: str,
    channel: str,
    status: str,
    provider_id: str | None,
    error: str | None,
) -> Message:
    stamp = now_iso()
    row = Message(
        id=new_id(),
        created_at=stamp,
        usubjid=usubjid,
        session_id=session_id,
        escalation_id=escalation_id,
        kind=kind,
        to_phone=to,
        body=body,
        channel=channel,
        status=status,
        provider_id=provider_id,
        error=error,
    )
    db.add(row)
    db.flush()
    append_event(
        db,
        actor,
        "message.failed" if status == "failed" else "message.sent",
        "message",
        row.id,
        {
            "kind": kind,
            "usubjid": usubjid,
            "session_id": session_id,
            "escalation_id": escalation_id,
            "to_masked": mask_phone(to),
            "body": body,
            "channel": channel,
            "status": status,
            "error": error,
            "consent_basis": CONSENT_BASIS,
        },
        ts_utc=stamp,
    )
    return row


def _deliver(
    database: Database,
    settings: Settings,
    actor: Actor,
    *,
    usubjid: str,
    to: str,
    body: str,
    kind: str,
    session_id: str | None,
    escalation_id: str | None = None,
    notifier: Notifier | None = None,
) -> dict[str, Any]:
    sender = notifier or get_notifier(settings)
    try:
        result = sender.send(to, body)
        channel, status = result.channel, result.status
        provider_id, error = result.provider_id, result.error
    except Exception as exc:  # a notifier broke its never-raise contract: record it
        channel, status = getattr(sender, "channel", "unknown"), "failed"
        provider_id, error = None, f"{type(exc).__name__}: {exc}"[:300]
    with database.write_scope() as db:
        row = _record(
            db,
            actor,
            usubjid=usubjid,
            session_id=session_id,
            escalation_id=escalation_id,
            kind=kind,
            to=to,
            body=body,
            channel=channel,
            status=status,
            provider_id=provider_id,
            error=error,
        )
        return message_to_dict(row)


def send_checkin_confirmation(
    database: Database,
    settings: Settings,
    session_id: str,
    *,
    notifier: Notifier | None = None,
) -> dict[str, Any] | None:
    """Text the completion confirmation once per session. ``None`` when the participant has
    no phone on file or anything went wrong (logged; the check-in is already committed)."""
    try:
        with database.read_scope() as db:
            existing = db.exec(
                select(Message)
                .where(Message.session_id == session_id)
                .where(Message.kind == KIND_CONFIRMATION)
            ).first()
            if existing is not None:  # /urgent is idempotent; never text twice
                return message_to_dict(existing)
            session = db.get(Session, session_id)
            if session is None or session.completed_at is None:
                return None
            participant = db.get(Participant, session.usubjid)
            if participant is None or not participant.phone:
                return None
            to, usubjid = participant.phone, participant.usubjid
            body = confirmation_text(int(session.tier or 0), session.completed_at, settings)
        return _deliver(
            database,
            settings,
            SYSTEM_ACTOR,
            usubjid=usubjid,
            to=to,
            body=body,
            kind=KIND_CONFIRMATION,
            session_id=session_id,
            notifier=notifier,
        )
    except Exception:
        log.exception("confirmation text for session %s not recorded", session_id)
        return None


def send_review_ack(
    database: Database,
    settings: Settings,
    actor: Actor,
    escalation_id: str,
    *,
    notifier: Notifier | None = None,
) -> dict[str, Any] | None:
    """Text "Your study nurse has reviewed your check-in." after a coordinator acknowledges
    a check-in's escalation. Chart-note escalations (no session) send nothing."""
    try:
        with database.read_scope() as db:
            esc = db.get(Escalation, escalation_id)
            if esc is None or esc.session_id is None:
                return None
            participant = db.get(Participant, esc.usubjid)
            if participant is None or not participant.phone:
                return None
            to, usubjid, session_id = participant.phone, participant.usubjid, esc.session_id
        return _deliver(
            database,
            settings,
            actor,
            usubjid=usubjid,
            to=to,
            body=REVIEW_ACK_TEXT,
            kind=KIND_REVIEW_ACK,
            session_id=session_id,
            escalation_id=escalation_id,
            notifier=notifier,
        )
    except Exception:
        log.exception("review text for escalation %s not recorded", escalation_id)
        return None
