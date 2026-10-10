"""Row -> contract-shaped dict serializers and small lookups shared by the services."""

from __future__ import annotations

from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.tables import escalation_ladder

from ..models import (
    AEOpen,
    Answer,
    ChartNote,
    Draft,
    Escalation,
    Page,
    Participant,
    SAEClock,
    Session,
    Study,
    VitalsSample,
)
from ..problems import problem
from ..util import load_json, now_iso, seconds_between

PARTICIPANTS_NOTE = "All participants are synthetic."


def tier_name(tier: int | None) -> str:
    if tier is None:
        return "pending"
    return escalation_ladder().tiers[tier].name


def tier_action(tier: int) -> str:
    return escalation_ladder().tiers[tier].action


def stop_screen_text(tier: int) -> str | None:
    return escalation_ladder().tiers[tier].stop_screen_text


# --------------------------------------------------------------------------- #
# Serializers
# --------------------------------------------------------------------------- #


def study_to_dict(study: Study) -> dict[str, Any]:
    return {
        "study_id": study.study_id,
        "nct_id": study.nct_id,
        "title": study.title,
        "title_official": study.title_official,
        "sponsor": study.sponsor,
        "phase": study.phase,
        "status": study.status,
        "conditions": load_json(study.conditions_json, []),
        "interventions": load_json(study.interventions_json, []),
        "fetched_at": study.fetched_at,
        "source_url": study.source_url,
        "participants_note": PARTICIPANTS_NOTE,
    }


def participant_to_dict(p: Participant) -> dict[str, Any]:
    return {
        "usubjid": p.usubjid,
        "study_id": p.study_id,
        "enrolled_at": p.enrolled_at,
        "display_label": p.display_label,
        "baseline_vitals_json": load_json(p.baseline_vitals_json, None),
        "is_eval": p.is_eval,
    }


def session_to_dict(s: Session) -> dict[str, Any]:
    return {
        "id": s.id,
        "usubjid": s.usubjid,
        "study_id": s.study_id,
        "started_at": s.started_at,
        "completed_at": s.completed_at,
        "consent_camera": s.consent_camera,
        "vitals_status": s.vitals_status,
        "tier": s.tier,
        "tier_name": tier_name(s.tier) if s.completed_at else None,
        "stop_screen_shown": s.stop_screen_shown,
        "is_eval": s.is_eval,
        "max_grade": s.max_grade,
        "backdated": s.backdated,
    }


def answer_to_dict(a: Answer) -> dict[str, Any]:
    return {
        "id": a.id,
        "session_id": a.session_id,
        "item_id": a.item_id,
        "attribute": a.attribute,
        "value_int": a.value_int,
        "value_text": a.value_text,
        "ts_client": a.ts_client,
        "ts_server": a.ts_server,
    }


def sample_to_dict(v: VitalsSample) -> dict[str, Any]:
    return {
        "id": v.id,
        "session_id": v.session_id,
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


def draft_to_dict(d: Draft) -> dict[str, Any]:
    fields = load_json(d.fields_json, {})
    # Where the record came from, on the row and inside the fields (R2.3 / exports).
    fields.setdefault("INTERIM_RECORD_SOURCE", d.source)
    return {
        "id": d.id,
        "lineage_id": d.lineage_id,
        "session_id": d.session_id,
        "note_id": d.note_id,
        "usubjid": d.usubjid,
        "domain": d.domain,
        "source": d.source,
        "version": d.version,
        "status": d.status,
        "fields": fields,
        "evidence": load_json(d.evidence_json, {}),
        "linked_ae_open_id": d.linked_ae_open_id,
        "is_followup": d.is_followup,
        "ae_open_id": d.ae_open_id,
        "created_by": d.created_by,
        "created_at": d.created_at,
        "supersedes_id": d.supersedes_id,
        "note": d.note,
        "status_changed_by": d.status_changed_by,
        "status_changed_at": d.status_changed_at,
    }


def escalation_to_dict(e: Escalation) -> dict[str, Any]:
    seconds_to_ack = (
        round(seconds_between(e.created_at, e.acked_at), 3) if e.acked_at is not None else None
    )
    return {
        "id": e.id,
        "session_id": e.session_id,
        "note_id": e.note_id,
        "usubjid": e.usubjid,
        "tier": e.tier,
        "tier_name": tier_name(e.tier),
        "reasons": load_json(e.reasons_json, []),
        "source": e.source,
        "created_at": e.created_at,
        "paged_at": e.paged_at,
        "acked_by": e.acked_by,
        "acked_at": e.acked_at,
        "seconds_to_ack": seconds_to_ack,
    }


def sae_clock_to_dict(c: SAEClock, *, now: str | None = None) -> dict[str, Any]:
    reference = now or now_iso()
    remaining = None if c.stopped_at is not None else round(seconds_between(reference, c.due_at), 3)
    return {
        "id": c.id,
        "session_id": c.session_id,
        "note_id": c.note_id,
        "usubjid": c.usubjid,
        "site_awareness_at": c.site_awareness_at,
        "due_at": c.due_at,
        "stopped_at": c.stopped_at,
        "stopped_by": c.stopped_by,
        "decision": c.decision,
        "seconds_remaining": remaining,
        "overdue": remaining is not None and remaining < 0,
        "informational": load_json(c.informational_json, {}),
        "created_at": c.created_at,
    }


def chart_note_to_dict(n: ChartNote, *, display_label: str | None = None) -> dict[str, Any]:
    """``ChartNote`` (R2.4): the stored note verbatim plus who read it and when."""
    return {
        "id": n.id,
        "usubjid": n.usubjid,
        "display_label": display_label,
        "note_date": n.note_date,
        "author": n.author,
        "note_type": n.note_type,
        "text": n.text,
        "ingested_at": n.ingested_at,
        "ingested_by": n.ingested_by,
        "tier": n.tier,
        "tier_name": tier_name(n.tier) if n.tier is not None else None,
        "source": "chart_note",
    }


def page_to_dict(p: Page) -> dict[str, Any]:
    return {
        "id": p.id,
        "ts": p.ts,
        "session_id": p.session_id,
        "escalation_id": p.escalation_id,
        "usubjid": p.usubjid,
        "tier": p.tier,
        "message": p.message,
        "delivered": p.delivered,
    }


def ae_open_to_dict(a: AEOpen) -> dict[str, Any]:
    return {
        "id": a.id,
        "usubjid": a.usubjid,
        "aedecod": a.aedecod,
        "first_session_id": a.first_session_id,
        "last_session_id": a.last_session_id,
        "first_note_id": a.first_note_id,
        "last_note_id": a.last_note_id,
        "first_reported_at": a.first_reported_at,
        "last_reported_at": a.last_reported_at,
        "ongoing": a.ongoing,
        "source": a.source,
    }


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #


def get_study(db: DbSession) -> Study:
    study = db.exec(select(Study)).first()
    if study is None:
        raise problem(503, "No study is seeded yet; run scripts/seed.py", title="Not Ready")
    return study


def get_session_or_404(db: DbSession, session_id: str) -> Session:
    session = db.get(Session, session_id)
    if session is None:
        raise problem(404, f"No session with id {session_id}", title="Session not found")
    return session


def get_draft_or_404(db: DbSession, draft_id: str) -> Draft:
    draft = db.get(Draft, draft_id)
    if draft is None:
        raise problem(404, f"No draft with id {draft_id}", title="Draft not found")
    return draft


def require_open(session: Session) -> None:
    if session.completed_at is not None:
        raise problem(
            409,
            f"Session {session.id} was completed at {session.completed_at}; "
            "start a new check-in instead",
            title="Session already completed",
        )
