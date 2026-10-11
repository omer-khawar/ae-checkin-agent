"""Visit-prep brief (CLAUDE.md §00.4, CONTRACTS.md R3.2): everything since the last visit.

``GET /participants/{usubjid}/brief?since=YYYY-MM-DD`` returns one page per participant::

    {usubjid, display_label, since, since_basis, generated_at, next_visit,
     sections: [{key, title, items: [{text, evidence_ids, link, ...extensions}]}],
     narrative: WrittenText, questions_to_ask: [{text, evidence_ids, link, kind}],
     evidence: {id: {kind, ts, note, link, resolved}}, counts, footer}

How it is built:

* **Facts, not prose.** The service reads rows (check-ins, chart notes and calls, drafts,
  open AEs, escalations, reporting clocks, vitals summaries, packets and sponsor queries
  when those features exist) and turns them into the fact bundle of
  ``interim_rules.narrative.BriefFacts``. Every fact cites the ids of the rows it came
  from. **Every line of text** on the brief, section items and questions included, is
  written by the template writer (``narrative.write("visit_brief", ...)``) from one fact
  at a time, so the page never says anything the writer could not cite.
* **Decisions stay in the rules engine.** Protocol flags of a medication come from
  ``interim_rules.protocol.classify_conmed``; still-missing CM fields from
  ``interim_rules.protocol.cm_missing_fields`` (minus fields a person has since filled);
  questions from ``narrative.derive_questions`` plus one per open sponsor query.
* **Evidence resolves.** ``evidence`` maps every id the page cites to the row it points at
  (``kind`` in ``participant | visit | session | draft | pro_response | gate_answer |
  chart_note | phone_call | ae_open | escalation | clock | packet | query``) with a web
  route in ``link``; the tests check that every cited id is in the map and every map entry
  was read from the database.
* **Cut-off.** ``since`` (``YYYY-MM-DD``) when given; else the participant's latest
  completed visit on or before today (``ParticipantVisit``); else 14 days back. Check-ins
  count by completion time, notes and calls by the time the site ingested them,
  escalations by creation time; open AEs and running clocks are shown whatever their age.

Generating a brief is an audit event (``brief.generated``), and the time-saved metric
counts one brief per participant and cut-off.
"""

from __future__ import annotations

import html
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, timedelta
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules import narrative
from interim_rules.models import GateAnswers
from interim_rules.plain_language import field_labels, tier_name
from interim_rules.protocol import classify_conmed, cm_missing_fields
from interim_rules.tables import items

from .. import models
from ..audit import Actor, append_event
from ..models import (
    AEOpen,
    Answer,
    ChartNote,
    Draft,
    Escalation,
    Participant,
    ParticipantVisit,
    SAEClock,
    Session,
)
from ..problems import problem
from ..settings import Settings
from ..util import load_json, new_id, now_iso, seconds_between
from .baseline import SYNTHEA_LABEL, baseline_view

DEFAULT_LOOKBACK_DAYS = 14
"""Cut-off when no visit is recorded (product default, not a clinical number)."""

FOOTER = (
    "Interim is a research data-capture tool. It is not a medical device and does not "
    "provide medical advice."
)
SYNTHETIC_NOTE = "All participants are synthetic."

SECTION_ORDER: tuple[tuple[str, str], ...] = (
    ("new_side_effects", "New side effects"),
    ("open_aes", "Open adverse events"),
    ("medication_changes", "Medication changes"),
    ("escalations_and_clocks", "Escalations and 24-hour reporting clocks"),
    ("notes_and_calls", "Chart notes and phone calls"),
    ("vitals_context", "Vitals context"),
)
SECTION_TITLES: dict[str, str] = dict(SECTION_ORDER)

# Template ids of the writer's per-fact sentences (``narrative_templates.json``).
_TPL = {
    "new_side_effects": "visit_brief.new_side_effect",
    "open_aes": "visit_brief.open_ae",
    "med_changes": "visit_brief.med_change",
    "escalations": "visit_brief.escalation",
    "clocks": "visit_brief.clock",
    "notes": "visit_brief.note",
    "vitals": "visit_brief.vitals",
    "questions": "visit_brief.question",
}
_DIRECTIONS = {"started": "started", "stopped": "stopped", "taking": "taking"}
_NOTE_TYPE_WORDS = {
    "phone_call": "phone call",
    "phone_note": "phone note",
    "ed_note": "emergency department note",
    "progress_note": "progress note",
    "outside_record": "outside record",
}


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _day(ts: str | None) -> str | None:
    return ts[:10] if ts else None


def checkin_link(session_id: str) -> str:
    return f"/dashboard/checkins/{session_id}"


def note_link(note_id: str) -> str:
    return f"/dashboard/notes/{note_id}"


def timeline_link(usubjid: str) -> str:
    return f"/dashboard/participants/{usubjid}"


def brief_link(usubjid: str) -> str:
    return f"/dashboard/participants/{usubjid}/brief"


def _is_filled(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list | tuple | dict):
        return bool(value)
    return True


def _lower_first(text: str) -> str:
    return text[:1].lower() + text[1:] if text else text


def parse_since(value: str | None) -> str | None:
    """``YYYY-MM-DD`` (a full ISO timestamp is cut to its date) or 422."""
    if value is None or not value.strip():
        return None
    text = value.strip()
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError as exc:
        raise problem(
            422, f"since must be a date YYYY-MM-DD, got {value!r}", title="Invalid since"
        ) from exc


