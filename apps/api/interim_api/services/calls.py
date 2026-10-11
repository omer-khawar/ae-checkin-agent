"""Phone-call intake (CONTRACTS.md R4.1, CLAUDE.md §00 step 2).

A logged call is a :class:`~interim_api.models.ChartNote` with ``note_type = "phone_call"``:
the text is the coordinator's call summary and it is scanned, drafted, de-duplicated and
escalated exactly like a chart note (``services/notes.py``). What a call adds is who was on
the line and who dialled, kept in the :class:`~interim_api.models.ChartNoteCall` side table
keyed by note id, and a source label ``"phone_call"`` wherever notes are listed (queue,
``GET /notes``, note detail, participant timeline).

The drafts a call produces keep ``source = "chart_note"`` and their evidence keeps
``kind = "chart_note"`` (one scanner, one evidence resolver); ``source_label`` is the
display-level distinction (decision recorded in ``apps/api/README.md``).
"""

from __future__ import annotations

from collections.abc import Iterable, MutableMapping, Sequence
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from ..models import ChartNote, ChartNoteCall

PHONE_CALL = "phone_call"
CALLERS: tuple[str, ...] = ("participant", "caregiver", "other")
CALL_DIRECTIONS: tuple[str, ...] = ("inbound", "outbound")


def is_phone_call(note_type: str | None) -> bool:
    return (note_type or "").strip() == PHONE_CALL


def source_label(note_type: str | None) -> str:
    """``"phone_call"`` for a logged call, else ``"chart_note"``."""
    return PHONE_CALL if is_phone_call(note_type) else "chart_note"


def store_call(
    db: DbSession,
    note: ChartNote,
    *,
    caller: str | None,
    call_direction: str | None,
    stamp: str,
) -> ChartNoteCall | None:
    """Persist the call metadata for a phone-call note (no-op for any other note type)."""
    if not is_phone_call(note.note_type):
        return None
    row = ChartNoteCall(
        note_id=note.id, caller=caller, call_direction=call_direction, created_at=stamp
    )
    db.add(row)
    db.flush()
    return row


def calls_for(db: DbSession, note_ids: Iterable[str]) -> dict[str, ChartNoteCall]:
    ids = sorted({i for i in note_ids if i})
    if not ids:
        return {}
    rows = db.exec(select(ChartNoteCall).where(ChartNoteCall.note_id.in_(ids))).all()  # type: ignore[attr-defined]
    return {r.note_id: r for r in rows}


def call_fields(note_type: str | None, call: ChartNoteCall | None) -> dict[str, Any]:
    """The R4.1 keys every note-shaped response carries."""
    return {
        "source_label": source_label(note_type),
        "is_phone_call": is_phone_call(note_type),
        "caller": call.caller if call else None,
        "call_direction": call.call_direction if call else None,
    }


def enrich_with_calls(
    db: DbSession,
    items: Sequence[MutableMapping[str, Any]],
    *,
    id_key: str = "id",
    type_key: str = "note_type",
) -> None:
    """Add ``source_label``/``is_phone_call``/``caller``/``call_direction`` in place.

    Items without a note id (check-in queue rows) get ``source_label`` from their own
    ``source`` and no call keys are overwritten with call data.
    """
    calls = calls_for(db, (str(i.get(id_key) or "") for i in items))
    for item in items:
        note_id = item.get(id_key)
        if not note_id:
            item.setdefault("source_label", item.get("source", "check_in"))
            continue
        item.update(call_fields(item.get(type_key), calls.get(str(note_id))))


__all__ = [
    "CALLERS",
    "CALL_DIRECTIONS",
    "PHONE_CALL",
    "call_fields",
    "calls_for",
    "enrich_with_calls",
    "is_phone_call",
    "source_label",
    "store_call",
]
