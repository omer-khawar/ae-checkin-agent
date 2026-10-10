"""Coordinator / investigator review queue."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, col, select

from app.db import get_session
from app.models import (
    AEFlag,
    CheckIn,
    ConMedChange,
    Escalation,
    EscalationStatus,
    Patient,
    ReviewStatus,
    utcnow,
)
from app.schemas import ConMedReview, EscalationUpdate, FlagReview
from app.services.capture import OPEN_FLAG_STATUSES, flag_out

router = APIRouter(prefix="/api", tags=["review"])

_LEVEL_ORDER = {"emergency": 0, "urgent": 1, "human_requested": 2}


# --- AE flags ---------------------------------------------------------------------------------------


@router.get("/flags", summary="Possible AEs with evidence (review queue)")
def list_flags(status: Optional[ReviewStatus] = None, patient_id: Optional[int] = None,
               serious_only: bool = False, session: Session = Depends(get_session)):
    q = select(AEFlag)
    if status:
        q = q.where(AEFlag.status == status.value)
    if patient_id:
        q = q.where(AEFlag.patient_id == patient_id)
    if serious_only:
        q = q.where(AEFlag.serious_candidate == True)  # noqa: E712
    flags = session.exec(q).all()
    # Serious candidates first, then highest grade, then newest
    flags.sort(key=lambda f: (not f.serious_candidate, -(f.final_grade or f.provisional_grade),
                              -f.last_updated_at.timestamp()))
    return [flag_out(session, f) for f in flags]


@router.get("/flags/{flag_id}")
def get_flag(flag_id: int, session: Session = Depends(get_session)):
    f = session.get(AEFlag, flag_id)
    if not f:
        raise HTTPException(404, f"Flag {flag_id} not found")
    return flag_out(session, f)


@router.patch("/flags/{flag_id}", summary="Coordinator confirms/rejects; investigator sets seriousness & attribution")
def review_flag(flag_id: int, body: FlagReview, session: Session = Depends(get_session)):
    f = session.get(AEFlag, flag_id)
    if not f:
        raise HTTPException(404, f"Flag {flag_id} not found")
    data = body.model_dump(exclude_unset=True)
    if "status" in data and data["status"] is not None:
        data["status"] = data["status"].value
    for k, v in data.items():
        setattr(f, k, v)
    if body.serious is True and f.site_aware_at is None:
        # Investigator marked it serious before the system did: start the clock now.
        from datetime import timedelta

        from app.config import settings

        f.serious_candidate, f.site_aware_at = True, utcnow()
        f.sae_due_at = f.site_aware_at + timedelta(hours=settings.sae_report_hours)
    f.reviewed_at = f.last_updated_at = utcnow()
    session.add(f)
    session.commit()
    session.refresh(f)
    return flag_out(session, f)


# --- Con-meds ---------------------------------------------------------------------------------------


@router.get("/conmeds", response_model=list[ConMedChange])
def list_conmeds(status: Optional[ReviewStatus] = None, patient_id: Optional[int] = None,
                 session: Session = Depends(get_session)):
    q = select(ConMedChange).order_by(col(ConMedChange.detected_at).desc())
    if status:
        q = q.where(ConMedChange.status == status.value)
    if patient_id:
        q = q.where(ConMedChange.patient_id == patient_id)
    return session.exec(q).all()


@router.patch("/conmeds/{conmed_id}", response_model=ConMedChange)
def review_conmed(conmed_id: int, body: ConMedReview, session: Session = Depends(get_session)):
    cm = session.get(ConMedChange, conmed_id)
    if not cm:
        raise HTTPException(404, f"Con-med change {conmed_id} not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(cm, k, v.value if hasattr(v, "value") else v)
    cm.reviewed_at = utcnow()
    session.add(cm)
    session.commit()
    session.refresh(cm)
    return cm


# --- Escalations ------------------------------------------------------------------------------------


@router.get("/escalations", summary="Escalations, most urgent first")
def list_escalations(status: Optional[EscalationStatus] = EscalationStatus.open, patient_id: Optional[int] = None,
                     session: Session = Depends(get_session)):
    q = select(Escalation)
    if status:
        q = q.where(Escalation.status == status.value)
    if patient_id:
        q = q.where(Escalation.patient_id == patient_id)
    rows = session.exec(q).all()
    rows.sort(key=lambda e: (_LEVEL_ORDER.get(e.level, 9), -e.created_at.timestamp()))
    patients = {p.id: p for p in session.exec(select(Patient)).all()}
    return [{**e.model_dump(), "patient": {"subject_id": patients[e.patient_id].subject_id,
                                           "display_name": patients[e.patient_id].display_name}} for e in rows]


@router.patch("/escalations/{escalation_id}", response_model=Escalation)
def update_escalation(escalation_id: int, body: EscalationUpdate, session: Session = Depends(get_session)):
    e = session.get(Escalation, escalation_id)
    if not e:
        raise HTTPException(404, f"Escalation {escalation_id} not found")
    e.status = body.status.value
    if body.by:
        e.acknowledged_by = body.by
    if body.note:
        e.resolution_note = body.note
    e.acknowledged_at = e.acknowledged_at or utcnow()
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


# --- Site dashboard ---------------------------------------------------------------------------------


@router.get("/dashboard", summary="Site-level counts for the coordinator home screen")
def dashboard(session: Session = Depends(get_session)):
    flags = session.exec(select(AEFlag)).all()
    now = utcnow()
    clocks = [f for f in flags if f.sae_due_at and f.serious is not False and f.status != ReviewStatus.rejected.value]
    esc = session.exec(select(Escalation).where(Escalation.status == EscalationStatus.open.value)).all()
    return {
        "patients": len(session.exec(select(Patient)).all()),
        "checkins_completed": len(session.exec(select(CheckIn).where(CheckIn.status == "completed")).all()),
        "open_escalations": {lvl: sum(e.level == lvl for e in esc) for lvl in ("emergency", "urgent", "human_requested")},
        "flags_pending_review": sum(f.status == ReviewStatus.pending.value for f in flags),
        "flags_open": sum(f.status in OPEN_FLAG_STATUSES for f in flags),
        "conmeds_pending_review": len(session.exec(select(ConMedChange).where(
            ConMedChange.status == ReviewStatus.pending.value)).all()),
        "sae_clocks": [{"flag_id": f.id, "patient_id": f.patient_id, "term": f.term,
                        "due_at": f.sae_due_at, "hours_remaining": round((f.sae_due_at - now).total_seconds() / 3600, 1)}
                       for f in sorted(clocks, key=lambda f: f.sae_due_at)],
    }