class _Evidence:
    """Every id the brief cites, with what it points at (the ``evidence`` map)."""

    def __init__(self) -> None:
        self.refs: dict[str, dict[str, Any]] = {}

    def add(
        self,
        ident: str,
        kind: str,
        *,
        ts: str | None = None,
        note: str | None = None,
        link: str | None = None,
    ) -> str:
        if ident not in self.refs:
            self.refs[ident] = {
                "kind": kind,
                "ts": ts,
                "note": note,
                "link": link,
                "resolved": True,
            }
        return ident

    def link_of(self, ident: str) -> str | None:
        ref = self.refs.get(ident)
        return ref.get("link") if ref else None


def _write_one(key: str, fact: Mapping[str, Any] | None, extra: Mapping[str, Any] | None = None):
    """Render one fact (or an empty list when ``fact`` is None) with the template writer.

    Returns ``(text, evidence_ids)`` of the sentence(s) for that fact, or ``None``.
    """
    facts: dict[str, Any] = {"questions": []} if key != "questions" else {}
    facts.update(extra or {})
    if key == "vitals":
        facts["vitals"] = fact
    else:
        facts[key] = [] if fact is None else [fact]
    written = narrative.write("visit_brief", facts)
    wanted = _TPL[key]
    sentences = [s for s in written.sentences if s.template_id == wanted]
    if not sentences:
        return None
    ids: list[str] = []
    for s in sentences:
        ids.extend(i for i in s.evidence_ids if i not in ids)
    return " ".join(s.text for s in sentences), ids


# --------------------------------------------------------------------------- #
# Cut-off and visits
# --------------------------------------------------------------------------- #


def visits_for(db: DbSession, usubjid: str) -> list[ParticipantVisit]:
    rows = db.exec(select(ParticipantVisit).where(ParticipantVisit.usubjid == usubjid)).all()
    return sorted(rows, key=lambda v: (v.visit_date, v.recorded_at, v.id))


def visit_to_dict(v: ParticipantVisit) -> dict[str, Any]:
    return {
        "id": v.id,
        "usubjid": v.usubjid,
        "visit_date": v.visit_date,
        "status": v.status,
        "label": v.label,
        "recorded_by": v.recorded_by,
        "recorded_at": v.recorded_at,
    }


def record_visit(
    db: DbSession,
    actor: Actor,
    participant: Participant,
    *,
    visit_date: str,
    status: str,
    label: str | None,
    now: str | None = None,
) -> ParticipantVisit:
    stamp = now or now_iso()
    day = parse_since(visit_date)
    if day is None:
        raise problem(422, "visit_date is required", title="Invalid visit")
    row = ParticipantVisit(
        id=new_id(),
        usubjid=participant.usubjid,
        visit_date=day,
        status=status,
        label=label,
        recorded_by=actor.id,
        recorded_at=stamp,
    )
    db.add(row)
    db.flush()
    append_event(
        db,
        actor,
        "visit.recorded",
        "participant",
        participant.usubjid,
        {"visit_id": row.id, "visit_date": day, "status": status, "label": label},
        ts_utc=stamp,
    )
    return row


def resolve_cutoff(
    db: DbSession, participant: Participant, since: str | None, *, today: str
) -> tuple[str, str, ParticipantVisit | None, ParticipantVisit | None]:
    """``(since, basis, previous_visit, next_visit)``; basis ``requested | previous_visit |
    default_lookback``."""
    visits = visits_for(db, participant.usubjid)
    previous = [v for v in visits if v.status == "completed" and v.visit_date <= today]
    upcoming = [v for v in visits if v.status == "scheduled" and v.visit_date >= today]
    nxt = upcoming[0] if upcoming else None
    requested = parse_since(since)
    if requested is not None:
        return requested, "requested", None, nxt
    if previous:
        return previous[-1].visit_date, "previous_visit", previous[-1], nxt
    fallback = (date.fromisoformat(today) - timedelta(days=DEFAULT_LOOKBACK_DAYS)).isoformat()
    return fallback, "default_lookback", None, nxt


# --------------------------------------------------------------------------- #
# Reading the record
# --------------------------------------------------------------------------- #


class _Record:
    """The participant's rows, read once."""

    def __init__(self, db: DbSession, participant: Participant, since_ts: str) -> None:
        usubjid = participant.usubjid
        self.db = db
        self.participant = participant
        self.since_ts = since_ts
        self.sessions = sorted(
            (
                s
                for s in db.exec(select(Session).where(Session.usubjid == usubjid)).all()
                if s.completed_at
            ),
            key=lambda s: (s.completed_at or "", s.id),
        )
        self.notes = sorted(
            db.exec(select(ChartNote).where(ChartNote.usubjid == usubjid)).all(),
            key=lambda n: (n.ingested_at, n.id),
        )
        self.session_by_id = {s.id: s for s in self.sessions}
        self.note_by_id = {n.id: n for n in self.notes}
        self.drafts = [
            d
            for d in db.exec(select(Draft).where(Draft.usubjid == usubjid)).all()
            if d.status != "superseded"
        ]
        self.window_sessions = [s for s in self.sessions if (s.completed_at or "") >= since_ts]
        self.window_notes = [n for n in self.notes if n.ingested_at >= since_ts]
        self.call_meta = self._calls()

    def _calls(self) -> dict[str, Any]:
        call_cls = getattr(models, "ChartNoteCall", None)
        if call_cls is None or not self.notes:
            return {}
        ids = [n.id for n in self.notes]
        rows = self.db.exec(select(call_cls).where(call_cls.note_id.in_(ids))).all()  # type: ignore[attr-defined]
        return {r.note_id: r for r in rows}

    def source_ts(self, d: Draft) -> str:
        if d.session_id and d.session_id in self.session_by_id:
            return self.session_by_id[d.session_id].completed_at or d.created_at
        if d.note_id and d.note_id in self.note_by_id:
            return self.note_by_id[d.note_id].ingested_at
        return d.created_at

    def in_window(self, d: Draft) -> bool:
        return self.source_ts(d) >= self.since_ts

    def source_link(self, session_id: str | None, note_id: str | None) -> str:
        if session_id:
            return checkin_link(session_id)
        if note_id:
            return note_link(note_id)
        return timeline_link(self.participant.usubjid)

    def note_kind(self, note: ChartNote) -> str:
        return "phone_call" if note.note_type == "phone_call" else "chart_note"


