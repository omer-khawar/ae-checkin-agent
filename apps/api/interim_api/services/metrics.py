"""Coordinator time saved, on screen (CLAUDE.md §00.5, CONTRACTS.md R3.2 / R4.4).

Two halves:

* :func:`record_confirm_metrics` runs inside ``services.drafts.confirm_draft``: it compares
  version 1 of the record (what Interim pre-filled from evidence) with the version being
  confirmed and stores the counts in ``DraftMetrics`` using the rules package's own
  counting helpers (``interim_rules.time_saved.prefilled_count`` / ``edited_count``), so the
  API never decides what counts as a field.
* :func:`time_saved` (``GET /metrics/time-saved``) adds up everything Interim pre-filled
  since a cut-off and hands the counts to ``interim_rules.time_saved.estimate``, which owns
  the minutes-per-field table (``packages/rules/data/time_model.json``). The arithmetic and
  its sources come back as ``basis[]``; the result is always labeled an **estimate**.

What is counted (every source is read lazily, so a table another feature owns being absent
simply contributes nothing):

* confirmed AE / VS / CM records: their countable fields (``DraftMetrics``); a record
  confirmed again after an edit counts once, with its latest counts;
* signed serious-event packets (``packet.signed`` / ``packet.followup_signed`` audit
  events): the packet's pre-filled report fields (``SAE_FORM``) and its drafted narrative
  (``NARRATIVE_PARAGRAPH``). Placeholders ("unknown", "not yet decided by the
  investigator") and values a person typed are not pre-filled; a follow-up counts only the
  fields that changed since the previous report; fields or narrative a person edited
  (``packet.edited``) save nothing (see :func:`_packet_counts`);
* visit briefs (``brief.generated`` audit events): one ``BRIEF_SECTION`` per section that
  had content, counted **once per participant per visit**: the key is the participant
  plus the brief's next scheduled visit (or, without one, the UTC day it was generated),
  never the cut-off, so a refresh, a print or moving the date cut-off does not add time;
  the latest generation for that visit is the one counted;
* sponsor queries answered from the suggested answer (``answered_from_suggestion``): one
  pre-filled field of the record's domain (R4.4).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import timedelta
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.time_saved import edited_count, estimate, prefilled_count, weekly_context
from interim_rules.timefmt import format_iso_utc

from .. import models
from ..audit import Actor
from ..models import AuditEvent, Draft, DraftMetrics, Participant
from ..problems import problem
from ..util import load_json, now_iso, parse_iso_utc

SDTM_DOMAINS: tuple[str, ...] = ("AE", "VS", "CM")
DEFAULT_WINDOW_DAYS = 7
"""Default look-back of ``GET /metrics/time-saved`` ("time saved this week"); not clinical."""

PACKET_SIGNED_ACTIONS: tuple[str, ...] = ("packet.signed", "packet.followup_signed")


# --------------------------------------------------------------------------- #
# On confirm
# --------------------------------------------------------------------------- #


def _first_version(db: DbSession, draft: Draft) -> Draft:
    first = db.get(Draft, draft.lineage_id)
    return first if first is not None else draft


def record_confirm_metrics(db: DbSession, actor: Actor, draft: Draft, stamp: str) -> DraftMetrics:
    """Store the pre-filled / edited counts of a draft that was just confirmed."""
    confirmed = load_json(draft.fields_json, {}) or {}
    drafted = load_json(_first_version(db, draft).fields_json, {}) or {}
    prefilled = edited = 0
    if draft.domain in SDTM_DOMAINS:
        prefilled = prefilled_count(draft.domain, drafted)
        edited = edited_count(draft.domain, drafted, confirmed)
    participant = db.get(Participant, draft.usubjid)
    row = db.get(DraftMetrics, draft.id) or DraftMetrics(
        id=draft.id,
        lineage_id=draft.lineage_id,
        usubjid=draft.usubjid,
        domain=draft.domain,
        confirmed_at=stamp,
        confirmed_by=actor.id,
    )
    row.prefilled_fields = prefilled
    row.edited_fields = edited
    row.confirmed_at = stamp
    row.confirmed_by = actor.id
    row.is_eval = bool(participant.is_eval) if participant is not None else False
    db.add(row)
    db.flush()
    return row


# --------------------------------------------------------------------------- #
# GET /metrics/time-saved
# --------------------------------------------------------------------------- #


def resolve_since(value: str | None, *, now: str) -> str:
    """``YYYY-MM-DD`` (midnight UTC) or an ISO-8601 timestamp; default: 7 days before now."""
    if value is None or not value.strip():
        return format_iso_utc(parse_iso_utc(now) - timedelta(days=DEFAULT_WINDOW_DAYS))
    text = value.strip()
    try:
        if len(text) == 10:
            return format_iso_utc(parse_iso_utc(f"{text}T00:00:00Z"))
        return format_iso_utc(parse_iso_utc(text))
    except ValueError as exc:
        raise problem(
            422,
            f"since must be YYYY-MM-DD or an ISO-8601 UTC timestamp, got {value!r}",
            title="Invalid since",
        ) from exc


def _eval_participants(db: DbSession) -> set[str]:
    rows = db.exec(select(Participant).where(Participant.is_eval == True)).all()  # noqa: E712
    return {p.usubjid for p in rows}


def _events(db: DbSession, actions: Iterable[str], since: str) -> list[AuditEvent]:
    wanted = list(actions)
    rows = db.exec(
        select(AuditEvent)
        .where(AuditEvent.action.in_(wanted))  # type: ignore[attr-defined]
        .where(AuditEvent.ts_utc >= since)
        .order_by(AuditEvent.seq)  # type: ignore[arg-type]
    ).all()
    return list(rows)


def _is_filled(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list | tuple | dict):
        return bool(value)
    return True


PERSON_POINTER_KINDS: frozenset[str] = frozenset({"edit", "packet"})
"""Evidence kinds that record a person's typing (an edit, or a value carried from a
previous report a person filled in); a field backed only by these was not pre-filled."""


def _from_source(evidence: Any) -> bool:
    """True when at least one evidence pointer is not a person's edit or a carried value."""
    if not isinstance(evidence, list):
        return False
    return any(
        isinstance(p, Mapping) and str(p.get("kind")) not in PERSON_POINTER_KINDS for p in evidence
    )


