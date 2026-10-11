"""24-hour clock alerts: a running SAE/AESI clock cannot be missed silently.

The sweep runs on read (queue, escalations, SAE-clock and pager reads all call
``sweep_if_needed``) and on demand (``POST /sae-clocks/sweep``, for a site cron). For every
running clock of a non-eval participant it writes, at most once per clock and threshold:

* ``clock.due_soon`` when ``due_soon_hours_before`` (``seriousness.json`` →
  ``clock_alerts``) or fewer remain, and
* ``clock.breached`` once ``due_at`` has passed,

each with a mock page (``pages`` row, shown as a dashboard toast like a Tier 3 page). A
breach also appends one reason to the clock's escalation row (the check-in's or chart note's;
an acknowledged escalation keeps its acknowledgment, the reason and the new page still show).
The audit chain itself is the "already alerted" record, so a restart never double-pages.
"""

from __future__ import annotations

from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.tables import load_table

from ..audit import SYSTEM_ACTOR, append_event
from ..db import Database
from ..models import AuditEvent, Escalation, Page, Participant, SAEClock
from ..util import dump_json, load_json, new_id, now_iso, seconds_between

DUE_SOON = "clock.due_soon"
BREACHED = "clock.breached"


def due_soon_seconds() -> float:
    table = load_table("seriousness")
    hours = float((table.get("clock_alerts") or {}).get("due_soon_hours_before", 4))
    return hours * 3600.0


def _alerted(db: DbSession, clock_id: str) -> set[str]:
    rows = db.exec(
        select(AuditEvent.action)
        .where(AuditEvent.entity_type == "sae_clock")
        .where(AuditEvent.entity_id == clock_id)
        .where(AuditEvent.action.in_((DUE_SOON, BREACHED)))  # type: ignore[attr-defined]
    ).all()
    return set(rows)


def pending_alerts(db: DbSession, *, now: str | None = None) -> list[tuple[SAEClock, str]]:
    """``(clock, action)`` pairs that are due and not yet written."""
    reference = now or now_iso()
    lead = due_soon_seconds()
    stmt = (
        select(SAEClock)
        .join(Participant, Participant.usubjid == SAEClock.usubjid)  # type: ignore[arg-type]
        .where(SAEClock.stopped_at == None)  # noqa: E711
        .where(Participant.is_eval == False)  # noqa: E712
    )
    out: list[tuple[SAEClock, str]] = []
    for clock in db.exec(stmt).all():
        remaining = seconds_between(reference, clock.due_at)
        if remaining > lead:
            continue
        done = _alerted(db, clock.id)
        if DUE_SOON not in done:
            out.append((clock, DUE_SOON))
        if remaining < 0 and BREACHED not in done:
            out.append((clock, BREACHED))
    return out


def _clock_escalation(db: DbSession, clock: SAEClock) -> Escalation | None:
    if clock.session_id:
        return db.exec(select(Escalation).where(Escalation.session_id == clock.session_id)).first()
    if clock.note_id:
        return db.exec(select(Escalation).where(Escalation.note_id == clock.note_id)).first()
    return None


def breach_reason(clock: SAEClock) -> str:
    kind = (clock.kind or "sae").upper()
    return (
        f"{kind} 24-hour clock overdue: due {clock.due_at}, no investigator decision or signed "
        "report recorded"
    )


def sweep_clock_alerts(db: DbSession, *, now: str | None = None) -> list[dict[str, Any]]:
    """Write the pending alerts (audit event + mock page each). Returns what was written."""
    stamp = now or now_iso()
    written: list[dict[str, Any]] = []
    for clock, action in pending_alerts(db, now=stamp):
        kind = (clock.kind or "sae").upper()
        remaining_h = round(seconds_between(stamp, clock.due_at) / 3600.0, 2)
        message = f"{kind} 24-hour clock for {clock.usubjid} " + (
            f"is overdue (due {clock.due_at}). Record the investigator decision now."
            if action == BREACHED
            else f"is due in {remaining_h} h (due {clock.due_at})."
        )
        escalation = _clock_escalation(db, clock) if action == BREACHED else None
        reason = breach_reason(clock) if action == BREACHED else None
        if escalation is not None and reason is not None:
            reasons = list(load_json(escalation.reasons_json, []) or [])
            if reason not in reasons:
                reasons.append(reason)
                escalation.reasons_json = dump_json(reasons)
                db.add(escalation)
        page = Page(
            id=new_id(),
            ts=stamp,
            session_id=clock.session_id,
            escalation_id=escalation.id if escalation is not None else None,
            usubjid=clock.usubjid,
            tier=3 if action == BREACHED else 2,
            message=message,
            delivered=True,
        )
        db.add(page)
        db.flush()
        event = append_event(
            db,
            SYSTEM_ACTOR,
            action,
            "sae_clock",
            clock.id,
            {
                "kind": clock.kind or "sae",
                "usubjid": clock.usubjid,
                "session_id": clock.session_id,
                "note_id": clock.note_id,
                "due_at": clock.due_at,
                "hours_remaining": remaining_h,
                "page_id": page.id,
                "escalation_id": escalation.id if escalation is not None else None,
                "escalation_reason": reason,
                "message": message,
                "mock_pager": True,
            },
            ts_utc=stamp,
        )
        written.append(
            {"clock_id": clock.id, "action": action, "page_id": page.id, "event_id": event.id}
        )
    return written


def sweep_if_needed(database: Database, *, now: str | None = None) -> list[dict[str, Any]]:
    """Cheap read first; take the write lock only when an alert is actually due."""
    with database.read_scope() as db:
        if not pending_alerts(db, now=now):
            return []
    with database.write_scope() as db:
        return sweep_clock_alerts(db, now=now)


def clock_breach_summary(db: DbSession, *, include_eval: bool = False) -> dict[str, int]:
    """Counts for the Escalations page: clocks running past due, and late stops."""
    stmt = select(SAEClock).join(
        Participant,
        Participant.usubjid == SAEClock.usubjid,  # type: ignore[arg-type]
    )
    if not include_eval:
        stmt = stmt.where(Participant.is_eval == False)  # noqa: E712
    reference = now_iso()
    running_overdue = 0
    stopped_late = 0
    for clock in db.exec(stmt).all():
        if clock.stopped_at is None:
            running_overdue += int(seconds_between(reference, clock.due_at) < 0)
        else:
            stopped_late += int(seconds_between(clock.stopped_at, clock.due_at) < 0)
    return {"running_overdue": running_overdue, "stopped_late": stopped_late}


__all__ = [
    "BREACHED",
    "DUE_SOON",
    "breach_reason",
    "clock_breach_summary",
    "due_soon_seconds",
    "pending_alerts",
    "sweep_clock_alerts",
    "sweep_if_needed",
]