def _register_source(ev: _Evidence, rec: _Record, d: Draft) -> str:
    """Register the check-in or note a draft came from; returns its id."""
    if d.session_id and d.session_id in rec.session_by_id:
        s = rec.session_by_id[d.session_id]
        return ev.add(s.id, "session", ts=s.completed_at, note="Check-in", link=checkin_link(s.id))
    if d.note_id and d.note_id in rec.note_by_id:
        n = rec.note_by_id[d.note_id]
        return ev.add(
            n.id, rec.note_kind(n), ts=n.ingested_at, note=n.note_type, link=note_link(n.id)
        )
    return ""


def _register_draft(ev: _Evidence, rec: _Record, d: Draft, note: str) -> str:
    return ev.add(
        d.id,
        "draft",
        ts=rec.source_ts(d),
        note=f"{d.domain} record v{d.version} ({d.status}): {note}",
        link=rec.source_link(d.session_id, d.note_id),
    )


def _field_evidence(ev: _Evidence, rec: _Record, d: Draft, field: str) -> list[str]:
    """Answer rows / notes behind one draft field that exist in the database."""
    out: list[str] = []
    pointers = (load_json(d.evidence_json, {}) or {}).get(field) or []
    for p in pointers:
        if not isinstance(p, Mapping):
            continue
        kind, ident = p.get("kind"), p.get("id")
        if not isinstance(ident, str):
            continue
        if kind in ("pro_response", "gate_answer"):
            answer = rec.db.get(Answer, ident)
            if answer is not None:
                value = answer.value_text if answer.value_text is not None else answer.value_int
                out.append(
                    ev.add(
                        ident,
                        str(kind),
                        ts=answer.ts_server,
                        note=f"{answer.item_id}.{answer.attribute} = {value}",
                        link=checkin_link(answer.session_id),
                    )
                )
        elif kind == "chart_note" and ident in rec.note_by_id:
            n = rec.note_by_id[ident]
            out.append(
                ev.add(
                    ident,
                    rec.note_kind(n),
                    ts=n.ingested_at,
                    note=n.note_type,
                    link=note_link(ident),
                )
            )
    return out


# --------------------------------------------------------------------------- #
# Sections
# --------------------------------------------------------------------------- #

_ITEM_BY_TERM = {i.ctcae_term: i for i in items()}


def _plain_term(term: str) -> str:
    item = _ITEM_BY_TERM.get(term)
    return _lower_first(item.label) if item is not None else term.lower()


def _grade(value: Any) -> int | None:
    try:
        return int(value) if value is not None and str(value).strip() != "" else None
    except (TypeError, ValueError):
        return None


