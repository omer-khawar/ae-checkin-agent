"""Read models for the coordinator dashboard: queue, check-in detail, timeline,
escalations, SAE clocks, pager log.

Everything here is read-only except ``ack_escalation``. The check-in detail
builds the ``evidence_index``: every evidence id that appears anywhere in the
stored result or the drafts, resolved to the row it points at (answer row,
vitals sample, rule firing, table file, or the audit event of a human edit),
so the dashboard can highlight the exact source of any field.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.tables import items

from ..audit import Actor, append_event
from ..models import (
    AEOpen,
    AuditEvent,
    ChartNote,
    Draft,
    Escalation,
    Page,
    Participant,
    SAEClock,
    Session,
    Study,
)
from ..problems import problem
from ..util import load_json, now_iso
from .calls import enrich_with_calls
from .checkins import log_clock_stopped, session_answers, session_samples
from .common import (
    ae_link,
    ae_open_to_dict,
    answer_to_dict,
    draft_to_dict,
    escalation_to_dict,
    page_to_dict,
    participant_to_dict,
    sample_to_dict,
    session_to_dict,
    tier_name,
)
from .notes import notes_for_participant, notes_with_context, timeline_note
from .packet_links import clock_rows, clocks_by_session, clocks_for_note, queue_clock_fields
from .participants import resolve_participant
from .plain import with_plain_language  # [briefs agent]

DOMAINS: tuple[str, ...] = ("AE", "VS", "CM")


def current_drafts(db: DbSession, session_ids: Iterable[str]) -> dict[str, list[Draft]]:
    """Current (non-superseded) draft rows grouped by session id."""
    ids = list(session_ids)
    out: dict[str, list[Draft]] = {sid: [] for sid in ids}
    if not ids:
        return out
    rows = db.exec(
        select(Draft).where(Draft.session_id.in_(ids)).where(Draft.status != "superseded")  # type: ignore[union-attr]
    ).all()
    for row in rows:
        out.setdefault(row.session_id or "", []).append(row)
    for sid in out:
        out[sid].sort(
            key=lambda d: (
                DOMAINS.index(d.domain) if d.domain in DOMAINS else 9,
                d.created_at,
                d.id,
            )
        )
    return out


def _status_summary(drafts: Sequence[Draft]) -> str:
    if not drafts:
        return "no drafts"
    counts: dict[str, int] = {}
    for d in drafts:
        counts[d.status] = counts.get(d.status, 0) + 1
    order = ("draft", "confirmed", "rejected")
    parts = [f"{counts[s]} {s}" for s in order if s in counts]
    return ", ".join(parts)


# --------------------------------------------------------------------------- #
# Queue
# --------------------------------------------------------------------------- #


def queue(
    db: DbSession,
    study: Study,
    *,
    usubjid: str | None,
    min_tier: int | None,
    status: str,
    include_eval: bool,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    stmt = select(Session, Participant).join(
        Participant,
        Participant.usubjid == Session.usubjid,  # type: ignore[arg-type]
    )
    stmt = stmt.where(Session.completed_at != None)  # noqa: E711
    if usubjid:
        participant = resolve_participant(db, study, usubjid)
        if participant is None:
            return {"items": [], "total": 0, "limit": limit, "offset": offset}
        stmt = stmt.where(Session.usubjid == participant.usubjid)
    if min_tier is not None:
        stmt = stmt.where(Session.tier >= min_tier)  # type: ignore[operator]
    if not include_eval:
        stmt = stmt.where(Session.is_eval == False)  # noqa: E712
    pairs = list(db.exec(stmt).all())
    session_ids = [s.id for s, _ in pairs]
    drafts = current_drafts(db, session_ids)
    escalations = (
        {
            e.session_id: e
            for e in db.exec(select(Escalation).where(Escalation.session_id.in_(session_ids))).all()  # type: ignore[union-attr]
        }
        if session_ids
        else {}
    )
    clocks = clocks_by_session(db, session_ids)  # [packets agent] SAE and AESI clocks

    rows: list[dict[str, Any]] = []
    for session, participant in pairs:
        session_drafts = drafts.get(session.id, [])
        escalation = escalations.get(session.id)
        session_clocks = clocks.get(session.id, [])
        is_open = any(d.status == "draft" for d in session_drafts) or (
            escalation is not None and escalation.acked_at is None
        )
        if status == "open" and not is_open:
            continue
        counts = {domain: 0 for domain in DOMAINS}
        for d in session_drafts:
            counts[d.domain] = counts.get(d.domain, 0) + 1
        rows.append(
            {
                "session_id": session.id,
                "note_id": None,
                "source": "check_in",
                "usubjid": session.usubjid,
                "display_label": participant.display_label,
                "completed_at": session.completed_at,
                "tier": session.tier if session.tier is not None else 0,
                "tier_name": tier_name(session.tier),
                "max_grade": session.max_grade if session.max_grade is not None else 0,
                "vitals_status": session.vitals_status,
                "is_measured": bool(session.is_measured),
                **queue_clock_fields(db, session_clocks),
                "escalation_acked": (escalation.acked_at is not None) if escalation else None,
                "escalation_id": escalation.id if escalation else None,
                "draft_counts": counts,
                "draft_status_summary": _status_summary(session_drafts),
                "is_open": is_open,
                "is_eval": session.is_eval,
                "stop_screen_shown": session.stop_screen_shown,
                "note_date": None,
                "note_type": None,
            }
        )
    rows.extend(
        _note_queue_rows(
            db, study, usubjid=usubjid, min_tier=min_tier, status=status, include_eval=include_eval
        )
    )
    # Tier desc, then newest first (a note's "completed_at" is when the site read it).
    rows.sort(
        key=lambda r: (str(r["completed_at"] or ""), str(r["session_id"] or r["note_id"])),
        reverse=True,
    )
    rows.sort(key=lambda r: int(r["tier"]), reverse=True)
    total = len(rows)
    return {
        "items": rows[offset : offset + limit],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def _note_queue_rows(
    db: DbSession,
    study: Study,
    *,
    usubjid: str | None,
    min_tier: int | None,
    status: str,
    include_eval: bool,
) -> list[dict[str, Any]]:
    """Queue rows for ingested chart notes (R2.4): ``session_id`` null, ``note_id`` set.

    A note has no vitals, so ``vitals_status`` is ``unavailable`` and ``is_measured``
    false; ``max_grade`` is the highest grade hint among its AE drafts; ``completed_at``
    is ``ingested_at`` so the shared sort and "when" column work for both sources.
    """
    stmt = select(ChartNote, Participant).join(
        Participant,
        Participant.usubjid == ChartNote.usubjid,  # type: ignore[arg-type]
    )
    if usubjid:
        participant = resolve_participant(db, study, usubjid)
        if participant is None:
            return []
        stmt = stmt.where(ChartNote.usubjid == participant.usubjid)
    if min_tier is not None:
        stmt = stmt.where(ChartNote.tier >= min_tier)  # type: ignore[operator]
    if not include_eval:
        stmt = stmt.where(Participant.is_eval == False)  # noqa: E712
    notes = [n for n, _ in db.exec(stmt).all()]
    rows: list[dict[str, Any]] = []
    for note, participant, note_drafts, escalation, _clock in notes_with_context(db, notes):
        is_open = any(d.status == "draft" for d in note_drafts) or (
            escalation is not None and escalation.acked_at is None
        )
        if status == "open" and not is_open:
            continue
        counts = {domain: 0 for domain in DOMAINS}
        grades: list[int] = []
        for d in note_drafts:
            counts[d.domain] = counts.get(d.domain, 0) + 1
            if d.domain == "AE":
                grade = load_json(d.fields_json, {}).get("AETOXGR")
                if isinstance(grade, int) and not isinstance(grade, bool):
                    grades.append(grade)
        rows.append(
            {
                "session_id": None,
                "note_id": note.id,
                "source": "chart_note",
                "usubjid": note.usubjid,
                "display_label": participant.display_label if participant else None,
                "completed_at": note.ingested_at,
                "tier": note.tier if note.tier is not None else 0,
                "tier_name": tier_name(note.tier),
                "max_grade": max(grades) if grades else 0,
                "vitals_status": "unavailable",
                "is_measured": False,
                **queue_clock_fields(db, clocks_for_note(db, note.id)),
                "escalation_acked": (escalation.acked_at is not None) if escalation else None,
                "escalation_id": escalation.id if escalation else None,
                "draft_counts": counts,
                "draft_status_summary": _status_summary(note_drafts),
                "is_open": is_open,
                "is_eval": bool(participant.is_eval) if participant else False,
                "stop_screen_shown": False,
                "note_date": note.note_date,
                "note_type": note.note_type,
            }
        )
    enrich_with_calls(db, rows, id_key="note_id")  # R4.1: source_label "phone_call" etc.
    return rows


# --------------------------------------------------------------------------- #
# Check-in detail
# --------------------------------------------------------------------------- #


def _walk_evidence(obj: Any, out: dict[str, dict[str, Any]]) -> None:
    """Collect every ``{kind, id, ts, note}`` evidence pointer in a nested structure."""
    if isinstance(obj, dict):
        if "kind" in obj and "id" in obj and "note" in obj and len(obj) <= 6:
            out.setdefault(str(obj["id"]), {k: obj.get(k) for k in ("kind", "id", "ts", "note")})
            return
        for value in obj.values():
            _walk_evidence(value, out)
    elif isinstance(obj, list):
        for value in obj:
            _walk_evidence(value, out)


def evidence_index(
    db: DbSession,
    session: Session,
    result: dict[str, Any],
    answers: Sequence[dict[str, Any]],
    samples: Sequence[dict[str, Any]],
    drafts: Sequence[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    pointers: dict[str, dict[str, Any]] = {}
    _walk_evidence(result, pointers)
    for d in drafts:
        _walk_evidence(d.get("evidence", {}), pointers)
    answers_by_id = {a["id"]: a for a in answers}
    samples_by_id = {s["id"]: s for s in samples}
    rules_by_id: dict[str, list[dict[str, Any]]] = {}
    for rule in result.get("rules_fired", []):
        rules_by_id.setdefault(str(rule["rule_id"]), []).append(rule)
    item_labels = {item.id: item.label for item in items()}

    index: dict[str, dict[str, Any]] = {}
    for key, pointer in pointers.items():
        entry: dict[str, Any] = dict(pointer)
        kind = pointer.get("kind")
        resolved = False
        if kind in ("pro_response", "gate_answer"):
            answer = answers_by_id.get(key)
            if answer is not None:
                entry["answer"] = answer
                entry["item_label"] = item_labels.get(answer["item_id"], answer["item_id"])
                resolved = True
        elif kind == "vitals_sample":
            sample = samples_by_id.get(key)
            if sample is not None:
                entry["sample"] = sample
                resolved = True
        elif kind == "rule":
            fired = rules_by_id.get(key, [])
            if fired:
                entry["rule"] = fired[0]
                entry["rules"] = fired
                resolved = True
        elif kind == "table":
            entry["table"] = {"file": key, "path": f"packages/rules/data/{key}"}
            resolved = True
        elif kind == "edit":
            event = db.get(AuditEvent, key)
            if event is not None:
                entry["audit_event"] = {
                    "id": event.id,
                    "seq": event.seq,
                    "ts_utc": event.ts_utc,
                    "actor_id": event.actor_id,
                    "actor_role": event.actor_role,
                    "action": event.action,
                    "payload": load_json(event.payload_json, {}),
                }
                resolved = True
        entry["resolved"] = resolved
        index[key] = entry
    return index


@with_plain_language  # [briefs agent] labels + rules_fired[].plain (R3.2)
def checkin_detail(db: DbSession, session: Session) -> dict[str, Any]:
    participant = db.get(Participant, session.usubjid)
    if participant is None:
        raise problem(
            404, f"Participant {session.usubjid} not found", title="Participant not found"
        )
    result: dict[str, Any] = load_json(session.result_json, {}) if session.result_json else {}
    answers = [answer_to_dict(a) for a in session_answers(db, session.id)]
    samples = [sample_to_dict(v) for v in session_samples(db, session.id)]
    draft_rows = current_drafts(db, [session.id]).get(session.id, [])
    drafts = [draft_to_dict(d) for d in draft_rows]
    escalation = db.exec(select(Escalation).where(Escalation.session_id == session.id)).first()
    # [packets agent] a session may carry a suspected-SAE clock and a possible-AESI clock.
    session_clocks = clocks_by_session(db, [session.id]).get(session.id, [])
    clock_dicts = clock_rows(db, session_clocks)
    sae_row = next((c for c in clock_dicts if c["kind"] == "sae"), None)
    aesi_row = next((c for c in clock_dicts if c["kind"] == "aesi"), None)
    vitals = result.get("vitals") or {}
    ae_links = [
        ae_link(d, db.get(AEOpen, d.linked_ae_open_id))
        for d in draft_rows
        if d.is_followup and d.linked_ae_open_id
    ]
    return {
        "session": session_to_dict(session),
        "participant": participant_to_dict(participant),
        "answers": answers,
        "vitals": {
            "samples": samples,
            "summary": vitals.get("summary"),
            "status": session.vitals_status,
            "assessment_status": vitals.get("status"),
            "ignored": vitals.get("ignored", []),
            "eligible_sample_ids": vitals.get("eligible_sample_ids", []),
        },
        "result": result,
        "drafts": drafts,
        "escalation": escalation_to_dict(escalation) if escalation else None,
        "sae_clock": sae_row,
        "aesi_clock": aesi_row,
        "clocks": clock_dicts,
        "protocol": result.get("protocol"),
        "ae_links": ae_links,
        "rules_fired": result.get("rules_fired", []),
        "why": result.get("why", []),
        "evidence_index": evidence_index(db, session, result, answers, samples, drafts),
        "settings": load_json(session.settings_json, None),
    }


# --------------------------------------------------------------------------- #
# Timeline
# --------------------------------------------------------------------------- #


def timeline(db: DbSession, participant: Participant) -> dict[str, Any]:
    sessions = sorted(
        db.exec(select(Session).where(Session.usubjid == participant.usubjid)).all(),
        key=lambda s: s.started_at,
    )
    symptom_series: dict[str, list[dict[str, Any]]] = {item.id: [] for item in items()}
    vitals_series: list[dict[str, Any]] = []
    for s in sessions:
        if not s.completed_at or not s.result_json:
            continue
        result = load_json(s.result_json, {})
        for item in result.get("items", []):
            symptom_series.setdefault(item["item_id"], []).append(
                {
                    "session_id": s.id,
                    "ts": s.completed_at,
                    "composite": item["composite"],
                    "grade": item["provisional_grade"],
                }
            )
        summary = (result.get("vitals") or {}).get("summary")
        vitals_series.append(
            {
                "session_id": s.id,
                "ts": s.completed_at,
                "pulse_median": summary.get("pulse_median") if summary else None,
                "breathing_median": summary.get("breathing_median") if summary else None,
                "hrv_median": summary.get("hrv_median") if summary else None,
                "is_measured": bool(summary.get("is_measured")) if summary else False,
                "source": summary.get("source") if summary else None,
                "vitals_status": s.vitals_status,
            }
        )
    open_aes = db.exec(
        select(AEOpen).where(AEOpen.usubjid == participant.usubjid).where(AEOpen.ongoing == True)  # noqa: E712
    ).all()
    cm_rows = db.exec(
        select(Draft)
        .where(Draft.usubjid == participant.usubjid)
        .where(Draft.domain == "CM")
        .where(Draft.status != "superseded")
    ).all()
    session_completed = {s.id: s.completed_at for s in sessions}
    note_rows = notes_for_participant(db, participant.usubjid)
    note_ingested = {n.id: n.ingested_at for n in note_rows}
    conmed_changes = []
    for d in cm_rows:
        f = load_json(d.fields_json, {})
        if d.session_id is not None:
            ts = session_completed.get(d.session_id) or d.created_at
        else:
            ts = note_ingested.get(d.note_id or "", d.created_at)
        conmed_changes.append(
            {
                "session_id": d.session_id,
                "note_id": d.note_id,
                "source": d.source,
                "draft_id": d.id,
                "status": d.status,
                "ts": ts,
                "cmtrt": f.get("CMTRT"),
                "cmdecod": f.get("CMDECOD"),
                "direction": f.get("INTERIM_DIRECTION"),
                "confidence": f.get("INTERIM_MATCH_CONFIDENCE", 0.0),
                "match_kind": f.get("INTERIM_MATCH_KIND"),
            }
        )
    conmed_changes.sort(key=lambda c: (str(c["ts"]), str(c["draft_id"])))
    notes = [
        timeline_note(note, drafts, escalation, clock)
        for note, _, drafts, escalation, clock in notes_with_context(db, note_rows)
    ]
    enrich_with_calls(db, notes)  # R4.1: source_label, caller, call_direction
    for note_dict in notes:  # [integration] the participant is known; label every note
        if not note_dict.get("display_label"):
            note_dict["display_label"] = participant.display_label
    person = participant_to_dict(participant)
    return {
        "participant": person,
        # [seed agent] Synthea baseline (docs/ISSUES #23), labelled simulated; null if none.
        "baseline": person["baseline"],
        "sessions": [session_to_dict(s) for s in sessions],
        "symptom_series": symptom_series,
        "vitals_series": vitals_series,
        "open_aes": [ae_open_to_dict(a) for a in open_aes],
        "conmed_changes": conmed_changes,
        "notes": notes,
    }


# --------------------------------------------------------------------------- #
# Escalations, SAE clocks, pages
# --------------------------------------------------------------------------- #


def list_escalations(
    db: DbSession,
    *,
    acked: bool | None,
    usubjid: str | None,
    limit: int,
    offset: int,
    include_eval: bool = False,
) -> dict[str, Any]:
    """Escalations, highest tier first. Eval-harness rows (participant ``is_eval``) are
    hidden unless ``include_eval``, like the queue: an eval run must not leave
    never-acknowledged ``EVAL-*`` rows on the Escalations page."""
    stmt = select(Escalation).join(
        Participant,
        Participant.usubjid == Escalation.usubjid,  # type: ignore[arg-type]
    )
    if acked is True:
        stmt = stmt.where(Escalation.acked_at != None)  # noqa: E711
    elif acked is False:
        stmt = stmt.where(Escalation.acked_at == None)  # noqa: E711
    if usubjid:
        stmt = stmt.where(Escalation.usubjid == usubjid)
    if not include_eval:
        stmt = stmt.where(Participant.is_eval == False)  # noqa: E712
    # Highest tier first, newest first within a tier.
    rows = sorted(db.exec(stmt).all(), key=lambda e: e.created_at, reverse=True)
    rows.sort(key=lambda e: e.tier, reverse=True)
    return {
        "items": [
            with_vitals_provenance(db, escalation_to_dict(e)) for e in rows[offset : offset + limit]
        ],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }


def with_vitals_provenance(db: DbSession, row: dict[str, Any]) -> dict[str, Any]:
    """[integration] ``vitals_is_measured`` on an escalation whose tier a vitals
    corroboration rule raised: ``True`` = a real sensor, ``False`` = simulated (the
    admin "treat simulated as measured" toggle does not make a sample measured).
    ``None`` when vitals played no part (chart notes, no corroboration), so the page
    never puts a MEASURED/SIMULATED word next to an escalation vitals did not touch."""
    row["vitals_is_measured"] = None
    session = db.get(Session, row["session_id"]) if row.get("session_id") else None
    if session is None or not session.result_json:
        return row
    result = load_json(session.result_json, {}) or {}
    fired = {str(r.get("rule_id", "")) for r in result.get("rules_fired", []) or []}
    if any(rule_id.startswith("corr.") for rule_id in fired):
        row["vitals_is_measured"] = bool(session.is_measured)
    return row


def ack_escalation(
    db: DbSession, actor: Actor, escalation_id: str, *, note: str | None, now: str | None = None
) -> Escalation:
    row = db.get(Escalation, escalation_id)
    if row is None:
        raise problem(404, f"No escalation with id {escalation_id}", title="Escalation not found")
    if row.acked_at is not None:
        raise problem(
            409,
            f"Escalation {row.id} was acknowledged by {row.acked_by} at {row.acked_at}",
            title="Already acknowledged",
        )
    stamp = now or now_iso()
    row.acked_by = actor.id
    row.acked_at = stamp
    db.add(row)
    db.flush()
    append_event(
        db,
        actor,
        "escalation.acked",
        "escalation",
        row.id,
        {
            "tier": row.tier,
            "session_id": row.session_id,
            "note_id": row.note_id,
            "source": row.source,
            "usubjid": row.usubjid,
            "acked_at": stamp,
            "seconds_to_ack": escalation_to_dict(row)["seconds_to_ack"],
            "note": note,
        },
        ts_utc=stamp,
    )
    return row


def list_sae_clocks(
    db: DbSession,
    *,
    active: bool | None,
    limit: int,
    offset: int,
    now: str | None = None,
    include_eval: bool = False,
) -> dict[str, Any]:
    """SAE clocks, soonest due first; eval-harness clocks hidden unless ``include_eval``."""
    stmt = select(SAEClock).join(
        Participant,
        Participant.usubjid == SAEClock.usubjid,  # type: ignore[arg-type]
    )
    if active is True:
        stmt = stmt.where(SAEClock.stopped_at == None)  # noqa: E711
    elif active is False:
        stmt = stmt.where(SAEClock.stopped_at != None)  # noqa: E711
    if not include_eval:
        stmt = stmt.where(Participant.is_eval == False)  # noqa: E712
    rows = sorted(db.exec(stmt).all(), key=lambda c: c.due_at)
    reference = now or now_iso()
    return {
        # [packets agent] rows carry kind, packet_id, ae_draft_ids, has_ae_draft (R3.2 / R4.3)
        "items": clock_rows(db, rows[offset : offset + limit], now=reference),
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }


def stop_sae_clock(
    db: DbSession,
    actor: Actor,
    clock_id: str,
    *,
    decision: str,
    note: str | None,
    now: str | None = None,
) -> SAEClock:
    """``PATCH /sae-clocks/{id}/stop``: an investigator records a seriousness decision
    directly on the clock (D-023).

    The usual stop path is ``PATCH /drafts/{id}/attribution`` with ``AESER``, which
    stops the clock of the draft's source. A hospitalization/ER cue with no symptom
    finding (a note saying "admitted overnight after a fall", or a kiosk check-in
    answering Yes to the hospital question with every item at zero) starts a clock
    but drafts no AE, so there would be nothing to attribute and the clock could
    never stop. This endpoint closes that gap; the decision is still the
    investigator's and is audited as ``sae_clock.stopped`` exactly like the
    attribution path.
    """
    row = db.get(SAEClock, clock_id)
    if row is None:
        raise problem(404, f"No SAE clock with id {clock_id}", title="SAE clock not found")
    if row.stopped_at is not None:
        raise problem(
            409,
            f"SAE clock {row.id} was stopped by {row.stopped_by} at {row.stopped_at} "
            f"({row.decision})",
            title="Already stopped",
        )
    stamp = now or now_iso()
    row.stopped_at = stamp
    row.stopped_by = actor.id
    row.decision = decision
    db.add(row)
    db.flush()
    log_clock_stopped(
        db,
        actor,
        row,
        {
            "session_id": row.session_id,
            "note_id": row.note_id,
            "usubjid": row.usubjid,
            "decision": decision,
            "note": note,
            "stopped_at": stamp,
            "due_at": row.due_at,
            "within_24h": stamp <= row.due_at,
            "path": "sae_clock.stop",
        },
        stamp,
    )
    return row


def list_pages(
    db: DbSession, *, limit: int, offset: int, include_eval: bool = False
) -> dict[str, Any]:
    """The mock pager log, newest first; eval-harness pages hidden unless ``include_eval``."""
    stmt = select(Page).join(Participant, Participant.usubjid == Page.usubjid)  # type: ignore[arg-type]
    if not include_eval:
        stmt = stmt.where(Participant.is_eval == False)  # noqa: E712
    rows = sorted(db.exec(stmt).all(), key=lambda p: p.ts, reverse=True)
    return {
        "items": [page_to_dict(p) for p in rows[offset : offset + limit]],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }
