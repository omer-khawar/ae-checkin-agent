"""Sponsor queries (CONTRACTS.md R4.4, CLAUDE.md §00 step 7).

After a site posts records to the EDC, the sponsor's data manager runs edit checks and sends
a *query* back for every failure; the coordinator answers each one. This module is the
stateful half of that loop; the deterministic half is ``interim_rules.queries``:

* **Raising.** :func:`run_checks_for_edc_post` runs ``run_edit_checks`` over the confirmed
  records a ``POST /mock-edc/{domain}`` just accepted (the "sponsor side"), and
  :func:`run_checks_on_confirmed` re-runs every check over every confirmed record
  (``POST /queries/run-checks``, admin). Each failure becomes one :class:`SponsorQuery`
  row unless an **open or answered** query already exists for the same
  ``(check_id, record lineage, field)``: a re-run never duplicates a live query, and a
  closed one may be raised again when the data still fails. An admin acting as the
  sponsor's monitor raises manual queries with :func:`raise_manual_query`.
* **Answering.** :func:`answer_query` stores the coordinator's text, the evidence ids it
  cites (resolved against the query, the record and the suggestion), and optionally
  corrects the record through the existing edit path (``services.drafts.edit_draft``: a
  new draft version, audited ``draft.edited``). ``answered_from_suggestion`` is true when
  the answer equals or starts with the template writer's suggested answer; the time-saved
  metric counts those (R4.4 "Time saved").
* **Suggested answer.** ``interim_rules.queries.suggest_answer`` (template writer,
  ``writer = "template"``) from ``answer_facts`` built out of the current record version
  and its evidence. No LLM is called here.

Audit: ``query.raised`` (edit-check queries carry the ``edit-check`` system actor and the
person who triggered the run in the payload), ``query.answered``, ``query.closed``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules import plain_language
from interim_rules.queries import (
    QueryCandidate,
    QueryContext,
    answer_facts,
    check_by_id,
    run_edit_checks,
    suggest_answer,
)

from .. import models
from ..audit import Actor, append_event
from ..models import Draft, Participant, SAEClock, SponsorQuery, User
from ..problems import problem
from ..util import dump_json, load_json, new_id, now_iso, seconds_between
from .common import draft_to_dict, get_draft_or_404
from .drafts import current_version, edit_draft

EDIT_CHECK_ACTOR = Actor(id="edit-check", role="system")
"""Who raises an edit-check query in the audit log (the person who triggered the run is in
the payload as ``triggered_by``)."""

STATUSES: tuple[str, ...] = ("open", "answered", "closed")
LIVE_STATUSES: tuple[str, ...] = ("open", "answered")
SEVERITIES: tuple[str, ...] = ("data", "safety")
DOMAINS: tuple[str, ...] = ("AE", "VS", "CM")
_FIELD_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,39}$")
_SPACES = re.compile(r"\s+")


# --------------------------------------------------------------------------- #
# Serialization
# --------------------------------------------------------------------------- #


def _age_hours(q: SponsorQuery, now: str) -> float:
    end = q.closed_at or now
    return round(max(seconds_between(q.raised_at, end), 0.0) / 3600.0, 1)


def query_to_dict(
    q: SponsorQuery,
    *,
    display_label: str | None = None,
    current_draft_id: str | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    """The contract's ``Query`` row plus display extras the web page reads."""
    stamp = now or now_iso()
    hours_to_answer = (
        round(max(seconds_between(q.raised_at, q.answered_at), 0.0) / 3600.0, 1)
        if q.answered_at
        else None
    )
    return {
        "id": q.id,
        "check_id": q.check_id,
        "check_sentence": (plain_language.rule_sentence(q.check_id) if q.check_id else None),
        "domain": q.domain,
        "domain_label": plain_language.domain_name(q.domain),
        "draft_id": q.draft_id,
        "lineage_id": q.lineage_id,
        "current_draft_id": current_draft_id or q.draft_id,
        "usubjid": q.usubjid,
        "display_label": display_label,
        "field": q.field,
        "field_label": plain_language.label(q.field),
        "fields": load_json(q.fields_json, []) or [q.field],
        "text": q.text,
        "severity": q.severity,
        "status": q.status,
        "raised_by": q.raised_by,
        "raised_at": q.raised_at,
        "trigger": q.trigger,
        "edc_ack_id": q.edc_ack_id,
        "age_hours": _age_hours(q, stamp),
        "hours_to_answer": hours_to_answer,
        "evidence": load_json(q.evidence_json, []),
        "answer_text": q.answer_text,
        "answer_evidence": load_json(q.answer_evidence_json, []),
        "answered_by": q.answered_by,
        "answered_at": q.answered_at,
        "answered_from_suggestion": q.answered_from_suggestion,
        "answer_edit_draft_id": q.answer_edit_draft_id,
        "closed_by": q.closed_by,
        "closed_at": q.closed_at,
        "close_note": q.close_note,
    }