def _new_side_effects(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    """One fact per standard term reported in the window, with its provisional grade trend."""
    groups: dict[str, list[Draft]] = {}
    for d in rec.drafts:
        if d.domain != "AE" or d.status == "rejected" or not rec.in_window(d):
            continue
        fields = load_json(d.fields_json, {}) or {}
        term = str(fields.get("AEDECOD") or fields.get("AETERM") or "").strip()
        if term:
            groups.setdefault(term, []).append(d)
    facts: list[dict[str, Any]] = []
    for term, drafts in groups.items():
        drafts.sort(key=lambda d: (rec.source_ts(d), d.id))
        points: list[dict[str, Any]] = []
        all_ids: list[str] = []
        latest = drafts[-1]
        seen_sessions = {d.session_id for d in drafts if d.session_id}
        for d in drafts:
            fields = load_json(d.fields_json, {}) or {}
            ids = [_register_draft(ev, rec, d, f"{term}, grade {fields.get('AETOXGR')}")]
            ids += _field_evidence(ev, rec, d, "AETOXGR")
            all_ids += [i for i in ids if i not in all_ids]
            grade = _grade(fields.get("AETOXGR"))
            if grade is not None:
                points.append({"grade": grade, "date": _day(rec.source_ts(d)), "evidence_ids": ids})
        # A later check-in in the window that scored the same item at grade 0 shows improvement.
        item = _ITEM_BY_TERM.get(term)
        if item is not None:
            first_ts = rec.source_ts(drafts[0])
            for s in rec.window_sessions:
                if s.id in seen_sessions or (s.completed_at or "") <= first_ts:
                    continue
                result = load_json(s.result_json, {}) or {}
                scored = [r for r in result.get("items", []) if r.get("item_id") == item.id]
                if not scored or scored[0].get("provisional_grade") != 0:
                    continue
                answers = [
                    a
                    for a in rec.db.exec(select(Answer).where(Answer.session_id == s.id)).all()
                    if a.item_id == item.id
                ]
                ids = [
                    ev.add(
                        a.id,
                        "pro_response",
                        ts=a.ts_server,
                        note=f"{a.item_id}.{a.attribute} = {a.value_int}",
                        link=checkin_link(s.id),
                    )
                    for a in answers
                ]
                if ids:
                    points.append({"grade": 0, "date": _day(s.completed_at), "evidence_ids": ids})
                    all_ids += [i for i in ids if i not in all_ids]
        points.sort(key=lambda p: p["date"] or "")
        facts.append(
            {
                "term": term,
                "plain_label": _plain_term(term),
                "grades": points,
                "evidence_ids": all_ids,
                "_link": rec.source_link(latest.session_id, latest.note_id),
                "_ts": rec.source_ts(latest),
            }
        )
    facts.sort(key=lambda f: (f["_ts"], f["term"]))
    return facts


def _open_aes(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    rows = rec.db.exec(
        select(AEOpen)
        .where(AEOpen.usubjid == rec.participant.usubjid)
        .where(AEOpen.ongoing == True)  # noqa: E712
    ).all()
    facts: list[dict[str, Any]] = []
    for a in sorted(rows, key=lambda r: (r.first_reported_at, r.id)):
        link = rec.source_link(a.first_session_id, a.first_note_id)
        ids = [
            ev.add(
                a.id,
                "ae_open",
                ts=a.first_reported_at,
                note=f"Open AE {a.aedecod} since {a.first_reported_at}",
                link=link,
            )
        ]
        linked = [
            d
            for d in rec.drafts
            if d.domain == "AE"
            and d.status != "rejected"
            and a.id in (d.ae_open_id, d.linked_ae_open_id)
        ]
        linked.sort(key=lambda d: (rec.source_ts(d), d.id))
        status = None
        if linked:
            latest = linked[-1]
            status = latest.status
            ids.append(_register_draft(ev, rec, latest, a.aedecod))
        facts.append(
            {
                "term": a.aedecod,
                "plain_label": _plain_term(a.aedecod),
                "onset": a.first_reported_at,
                "last_reported": a.last_reported_at,
                "ongoing": True,
                "evidence_ids": ids,
                "_link": link,
                "_ts": a.last_reported_at,
                "_record_status": status,
            }
        )
    return facts


def _missing_cm_fields(fields: Mapping[str, Any]) -> list[str]:
    """Protocol-required CM fields still empty (rules: ``protocol.cm_missing_fields``)."""
    direction = fields.get("INTERIM_DIRECTION")
    gate_direction = direction if direction in ("started", "stopped", "both") else None
    gates = GateAnswers(
        hospitalization=False,
        hospitalization_answer_id=None,
        conmed_changed=True,
        conmed_text=str(fields.get("CMTRT") or "") or None,
        conmed_direction=gate_direction,
        conmed_answer_id=None,
        other_text=None,
        other_answer_id=None,
        temp_c=None,
        temp_answer_id=None,
    )
    return [f for f in cm_missing_fields(gates) if not _is_filled(fields.get(f))]


def _med_changes(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    rows = [
        d for d in rec.drafts if d.domain == "CM" and d.status != "rejected" and rec.in_window(d)
    ]
    for d in sorted(rows, key=lambda d: (rec.source_ts(d), d.id)):
        fields = load_json(d.fields_json, {}) or {}
        name = str(fields.get("CMTRT") or fields.get("CMDECOD") or "").strip()
        if not name:
            continue
        raw_direction = str(fields.get("INTERIM_DIRECTION") or "").strip()
        direction = _DIRECTIONS.get(raw_direction, "changed")
        ids = [_register_draft(ev, rec, d, name)] + _field_evidence(ev, rec, d, "CMTRT")
        fact: dict[str, Any] = {
            "name": name,
            "direction": direction,
            "evidence_ids": ids,
            "_link": rec.source_link(d.session_id, d.note_id),
            "_ts": rec.source_ts(d),
            "_record_status": d.status,
        }
        when = fields.get("CMENDTC") if direction == "stopped" else fields.get("CMSTDTC")
        if _is_filled(when):
            fact["date"] = str(when)[:10]
        flags, _notes = classify_conmed(name, fields.get("CMDECOD") or None)
        stored_level = fields.get("INTERIM_PROTOCOL_FLAG")
        chosen = next((f for f in flags if f.level == stored_level), flags[0] if flags else None)
        if chosen is not None:
            fact["protocol_flag"] = chosen.level
            fact["protocol_section"] = chosen.protocol_ref.section
            fact["printed_page"] = chosen.protocol_ref.printed_page
            if chosen.exception_text:
                fact["exception_text"] = chosen.exception_text
        missing = _missing_cm_fields(fields)
        if missing:
            fact["missing_fields"] = missing
        facts.append(fact)
    return facts


def _escalations(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    rows = rec.db.exec(
        select(Escalation).where(Escalation.usubjid == rec.participant.usubjid)
    ).all()
    facts: list[dict[str, Any]] = []
    for e in sorted(rows, key=lambda r: (r.created_at, r.id)):
        if e.created_at < rec.since_ts and e.acked_at is not None:
            continue
        link = rec.source_link(e.session_id, e.note_id)
        reasons = load_json(e.reasons_json, []) or []
        ident = ev.add(
            e.id,
            "escalation",
            ts=e.created_at,
            note=f"Tier {e.tier}: " + "; ".join(str(r) for r in reasons)[:300],
            link=link,
        )
        fact: dict[str, Any] = {
            "tier": e.tier,
            "tier_name": tier_name(e.tier),
            "date": e.created_at,
            "acknowledged": e.acked_at is not None,
            "evidence_ids": [ident],
            "_link": link,
            "_ts": e.created_at,
            "_reasons": reasons,
        }
        if e.acked_at:
            fact["acknowledged_at"] = e.acked_at
        facts.append(fact)
    return facts


def _packet_for_clock(db: DbSession, clock_id: str) -> Any | None:
    packet_cls = getattr(models, "Packet", None)
    if packet_cls is None or not hasattr(packet_cls, "clock_id"):
        return None
    rows = db.exec(select(packet_cls).where(packet_cls.clock_id == clock_id)).all()  # type: ignore[attr-defined]
    if not rows:
        return None
    return sorted(
        rows, key=lambda p: (getattr(p, "sequence", 0) or 0, getattr(p, "created_at", ""))
    )[-1]


def _clock_event_label(rec: _Record, c: SAEClock, kind: str) -> str:
    drafts = [
        d
        for d in rec.drafts
        if d.domain == "AE"
        and d.status != "rejected"
        and (
            (c.session_id and d.session_id == c.session_id)
            or (c.note_id and d.note_id == c.note_id)
        )
    ]
    terms: list[str] = []
    for d in drafts:
        fields = load_json(d.fields_json, {}) or {}
        if kind == "aesi" and not fields.get("INTERIM_AESI_SUSPECTED"):
            continue
        term = _plain_term(str(fields.get("AEDECOD") or fields.get("AETERM") or ""))
        if term and term not in terms:
            terms.append(term)
    if terms:
        return ", ".join(terms)
    if c.note_id and c.note_id in rec.note_by_id:
        n = rec.note_by_id[c.note_id]
        return f"the {_note_type_words(n.note_type)} of {n.note_date}"
    return "the hospital or emergency-room visit reported at the check-in"


def _clocks(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    rows = rec.db.exec(select(SAEClock).where(SAEClock.usubjid == rec.participant.usubjid)).all()
    facts: list[dict[str, Any]] = []
    for c in sorted(rows, key=lambda r: (r.site_awareness_at, r.id)):
        if c.site_awareness_at < rec.since_ts and c.stopped_at is not None:
            continue
        kind = str(getattr(c, "kind", None) or "sae")
        if kind not in ("sae", "aesi"):
            kind = "sae"
        if c.stopped_at is None:
            status = "running"
        elif (c.decision or "").strip() == "reported (mock)":
            status = "reported (mock)"
        else:
            status = "stopped"
        packet = _packet_for_clock(rec.db, c.id)
        link = (
            f"/dashboard/packets/{packet.id}"
            if packet is not None
            else rec.source_link(c.session_id, c.note_id)
        )
        ids = [
            ev.add(
                c.id,
                "clock",
                ts=c.site_awareness_at,
                note=f"{kind.upper()} clock: aware {c.site_awareness_at}, due {c.due_at}",
                link=link,
            )
        ]
        if packet is not None:
            ids.append(
                ev.add(
                    packet.id,
                    "packet",
                    ts=getattr(packet, "created_at", None),
                    note=f"Report packet ({getattr(packet, 'status', 'draft')})",
                    link=f"/dashboard/packets/{packet.id}",
                )
            )
        hours = round(seconds_between(c.site_awareness_at, c.due_at) / 3600.0, 2)
        facts.append(
            {
                "kind": kind,
                "event_label": _clock_event_label(rec, c, kind),
                "hours": hours,
                "due_at": c.due_at,
                "status": status,
                "evidence_ids": ids,
                "_link": link,
                "_ts": c.site_awareness_at,
                "_packet_status": getattr(packet, "status", None) if packet is not None else None,
                "_packet_id": packet.id if packet is not None else None,
            }
        )
    return facts


def _note_type_words(note_type: str) -> str:
    return _NOTE_TYPE_WORDS.get(note_type, note_type.replace("_", " "))


def _notes(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    for n in rec.window_notes:
        scan = (load_json(n.scan_json, {}) or {}).get("scan") or {}
        kind = rec.note_kind(n)
        ident = ev.add(n.id, kind, ts=n.ingested_at, note=n.note_type, link=note_link(n.id))
        words = _note_type_words(n.note_type)
        call = rec.call_meta.get(n.id)
        if call is not None:
            extras = [
                x
                for x in (getattr(call, "caller", None), getattr(call, "call_direction", None))
                if x
            ]
            if extras:
                words = f"{words} ({', '.join(extras)})"
        facts.append(
            {
                "note_type": words,
                "note_date": n.note_date,
                "author": n.author,
                "n_symptoms": len(scan.get("symptoms") or []),
                "n_meds": len(scan.get("meds") or []),
                "evidence_ids": [ident],
                "_link": note_link(n.id),
                "_ts": n.ingested_at,
                "_raw_type": n.note_type,
            }
        )
    return facts


def _vitals(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    for s in rec.window_sessions:
        summary = ((load_json(s.result_json, {}) or {}).get("vitals") or {}).get("summary") or {}
        pulse, breathing = summary.get("pulse_median"), summary.get("breathing_median")
        if pulse is None and breathing is None:
            continue
        measured = bool(summary.get("is_measured"))
        ident = ev.add(
            s.id,
            "session",
            ts=s.completed_at,
            note=f"Check-in vitals summary ({'measured' if measured else 'simulated'})",
            link=checkin_link(s.id),
        )
        fact: dict[str, Any] = {
            "is_measured": measured,
            "source": str(summary.get("source") or "unknown source"),
            "date": s.completed_at,
            "evidence_ids": [ident],
            "_link": checkin_link(s.id),
            "_ts": s.completed_at,
        }
        if pulse is not None:
            fact["pulse_median"] = round(float(pulse), 1)
        if breathing is not None:
            fact["breathing_median"] = round(float(breathing), 1)
        facts.append(fact)
    return facts


def _open_queries(ev: _Evidence, rec: _Record) -> list[dict[str, Any]]:
    """One ``other`` question per open sponsor query (when the queries feature exists)."""
    query_cls = getattr(models, "SponsorQuery", None) or getattr(models, "Query", None)
    if query_cls is None or not hasattr(query_cls, "usubjid"):
        return []
    rows = rec.db.exec(select(query_cls).where(query_cls.usubjid == rec.participant.usubjid)).all()  # type: ignore[attr-defined]
    out: list[dict[str, Any]] = []
    labels = field_labels([str(getattr(q, "field", "")) for q in rows])
    for q in sorted(rows, key=lambda r: (getattr(r, "raised_at", ""), r.id)):
        if getattr(q, "status", None) != "open":
            continue
        ident = ev.add(
            q.id,
            "query",
            ts=getattr(q, "raised_at", None),
            note=str(getattr(q, "text", ""))[:300],
            link="/dashboard/queries",
        )
        field = str(getattr(q, "field", ""))
        out.append(
            {
                "kind": "other",
                "subject": f"the details needed to answer the open data query on "
                f"{labels.get(field, field).lower()}",
                "details": [],
                "evidence_ids": [ident],
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #


def _public(fact: Mapping[str, Any]) -> dict[str, Any]:
    """The fact without the service's private ``_`` keys (what the writer sees)."""
    return {k: v for k, v in fact.items() if not k.startswith("_")}


def _item(
    key: str, fact: Mapping[str, Any], *, extra: Mapping[str, Any] | None = None, **ext: Any
) -> dict[str, Any] | None:
    rendered = _write_one(key, _public(fact), extra)
    if rendered is None:
        return None
    text, ids = rendered
    out: dict[str, Any] = {"text": text, "evidence_ids": ids, "link": fact.get("_link")}
    out.update({k: v for k, v in ext.items() if v is not None})
    return out


def _empty_item(key: str, since_fact: Mapping[str, Any], link: str) -> dict[str, Any] | None:
    rendered = _write_one(key, None, {"since": since_fact})
    if rendered is None:
        return None
    text, ids = rendered
    return {"text": text, "evidence_ids": ids, "link": link, "empty": True}


def _narrative(facts: Mapping[str, Any], settings: Settings | None) -> dict[str, Any]:
    """The narrative: the template writer, or the shared writer selection when configured.

    ``interim_api.writers.write_text`` (CLAUDE.md §00.3) returns the template text unless
    ``ANTHROPIC_API_KEY`` is set; an LLM text is accepted only when
    ``narrative.validate_written`` passes, else the template text comes back with
    ``fallback_reason``. The check is repeated here so a brief can never carry LLM text
    that fails the gate, whichever writer produced it.
    """
    template = narrative.write("visit_brief", facts).to_dict()
    if settings is None:
        return template
    from ..writers import write_text  # lazy: the writers package is optional at import time

    data = dict(write_text(settings, "visit_brief", facts))
    if data.get("writer") != "llm":
        return data
    problems = narrative.validate_written(data, facts)
    if problems:
        template["fallback_reason"] = "LLM text rejected: " + "; ".join(problems[:3])
        return template
    return data


def build_brief(
    db: DbSession,
    participant: Participant,
    *,
    since: str | None,
    now: str | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """The brief payload (read-only; :func:`generate_brief` adds the audit event).

    ``settings`` selects the writer (``writers.write_text``); without it the template
    writer is used directly.
    """
    stamp = now or now_iso()
    today = stamp[:10]
    since_day, basis, prev_visit, next_visit = resolve_cutoff(db, participant, since, today=today)
    since_ts = f"{since_day}T00:00:00.000Z"
    ev = _Evidence()
    usubjid = participant.usubjid
    who = ev.add(
        usubjid,
        "participant",
        note=f"Participant {participant.display_label} (synthetic)",
        link=timeline_link(usubjid),
    )
    since_id = (
        ev.add(
            prev_visit.id,
            "visit",
            ts=prev_visit.recorded_at,
            note=f"Completed visit on {prev_visit.visit_date}",
            link=timeline_link(usubjid),
        )
        if prev_visit is not None
        else who
    )
    since_fact = {"value": since_day, "evidence_ids": [since_id]}
    rec = _Record(db, participant, since_ts)

    side_effects = _new_side_effects(ev, rec)
    open_aes = _open_aes(ev, rec)
    meds = _med_changes(ev, rec)
    escalations = _escalations(ev, rec)
    clocks = _clocks(ev, rec)
    notes = _notes(ev, rec)
    vitals = _vitals(ev, rec)

    facts: dict[str, Any] = {
        "participant": {"value": participant.display_label, "evidence_ids": [who]},
        "since": since_fact,
        "new_side_effects": [_public(f) for f in side_effects],
        "open_aes": [_public(f) for f in open_aes],
        "med_changes": [_public(f) for f in meds],
        "escalations": [_public(f) for f in escalations],
        "clocks": [_public(f) for f in clocks],
        "notes": [_public(f) for f in notes],
    }
    if next_visit is not None:
        facts["next_visit"] = {
            "value": next_visit.visit_date,
            "evidence_ids": [
                ev.add(
                    next_visit.id,
                    "visit",
                    ts=next_visit.recorded_at,
                    note=f"Scheduled visit on {next_visit.visit_date}",
                    link=timeline_link(usubjid),
                )
            ],
        }
    if vitals:
        facts["vitals"] = _public(vitals[-1])
    questions = narrative.derive_questions(facts) + _open_queries(ev, rec)
    facts["questions"] = questions

    link_home = timeline_link(usubjid)
    sections: dict[str, list[dict[str, Any]]] = {key: [] for key, _ in SECTION_ORDER}

    for f in side_effects:
        it = _item("new_side_effects", f, grades=f["grades"], ts=f["_ts"])
        if it:
            sections["new_side_effects"].append(it)
    if not side_effects:
        empty = _empty_item("new_side_effects", since_fact, link_home)
        if empty:
            sections["new_side_effects"].append(empty)
    for f in open_aes:
        it = _item("open_aes", f, status=f["_record_status"], ts=f["_ts"])
        if it:
            sections["open_aes"].append(it)
    for f in meds:
        it = _item(
            "med_changes",
            f,
            protocol_flag=f.get("protocol_flag"),
            protocol_section=f.get("protocol_section"),
            printed_page=f.get("printed_page"),
            exception_text=f.get("exception_text"),
            missing_fields=f.get("missing_fields"),
            status=f["_record_status"],
            ts=f["_ts"],
        )
        if it:
            sections["medication_changes"].append(it)
    if not meds:
        empty = _empty_item("med_changes", since_fact, link_home)
        if empty:
            sections["medication_changes"].append(empty)
    for f in escalations:
        it = _item(
            "escalations",
            f,
            tier=f["tier"],
            # [integration] a boolean the brief page renders as one chip; the item text
            # already says "acknowledged" / "not yet acknowledged", so no status string too.
            acknowledged=bool(f["acknowledged"]),
            reasons=f["_reasons"],
            ts=f["_ts"],
        )
        if it:
            sections["escalations_and_clocks"].append(it)
    for f in clocks:
        it = _item(
            "clocks",
            f,
            clock_kind=f["kind"],
            due_at=f["due_at"],
            status=f["status"],
            packet_id=f["_packet_id"],
            packet_status=f["_packet_status"],
            ts=f["_ts"],
        )
        if it:
            sections["escalations_and_clocks"].append(it)
    for f in notes:
        it = _item("notes", f, note_type=f["_raw_type"], ts=f["_ts"])
        if it:
            sections["notes_and_calls"].append(it)
    for f in vitals:
        it = _item("vitals", f, is_measured=f["is_measured"], source=f["source"], ts=f["_ts"])
        if it:
            word = "MEASURED" if f["is_measured"] else "SIMULATED"
            it["text"] = f"{word}: {it['text']}"
            sections["vitals_context"].append(it)

    question_items: list[dict[str, Any]] = []
    for q in questions:
        rendered = _write_one("questions", q)
        if rendered is None:
            continue
        text, ids = rendered
        link = next((ev.link_of(i) for i in ids if ev.link_of(i)), link_home)
        if q.get("kind") == "other":
            link = "/dashboard/queries"
        question_items.append(
            {"text": text, "evidence_ids": ids, "link": link, "kind": q.get("kind")}
        )

    written = _narrative(facts, settings)
    section_list: list[dict[str, Any]] = [
        {"key": key, "title": title, "items": sections[key]} for key, title in SECTION_ORDER
    ]
    with_content = sum(
        1 for key, _ in SECTION_ORDER if any(not it.get("empty") for it in sections[key])
    ) + (1 if question_items else 0)
    return {
        "usubjid": usubjid,
        "display_label": participant.display_label,
        "since": since_day,
        "since_basis": basis,
        "generated_at": stamp,
        "next_visit": next_visit.visit_date if next_visit is not None else None,
        "sections": section_list,
        "narrative": written,
        "questions_to_ask": question_items,
        "evidence": ev.refs,
        "counts": {
            "new_side_effects": len(side_effects),
            "open_aes": len(open_aes),
            "medication_changes": len(meds),
            "escalations": len(escalations),
            "clocks": len(clocks),
            "notes_and_calls": len(notes),
            "vitals_sessions": len(vitals),
            "questions": len(question_items),
            "sections_with_content": with_content,
        },
        "links": {"timeline": link_home, "brief": brief_link(usubjid)},
        # [seed agent] Background from the Synthea cohort (docs/ISSUES #23): structured data
        # restated field by field, labelled simulated, citing the participant row.
        "baseline": (
            {**view, "evidence_ids": [who]}
            if (view := baseline_view(load_json(participant.baseline_json, None)))
            else None
        ),
        "footer": FOOTER,
        "participants_note": SYNTHETIC_NOTE,
        "facts": facts,
    }


def generate_brief(
    db: DbSession,
    actor: Actor,
    participant: Participant,
    *,
    since: str | None,
    printable: bool = False,
    now: str | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """:func:`build_brief` plus the ``brief.generated`` audit event."""
    brief = build_brief(db, participant, since=since, now=now, settings=settings)
    append_event(
        db,
        actor,
        "brief.generated",
        "participant",
        participant.usubjid,
        {
            "since": brief["since"],
            "since_basis": brief["since_basis"],
            "next_visit": brief.get("next_visit"),
            "print": printable,
            "writer": brief["narrative"].get("writer"),
            "fallback_reason": brief["narrative"].get("fallback_reason"),
            "sections_with_content": brief["counts"]["sections_with_content"],
            "items": sum(len(s["items"]) for s in brief["sections"]),
            "questions": len(brief["questions_to_ask"]),
            "evidence_ids": len(brief["evidence"]),
        },
        ts_utc=brief["generated_at"],
    )
    return brief


# --------------------------------------------------------------------------- #
# Printable HTML
# --------------------------------------------------------------------------- #

_CSS = """
*{box-sizing:border-box}
body{font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;
margin:0;padding:24px 28px;background:#fff}
h1{font-size:20px;margin:0 0 4px}
.meta{color:#444;font-size:12.5px;margin-bottom:14px}
h2{font-size:15px;margin:18px 0 6px;padding-bottom:3px;border-bottom:1px solid #bbb}
ul{margin:0;padding-left:18px}
li{margin:3px 0}
.ev{font:11px/1.3 ui-monospace,Consolas,monospace;color:#555;word-break:break-all}
.empty{color:#555;font-style:italic}
.tag{display:inline-block;font-size:11px;border:1px solid #888;border-radius:3px;padding:0 4px;
margin-right:4px}
.narr p{margin:4px 0}
.writer{font-size:12px;color:#444}
footer{margin-top:24px;padding-top:8px;border-top:1px solid #bbb;font-size:12px;color:#333}
@media print{body{padding:0}a{color:#111;text-decoration:none}h2{break-after:avoid}
li{break-inside:avoid}}
"""


def _esc(value: Any) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _ev_line(ids: Sequence[str]) -> str:
    return f'<div class="ev">evidence: {_esc(", ".join(ids))}</div>' if ids else ""


def render_brief_html(brief: Mapping[str, Any]) -> str:
    """A self-contained, printable HTML page (no scripts, no external assets)."""
    out: list[str] = [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        f"<title>Visit brief {_esc(brief['display_label'])} since {_esc(brief['since'])}</title>",
        f"<style>{_CSS}</style></head><body>",
        f"<h1>Visit brief: participant {_esc(brief['display_label'])}</h1>",
        '<div class="meta">',
        f"USUBJID {_esc(brief['usubjid'])} &middot; everything since "
        f"<strong>{_esc(brief['since'])}</strong> ({_esc(brief['since_basis'])})",
    ]
    if brief.get("next_visit"):
        out.append(f" &middot; next visit <strong>{_esc(brief['next_visit'])}</strong>")
    out.append(
        f" &middot; generated {_esc(brief['generated_at'])} &middot; {_esc(SYNTHETIC_NOTE)}</div>"
    )
    baseline = brief.get("baseline") or {}
    if baseline.get("summary"):  # [seed agent] Synthea background, labelled simulated
        out.append(f"<h2>Background ({_esc(SYNTHEA_LABEL)})</h2><ul>")
        out.extend(f"<li>{_esc(line)}</li>" for line in baseline["summary"])
        out.append(f"</ul>{_ev_line(baseline.get('evidence_ids') or [])}")
    for section in brief["sections"]:
        out.append(f"<h2>{_esc(section['title'])}</h2>")
        if not section["items"]:
            out.append('<p class="empty">Nothing recorded.</p>')
            continue
        out.append("<ul>")
        for it in section["items"]:
            cls = ' class="empty"' if it.get("empty") else ""
            tags = ""
            if it.get("protocol_flag"):
                tags += f'<span class="tag">protocol: {_esc(it["protocol_flag"])}</span>'
            if it.get("clock_kind"):
                tags += f'<span class="tag">{_esc(str(it["clock_kind"]).upper())}</span>'
            out.append(f"<li{cls}>{tags}{_esc(it['text'])}{_ev_line(it['evidence_ids'])}</li>")
        out.append("</ul>")
    out.append("<h2>Questions to ask at the visit</h2>")
    if brief["questions_to_ask"]:
        out.append("<ul>")
        for q in brief["questions_to_ask"]:
            out.append(f"<li>&#9744; {_esc(q['text'])}{_ev_line(q['evidence_ids'])}</li>")
        out.append("</ul>")
    else:
        out.append('<p class="empty">No open questions.</p>')
    written = brief.get("narrative") or {}
    writer = "template" if written.get("writer") != "llm" else "Claude"
    out.append("<h2>Summary</h2>")
    out.append(f'<div class="writer">Written by {_esc(writer)}; review before use.')
    if written.get("fallback_reason"):
        out.append(f" ({_esc(written['fallback_reason'])})")
    out.append('</div><div class="narr">')
    for s in written.get("sentences") or []:
        out.append(f"<p>{_esc(s.get('text'))}{_ev_line(s.get('evidence_ids') or [])}</p>")
    out.append("</div>")
    out.append(f"<footer>{_esc(FOOTER)}</footer></body></html>")
    return "\n".join(out)


def strip_internal(brief: dict[str, Any]) -> dict[str, Any]:
    """The JSON payload without the raw fact bundle (kept server-side for validation/tests)."""
    return {k: v for k, v in brief.items() if k != "facts"}


def cited_ids(brief: Mapping[str, Any]) -> list[str]:
    """Every evidence id the page cites (sections, questions, narrative)."""
    ids: list[str] = []

    def add(values: Iterable[str]) -> None:
        ids.extend(v for v in values if v not in ids)

    for s in brief["sections"]:
        for it in s["items"]:
            add(it["evidence_ids"])
            for g in it.get("grades") or []:
                add(g.get("evidence_ids") or [])
    for q in brief["questions_to_ask"]:
        add(q["evidence_ids"])
    for s in (brief.get("narrative") or {}).get("sentences") or []:
        add(s.get("evidence_ids") or [])
    return ids


__all__ = [
    "DEFAULT_LOOKBACK_DAYS",
    "FOOTER",
    "build_brief",
    "cited_ids",
    "generate_brief",
    "parse_since",
    "record_visit",
    "render_brief_html",
    "resolve_cutoff",
    "strip_internal",
    "visit_to_dict",
    "visits_for",
]
