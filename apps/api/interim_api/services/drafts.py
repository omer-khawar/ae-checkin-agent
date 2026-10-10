"""Coordinator review of drafts: confirm, reject, edit (new version), attribution.

Rules of the review desk (CLAUDE.md §3.5-§3.7):

* a draft stays ``draft`` until a coordinator/investigator/admin confirms it;
* edits never overwrite: ``PATCH`` creates a new version row (``version + 1``,
  ``supersedes_id`` = the old row, same ``lineage_id``) and the old row becomes
  ``superseded``; the edit is an audit event (``draft.edited``, with a diff) and
  every edited field gains an ``Evidence{kind: "edit", id: <audit event id>}``
  pointer so the value still "knows where it came from";
* only an investigator sets ``AEREL`` / ``AESER``; recording ``AESER`` stops the
  session's SAE clock;
* rejecting an AE draft that opened an ``AEOpen`` row closes that row; editing
  an AE draft to ``AEONGO = "N"`` or a non-null ``AEENDTC`` closes it too.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from ..audit import Actor, append_event
from ..models import Draft, SAEClock
from ..problems import problem
from ..util import dump_json, load_json, new_id, now_iso
from .checkins import close_open_ae
from .sdtm_fields import field_problems

ATTRIBUTION_FIELDS: tuple[str, ...] = ("AEREL", "AESER")


def versions_of(db: DbSession, draft: Draft) -> list[Draft]:
    rows = db.exec(select(Draft).where(Draft.lineage_id == draft.lineage_id)).all()
    return sorted(rows, key=lambda d: d.version)


def current_version(db: DbSession, draft: Draft) -> Draft:
    """The newest version in this draft's lineage."""
    return versions_of(db, draft)[-1]


def _require_current(db: DbSession, draft: Draft) -> None:
    if draft.status == "superseded":
        newest = current_version(db, draft)
        raise problem(
            409,
            f"Draft {draft.id} is version {draft.version} and was superseded; "
            f"act on the current version {newest.id} (v{newest.version})",
            title="Draft superseded",
        )


def confirm_draft(
    db: DbSession, actor: Actor, draft: Draft, *, note: str | None, now: str | None = None
) -> Draft:
    _require_current(db, draft)
    if draft.status != "draft":
        raise problem(409, f"Draft {draft.id} is {draft.status}, not draft", title="Cannot confirm")
    stamp = now or now_iso()
    draft.status = "confirmed"
    draft.status_changed_by = actor.id
    draft.status_changed_at = stamp
    if note:
        draft.note = note
    db.add(draft)
    db.flush()
    append_event(
        db,
        actor,
        "draft.confirmed",
        "draft",
        draft.id,
        {
            "domain": draft.domain,
            "session_id": draft.session_id,
            "note_id": draft.note_id,
            "source": draft.source,
            "note": note,
            "version": draft.version,
        },
        ts_utc=stamp,
    )
    return draft


def reject_draft(
    db: DbSession, actor: Actor, draft: Draft, *, reason: str, now: str | None = None
) -> Draft:
    _require_current(db, draft)
    if draft.status not in ("draft", "confirmed"):
        raise problem(409, f"Draft {draft.id} is {draft.status}", title="Cannot reject")
    stamp = now or now_iso()
    previous = draft.status
    draft.status = "rejected"
    draft.status_changed_by = actor.id
    draft.status_changed_at = stamp
    draft.note = reason
    db.add(draft)
    db.flush()
    append_event(
        db,
        actor,
        "draft.rejected",
        "draft",
        draft.id,
        {
            "domain": draft.domain,
            "session_id": draft.session_id,
            "note_id": draft.note_id,
            "source": draft.source,
            "reason": reason,
            "previous_status": previous,
            "version": draft.version,
        },
        ts_utc=stamp,
    )
    if draft.domain == "AE" and draft.ae_open_id and not draft.is_followup:
        close_open_ae(db, actor, draft.ae_open_id, f"AE draft {draft.id} rejected", stamp)
    return draft