def _packet_counts(db: DbSession, packet_id: str) -> tuple[str | None, int, int, int, int]:
    """``(usubjid, form_prefilled, form_edited, narrative_prefilled, narrative_edited)``.

    A report field counts as **pre-filled** only when the value Interim drafted (the value
    before the first person's edit, from ``edits_json``) is a real value, not a placeholder
    such as "unknown" or "not yet decided by the investigator" (``packets.is_placeholder``),
    and is backed by at least one source pointer (not only ``edit`` / ``packet`` pointers).
    On a follow-up report only the fields whose drafted value changed since the previous
    report (``changes_json``) count: the rest was already counted when that report was
    signed, or was typed by a person there. A pre-filled field a person then changed is
    **edited** (it saves nothing). The drafted narrative counts once; a person's own
    narrative text marks it edited.
    """
    from .packets import is_placeholder  # local: packets imports services that import us

    row = db.get(models.Packet, packet_id)
    if row is None:
        return None, 0, 0, 0, 0
    edits = [e for e in load_json(row.edits_json, []) or [] if isinstance(e, Mapping)]
    drafted: dict[str, Any] = {}
    touched: set[str] = set()
    for edit in edits:
        diff = edit.get("diff")
        if not isinstance(diff, Mapping):
            continue
        for name, change in diff.items():
            touched.add(str(name))
            if str(name) not in drafted and isinstance(change, Mapping):
                drafted[str(name)] = change.get("before")
    changed_since_parent: set[str] | None = None
    if row.parent_packet_id:
        changed_since_parent = {
            str(c.get("field"))
            for c in load_json(row.changes_json, []) or []
            if isinstance(c, Mapping)
        }
    prefilled: set[str] = set()
    for entry in load_json(row.fields_json, []) or []:
        if not isinstance(entry, Mapping):
            continue
        name = str(entry.get("name"))
        value = drafted[name] if name in drafted else entry.get("value")
        if is_placeholder(value) or not _is_filled(value):
            continue
        if not _from_source(entry.get("evidence")):
            continue
        if changed_since_parent is not None and name not in changed_since_parent:
            continue
        prefilled.add(name)
    narrative = 1 if _is_filled(load_json(row.narrative_json, None)) else 0
    narrative_edited = (
        row.narrative_edited_json is not None
        or "narrative_text" in touched
        or "narrative" in touched
    )
    form_edited = len(prefilled & touched)
    return (
        row.usubjid,
        len(prefilled),
        form_edited,
        narrative,
        1 if narrative and narrative_edited else 0,
    )


