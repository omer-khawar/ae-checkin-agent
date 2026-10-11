"""Database tables.

All timestamps are timezone-aware UTC (they serialize as ISO strings with +00:00, which JavaScript's
Date parses correctly). Relationships are plain foreign keys, queried explicitly, to keep things
easy to follow.
"""

from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """Treat naive datetimes as UTC (older SQLite rows / client input) and normalise to UTC."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Enums (stored as plain strings)
# ---------------------------------------------------------------------------


class CheckInMode(str, Enum):
    text = "text"
    voice = "voice"
    video = "video"  # video check-in = voice/text + Presage camera vitals


class Respondent(str, Enum):
    patient = "patient"
    caregiver = "caregiver"


class CheckInStatus(str, Enum):
    in_progress = "in_progress"
    completed = "completed"


class ReviewStatus(str, Enum):
    pending = "pending"
    confirmed = "confirmed"
    rejected = "rejected"
    needs_info = "needs_info"


class EscalationLevel(str, Enum):
    emergency = "emergency"  # tell the patient to call 911 now + alert the team
    urgent = "urgent"  # research nurse should contact the patient today
    human_requested = "human_requested"  # patient asked for a person


class EscalationStatus(str, Enum):
    open = "open"
    acknowledged = "acknowledged"
    resolved = "resolved"


class SourceType(str, Enum):
    checkin_answer = "checkin_answer"
    checkin_text = "checkin_text"
    chart_note = "chart_note"
    vitals = "vitals"


class MedAction(str, Enum):
    started = "started"
    stopped = "stopped"
    dose_changed = "dose_changed"
    taking = "taking"  # mentioned as currently taking; action unclear


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


class Patient(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    subject_id: str = Field(index=True, unique=True, description="Site subject number, e.g. 101-003")
    display_name: str
    age: Optional[int] = None
    sex: Optional[str] = None
    condition: Optional[str] = None
    study_arm: Optional[str] = None
    preferred_language: str = "en"
    phone: Optional[str] = None
    consented_to_contact: bool = True
    caregiver_name: Optional[str] = None
    enrolled_on: Optional[date] = None
    baseline_meds: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)


class CheckIn(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    patient_id: int = Field(foreign_key="patient.id", index=True)
    mode: str = CheckInMode.text.value
    respondent: str = Respondent.patient.value
    respondent_name: Optional[str] = None
    status: str = CheckInStatus.in_progress.value
    recall_period: str = "the past 7 days"
    human_requested: bool = False
    emergency_triggered: bool = False
    transcript: str = ""
    started_at: datetime = Field(default_factory=utcnow)
    completed_at: Optional[datetime] = None


class Answer(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    checkin_id: int = Field(foreign_key="checkin.id", index=True)
    question_id: str  # e.g. "nausea.severity" or "meds.changes"
    symptom: Optional[str] = None
    attribute: str  # frequency | severity | interference | presence | text
    value: Optional[int] = None  # 0-4 for PRO-CTCAE scales, 0/1 for presence
    raw_text: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


class VitalsReading(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    patient_id: int = Field(foreign_key="patient.id", index=True)
    checkin_id: Optional[int] = Field(default=None, foreign_key="checkin.id", index=True)
    source: str = "presage_smartspectra"
    pulse_bpm: Optional[float] = None
    pulse_confidence: Optional[float] = None
    breathing_bpm: Optional[float] = None
    breathing_confidence: Optional[float] = None
    hrv_rmssd_ms: Optional[float] = None
    hrv_confidence: Optional[float] = None
    n_pulse_samples: int = 0
    n_breathing_samples: int = 0
    duration_s: Optional[float] = None
    quality_notes: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    signals: list[dict] = Field(default_factory=list, sa_column=Column(JSON))
    processed: bool = False
    captured_at: datetime = Field(default_factory=utcnow)


class ChartNote(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    patient_id: int = Field(foreign_key="patient.id", index=True)
    note_date: date
    author: Optional[str] = None
    note_type: str = "progress_note"
    source: str = "synthetic"
    text: str
    created_at: datetime = Field(default_factory=utcnow)


class AEFlag(SQLModel, table=True):
    """A possible adverse event. Evidence rows from any source attach to the same flag (de-dup)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    patient_id: int = Field(foreign_key="patient.id", index=True)
    term: str = Field(index=True, description="CTCAE v5 term, e.g. 'Nausea'")
    provisional_grade: int = 1
    grade_basis: str = ""
    status: str = ReviewStatus.pending.value
    onset_date: Optional[date] = None
    first_detected_at: datetime = Field(default_factory=utcnow)
    last_updated_at: datetime = Field(default_factory=utcnow)

    # Serious-AE clock: starts when the site becomes aware of a *possible* SAE.
    serious_candidate: bool = False
    serious_reason: Optional[str] = None
    site_aware_at: Optional[datetime] = None
    sae_due_at: Optional[datetime] = None

    # Coordinator / investigator review. The investigator decides seriousness and attribution.
    final_grade: Optional[int] = None
    serious: Optional[bool] = None
    attribution: Optional[str] = None  # not_related | unlikely | possible | probable | definite
    reviewer: Optional[str] = None
    review_note: Optional[str] = None
    reviewed_at: Optional[datetime] = None


class Evidence(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    flag_id: int = Field(foreign_key="aeflag.id", index=True)
    source_type: str
    source_id: Optional[int] = None
    quote: str
    span_start: Optional[int] = None
    span_end: Optional[int] = None
    reasoning: str
    grade_suggested: Optional[int] = None
    created_at: datetime = Field(default_factory=utcnow)


class ConMedChange(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    patient_id: int = Field(foreign_key="patient.id", index=True)
    drug: str = Field(index=True, description="Normalized generic name")
    mentioned_as: str
    action: str = MedAction.taking.value
    indication: Optional[str] = None
    event_date: Optional[date] = None
    source_type: str
    source_id: Optional[int] = None
    quote: str
    reasoning: str
    status: str = ReviewStatus.pending.value
    detected_at: datetime = Field(default_factory=utcnow)
    reviewer: Optional[str] = None
    reviewed_at: Optional[datetime] = None


class Escalation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    patient_id: int = Field(foreign_key="patient.id", index=True)
    checkin_id: Optional[int] = Field(default=None, foreign_key="checkin.id")
    level: str
    category: Optional[str] = None  # e.g. dyspnea, fever, chest_pain; one open escalation per category
    reason: str
    quote: Optional[str] = None
    source_type: Optional[str] = None
    source_id: Optional[int] = None
    patient_message: Optional[str] = None
    status: str = EscalationStatus.open.value
    created_at: datetime = Field(default_factory=utcnow)
    acknowledged_by: Optional[str] = None
    acknowledged_at: Optional[datetime] = None
    resolution_note: Optional[str] = None