def get_query_or_404(db: DbSession, query_id: str) -> SponsorQuery:
    row = db.get(SponsorQuery, query_id)
    if row is None:
        raise problem(404, f"No query with id {query_id}", title="Query not found")
    return row


def _labels(db: DbSession, usubjids: Iterable[str]) -> dict[str, str]:
    ids = sorted(set(usubjids))
    if not ids:
        return {}
    rows = db.exec(select(Participant).where(Participant.usubjid.in_(ids))).all()  # type: ignore[attr-defined]
    return {p.usubjid: p.display_label for p in rows}


def _current_ids(db: DbSession, lineage_ids: Iterable[str]) -> dict[str, str]:
    """``lineage_id -> id`` of the newest version of each lineage."""
    ids = sorted(set(lineage_ids))
    if not ids:
        return {}
    rows = db.exec(select(Draft).where(Draft.lineage_id.in_(ids))).all()  # type: ignore[attr-defined]
    newest: dict[str, Draft] = {}
    for row in rows:
        best = newest.get(row.lineage_id)
        if best is None or row.version > best.version:
            newest[row.lineage_id] = row
    return {k: v.id for k, v in newest.items()}


# --------------------------------------------------------------------------- #
# Edit-check context (signed packets, investigator notes)
# --------------------------------------------------------------------------- #


def _record_keys(drafts: Iterable[Draft]) -> set[str]:
    keys: set[str] = set()
    for d in drafts:
        keys.update(k for k in (d.id, d.lineage_id, d.ae_open_id) if k)
    return keys


def _signed_packet_keys(db: DbSession) -> frozenset[str]:
    """Record keys of AE drafts whose serious-event packet is signed.

    A packet (packets track, ``models.Packet``) belongs to a 24-hour clock; the clock to a
    check-in session or a chart note; the AE drafts of that source are the ones the report
    covers. Read defensively so this module works with or without the packets table.
    """
    packet_cls = getattr(models, "Packet", None)
    if packet_cls is None:
        return frozenset()
    signed = [p for p in db.exec(select(packet_cls)).all() if getattr(p, "status", "") == "signed"]
    if not signed:
        return frozenset()
    session_ids: set[str] = set()
    note_ids: set[str] = set()
    for packet in signed:
        sid, nid = getattr(packet, "session_id", None), getattr(packet, "note_id", None)
        if not sid and not nid:
            clock = db.get(SAEClock, getattr(packet, "clock_id", "") or "")
            if clock is not None:
                sid, nid = clock.session_id, clock.note_id
        if sid:
            session_ids.add(sid)
        if nid:
            note_ids.add(nid)
    drafts: list[Draft] = []
    if session_ids:
        drafts += db.exec(
            select(Draft).where(Draft.domain == "AE").where(Draft.session_id.in_(session_ids))  # type: ignore[union-attr]
        ).all()
    if note_ids:
        drafts += db.exec(
            select(Draft).where(Draft.domain == "AE").where(Draft.note_id.in_(note_ids))  # type: ignore[union-attr]
        ).all()
    return frozenset(_record_keys(drafts))


def _noted_record_keys(db: DbSession) -> frozenset[str]:
    """Record keys whose lineage has a version carrying an investigator's note."""
    investigators = {
        u.username for u in db.exec(select(User).where(User.role == "investigator")).all()
    }
    if not investigators:
        return frozenset()
    rows = db.exec(select(Draft).where(Draft.created_by.in_(investigators))).all()  # type: ignore[attr-defined]
    noted_lineages = {r.lineage_id for r in rows if (r.note or "").strip()}
    confirmed = db.exec(select(Draft).where(Draft.status_changed_by.in_(investigators))).all()  # type: ignore[union-attr]
    noted_lineages |= {r.lineage_id for r in confirmed if (r.note or "").strip()}
    if not noted_lineages:
        return frozenset()
    lineage_rows = db.exec(select(Draft).where(Draft.lineage_id.in_(noted_lineages))).all()  # type: ignore[attr-defined]
    return frozenset(_record_keys(lineage_rows))


