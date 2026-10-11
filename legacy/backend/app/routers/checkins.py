"""The check-in agent's API. A frontend (text chat, voice agent, or video call with Presage) drives
the conversation like this:

    POST /api/checkins                      -> opening_script (automated disclosure) + first question
    POST /api/checkins/{id}/answers         -> live safety result + next question   (repeat)
    POST /api/checkins/{id}/transcript      -> (optional) free-form speech/text to scan
    POST /api/checkins/{id}/vitals          -> (optional) Presage SmartSpectra vitals
    POST /api/checkins/{id}/complete        -> structured report (flags, con-meds, escalations)

If an answer comes back with "end_checkin": true, say "patient_message" (it tells them to call 911)
and stop. The check-in is processed automatically in that case.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.config import settings
from app.db import get_session
from app.models import CheckIn, CheckInMode, CheckInStatus, Patient, VitalsReading, as_utc
from app.schemas import AnswersIn, CheckInCreate, TranscriptIn, VitalsIn
from app.services import safety
from app.services.capture import build_checkin_report, complete_checkin, next_question, process_vitals, submit_answers
from app.services.vitals import summarize_presage

router = APIRouter(prefix="/api/checkins", tags=["check-ins"])


def _get_checkin(session: Session, checkin_id: int) -> CheckIn:
    c = session.get(CheckIn, checkin_id)
    if not c:
        raise HTTPException(404, f"Check-in {checkin_id} not found")
    return c


def _require_open(c: CheckIn) -> None:
    if c.status == CheckInStatus.completed.value:
        raise HTTPException(409, "Check-in already completed")


def create_vitals_reading(session: Session, patient_id: int, checkin: CheckIn | None, body: VitalsIn) -> VitalsReading:
    if body.metrics:
        summary = summarize_presage([m.model_dump() for m in body.metrics])
    else:
        if body.pulse_bpm is None and body.breathing_bpm is None:
            raise HTTPException(422, "Send `metrics` (raw Presage) or at least one of pulse_bpm / breathing_bpm")
        summary = body.model_dump(include={"pulse_bpm", "pulse_confidence", "breathing_bpm", "breathing_confidence",
                                           "hrv_rmssd_ms", "hrv_confidence", "duration_s"})
        summary["n_pulse_samples"] = int(body.pulse_bpm is not None)
        summary["n_breathing_samples"] = int(body.breathing_bpm is not None)
        summary["quality_notes"] = ["Summary supplied by client"]
    reading = VitalsReading(patient_id=patient_id, checkin_id=checkin.id if checkin else None, **summary)
    if body.captured_at:
        reading.captured_at = as_utc(body.captured_at)
    session.add(reading)
    session.flush()
    return reading


@router.post("", status_code=201, summary="Start a check-in")
def start_checkin(body: CheckInCreate, session: Session = Depends(get_session)):
    patient = session.get(Patient, body.patient_id)
    if not patient:
        raise HTTPException(404, f"Patient {body.patient_id} not found")
    if body.mode in (CheckInMode.voice, CheckInMode.video) and not patient.consented_to_contact:
        raise HTTPException(403, "Patient has not consented to automated voice/video contact (TCPA). Use text or a human.")
    c = CheckIn(patient_id=patient.id, mode=body.mode.value, respondent=body.respondent.value,
                respondent_name=body.respondent_name)
    session.add(c)
    session.commit()
    session.refresh(c)
    q = next_question(session, c)
    return {
        "checkin": c,
        "opening_script": safety.opening_script(patient.display_name, c.respondent, settings.site_name, settings.study_id),
        "next_question": q.as_dict() if q else None,
    }


@router.get("/{checkin_id}", summary="Check-in report (works mid-check-in too)")
def get_checkin(checkin_id: int, session: Session = Depends(get_session)):
    return build_checkin_report(session, _get_checkin(session, checkin_id))


@router.get("/{checkin_id}/next", summary="Next question (null when done)")
def get_next(checkin_id: int, session: Session = Depends(get_session)):
    c = _get_checkin(session, checkin_id)
    q = next_question(session, c) if c.status != CheckInStatus.completed.value else None
    return {"next_question": q.as_dict() if q else None, "done": q is None}


@router.post("/{checkin_id}/answers", summary="Submit one or more answers")
def post_answers(checkin_id: int, body: AnswersIn, session: Session = Depends(get_session)):
    c = _get_checkin(session, checkin_id)
    _require_open(c)
    try:
        return submit_answers(session, c, [a.model_dump() for a in body.answers])
    except ValueError as e:
        session.rollback()
        raise HTTPException(422, str(e)) from e


@router.post("/{checkin_id}/transcript", summary="Add free-form speech/text (scanned for symptoms, meds, red flags)")
def post_transcript(checkin_id: int, body: TranscriptIn, session: Session = Depends(get_session)):
    c = _get_checkin(session, checkin_id)
    _require_open(c)
    return _append_transcript(session, c, body.text)


def _append_transcript(session: Session, c: CheckIn, text: str) -> dict:
    """Free-form speech (e.g. a voice agent's running transcript). Red flags / human requests are
    handled now; symptoms and meds are extracted at /complete."""
    from app.services.capture import ingest_scan
    from app.services.extract import ScanResult, scan_text

    c.transcript = (c.transcript + "\n(transcript) " + text).strip()
    patient = session.get(Patient, c.patient_id)
    scan = scan_text(text, c.started_at.date(), detect_human_request=True)
    res = ingest_scan(session, patient, ScanResult(red_flags=scan.red_flags, human_requested=scan.human_requested),
                      source_type="checkin_text", source_id=c.id, ref_date=c.started_at.date(), context="checkin",
                      checkin_id=c.id, create_generic_sae=False)
    esc = res["escalations"]
    top = max(esc, key=lambda e: {"emergency": 3, "urgent": 2, "human_requested": 1}.get(e.level, 0), default=None)
    end = bool(top and top.level == "emergency")
    if scan.human_requested:
        c.human_requested = True
    if end:
        c.emergency_triggered = True
    session.add(c)
    session.commit()
    if end:
        complete_checkin(session, c)
    return {"escalations": [e.model_dump() for e in esc], "patient_message": top.patient_message if top else None,
            "end_checkin": end, "preview": scan.to_dict()}


@router.post("/{checkin_id}/vitals", status_code=201, summary="Attach Presage SmartSpectra vitals to this check-in")
def post_vitals(checkin_id: int, body: VitalsIn, session: Session = Depends(get_session)):
    c = _get_checkin(session, checkin_id)
    reading = create_vitals_reading(session, c.patient_id, c, body)
    if c.status == CheckInStatus.completed.value:
        process_vitals(session, reading)  # otherwise processed at /complete, after symptoms are graded
    session.commit()
    session.refresh(reading)
    return reading


@router.post("/{checkin_id}/complete", summary="Finish: grade, scan, merge, escalate -> structured report")
def post_complete(checkin_id: int, session: Session = Depends(get_session)):
    return complete_checkin(session, _get_checkin(session, checkin_id))
