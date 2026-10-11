"""Draft EDC entries shaped like CDISC SDTM AE and CM domain rows.

Variable names follow SDTM (see the CDISC SDTM/ADaM pilot project:
https://github.com/cdisc-org/sdtm-adam-pilot-project). AEDECOD would normally be a MedDRA preferred
term; we use the CTCAE term as a stand-in. Fields only the investigator can decide (AESER, AEREL)
stay blank until the flag is reviewed. Columns starting with "_" are review metadata, not SDTM.
"""

from sqlmodel import Session, col, select

from app.config import settings
from app.models import AEFlag, ConMedChange, Evidence, Patient, ReviewStatus
from app.services.grading import grade_to_severity

_REL = {"not_related": "NOT RELATED", "unlikely": "UNLIKELY RELATED", "possible": "POSSIBLY RELATED",
        "probable": "PROBABLY RELATED", "definite": "RELATED"}


def usubjid(patient: Patient) -> str:
    return f"{settings.study_id}-{patient.subject_id}"


def ae_rows(session: Session, patient: Patient, include_pending: bool = True) -> list[dict]:
    statuses = [ReviewStatus.confirmed.value] + ([ReviewStatus.pending.value, ReviewStatus.needs_info.value]
                                                  if include_pending else [])
    flags = session.exec(select(AEFlag).where(AEFlag.patient_id == patient.id, col(AEFlag.status).in_(statuses))
                         .order_by(AEFlag.first_detected_at)).all()
    rows = []
    for i, f in enumerate(flags, 1):
        first_ev = session.exec(select(Evidence).where(Evidence.flag_id == f.id).order_by(Evidence.id)).first()
        grade = f.final_grade if f.final_grade is not None else f.provisional_grade
        rows.append({
            "STUDYID": settings.study_id,
            "DOMAIN": "AE",
            "USUBJID": usubjid(patient),
            "AESEQ": i,
            "AETERM": (first_ev.quote[:200] if first_ev else f.term),
            "AEDECOD": f.term,
            "AESTDTC": f.onset_date.isoformat() if f.onset_date else "",
            "AESEV": grade_to_severity(grade),
            "AETOXGR": str(grade),
            "AESER": "" if f.serious is None else ("Y" if f.serious else "N"),
            "AEREL": _REL.get(f.attribution or "", ""),
            "_flag_id": f.id,
            "_status": f.status,
            "_grade_is_provisional": f.final_grade is None,
            "_serious_candidate": f.serious_candidate,
            "_sae_due_at": f.sae_due_at.isoformat() if f.sae_due_at else None,
        })
    return rows


def cm_rows(session: Session, patient: Patient, include_pending: bool = True) -> list[dict]:
    statuses = [ReviewStatus.confirmed.value] + ([ReviewStatus.pending.value, ReviewStatus.needs_info.value]
                                                  if include_pending else [])
    meds = session.exec(select(ConMedChange).where(ConMedChange.patient_id == patient.id,
                                                   col(ConMedChange.status).in_(statuses))
                        .order_by(ConMedChange.detected_at)).all()
    rows = []
    for i, m in enumerate(meds, 1):
        d = m.event_date.isoformat() if m.event_date else ""
        rows.append({
            "STUDYID": settings.study_id,
            "DOMAIN": "CM",
            "USUBJID": usubjid(patient),
            "CMSEQ": i,
            "CMTRT": m.mentioned_as.upper(),
            "CMDECOD": m.drug.upper(),
            "CMINDC": (m.indication or "").upper(),
            "CMSTDTC": d if m.action == "started" else "",
            "CMENDTC": d if m.action == "stopped" else "",
            "_action": m.action,
            "_conmed_id": m.id,
            "_status": m.status,
        })
    return rows
