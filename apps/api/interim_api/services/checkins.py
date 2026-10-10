"""From a rules result to rows: drafts, open AEs, escalations, SAE clocks, pages.

Two functions matter to other modules:

* :func:`build_engine_input` turns a session's stored answers, gate rows, vitals
  samples and the participant's open AEs into the engine's ``CheckInInput``
  (real ``Answer.id`` / ``VitalsSample.id`` values become the evidence ids).
* :func:`apply_result` persists what a rules result decided. It takes plain
  data (draft records, a tier, reasons, a seriousness flag, an SAE clock) and
  is deliberately source-agnostic: a check-in passes ``session_id``, a chart
  note will pass ``note_id`` and ``source="chart_note"`` and reuse everything
  else (de-duplication against open AEs included).

Every row written here is also an audit event.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.models import CheckInInput, DraftRecord
from interim_rules.serialize import build_input, to_jsonable

from ..audit import Actor, append_event
from ..models import AEOpen, Answer, Draft, Escalation, Page, SAEClock, Session, Study, VitalsSample
from ..util import dump_json, load_json, new_id, normalize_iso, now_iso
from .common import stop_screen_text, tier_name

GATE_HOSPITALIZATION = "gate_hospitalization"
GATE_CONMED = "gate_conmed"
GATE_CONMED_TEXT = "gate_conmed_text"
GATE_CONMED_DIRECTION = "gate_conmed_direction"
GATE_OTHER = "gate_other"
GATE_TEMP_C = "gate_temp_c"
GATE_ATTRIBUTE = "gate"
GATE_ITEM_IDS: tuple[str, ...] = (
    GATE_HOSPITALIZATION,
    GATE_CONMED,
    GATE_CONMED_TEXT,
    GATE_CONMED_DIRECTION,
    GATE_OTHER,
    GATE_TEMP_C,
)


# --------------------------------------------------------------------------- #
# Engine input
# --------------------------------------------------------------------------- #


def session_answers(db: DbSession, session_id: str) -> list[Answer]:
    rows = db.exec(select(Answer).where(Answer.session_id == session_id)).all()
    return sorted(rows, key=lambda a: (a.ts_client, a.id))


def session_samples(db: DbSession, session_id: str) -> list[VitalsSample]:
    rows = db.exec(select(VitalsSample).where(VitalsSample.session_id == session_id)).all()
    return sorted(rows, key=lambda v: (v.ts_utc, v.id))


def open_aes_for(db: DbSession, usubjid: str) -> list[AEOpen]:
    return list(
        db.exec(
            select(AEOpen).where(AEOpen.usubjid == usubjid).where(AEOpen.ongoing == True)  # noqa: E712
        ).all()
    )


def next_aeseq_for(db: DbSession, usubjid: str) -> int:
    """``max(AESEQ) + 1`` over every AE draft row of the participant (all versions)."""
    highest = 0
    rows = db.exec(select(Draft).where(Draft.usubjid == usubjid).where(Draft.domain == "AE")).all()
    for row in rows:
        value = load_json(row.fields_json, {}).get("AESEQ")
        if isinstance(value, int) and not isinstance(value, bool):
            highest = max(highest, value)
    return highest + 1


def gates_from_rows(rows: Sequence[Answer]) -> dict[str, Any]:
    """The engine's ``GateAnswers`` dict from the stored ``gate_*`` answer rows.

    A row blanked by a gate re-submission (both values ``None``; see
    ``sessions.record_gates``) is treated as absent, so the engine sees exactly
    what a first submission with the same answers would have produced.
    """
    by_item = {
        a.item_id: a
        for a in rows
        if a.attribute == GATE_ATTRIBUTE and not (a.value_int is None and a.value_text is None)
    }
    hosp = by_item.get(GATE_HOSPITALIZATION)
    conmed = by_item.get(GATE_CONMED)
    text = by_item.get(GATE_CONMED_TEXT)
    direction = by_item.get(GATE_CONMED_DIRECTION)
    other = by_item.get(GATE_OTHER)
    temp = by_item.get(GATE_TEMP_C)
    conmed_changed = bool(conmed.value_int) if conmed is not None else False
    conmed_pointer = text if text is not None else conmed
    temp_value: float | None = None
    if temp is not None and temp.value_text not in (None, ""):
        temp_value = float(temp.value_text)
    return {
        "hospitalization": bool(hosp.value_int) if hosp is not None else False,
        "hospitalization_answer_id": hosp.id if hosp is not None else None,
        "conmed_changed": conmed_changed,
        "conmed_text": text.value_text if text is not None else None,
        "conmed_direction": direction.value_text if direction is not None else None,
        "conmed_answer_id": conmed_pointer.id if conmed_pointer is not None else None,
        "other_text": other.value_text if other is not None else None,
        "other_answer_id": other.id if other is not None else None,
        "temp_c": temp_value,
        "temp_answer_id": temp.id if temp is not None else None,
    }


def sample_row_to_engine(v: VitalsSample) -> dict[str, Any]:
    return {
        "sample_id": v.id,
        "ts_utc": v.ts_utc,
        "source": v.source,
        "is_measured": v.is_measured,
        "pulse_bpm": v.pulse_bpm,
        "pulse_conf": v.pulse_conf,
        "breathing_bpm": v.breathing_bpm,
        "breathing_conf": v.breathing_conf,
        "hrv_rmssd_ms": v.hrv_rmssd_ms,
        "hrv_conf": v.hrv_conf,
        "window_s": v.window_s,
        "quality_flags": load_json(v.quality_flags_json, []),
    }


def build_engine_input(
    db: DbSession,
    study: Study,
    session: Session,
    completed_at: str,
    rule_settings: Mapping[str, Any],
) -> CheckInInput:
    """Assemble the engine input for ``session`` as of ``completed_at``.

    Response timestamps are the server receipt time, except for an
    admin-backdated session (seed, eval) where the client timestamp the admin
    supplied is the one that places the answer inside the backdated window.
    A session without camera consent passes no vitals to the engine, whatever
    the table holds (``record_vitals`` refuses samples for it anyway).
    """
    answers = session_answers(db, session.id)
    responses = [
        {
            "answer_id": a.id,
            "item_id": a.item_id,
            "attribute": a.attribute,
            "value": a.value_int,
            "ts": a.ts_client if session.backdated else a.ts_server,
        }
        for a in answers
        if a.attribute != GATE_ATTRIBUTE
    ]
    open_aes = [
        {
            "ae_open_id": ae.id,
            "aedecod": ae.aedecod,
            "first_reported_at": ae.first_reported_at,
            "last_reported_at": ae.last_reported_at,
            "last_session_id": ae.last_session_id or ae.last_note_id or "",
        }
        for ae in open_aes_for(db, session.usubjid)
    ]
    return build_input(
        session_id=session.id,
        studyid=study.study_id,
        usubjid=session.usubjid,
        completed_at=completed_at,
        nct_id=study.nct_id,
        responses=responses,
        gates=gates_from_rows(answers),
        vitals=(
            [sample_row_to_engine(v) for v in session_samples(db, session.id)]
            if session.consent_camera
            else []
        ),
        open_aes=open_aes,
        settings=dict(rule_settings),
        next_aeseq=next_aeseq_for(db, session.usubjid),
        started_at=session.started_at,
    )


# --------------------------------------------------------------------------- #
# Persisting a result
# --------------------------------------------------------------------------- #


@dataclass
class DraftInput:
    """Source-agnostic draft record: what the engine (or a note scan) proposes."""

    domain: str
    fields: dict[str, Any]
    evidence: dict[str, list[dict[str, Any]]]
    linked_ae_open_id: str | None = None
    is_followup: bool = False

    @classmethod
    def from_record(cls, record: DraftRecord) -> DraftInput:
        fields: dict[str, Any] = {}
        evidence: dict[str, list[dict[str, Any]]] = {}
        for f in record.fields:
            fields[f.name] = to_jsonable(f.value)
            evidence[f.name] = [to_jsonable(e) for e in f.evidence]
        return cls(
            domain=record.domain,
            fields=fields,
            evidence=evidence,
            linked_ae_open_id=record.linked_ae_open_id,
            is_followup=record.is_followup,
        )


@dataclass
class ApplyOutcome:
    drafts: list[Draft] = field(default_factory=list)
    ae_open_rows: list[AEOpen] = field(default_factory=list)
    escalation: Escalation | None = None
    page: Page | None = None
    sae_clock: SAEClock | None = None


def _draft_summary(fields: Mapping[str, Any], domain: str) -> dict[str, Any]:
    keys = {
        "AE": ("AESEQ", "AETERM", "AEDECOD", "AETOXGR", "AESTDTC", "INTERIM_TIER"),
        "VS": ("VSSEQ", "VSTESTCD", "VSORRES", "VSORRESU", "VSMETHOD", "VSSTAT"),
        "CM": ("CMSEQ", "CMTRT", "CMDECOD", "INTERIM_MATCH_KIND", "INTERIM_MATCH_CONFIDENCE"),
    }
    return {k: fields.get(k) for k in keys.get(domain, ()) if k in fields}


def apply_result(
    db: DbSession,
    actor: Actor,
    *,
    usubjid: str,
    drafts: Sequence[DraftInput],
    tier: int,
    reasons: Sequence[str],
    seriousness_suspected: bool,
    sae_clock: Mapping[str, Any] | None,
    page_oncall: bool,
    reported_at: str,
    session_id: str | None = None,
    note_id: str | None = None,
    source: str = "check_in",
    now: str | None = None,
) -> ApplyOutcome:
    """Persist drafts, open-AE bookkeeping, escalation (+ page) and SAE clock.

    ``reported_at`` is the moment the site became aware (a check-in's
    ``completed_at``; a note's ``ingested_at``) and stamps every open AE.
    """
    stamp = now or now_iso()
    entity_type = "session" if session_id is not None else "note"
    entity_id = session_id or note_id or "unknown"
    outcome = ApplyOutcome()

    for item in drafts:
        draft_id = new_id()
        fields = dict(item.fields)
        fields["INTERIM_RECORD_SOURCE"] = source
        ae_open_id: str | None = None
        if item.domain == "AE":
            aedecod = str(fields.get("AEDECOD") or "")
            if item.is_followup and item.linked_ae_open_id:
                existing = db.get(AEOpen, item.linked_ae_open_id)
                if existing is not None:
                    existing.last_reported_at = reported_at
                    if session_id is not None:
                        existing.last_session_id = session_id
                    if note_id is not None:
                        existing.last_note_id = note_id
                    db.add(existing)
                    ae_open_id = existing.id
                    outcome.ae_open_rows.append(existing)
            if ae_open_id is None:
                first_reported = str(fields.get("AESTDTC") or reported_at)
                opened = AEOpen(
                    id=new_id(),
                    usubjid=usubjid,
                    aedecod=aedecod,
                    first_session_id=session_id,
                    last_session_id=session_id,
                    first_note_id=note_id,
                    last_note_id=note_id,
                    first_reported_at=normalize_iso(first_reported),
                    last_reported_at=reported_at,
                    ongoing=True,
                    source=source,
                )
                db.add(opened)
                ae_open_id = opened.id
                outcome.ae_open_rows.append(opened)
        row = Draft(
            id=draft_id,
            lineage_id=draft_id,
            session_id=session_id,
            note_id=note_id,
            usubjid=usubjid,
            domain=item.domain,
            source=source,
            version=1,
            status="draft",
            fields_json=dump_json(fields),
            evidence_json=dump_json(item.evidence),
            linked_ae_open_id=item.linked_ae_open_id,
            is_followup=item.is_followup,
            ae_open_id=ae_open_id,
            created_by=actor.id,
            created_at=stamp,
        )
        db.add(row)
        db.flush()
        outcome.drafts.append(row)
        append_event(
            db,
            actor,
            "draft.created",
            "draft",
            draft_id,
            {
                "domain": item.domain,
                "source": source,
                "session_id": session_id,
                "note_id": note_id,
                "usubjid": usubjid,
                "is_followup": item.is_followup,
                "linked_ae_open_id": item.linked_ae_open_id,
                "ae_open_id": ae_open_id,
                "summary": _draft_summary(fields, item.domain),
            },
            ts_utc=stamp,
        )

    if tier >= 2:
        escalation = Escalation(
            id=new_id(),
            session_id=session_id,
            note_id=note_id,
            usubjid=usubjid,
            tier=tier,
            reasons_json=dump_json(list(reasons)),
            source=source,
            created_at=stamp,
        )
        db.add(escalation)
        db.flush()
        outcome.escalation = escalation
        append_event(
            db,
            actor,
            "escalation.created",
            "escalation",
            escalation.id,
            {
                "tier": tier,
                "tier_name": tier_name(tier),
                "reasons": list(reasons),
                "session_id": session_id,
                "note_id": note_id,
                "usubjid": usubjid,
            },
            ts_utc=stamp,
        )
        if page_oncall:
            message = (
                f"Tier {tier} ({tier_name(tier)}) for {usubjid}: "
                f"{'; '.join(reasons) or 'see check-in'}. "
                f"Kiosk shows: {stop_screen_text(tier) or ''}"
            ).strip()
            page = Page(
                id=new_id(),
                ts=stamp,
                session_id=session_id,
                escalation_id=escalation.id,
                usubjid=usubjid,
                tier=tier,
                message=message,
                delivered=True,
            )
            escalation.paged_at = stamp
            db.add(page)
            db.add(escalation)
            db.flush()
            outcome.page = page
            append_event(
                db,
                actor,
                "escalation.paged",
                "escalation",
                escalation.id,
                {"page_id": page.id, "tier": tier, "message": message, "mock_pager": True},
                ts_utc=stamp,
            )

    if seriousness_suspected and sae_clock is not None:
        clock = SAEClock(
            id=new_id(),
            session_id=session_id,
            note_id=note_id,
            usubjid=usubjid,
            site_awareness_at=str(sae_clock["site_awareness_at"]),
            due_at=str(sae_clock["due_at"]),
            informational_json=dump_json(sae_clock.get("informational", {})),
            created_at=stamp,
        )
        db.add(clock)
        db.flush()
        outcome.sae_clock = clock
        append_event(
            db,
            actor,
            "sae_clock.started",
            "sae_clock",
            clock.id,
            {
                "session_id": session_id,
                "note_id": note_id,
                "usubjid": usubjid,
                "site_awareness_at": clock.site_awareness_at,
                "due_at": clock.due_at,
                "informational": sae_clock.get("informational", {}),
                "stops_when": "an investigator records a seriousness decision (AESER)",
            },
            ts_utc=stamp,
        )

    db.flush()
    # Keep the audit chain readable: one summary line on the originating entity.
    append_event(
        db,
        actor,
        "drafts.applied",
        entity_type,
        entity_id,
        {
            "n_drafts": len(outcome.drafts),
            "draft_ids": [d.id for d in outcome.drafts],
            "escalation_id": outcome.escalation.id if outcome.escalation else None,
            "page_id": outcome.page.id if outcome.page else None,
            "sae_clock_id": outcome.sae_clock.id if outcome.sae_clock else None,
            "source": source,
        },
        ts_utc=stamp,
    )
    return outcome


def close_open_ae(
    db: DbSession, actor: Actor, ae_open_id: str | None, reason: str, now: str
) -> None:
    """Mark an open AE as no longer ongoing (draft rejected, ``AEONGO = N`` or ``AEENDTC`` set)."""
    if ae_open_id is None:
        return
    row = db.get(AEOpen, ae_open_id)
    if row is None or not row.ongoing:
        return
    row.ongoing = False
    db.add(row)
    db.flush()
    append_event(
        db,
        actor,
        "ae_open.closed",
        "ae_open",
        row.id,
        {"usubjid": row.usubjid, "aedecod": row.aedecod, "reason": reason},
        ts_utc=now,
    )
