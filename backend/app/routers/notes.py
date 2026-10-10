from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.db import get_session
from app.models import ChartNote, Patient
from app.schemas import NoteIn
from app.services.capture import flag_out, ingest_note

router = APIRouter(prefix="/api/notes", tags=["chart notes"])


@router.post("", status_code=201, summary="Ingest a new EHR/chart note and scan it for possible AEs and med changes")
def create_note(body: NoteIn, session: Session = Depends(get_session)):
    if not session.get(Patient, body.patient_id):
        raise HTTPException(404, f"Patient {body.patient_id} not found")
    note = ChartNote(**body.model_dump(exclude={"note_date"}), note_date=body.note_date or date.today())
    session.add(note)
    session.flush()
    result = ingest_note(session, note)
    session.commit()
    session.refresh(note)
    return {
        "note": note,
        "findings": result["scan"].to_dict(),
        "flags": [flag_out(session, f) for f in result["flags"]],
        "conmed_changes": [c.model_dump() for c in result["conmeds"]],
        "escalations": [e.model_dump() for e in result["escalations"]],
    }


@router.get("/{note_id}", response_model=ChartNote)
def get_note(note_id: int, session: Session = Depends(get_session)):
    n = session.get(ChartNote, note_id)
    if not n:
        raise HTTPException(404, f"Note {note_id} not found")
    return n