def edit_check_context(db: DbSession) -> QueryContext:
    return QueryContext(
        signed_packet_keys=_signed_packet_keys(db), noted_record_keys=_noted_record_keys(db)
    )


# --------------------------------------------------------------------------- #
# Raising
# --------------------------------------------------------------------------- #


def _record(draft: Draft, fields: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The rules package's record shape: the draft dict, optionally with posted fields."""
    record = draft_to_dict(draft)
    if fields is not None:
        record["fields"] = dict(fields)
    return record


def _live_query(db: DbSession, check_id: str, lineage_id: str, field: str) -> SponsorQuery | None:
    return db.exec(
        select(SponsorQuery)
        .where(SponsorQuery.check_id == check_id)
        .where(SponsorQuery.lineage_id == lineage_id)
        .where(SponsorQuery.field == field)
        .where(SponsorQuery.status.in_(LIVE_STATUSES))  # type: ignore[attr-defined]
    ).first()


def _raise_candidates(
    db: DbSession,
    triggered_by: Actor,
    candidates: Sequence[QueryCandidate],
    drafts: Mapping[str, Draft],
    *,
    trigger: str,
    edc_ack_id: str | None,
    stamp: str,
) -> tuple[list[SponsorQuery], list[str]]:
    """Insert one query per new candidate; returns ``(raised, ids of live duplicates)``."""
    raised: list[SponsorQuery] = []
    duplicates: list[str] = []
    for cand in candidates:
        draft = drafts.get(cand.record_key)
        if draft is None:
            continue
        existing = _live_query(db, cand.check_id, draft.lineage_id, cand.field)
        if existing is not None:
            duplicates.append(existing.id)
            continue
        row = SponsorQuery(
            id=new_id(),
            check_id=cand.check_id,
            domain=cand.domain,
            draft_id=draft.id,
            lineage_id=draft.lineage_id,
            usubjid=draft.usubjid,
            field=cand.field,
            text=cand.text,
            severity=cand.severity,
            status="open",
            raised_by=EDIT_CHECK_ACTOR.id,
            raised_at=stamp,
            trigger=trigger,
            edc_ack_id=edc_ack_id,
            evidence_json=dump_json([e.to_dict() for e in cand.evidence]),
            fields_json=dump_json(list(cand.fields or (cand.field,))),
        )
        db.add(row)
        db.flush()
        append_event(
            db,
            EDIT_CHECK_ACTOR,
            "query.raised",
            "query",
            row.id,
            {
                "check_id": cand.check_id,
                "domain": cand.domain,
                "draft_id": draft.id,
                "lineage_id": draft.lineage_id,
                "usubjid": draft.usubjid,
                "field": cand.field,
                "severity": cand.severity,
                "text": cand.text,
                "trigger": trigger,
                "edc_ack_id": edc_ack_id,
                "triggered_by": triggered_by.id,
                "triggered_by_role": triggered_by.role,
                "statement": "Raised by a deterministic edit check (interim_rules.queries, "
                "edit_checks.json); a check asks a person to look and never changes a record.",
            },
            ts_utc=stamp,
        )
        raised.append(row)
    return raised, duplicates


def _summary(
    raised: Sequence[SponsorQuery], duplicates: Sequence[str], checked: int, **extra: Any
) -> dict[str, Any]:
    return {
        "records_checked": checked,
        "raised": len(raised),
        "raised_ids": [q.id for q in raised],
        "already_open": len(set(duplicates)),
        "already_open_ids": sorted(set(duplicates)),
        **extra,
    }


def _eval_usubjids(db: DbSession) -> set[str]:
    return {
        p.usubjid
        for p in db.exec(select(Participant).where(Participant.is_eval == True)).all()  # noqa: E712
    }


def run_checks_on_confirmed(
    db: DbSession,
    actor: Actor,
    *,
    domains: Sequence[str] | None = None,
    include_eval: bool = False,
    now: str | None = None,
) -> dict[str, Any]:
    """``POST /queries/run-checks``: every check over every current confirmed record."""
    stamp = now or now_iso()
    wanted = [d for d in (domains or DOMAINS) if d in DOMAINS]
    rows = list(
        db.exec(
            select(Draft).where(Draft.status == "confirmed").where(Draft.domain.in_(wanted))  # type: ignore[attr-defined]
        ).all()
    )
    if not include_eval:
        hidden = _eval_usubjids(db)
        rows = [r for r in rows if r.usubjid not in hidden]
    rows.sort(key=lambda d: (d.usubjid, d.domain, d.created_at, d.id))
    drafts = {d.id: d for d in rows}
    candidates = run_edit_checks([_record(d) for d in rows], edit_check_context(db))
    raised, duplicates = _raise_candidates(
        db, actor, candidates, drafts, trigger="run_checks", edc_ack_id=None, stamp=stamp
    )
    return _summary(
        raised,
        duplicates,
        len(rows),
        domains=wanted,
        failures=len(candidates),
        ran_at=stamp,
        queries=[query_to_dict(q, now=stamp) for q in raised],
    )


def run_checks_for_edc_post(
    db: DbSession,
    actor: Actor,
    domain: str,
    records: Sequence[Mapping[str, Any]],
    *,
    ack_id: str,
    now: str | None = None,
) -> dict[str, Any]:
    """The sponsor side of ``POST /mock-edc/{domain}``: edit checks on what was received.

    A record is checked when its ``INTERIM_DRAFT_ID`` names a confirmed draft (the checks
    read the **posted** field values and cite that draft's evidence); records without a
    resolvable draft id, or naming an unconfirmed draft, are counted and skipped. A malformed
    record never fails the post: the acknowledgment stands and the problem is reported.
    """
    stamp = now or now_iso()
    drafts: dict[str, Draft] = {}
    to_check: list[dict[str, Any]] = []
    skipped_unlinked = 0
    skipped_not_confirmed = 0
    for record in records:
        draft_id = record.get("INTERIM_DRAFT_ID")
        draft = db.get(Draft, str(draft_id)) if draft_id else None
        if draft is None or draft.domain != domain:
            skipped_unlinked += 1
            continue
        if draft.status != "confirmed":
            skipped_not_confirmed += 1
            continue
        drafts[draft.id] = draft
        to_check.append(_record(draft, record))
    try:
        candidates = run_edit_checks(to_check, edit_check_context(db))
    except ValueError as exc:
        return _summary(
            [],
            [],
            len(to_check),
            error=str(exc),
            skipped_unlinked=skipped_unlinked,
            skipped_not_confirmed=skipped_not_confirmed,
        )
    raised, duplicates = _raise_candidates(
        db, actor, candidates, drafts, trigger="mock_edc", edc_ack_id=ack_id, stamp=stamp
    )
    return _summary(
        raised,
        duplicates,
        len(to_check),
        failures=len(candidates),
        skipped_unlinked=skipped_unlinked,
        skipped_not_confirmed=skipped_not_confirmed,
    )


def _field_known(draft: Draft, field: str) -> bool:
    from .exports import SDTM_VARIABLES  # local import: exports imports this module lazily

    fields = load_json(draft.fields_json, {})
    return (
        field in fields
        or field in SDTM_VARIABLES.get(draft.domain, ())
        or plain_language.has_label(field)
    )


def raise_manual_query(
    db: DbSession,
    actor: Actor,
    *,
    draft_id: str,
    field: str,
    text: str,
    severity: str,
    now: str | None = None,
) -> SponsorQuery:
    """``POST /queries``: the sponsor's monitor (an admin here) asks about one field."""
    stamp = now or now_iso()
    draft = current_version(db, get_draft_or_404(db, draft_id))
    if draft.status == "rejected":
        raise problem(409, f"Draft {draft.id} was rejected; nothing to query", title="Rejected")
    name = field.strip()
    if not _FIELD_NAME.match(name) or not _field_known(draft, name):
        raise problem(
            422,
            f"{field!r} is not a field of a {draft.domain} record",
            title="Unknown field",
        )
    if not text.strip():
        raise problem(422, "text must not be blank", title="Empty query")
    evidence = load_json(draft.evidence_json, {}).get(name, [])
    row = SponsorQuery(
        id=new_id(),
        check_id=None,
        domain=draft.domain,
        draft_id=draft.id,
        lineage_id=draft.lineage_id,
        usubjid=draft.usubjid,
        field=name,
        text=text.strip(),
        severity=severity,
        status="open",
        raised_by=actor.id,
        raised_at=stamp,
        trigger="manual",
        evidence_json=dump_json(evidence),
        fields_json=dump_json([name]),
    )
    db.add(row)
    db.flush()
    append_event(
        db,
        actor,
        "query.raised",
        "query",
        row.id,
        {
            "check_id": None,
            "domain": draft.domain,
            "draft_id": draft.id,
            "lineage_id": draft.lineage_id,
            "usubjid": draft.usubjid,
            "field": name,
            "severity": severity,
            "text": row.text,
            "trigger": "manual",
            "statement": "Raised by a person acting as the sponsor's monitor.",
        },
        ts_utc=stamp,
    )
    return row


# --------------------------------------------------------------------------- #
# Suggested answer, detail
# --------------------------------------------------------------------------- #


def _rules_view(q: SponsorQuery) -> dict[str, Any]:
    return {
        "check_id": q.check_id,
        "field": q.field,
        "fields": load_json(q.fields_json, []) or [q.field],
        "evidence": load_json(q.evidence_json, []),
    }


def _packet_extra(db: DbSession, draft: Draft) -> list[dict[str, Any]]:
    """A fact about the serious-event packet of the record's source, when one exists."""
    packet_cls = getattr(models, "Packet", None)
    if packet_cls is None or draft.domain != "AE":
        return []
    rows = [
        p
        for p in db.exec(select(packet_cls)).all()
        if (draft.session_id and getattr(p, "session_id", None) == draft.session_id)
        or (draft.note_id and getattr(p, "note_id", None) == draft.note_id)
    ]
    if not rows:
        return []
    latest = max(rows, key=lambda p: (getattr(p, "sequence", 0), getattr(p, "created_at", "")))
    status = str(getattr(latest, "status", "draft"))
    when = getattr(latest, "signed_at", None) if status == "signed" else None
    value = f"{status} {when[:10]}" if when else status
    return [{"label": "Serious-event report", "value": value, "evidence_ids": [latest.id]}]


def suggested_answer_for(db: DbSession, q: SponsorQuery) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(WrittenText dict, evidence index)`` for the query's current record version."""
    base = db.get(Draft, q.draft_id)
    if base is None:
        empty = {"kind": "query_answer", "writer": "template", "sentences": [], "text": ""}
        return empty, {}
    draft = current_version(db, base)
    record = draft_to_dict(draft)
    extra = _packet_extra(db, draft)
    view = _rules_view(q)
    try:
        facts = answer_facts(view, record, extra)  # type: ignore[arg-type]
        written = suggest_answer(view, facts)
    except ValueError as exc:
        written = {
            "kind": "query_answer",
            "writer": "template",
            "sentences": [],
            "text": "",
            "fallback_reason": f"no suggestion: {exc}",
        }
    index: dict[str, Any] = {}
    for pointer in view["evidence"]:
        index.setdefault(str(pointer.get("id")), pointer)
    for pointers in record.get("evidence", {}).values():
        for pointer in pointers:
            index.setdefault(str(pointer.get("id")), pointer)
    for item in extra:
        for ident in item["evidence_ids"]:
            index.setdefault(
                ident, {"kind": "packet", "id": ident, "ts": None, "note": item["value"]}
            )
    return written, index


def query_detail(db: DbSession, q: SponsorQuery, *, now: str | None = None) -> dict[str, Any]:
    """``GET /queries/{id}``: the row, its record now, and the suggested answer."""
    base = db.get(Draft, q.draft_id)
    current = current_version(db, base) if base is not None else None
    labels = _labels(db, [q.usubjid])
    out = query_to_dict(
        q,
        display_label=labels.get(q.usubjid),
        current_draft_id=current.id if current else None,
        now=now,
    )
    written, index = suggested_answer_for(db, q)
    current_dict = draft_to_dict(current) if current is not None else None
    out.update(
        {
            "suggested_answer": written if written.get("sentences") else None,
            "suggestion_fallback_reason": written.get("fallback_reason"),
            "draft": current_dict,
            "current_value": (current_dict or {}).get("fields", {}).get(q.field),
            "record_label": _record_label(current_dict),
            "check": _check_info(q.check_id),
            "evidence_index": index,
        }
    )
    return out


def _record_label(record: Mapping[str, Any] | None) -> str | None:
    if not record:
        return None
    fields = record.get("fields", {})
    term = {"AE": "AETERM", "CM": "CMTRT", "VS": "VSTESTCD"}.get(str(record.get("domain")))
    value = fields.get(term) if term else None
    return f"{plain_language.domain_name(str(record.get('domain')))}: {value}" if value else None


def _check_info(check_id: str | None) -> dict[str, Any] | None:
    if not check_id:
        return None
    check = check_by_id(check_id)
    if check is None:
        return {"id": check_id}
    ref = check.protocol_ref
    return {
        "id": check.id,
        "plain": plain_language.rule_sentence(check.id),
        "rationale": check.rationale,
        "source": check.source,
        "protocol_ref": (
            None if ref is None else {"section": ref.section, "printed_page": ref.printed_page}
        ),
        "quote": check.quote,
    }


# --------------------------------------------------------------------------- #
# Listing
# --------------------------------------------------------------------------- #


def list_queries(
    db: DbSession,
    *,
    status: str | None,
    usubjid: str | None,
    domain: str | None,
    severity: str | None,
    check_id: str | None,
    draft_id: str | None,
    include_eval: bool,
    limit: int,
    offset: int,
    now: str | None = None,
) -> dict[str, Any]:
    """``GET /queries``: safety first, then oldest first; ``counts`` per status."""
    from .common import get_study
    from .participants import resolve_participant

    stamp = now or now_iso()
    stmt = select(SponsorQuery)
    if usubjid:
        participant = resolve_participant(db, get_study(db), usubjid)
        if participant is None:
            empty = dict.fromkeys(STATUSES, 0)
            return {"items": [], "total": 0, "limit": limit, "offset": offset, "counts": empty}
        stmt = stmt.where(SponsorQuery.usubjid == participant.usubjid)
    if domain:
        stmt = stmt.where(SponsorQuery.domain == domain)
    if severity:
        stmt = stmt.where(SponsorQuery.severity == severity)
    if check_id:
        stmt = stmt.where(SponsorQuery.check_id == check_id)
    if draft_id:
        draft = db.get(Draft, draft_id)
        lineage = draft.lineage_id if draft is not None else draft_id
        stmt = stmt.where(SponsorQuery.lineage_id == lineage)
    rows = list(db.exec(stmt).all())
    if not include_eval:
        hidden = _eval_usubjids(db)
        rows = [r for r in rows if r.usubjid not in hidden]
    counts = dict.fromkeys(STATUSES, 0)
    for r in rows:
        counts[r.status] = counts.get(r.status, 0) + 1
    if status and status != "all":
        rows = [r for r in rows if r.status == status]
    rows.sort(key=lambda r: (0 if r.severity == "safety" else 1, r.raised_at, r.id))
    page = rows[offset : offset + limit]
    labels = _labels(db, (r.usubjid for r in page))
    current = _current_ids(db, (r.lineage_id for r in page))
    return {
        "items": [
            query_to_dict(
                r,
                display_label=labels.get(r.usubjid),
                current_draft_id=current.get(r.lineage_id),
                now=stamp,
            )
            for r in page
        ],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "counts": counts,
    }


# --------------------------------------------------------------------------- #
# Answer, close
# --------------------------------------------------------------------------- #


def _norm(text: str) -> str:
    return _SPACES.sub(" ", text).strip()


def from_suggestion(answer_text: str, suggestion_text: str) -> bool:
    """True when the answer equals, or starts from, the suggested answer (whitespace-blind)."""
    suggestion = _norm(suggestion_text)
    return bool(suggestion) and _norm(answer_text).startswith(suggestion)


def _resolve_evidence(
    ids: Sequence[str], index: Mapping[str, Any], extra: Mapping[str, Any]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    unknown: list[str] = []
    for ident in dict.fromkeys(i for i in ids if i):
        pointer = index.get(ident) or extra.get(ident)
        if pointer is None:
            unknown.append(ident)
            continue
        out.append({k: pointer.get(k) for k in ("kind", "id", "ts", "note")})
    if unknown:
        raise problem(
            422,
            f"Unknown evidence id(s): {', '.join(unknown)}. Cite ids from the query, its "
            "record or the suggested answer.",
            title="Unknown evidence",
        )
    return out


def answer_query(
    db: DbSession,
    actor: Actor,
    q: SponsorQuery,
    *,
    answer_text: str,
    evidence_ids: Sequence[str] | None,
    also_edit: Mapping[str, Any] | None,
    now: str | None = None,
) -> SponsorQuery:
    """``POST /queries/{id}/answer``: store the answer; optionally correct the record."""
    stamp = now or now_iso()
    if q.status != "open":
        raise problem(409, f"Query {q.id} is {q.status}, not open", title="Cannot answer")
    text = answer_text.strip()
    if not text:
        raise problem(422, "answer_text must not be blank", title="Empty answer")
    written, index = suggested_answer_for(db, q)
    suggestion_text = str(written.get("text") or "")
    used_suggestion = from_suggestion(text, suggestion_text)

    edit_row: Draft | None = None
    edit_pointer: dict[str, Any] = {}
    if also_edit:
        base = db.get(Draft, q.draft_id)
        if base is None:
            raise problem(409, f"The record of query {q.id} no longer exists", title="No record")
        target = current_version(db, base)
        field = str(also_edit.get("field") or "").strip()
        if not field:
            raise problem(422, "also_edit.field is required", title="Invalid edit")
        allowed_new = [f for f in load_json(q.fields_json, []) or [q.field] if f]
        if field not in allowed_new and field != q.field and not _field_known(target, field):
            raise problem(422, f"{field!r} cannot be set on this record", title="Invalid edit")
        edit_row = edit_draft(
            db,
            actor,
            target,
            changes={field: also_edit.get("value")},
            note=f"Correction in answer to sponsor query {q.id}",
            now=stamp,
            allow_new_fields=[*allowed_new, q.field],
        )
        edit_pointer = {
            edit_row.id: {
                "kind": "draft_version",
                "id": edit_row.id,
                "ts": stamp,
                "note": f"{field} set to {also_edit.get('value')!r} (version {edit_row.version})",
            }
        }

    if evidence_ids is None:
        cited = (
            [
                ident
                for sentence in written.get("sentences", [])
                for ident in sentence.get("evidence_ids", [])
            ]
            if used_suggestion
            else []
        )
    else:
        cited = list(evidence_ids)
    evidence = _resolve_evidence(cited, index, {})
    evidence += list(edit_pointer.values())

    q.status = "answered"
    q.answer_text = text
    q.answer_evidence_json = dump_json(evidence)
    q.answered_by = actor.id
    q.answered_at = stamp
    q.answered_from_suggestion = used_suggestion
    q.answer_edit_draft_id = edit_row.id if edit_row is not None else None
    db.add(q)
    db.flush()
    append_event(
        db,
        actor,
        "query.answered",
        "query",
        q.id,
        {
            "check_id": q.check_id,
            "draft_id": q.draft_id,
            "field": q.field,
            "answer_text": text,
            "evidence_ids": [e["id"] for e in evidence],
            "answered_from_suggestion": used_suggestion,
            "suggestion_writer": written.get("writer"),
            "edit_draft_id": q.answer_edit_draft_id,
        },
        ts_utc=stamp,
    )
    return q


def close_query(
    db: DbSession, actor: Actor, q: SponsorQuery, *, note: str | None, now: str | None = None
) -> SponsorQuery:
    """``POST /queries/{id}/close``: the sponsor accepts the answer (or withdraws the query)."""
    stamp = now or now_iso()
    if q.status == "closed":
        raise problem(409, f"Query {q.id} is already closed", title="Cannot close")
    previous = q.status
    q.status = "closed"
    q.closed_by = actor.id
    q.closed_at = stamp
    q.close_note = (note or "").strip() or None
    db.add(q)
    db.flush()
    append_event(
        db,
        actor,
        "query.closed",
        "query",
        q.id,
        {
            "check_id": q.check_id,
            "draft_id": q.draft_id,
            "field": q.field,
            "previous_status": previous,
            "note": q.close_note,
        },
        ts_utc=stamp,
    )
    return q


__all__ = [
    "EDIT_CHECK_ACTOR",
    "answer_query",
    "close_query",
    "edit_check_context",
    "from_suggestion",
    "get_query_or_404",
    "list_queries",
    "query_detail",
    "query_to_dict",
    "raise_manual_query",
    "run_checks_for_edc_post",
    "run_checks_on_confirmed",
    "suggested_answer_for",
]
