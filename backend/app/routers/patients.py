from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, col, select

from app.db import get_session
from app.models import (
    AEFlag,
    ChartNote,
    CheckIn,
    ConMedChange,
    Escalation,
    EscalationStatus,
    Patient,
    VitalsReading,
    utcnow,
)
from app.schemas import PatientCreate, PatientVitalsIn
from app.services import edc
from app.services.capture import OPEN_FLAG_STATUSES, flag_out, process_vitals
from app.routers.checkins import create_vitals_reading

router = APIRouter(prefix="/api/patients", tags=["patients"])


def get_patient_or_404(session: Session, patient_id: int) -> Patient:
    p = session.get(Patient, patient_id)
    if not p:
        raise HTTPException(404, f"Patient {patient_id} not found")
    return p


@router.get("", response_model=list[Patient])
def list_patients(session: Session = Depends(get_session)):
    return session.exec(select(Patient).order_by(Patient.id)).all()


@router.post("", response_model=Patient, status_code=201)
def create_patient(body: PatientCreate, session: Session = Depends(get_session)):
    if session.exec(select(Patient).where(Patient.subject_id == body.subject_id)).first():
        raise HTTPException(409, f"subject_id {body.subject_id} already exists")
    p = Patient(**body.model_dump())
    session.add(p)
    session.commit()
    session.refresh(p)
    return p


@router.get("/{patient_id}", response_model=Patient)
def get_patient(patient_id: int, session: Session = Depends(get_session)):
    return get_patient_or_404(session, patient_id)


@router.get("/{patient_id}/summary", summary="Everything the coordinator needs for one patient")
def patient_summary(patient_id: int, session: Session = Depends(get_session)):
    p = get_patient_or_404(session, patient_id)
    flags = session.exec(select(AEFlag).where(AEFlag.patient_id == p.id).order_by(col(AEFlag.last_updated_at).desc())).all()
    checkins = session.exec(select(CheckIn).where(CheckIn.patient_id == p.id).order_by(col(CheckIn.started_at).desc())).all()
    vitals = session.exec(select(VitalsReading).where(VitalsReading.patient_id == p.id).order_by(VitalsReading.captured_at)).all()
    return {
        "patient": p.model_dump(),
        "open_escalations": session.exec(select(Escalation).where(
            Escalation.patient_id == p.id, Escalation.status == EscalationStatus.open.value)).all(),
        "flags": [flag_out(session, f) for f in flags],
        "conmed_changes": session.exec(select(ConMedChange).where(ConMedChange.patient_id == p.id)
                                       .order_by(col(ConMedChange.detected_at).desc())).all(),
        "checkins": checkins,
        "vitals_trend": [{"captured_at": v.captured_at, "pulse_bpm": v.pulse_bpm, "breathing_bpm": v.breathing_bpm,
                          "hrv_rmssd_ms": v.hrv_rmssd_ms, "signals": v.signals} for v in vitals],
        "counts": {
            "open_flags": sum(f.status in OPEN_FLAG_STATUSES for f in flags),
            "serious_candidates": sum(f.serious_candidate and f.serious is not False for f in flags),
        },
    }


@router.get("/{patient_id}/notes", response_model=list[ChartNote])
def patient_notes(patient_id: int, session: Session = Depends(get_session)):
    get_patient_or_404(session, patient_id)
    return session.exec(select(ChartNote).where(ChartNote.patient_id == patient_id).order_by(ChartNote.note_date)).all()


@router.get("/{patient_id}/edc-draft", summary="Draft SDTM-style AE + CM rows for coordinator confirmation")
def edc_draft(patient_id: int, include_pending: bool = True, session: Session = Depends(get_session)):
    p = get_patient_or_404(session, patient_id)
    return {"generated_at": utcnow(), "usubjid": edc.usubjid(p),
            "AE": edc.ae_rows(session, p, include_pending), "CM": edc.cm_rows(session, p, include_pending)}


@router.post("/{patient_id}/vitals", status_code=201, summary="Store Presage vitals outside of a check-in")
def add_patient_vitals(patient_id: int, body: PatientVitalsIn, session: Session = Depends(get_session)):
    p = get_patient_or_404(session, patient_id)
    checkin = session.get(CheckIn, body.checkin_id) if body.checkin_id else None
    reading = create_vitals_reading(session, p.id, checkin, body)
    if checkin is None or checkin.status == "completed":
        process_vitals(session, reading)
    session.commit()
    session.refresh(reading)
    return reading