def _brief_key(event: AuditEvent, payload: Mapping[str, Any]) -> tuple[str, str]:
    """One brief per participant per visit: the next scheduled visit the brief prepares for,
    else the UTC calendar day it was generated. The cut-off (``since``) is deliberately not
    part of the key: re-opening the brief with another cut-off is the same piece of work."""
    visit = payload.get("next_visit")
    if isinstance(visit, str) and visit.strip():
        return event.entity_id, f"visit:{visit.strip()}"
    return event.entity_id, f"day:{event.ts_utc[:10]}"


def time_saved(db: DbSession, *, since: str, include_eval: bool = False) -> dict[str, Any]:
    """The ``GET /metrics/time-saved`` payload (CONTRACTS R3.2), always an estimate."""
    excluded = set() if include_eval else _eval_participants(db)
    prefilled: dict[str, int] = {}
    edited: dict[str, int] = {}

    def add(category: str, n_pre: int, n_edit: int = 0) -> None:
        prefilled[category] = prefilled.get(category, 0) + n_pre
        edited[category] = edited.get(category, 0) + n_edit

    # 1. Confirmed records: latest confirmation per lineage.
    latest: dict[str, DraftMetrics] = {}
    for row in db.exec(select(DraftMetrics).where(DraftMetrics.confirmed_at >= since)).all():
        if row.usubjid in excluded:
            continue
        kept = latest.get(row.lineage_id)
        if kept is None or row.confirmed_at >= kept.confirmed_at:
            latest[row.lineage_id] = row
    for row in latest.values():
        add(row.domain, row.prefilled_fields, row.edited_fields)
    records_confirmed = len(latest)

    # 2. Signed packets.
    packets_signed = 0
    for event in _events(db, PACKET_SIGNED_ACTIONS, since):
        payload = load_json(event.payload_json, {}) or {}
        usubjid, form_pre, form_edit, narr_pre, narr_edit = _packet_counts(db, event.entity_id)
        if (usubjid or payload.get("usubjid")) in excluded:
            continue
        packets_signed += 1
        add("SAE_FORM", form_pre, form_edit)
        add("NARRATIVE_PARAGRAPH", narr_pre, narr_edit)

    # 3. Visit briefs: one per (participant, visit), whatever cut-off was chosen.
    briefs: dict[tuple[str, str], int] = {}
    for event in _events(db, ("brief.generated",), since):
        if event.entity_id in excluded:
            continue
        payload = load_json(event.payload_json, {}) or {}
        briefs[_brief_key(event, payload)] = int(payload.get("sections_with_content", 0) or 0)
    for n_sections in briefs.values():
        add("BRIEF_SECTION", n_sections)

    # 4. Queries answered from the suggested answer (R4.4), when that feature exists.
    queries_from_suggestion = 0
    query_cls = getattr(models, "SponsorQuery", None) or getattr(models, "Query", None)
    if query_cls is not None and hasattr(query_cls, "answered_from_suggestion"):
        for q in db.exec(select(query_cls)).all():
            answered_at = getattr(q, "answered_at", None)
            if not getattr(q, "answered_from_suggestion", False) or not answered_at:
                continue
            if answered_at < since or getattr(q, "usubjid", None) in excluded:
                continue
            queries_from_suggestion += 1
            domain = str(getattr(q, "domain", "") or "").upper()
            add(domain if domain in SDTM_DOMAINS else "AE", 1)

    result = estimate(prefilled, edited)
    return {
        "since": since,
        "minutes_saved": result["minutes_saved"],
        "minutes_manual_baseline": result["minutes_manual_baseline"],
        "records_confirmed": records_confirmed,
        "fields_prefilled": sum(prefilled.values()),
        "fields_edited": sum(min(edited.get(k, 0), v) for k, v in prefilled.items()),
        "packets_signed": packets_signed,
        "briefs_generated": len(briefs),
        "queries_answered_from_suggestion": queries_from_suggestion,
        "prefilled_by_category": dict(sorted(prefilled.items())),
        "edited_by_category": dict(sorted(edited.items())),
        "basis": result["basis"],
        "breakdown": result["breakdown"],
        "is_estimate": result["is_estimate"],
        "disclaimer": result["disclaimer"],
        "weekly_context": weekly_context(result["minutes_saved"]),
        "generated_at": now_iso(),
    }


__all__ = [
    "DEFAULT_WINDOW_DAYS",
    "record_confirm_metrics",
    "resolve_since",
    "time_saved",
]
