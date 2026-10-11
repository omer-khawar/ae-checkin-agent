"""The hash-chained audit log (CLAUDE.md §3.6, CONTRACTS.md §2.3).

Each event is ``{id, seq, ts_utc, actor_id, actor_role, action, entity_type,
entity_id, payload, prev_hash, hash}`` with::

    hash = sha256(prev_hash + canonical_json(event_without_hash))
    canonical_json = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

Genesis ``prev_hash`` is 64 zeros. ``seq`` is strictly increasing. Rows are
append-only (``db.py`` refuses UPDATE/DELETE). :func:`verify_chain` recomputes
every hash from the stored fields and reports the first broken link, which is
what ``GET /audit/verify`` and the dashboard's green badge rely on.

:func:`append_event` must be called inside a write scope (``Database.write_scope``)
so that ``read head -> hash -> insert`` cannot interleave between threads.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func
from sqlmodel import Session as DbSession
from sqlmodel import select

from .models import AuditEvent
from .util import dump_json, load_json, new_id, now_iso, to_jsonable

GENESIS_PREV_HASH = "0" * 64


@dataclass(frozen=True)
class Actor:
    """Who did it. Kiosk events carry the participant; the bridge is ``vitals-bridge``."""

    id: str
    role: str  # coordinator | investigator | admin | participant | system

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


SYSTEM_ACTOR = Actor(id="interim-api", role="system")
BRIDGE_ACTOR = Actor(id="vitals-bridge", role="system")

AUDIT_ACTIONS: frozenset[str] = frozenset(
    {
        # CONTRACTS.md §2.3
        "session.started",
        "session.consent",
        "answer.recorded",
        "answer.updated",
        "gates.recorded",
        "vitals.batch",
        "session.completed",
        "session.ended_early",  # R5.1: kiosk urgent path, completed with answers so far
        "rule.fired",
        "draft.created",
        "draft.edited",
        "draft.confirmed",
        "draft.rejected",
        "draft.attribution",
        "escalation.created",
        "escalation.paged",
        "escalation.acked",
        "sae_clock.started",
        "sae_clock.stopped",
        "export.generated",
        "mock_edc.posted",
        "settings.changed",
        "demo.reset",
        "eval.run",
        "auth.login",
        # R2.4 (chart notes; emitted by the scanner track)
        "note.ingested",
        "note.scanned",
        # R5.3 (second reader): input sha256, model, status, kept / rejected counts
        "llm.read",
        # API additions beyond the contract list (see apps/api/README.md "Audit chain")
        "vitals.rejected",  # batch refused: no camera consent / unverifiable measured claim
        "drafts.applied",  # one summary line per apply_result() call on the originating entity
        "ae_open.closed",  # an open AE closed by a reject / AEONGO=N / AEENDTC edit
        "demo.seed",  # genesis event of a seeded database
        "demo.seeded",  # seed summary
        # [briefs agent] R3.2 visit-prep brief + the visit dates it is cut off at
        "brief.generated",
        "visit.recorded",
        # [queries agent] R4.4 sponsor queries
        "query.raised",
        "query.answered",
        "query.closed",
        # [packets agent] R3.2 / R4.2 serious-event packets; AESI clocks (kind "aesi")
        "packet.created",
        "packet.edited",
        "packet.signed",
        "packet.followup_signed",
        "clock.started",
        # [fixer 2B] every clock stop, any kind (sae_clock.stopped kept for back-compat)
        "clock.stopped",
        "clock.due_soon",
        "clock.breached",
        # R6 participant texts: one event per message (sent / mock outbox, or failed)
        "message.sent",
        "message.failed",
    }
)
"""Every action the API may emit. ``append_event`` refuses anything else, so the audit
vocabulary is a closed, documented list rather than whatever string a caller typed."""


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def event_hash(prev_hash: str, event_without_hash: dict[str, Any]) -> str:
    material = prev_hash + canonical_json(event_without_hash)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def hashable_view(row: AuditEvent) -> dict[str, Any]:
    """The fields that are hashed, decoded exactly as they were when written."""
    return {
        "id": row.id,
        "seq": row.seq,
        "ts_utc": row.ts_utc,
        "actor_id": row.actor_id,
        "actor_role": row.actor_role,
        "action": row.action,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "payload": load_json(row.payload_json, {}),
    }


def head(db: DbSession) -> AuditEvent | None:
    """The newest event, or ``None`` on an empty chain."""
    return db.exec(select(AuditEvent).order_by(AuditEvent.seq.desc()).limit(1)).first()  # type: ignore[attr-defined]


def append_event(
    db: DbSession,
    actor: Actor,
    action: str,
    entity_type: str,
    entity_id: str,
    payload: Any = None,
    *,
    ts_utc: str | None = None,
) -> AuditEvent:
    """Append one event and flush it so the next call sees it as the head."""
    if action not in AUDIT_ACTIONS:
        raise ValueError(f"unregistered audit action {action!r}; add it to AUDIT_ACTIONS")
    last = head(db)
    seq = 1 if last is None else last.seq + 1
    prev_hash = GENESIS_PREV_HASH if last is None else last.hash
    payload_obj = to_jsonable(payload if payload is not None else {})
    body = {
        "id": new_id(),
        "seq": seq,
        "ts_utc": ts_utc or now_iso(),
        "actor_id": actor.id,
        "actor_role": actor.role,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "payload": payload_obj,
    }
    row = AuditEvent(
        id=body["id"],
        seq=seq,
        ts_utc=body["ts_utc"],
        actor_id=actor.id,
        actor_role=actor.role,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        payload_json=dump_json(payload_obj),
        prev_hash=prev_hash,
        hash=event_hash(prev_hash, body),
    )
    db.add(row)
    db.flush()
    return row


def event_to_dict(row: AuditEvent) -> dict[str, Any]:
    out = hashable_view(row)
    out["prev_hash"] = row.prev_hash
    out["hash"] = row.hash
    return out


def count_events(db: DbSession) -> int:
    return int(db.exec(select(func.count()).select_from(AuditEvent)).one())


def verify_chain(db: DbSession, *, batch: int = 500) -> dict[str, Any]:
    """Walk the whole chain in ``seq`` order and recompute every hash.

    Returns ``{ok, checked, head_hash, first_broken, verified_at}`` where
    ``first_broken`` is ``{index, id, expected_hash, actual_hash, reason}`` for
    the first event whose stored hash, link or sequence does not match.
    """
    prev_hash = GENESIS_PREV_HASH
    expected_seq = 1
    checked = 0
    head_hash = GENESIS_PREV_HASH
    first_broken: dict[str, Any] | None = None
    offset = 0
    while first_broken is None:
        rows = db.exec(
            select(AuditEvent).order_by(AuditEvent.seq).offset(offset).limit(batch)  # type: ignore[arg-type]
        ).all()
        if not rows:
            break
        for row in rows:
            expected = event_hash(prev_hash, hashable_view(row))
            reason: str | None = None
            if row.seq != expected_seq:
                reason = f"sequence gap: expected seq {expected_seq}, found {row.seq}"
            elif row.prev_hash != prev_hash:
                reason = "prev_hash does not match the previous event's hash"
            elif row.hash != expected:
                reason = "stored hash does not match the recomputed hash"
            if reason is not None:
                first_broken = {
                    "index": checked,
                    "seq": row.seq,
                    "id": row.id,
                    "expected_hash": expected,
                    "actual_hash": row.hash,
                    "reason": reason,
                }
                break
            prev_hash = row.hash
            head_hash = row.hash
            expected_seq += 1
            checked += 1
        offset += batch
    return {
        "ok": first_broken is None,
        "checked": checked,
        "head_hash": head_hash,
        "first_broken": first_broken,
        "verified_at": now_iso(),
    }