def _new_version(
    db: DbSession,
    actor: Actor,
    draft: Draft,
    *,
    fields: Mapping[str, Any],
    evidence: Mapping[str, Any],
    status: str,
    note: str | None,
    stamp: str,
    new_id_value: str,
) -> Draft:
    row = Draft(
        id=new_id_value,
        lineage_id=draft.lineage_id,
        session_id=draft.session_id,
        note_id=draft.note_id,
        usubjid=draft.usubjid,
        domain=draft.domain,
        source=draft.source,
        version=draft.version + 1,
        status=status,
        fields_json=dump_json(fields),
        evidence_json=dump_json(evidence),
        linked_ae_open_id=draft.linked_ae_open_id,
        is_followup=draft.is_followup,
        ae_open_id=draft.ae_open_id,
        created_by=actor.id,
        created_at=stamp,
        supersedes_id=draft.id,
        note=note,
        status_changed_by=actor.id if status != "draft" else None,
        status_changed_at=stamp if status != "draft" else None,
    )
    draft.status = "superseded"
    draft.status_changed_by = actor.id
    draft.status_changed_at = stamp
    db.add(draft)
    db.add(row)
    db.flush()
    return row


def _diff(before: Mapping[str, Any], after: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        key: {"before": before.get(key), "after": after[key]}
        for key in after
        if before.get(key) != after[key]
    }


def edit_draft(
    db: DbSession,
    actor: Actor,
    draft: Draft,
    *,
    changes: Mapping[str, Any],
    note: str | None,
    now: str | None = None,
) -> Draft:
    """``PATCH /drafts/{id}``: a new ``draft`` version with the given field values."""
    _require_current(db, draft)
    if draft.status == "rejected":
        raise problem(
            409, f"Draft {draft.id} was rejected; it cannot be edited", title="Cannot edit"
        )
    before = load_json(draft.fields_json, {})
    unknown = [k for k in changes if k not in before]
    if unknown:
        raise problem(
            422,
            f"Unknown field(s) for a {draft.domain} record: {', '.join(unknown)}. "
            f"Editable fields: {', '.join(before)}",
            title="Unknown field",
        )
    protected = [k for k in changes if k in ("STUDYID", "USUBJID", "INTERIM_RECORD_SOURCE")]
    if protected:
        raise problem(422, f"{', '.join(protected)} cannot be edited", title="Protected field")
    # Same checks the mock EDC applies on the way out, enforced on the way in (strict types).
    bad_values = field_problems(changes)
    if bad_values:
        raise problem(
            422,
            "; ".join(bad_values),
            title="Invalid field value",
            errors=bad_values,
        )
    stamp = now or now_iso()
    after = dict(before)
    after.update(changes)
    diff = _diff(before, after)
    if not diff:
        raise problem(422, "No field value would change", title="Nothing to edit")
    new_version_id = new_id()
    event = append_event(
        db,
        actor,
        "draft.edited",
        "draft",
        draft.id,
        {
            "domain": draft.domain,
            "session_id": draft.session_id,
            "note_id": draft.note_id,
            "source": draft.source,
            "supersedes_id": draft.id,
            "new_version_id": new_version_id,
            "version": draft.version + 1,
            "diff": diff,
            "note": note,
        },
        ts_utc=stamp,
    )
    evidence: dict[str, Any] = load_json(draft.evidence_json, {})
    for key, change in diff.items():
        pointer = {
            "kind": "edit",
            "id": event.id,
            "ts": stamp,
            "note": (
                f"{key} edited by {actor.id} ({actor.role}): "
                f"{change['before']!r} -> {change['after']!r}" + (f"; note: {note}" if note else "")
            ),
        }
        evidence[key] = [*evidence.get(key, []), pointer]
    row = _new_version(
        db,
        actor,
        draft,
        fields=after,
        evidence=evidence,
        status="draft",
        note=note,
        stamp=stamp,
        new_id_value=new_version_id,
    )
    if draft.domain == "AE" and draft.ae_open_id:
        ended = after.get("AEONGO") == "N" or after.get("AEENDTC") not in (None, "")
        if ended:
            close_open_ae(db, actor, draft.ae_open_id, f"AE draft {row.id} marked ended", stamp)
    return row


