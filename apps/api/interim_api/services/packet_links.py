"""Clock <-> packet lookups shared by the dashboard read models (CONTRACTS R3.2).

Kept apart from :mod:`interim_api.services.packets` so that ``services.dashboard`` can
enrich clock rows (``kind``, ``packet_id``, ``ae_draft_ids``) without importing the packet
service, which itself imports the dashboard's evidence index.

A session can carry two clocks: a suspected SAE (hospitalization / ER) and a possible
AESI (grade >= 3 on a potentially immune-related item). Every list here is therefore
"clocks of a source", never "the clock".
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from ..models import Draft, Packet, SAEClock
from .common import sae_clock_to_dict


def clocks_by_session(db: DbSession, session_ids: Iterable[str]) -> dict[str, list[SAEClock]]:
    """Every clock of each session, SAE first then AESI, oldest first."""
    ids = list(session_ids)
    out: dict[str, list[SAEClock]] = {}
    if not ids:
        return out
    rows = db.exec(select(SAEClock).where(SAEClock.session_id.in_(ids))).all()  # type: ignore[union-attr]
    for row in rows:
        out.setdefault(row.session_id or "", []).append(row)
    for sid in out:
        out[sid].sort(key=_clock_order)
    return out


def clocks_for_note(db: DbSession, note_id: str) -> list[SAEClock]:
    rows = list(db.exec(select(SAEClock).where(SAEClock.note_id == note_id)).all())
    return sorted(rows, key=_clock_order)


def _clock_order(c: SAEClock) -> tuple[int, str, str]:
    return (0 if (c.kind or "sae") == "sae" else 1, c.created_at, c.id)


def primary_clock(clocks: Sequence[SAEClock]) -> SAEClock | None:
    """The clock a single-clock UI field should show: the running one due soonest, else
    the first (SAE before AESI)."""
    running = sorted((c for c in clocks if c.stopped_at is None), key=lambda c: c.due_at)
    if running:
        return running[0]
    return clocks[0] if clocks else None


def latest_packet_ids(db: DbSession, clock_ids: Iterable[str]) -> dict[str, str]:
    """``{clock_id: id of its newest packet (highest sequence)}``."""
    ids = list(clock_ids)
    if not ids:
        return {}
    rows = db.exec(select(Packet).where(Packet.clock_id.in_(ids))).all()  # type: ignore[attr-defined]
    best: dict[str, Packet] = {}
    for row in rows:
        current = best.get(row.clock_id)
        if current is None or row.sequence > current.sequence:
            best[row.clock_id] = row
    return {cid: p.id for cid, p in best.items()}


def ae_draft_ids_for_clock(db: DbSession, clock: SAEClock) -> list[str]:
    """Current (not superseded / rejected) AE draft ids of the clock's source."""
    stmt = select(Draft).where(Draft.domain == "AE").where(Draft.status != "superseded")
    if clock.session_id is not None:
        stmt = stmt.where(Draft.session_id == clock.session_id)
    elif clock.note_id is not None:
        stmt = stmt.where(Draft.note_id == clock.note_id)
    else:
        return []
    return sorted(d.id for d in db.exec(stmt).all() if d.status != "rejected")


def clock_rows(
    db: DbSession, clocks: Sequence[SAEClock], *, now: str | None = None
) -> list[dict[str, Any]]:
    """``SAEClockRow`` dicts enriched with ``packet_id``, ``ae_draft_ids``, ``has_ae_draft``."""
    packets = latest_packet_ids(db, (c.id for c in clocks))
    out: list[dict[str, Any]] = []
    for clock in clocks:
        row = sae_clock_to_dict(clock, now=now)
        ae_ids = ae_draft_ids_for_clock(db, clock)
        row["packet_id"] = packets.get(clock.id)
        row["ae_draft_ids"] = ae_ids
        row["has_ae_draft"] = bool(ae_ids)
        out.append(row)
    return out


def queue_clock_fields(db: DbSession, clocks: Sequence[SAEClock]) -> dict[str, Any]:
    """The queue item's clock fields: legacy single-clock fields from the primary clock
    plus ``clocks[]`` (R3.2) and ``clock_kind``."""
    primary = primary_clock(clocks)
    packets = latest_packet_ids(db, (c.id for c in clocks))
    return {
        "has_sae_clock": primary is not None,
        "sae_due_at": primary.due_at if primary is not None else None,
        "sae_stopped": (primary.stopped_at is not None) if primary is not None else None,
        "sae_stopped_at": primary.stopped_at if primary is not None else None,
        "clock_kind": (primary.kind or "sae") if primary is not None else None,
        "clocks": [
            {
                "id": c.id,
                "kind": c.kind or "sae",
                "due_at": c.due_at,
                "stopped_at": c.stopped_at,
                "decision": c.decision,
                "packet_id": packets.get(c.id),
            }
            for c in clocks
        ],
    }


__all__ = [
    "ae_draft_ids_for_clock",
    "clock_rows",
    "clocks_by_session",
    "clocks_for_note",
    "latest_packet_ids",
    "primary_clock",
    "queue_clock_fields",
]
