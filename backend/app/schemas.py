"""Request bodies. Responses are mostly the table models or plain dicts (see /docs for shapes)."""

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.models import CheckInMode, EscalationStatus, MedAction, Respondent, ReviewStatus


class PatientCreate(BaseModel):
    subject_id: str = Field(examples=["101-007"])
    display_name: str = Field(examples=["Test Patient"])
    age: Optional[int] = None
    sex: Optional[str] = None
    condition: Optional[str] = None
    study_arm: Optional[str] = None
    preferred_language: str = "en"
    phone: Optional[str] = None
    consented_to_contact: bool = True
    caregiver_name: Optional[str] = None
    enrolled_on: Optional[date] = None
    baseline_meds: list[str] = Field(default_factory=list, examples=[["lisinopril", "metformin"]])


class CheckInCreate(BaseModel):
    patient_id: int
    mode: CheckInMode = CheckInMode.text
    respondent: Respondent = Respondent.patient
    respondent_name: Optional[str] = None


class AnswerIn(BaseModel):
    question_id: str = Field(examples=["nausea.severity"])
    value: Optional[int] = Field(default=None, description="Scale index (0-4) or 0/1 for yes/no")
    text: Optional[str] = Field(default=None, description="What the person said/typed. Parsed if value is missing, "
                                                          "and always scanned for red flags, symptoms and meds.")


class AnswersIn(BaseModel):
    answers: list[AnswerIn]


class TranscriptIn(BaseModel):
    text: str = Field(examples=["Honestly the rash on my arms is back and I started taking Benadryl for it."])


# --- Presage SmartSpectra -------------------------------------------------------------------------
# Accepts the decoded Metrics message in snake_case OR camelCase (e.g. JSON from the Node SDK).


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class PresageMeasurement(_Camel):
    value: float
    stable: Optional[bool] = None
    confidence: Optional[float] = None  # 0-100
    timestamp: Optional[int] = None  # microseconds since epoch


class PresageHrv(_Camel):
    rmssd: Optional[float] = None
    mean_nn: Optional[float] = None
    sdnn: Optional[float] = None
    baevsky: Optional[float] = None
    confidence: Optional[float] = None
    stable: Optional[bool] = None
    timestamp: Optional[int] = None


class PresageCardio(_Camel):
    pulse_rate: list[PresageMeasurement] = Field(default_factory=list)
    hrv: list[PresageHrv] = Field(default_factory=list)


class PresageBreathing(_Camel):
    rate: list[PresageMeasurement] = Field(default_factory=list)


class PresageMetrics(_Camel):
    cardio: Optional[PresageCardio] = None
    breathing: Optional[PresageBreathing] = None


class VitalsIn(_Camel):
    """Send EITHER `metrics` (raw decoded Presage Metrics messages, we summarize) OR the summary fields."""

    metrics: list[PresageMetrics] = Field(default_factory=list)
    pulse_bpm: Optional[float] = None
    pulse_confidence: Optional[float] = None
    breathing_bpm: Optional[float] = None
    breathing_confidence: Optional[float] = None
    hrv_rmssd_ms: Optional[float] = None
    hrv_confidence: Optional[float] = None
    duration_s: Optional[float] = None
    captured_at: Optional[datetime] = None


class PatientVitalsIn(VitalsIn):
    checkin_id: Optional[int] = None


# --- Chart notes ------------------------------------------------------------------------------------


class NoteIn(BaseModel):
    patient_id: int
    text: str = Field(examples=["Pt reports 3 days of diarrhea, started loperamide. Denies fever."])
    note_date: Optional[date] = None
    author: Optional[str] = None
    note_type: str = "progress_note"
    source: str = "synthetic"


class ScanIn(BaseModel):
    text: str
    ref_date: Optional[date] = None


# --- Reviews ----------------------------------------------------------------------------------------


class FlagReview(BaseModel):
    status: Optional[ReviewStatus] = None
    reviewer: Optional[str] = None
    review_note: Optional[str] = None
    term: Optional[str] = Field(default=None, description="Re-code the AE term")
    final_grade: Optional[int] = Field(default=None, ge=1, le=5)
    onset_date: Optional[date] = None
    serious: Optional[bool] = Field(default=None, description="Investigator decision")
    attribution: Optional[str] = Field(default=None, description="not_related|unlikely|possible|probable|definite")


class ConMedReview(BaseModel):
    status: Optional[ReviewStatus] = None
    reviewer: Optional[str] = None
    drug: Optional[str] = None
    action: Optional[MedAction] = None
    indication: Optional[str] = None
    event_date: Optional[date] = None


class EscalationUpdate(BaseModel):
    status: EscalationStatus
    by: Optional[str] = None
    note: Optional[str] = None