def stop_sae_clock_for(
    db: DbSession,
    actor: Actor,
    *,
    session_id: str | None,
    note_id: str | None,
    decision: str,
    stamp: str,
) -> SAEClock | None:
    """Stop the running SAE clock of the draft's source (a check-in session or a chart
    note); the investigator's seriousness decision is what stops it (CLAUDE.md §3.4(f))."""
    stmt = select(SAEClock).where(SAEClock.stopped_at == None)  # noqa: E711
    if session_id is not None:
        stmt = stmt.where(SAEClock.session_id == session_id)
    elif note_id is not None:
        stmt = stmt.where(SAEClock.note_id == note_id)
    else:
        return None
    clock = db.exec(stmt).first()
    if clock is None:
        return None
    clock.stopped_at = stamp
    clock.stopped_by = actor.id
    clock.decision = decision
    db.add(clock)
    db.flush()
    append_event(
        db,
        actor,
        "sae_clock.stopped",
        "sae_clock",
        clock.id,
        {
            "session_id": clock.session_id,
            "note_id": clock.note_id,
            "usubjid": clock.usubjid,
            "decision": decision,
            "stopped_at": stamp,
            "due_at": clock.due_at,
            "within_24h": stamp <= clock.due_at,
        },
        ts_utc=stamp,
    )
    return clock


def stop_sae_clock_for_session(
    db: DbSession, actor: Actor, session_id: str | None, decision: str, stamp: str
) -> SAEClock | None:
    """Backwards-compatible wrapper around :func:`stop_sae_clock_for`."""
    return stop_sae_clock_for(
        db, actor, session_id=session_id, note_id=None, decision=decision, stamp=stamp
    )


def record_attribution(
    db: DbSession,
    actor: Actor,
    draft: Draft,
    *,
    aerel: str | None,
    aeser: str | None,
    note: str | None,
    now: str | None = None,
) -> Draft:
    """Investigator-only ``AEREL`` / ``AESER``; a new version that keeps the current status."""
    _require_current(db, draft)
    if draft.domain != "AE":
        raise problem(409, "Attribution applies to AE drafts only", title="Not an AE draft")
    if draft.status == "rejected":
        raise problem(409, f"Draft {draft.id} was rejected", title="Cannot attribute")
    if aerel is None and aeser is None:
        raise problem(422, "Provide AEREL and/or AESER", title="Nothing to record")
    stamp = now or now_iso()
    before = load_json(draft.fields_json, {})
    after = dict(before)
    if aerel is not None:
        after["AEREL"] = aerel
    if aeser is not None:
        after["AESER"] = aeser
    diff = _diff(before, after)
    new_version_id = new_id()
    event = append_event(
        db,
        actor,
        "draft.attribution",
        "draft",
        draft.id,
        {
            "session_id": draft.session_id,
            "note_id": draft.note_id,
            "source": draft.source,
            "supersedes_id": draft.id,
            "new_version_id": new_version_id,
            "version": draft.version + 1,
            "AEREL": aerel,
            "AESER": aeser,
            "diff": diff,
            "note": note,
        },
        ts_utc=stamp,
    )
    evidence: dict[str, Any] = load_json(draft.evidence_json, {})
    for key in diff:
        evidence[key] = [
            *evidence.get(key, []),
            {
                "kind": "edit",
                "id": event.id,
                "ts": stamp,
                "note": f"{key} recorded by investigator {actor.id}: {after[key]!r}"
                + (f"; note: {note}" if note else ""),
            },
        ]
    row = _new_version(
        db,
        actor,
        draft,
        fields=after,
        evidence=evidence,
        status=draft.status,
        note=note,
        stamp=stamp,
        new_id_value=new_version_id,
    )
    if aeser is not None:
        stop_sae_clock_for(
            db,
            actor,
            session_id=draft.session_id,
            note_id=draft.note_id,
            decision=f"AESER = {aeser}",
            stamp=stamp,
        )
    return row
