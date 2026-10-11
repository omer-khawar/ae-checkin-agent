"""SQLModel tables (CLAUDE.md §6, CONTRACTS.md §2.4).

Conventions:

* primary keys are ULID strings; timestamps are ISO-8601 UTC strings
  (``...mmmZ``) stored as TEXT so SQLite and Postgres behave identically;
* JSON-valued columns end in ``_json`` and hold compact JSON text
  (``interim_api.util.dump_json`` / ``load_json``); the API never exposes the
  raw text, only the decoded value;
* ``AuditEvent`` rows are append-only: the SQLAlchemy listeners in ``db.py``
  refuse any UPDATE or DELETE against them;
* ``Draft`` versions are rows linked by ``supersedes_id`` and grouped by
  ``lineage_id`` (the id of the first version); a superseded row keeps its
  content and gets ``status = "superseded"``;
* every table a chart note will need (``ChartNote``, the nullable ``note_id`` on
  drafts / escalations / SAE clocks, ``source`` columns) exists now so the
  follow-up task can wire ``/notes`` without a migration.
"""

from __future__ import annotations

from sqlalchemy import Column, Index, Text, UniqueConstraint
from sqlmodel import Field, SQLModel

# --------------------------------------------------------------------------- #
# Reference / identity
# --------------------------------------------------------------------------- #


class Study(SQLModel, table=True):
    __tablename__ = "study"

    study_id: str = Field(primary_key=True)
    nct_id: str
    title: str
    title_official: str | None = None
    sponsor: str
    phase: str
    status: str | None = None
    conditions_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    interventions_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    fetched_at: str
    source_url: str


class Participant(SQLModel, table=True):
    __tablename__ = "participants"

    usubjid: str = Field(primary_key=True)
    study_id: str = Field(index=True)
    enrolled_at: str
    display_label: str = Field(index=True)
    baseline_vitals_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    is_eval: bool = Field(default=False, index=True)
    created_at: str
    # [seed agent] Synthea baseline profile (age, sex, NSCLC stage, comorbidities, active meds,
    # prior chemo, baseline pulse/breathing; docs/ISSUES #23), labelled "Synthea synthetic EHR
    # (simulated)", and the protocol context the rules engine reads (CONTRACTS R3.1
    # ``ProtocolContext``: ``prior_pi3k_inhibitor``, ``last_dose_date``). Both nullable.
    baseline_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    protocol_context_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))


class User(SQLModel, table=True):
    """Demo identity. The shared password is ``DEMO_PASSWORD`` from the environment
    (never stored); this row carries role and display name only."""

    __tablename__ = "users"

    username: str = Field(primary_key=True)
    role: str
    display_name: str
    created_at: str


class Setting(SQLModel, table=True):
    __tablename__ = "settings"

    key: str = Field(primary_key=True)
    value_json: str = Field(sa_column=Column(Text, nullable=False))
    updated_at: str


# --------------------------------------------------------------------------- #
# Check-in capture
# --------------------------------------------------------------------------- #


class Session(SQLModel, table=True):
    __tablename__ = "sessions"

    id: str = Field(primary_key=True)
    usubjid: str = Field(index=True)
    study_id: str
    started_at: str
    completed_at: str | None = Field(default=None, index=True)
    consent_camera: bool
    vitals_status: str = Field(default="pending")
    tier: int | None = Field(default=None, index=True)
    stop_screen_shown: bool = False
    is_eval: bool = Field(default=False, index=True)
    max_grade: int | None = None
    is_measured: bool | None = None
    backdated: bool = False
    """True when an admin override set ``started_at`` / ``completed_at`` (seed, eval)."""
    settings_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    """Effective ``RuleSettings`` used at completion."""
    result_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    """``interim_rules.serialize.result_to_dict`` output, stored once at completion."""
    consent_basis: str | None = None
    """CLAUDE.md §00 / D-026: ``"enrollment_icf"`` (camera use is covered by the informed
    consent form signed at enrollment; no per-session consent screen). Null on rows written
    before the change."""


class Answer(SQLModel, table=True):
    __tablename__ = "answers"
    __table_args__ = (
        UniqueConstraint("session_id", "item_id", "attribute", name="uq_answer_session_item_attr"),
    )

    id: str = Field(primary_key=True)
    session_id: str = Field(index=True)
    item_id: str
    attribute: str
    value_int: int | None = None
    value_text: str | None = None
    ts_client: str
    ts_server: str


class VitalsSample(SQLModel, table=True):
    __tablename__ = "vitals_samples"

    id: str = Field(primary_key=True)
    session_id: str = Field(index=True)
    ts_utc: str
    source: str
    is_measured: bool
    pulse_bpm: float | None = None
    pulse_conf: float | None = None
    breathing_bpm: float | None = None
    breathing_conf: float | None = None
    hrv_rmssd_ms: float | None = None
    hrv_conf: float | None = None
    window_s: float = 0.0
    quality_flags_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))


# --------------------------------------------------------------------------- #
# Outputs of the rules engine
# --------------------------------------------------------------------------- #


class Draft(SQLModel, table=True):
    __tablename__ = "drafts"

    id: str = Field(primary_key=True)
    lineage_id: str = Field(index=True)
    """Id of version 1 of this record; all versions share it."""
    session_id: str | None = Field(default=None, index=True)
    note_id: str | None = Field(default=None, index=True)
    usubjid: str = Field(index=True)
    domain: str = Field(index=True)
    source: str = Field(default="check_in")
    """``check_in`` | ``chart_note``."""
    version: int = 1
    status: str = Field(default="draft", index=True)
    """``draft`` | ``confirmed`` | ``rejected`` | ``superseded``."""
    fields_json: str = Field(sa_column=Column(Text, nullable=False))
    evidence_json: str = Field(sa_column=Column(Text, nullable=False))
    linked_ae_open_id: str | None = None
    """The open AE this draft was de-duplicated against (follow-ups only; rules contract)."""
    is_followup: bool = False
    ae_open_id: str | None = Field(default=None, index=True)
    """For AE drafts: the ``AEOpen`` row this draft opened (new AE) or extended (follow-up)."""
    created_by: str
    created_at: str
    supersedes_id: str | None = None
    note: str | None = None
    status_changed_by: str | None = None
    status_changed_at: str | None = None


class AEOpen(SQLModel, table=True):
    __tablename__ = "ae_open"

    id: str = Field(primary_key=True)
    usubjid: str = Field(index=True)
    aedecod: str
    first_session_id: str | None = None
    last_session_id: str | None = None
    first_note_id: str | None = None
    last_note_id: str | None = None
    first_reported_at: str
    last_reported_at: str
    ongoing: bool = Field(default=True, index=True)
    source: str = "check_in"


class Escalation(SQLModel, table=True):
    __tablename__ = "escalations"

    id: str = Field(primary_key=True)
    session_id: str | None = Field(default=None, index=True)
    note_id: str | None = Field(default=None, index=True)
    usubjid: str = Field(index=True)
    tier: int
    reasons_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    source: str = "check_in"
    created_at: str
    paged_at: str | None = None
    acked_by: str | None = None
    acked_at: str | None = None


class SAEClock(SQLModel, table=True):
    __tablename__ = "sae_clocks"

    id: str = Field(primary_key=True)
    session_id: str | None = Field(default=None, index=True)
    note_id: str | None = Field(default=None, index=True)
    usubjid: str = Field(index=True)
    site_awareness_at: str
    due_at: str
    informational_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    stopped_at: str | None = None
    stopped_by: str | None = None
    decision: str | None = None
    created_at: str
    kind: str = Field(default="sae")
    """[packets agent] ``sae`` (suspected serious event) | ``aesi`` (possible adverse event of
    special interest, CONTRACTS R3.1/R3.2); same 24-hour machinery. Added column: an older
    database gets it through ``schema_upgrade`` with ``DEFAULT 'sae'``."""


class Page(SQLModel, table=True):
    """The mock pager log: one row per Tier 3 page (CLAUDE.md §3.4(e))."""

    __tablename__ = "pages"

    id: str = Field(primary_key=True)
    ts: str
    session_id: str | None = Field(default=None, index=True)
    escalation_id: str | None = None
    usubjid: str
    tier: int
    message: str
    delivered: bool = True


# --------------------------------------------------------------------------- #
# Audit, eval, chart notes
# --------------------------------------------------------------------------- #


class AuditEvent(SQLModel, table=True):
    """Append-only hash chain (CLAUDE.md §3.6, CONTRACTS.md §2.3).

    ``hash = sha256(prev_hash + canonical_json(event_without_hash))``; genesis
    ``prev_hash`` is 64 zeros; ``seq`` is strictly increasing.
    """

    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_entity", "entity_type", "entity_id"),)

    id: str = Field(primary_key=True)
    seq: int = Field(unique=True, index=True)
    ts_utc: str
    actor_id: str
    actor_role: str
    action: str = Field(index=True)
    entity_type: str
    entity_id: str
    payload_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    prev_hash: str
    hash: str = Field(unique=True)


class EvalRun(SQLModel, table=True):
    __tablename__ = "eval_runs"

    id: str = Field(primary_key=True)
    ran_at: str = Field(index=True)
    ran_by: str
    include_hidden: bool
    n_personas: int
    n_pass: int
    n_fail: int
    results_json: str = Field(sa_column=Column(Text, nullable=False))


class ChartNote(SQLModel, table=True):
    """Table only in this wave; ``/notes`` endpoints land with the scanner port (R2.4)."""

    __tablename__ = "chart_notes"

    id: str = Field(primary_key=True)
    usubjid: str = Field(index=True)
    note_date: str
    author: str
    note_type: str
    text: str = Field(sa_column=Column(Text, nullable=False))
    ingested_at: str
    ingested_by: str
    scan_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    tier: int | None = None


# --------------------------------------------------------------------------- #
# [queries agent] Phone-call intake (CONTRACTS R4.1) and sponsor queries (R4.4)
# --------------------------------------------------------------------------- #


class ChartNoteCall(SQLModel, table=True):
    """Call metadata for a ``ChartNote`` whose ``note_type`` is ``"phone_call"`` (R4.1).

    A side table keyed by note id (rather than new ``ChartNote`` columns) so the note table
    stays exactly as the scanner track defined it; ``services/calls.py`` joins it in.
    """

    __tablename__ = "chart_note_calls"

    note_id: str = Field(primary_key=True)
    caller: str | None = None
    """``participant`` | ``caregiver`` | ``other``."""
    call_direction: str | None = None
    """``inbound`` | ``outbound``."""
    created_at: str


class SponsorQuery(SQLModel, table=True):
    """A sponsor data query on one field of one record (CONTRACTS R4.4, CLAUDE.md §00 step 7).

    Raised by an edit check (``interim_rules.queries``; ``check_id`` set, ``raised_by =
    "edit-check"``) when records reach the mock EDC or on an admin re-run, or by a person
    acting as the sponsor's monitor (``check_id`` null). ``lineage_id`` is the record's
    lineage, so a later version of the same record never gets a duplicate open query.
    """

    __tablename__ = "queries"

    id: str = Field(primary_key=True)
    check_id: str | None = Field(default=None, index=True)
    domain: str
    draft_id: str = Field(index=True)
    """The record version the query was raised on."""
    lineage_id: str = Field(index=True)
    usubjid: str = Field(index=True)
    field: str
    text: str = Field(sa_column=Column(Text, nullable=False))
    severity: str
    """``data`` | ``safety``."""
    status: str = Field(default="open", index=True)
    """``open`` | ``answered`` | ``closed``."""
    raised_by: str
    raised_at: str = Field(index=True)
    trigger: str = "manual"
    """``mock_edc`` | ``run_checks`` | ``manual``."""
    edc_ack_id: str | None = None
    evidence_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    fields_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    """Every field the check read (``field`` first); the suggested answer cites them."""
    answer_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    answer_evidence_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    answered_by: str | None = None
    answered_at: str | None = None
    answered_from_suggestion: bool = False
    """The answer equals, or starts from, the template writer's suggested answer (time saved)."""
    answer_edit_draft_id: str | None = None
    """The draft version created by ``also_edit``, if any."""
    closed_by: str | None = None
    closed_at: str | None = None
    close_note: str | None = None


# --------------------------------------------------------------------------- #
# [briefs agent] Time-saved counts (CONTRACTS R3.2) and visit dates for the brief (§00.4)
# --------------------------------------------------------------------------- #


class DraftMetrics(SQLModel, table=True):
    """Pre-filled / person-edited field counts of one confirmed draft (CLAUDE.md §00.5).

    Written by ``services.drafts.confirm_draft`` through ``services.time_saved``: the
    counts compare version 1 of the record (what Interim pre-filled from evidence) with
    the confirmed version, using ``interim_rules.time_saved.prefilled_count`` /
    ``edited_count``. One row per confirmed draft row (``id`` = that draft's id); a side
    table, not new ``Draft`` columns, so existing databases need no column upgrade.
    """

    __tablename__ = "draft_metrics"

    id: str = Field(primary_key=True)
    lineage_id: str = Field(index=True)
    usubjid: str = Field(index=True)
    domain: str
    prefilled_fields: int = 0
    edited_fields: int = 0
    confirmed_at: str = Field(index=True)
    confirmed_by: str
    is_eval: bool = Field(default=False, index=True)


class ParticipantVisit(SQLModel, table=True):
    """A study visit date for a participant: ``completed`` (the brief's default cut-off)
    or ``scheduled`` (the brief's "next visit"). Synthetic demo data only."""

    __tablename__ = "participant_visits"

    id: str = Field(primary_key=True)
    usubjid: str = Field(index=True)
    visit_date: str = Field(index=True)
    """``YYYY-MM-DD``."""
    status: str = Field(default="completed")
    """``completed`` | ``scheduled``."""
    label: str | None = None
    recorded_by: str
    recorded_at: str


# --------------------------------------------------------------------------- #
# [packets agent] Serious-event packets (CONTRACTS R3.2 "Packets", R4.2 follow-ups)
# --------------------------------------------------------------------------- #


class Packet(SQLModel, table=True):
    """One SAE / AESI report packet for a 24-hour clock (CLAUDE.md §00.2).

    ``sequence`` 0 is the initial report, 1..n are follow-ups (``parent_packet_id`` = the
    signed report it follows). The packet id is stable across edits: each ``PATCH`` bumps
    ``version`` and appends ``{version, edited_by, edited_at, diff, note, audit_event_id}``
    to ``edits_json`` (the versions log), mirrored by a ``packet.edited`` audit event.
    ``facts_json`` keeps the exact fact bundle the narrative was written from, so the
    narrative's evidence ids can be re-validated later. A signed packet is immutable.
    """

    __tablename__ = "packets"
    __table_args__ = (UniqueConstraint("clock_id", "sequence", name="uq_packet_clock_sequence"),)

    id: str = Field(primary_key=True)
    clock_id: str = Field(index=True)
    kind: str
    """``sae`` | ``aesi`` (copied from the clock)."""
    sequence: int = 0
    parent_packet_id: str | None = None
    usubjid: str = Field(index=True)
    session_id: str | None = None
    note_id: str | None = None
    status: str = Field(default="draft", index=True)
    """``draft`` | ``signed``."""
    version: int = 1
    fields_json: str = Field(sa_column=Column(Text, nullable=False))
    missing_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    narrative_json: str = Field(sa_column=Column(Text, nullable=False))
    narrative_edited_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    facts_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    evidence_index_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    changes_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    edits_json: str = Field(default="[]", sa_column=Column(Text, nullable=False))
    created_by: str
    created_at: str
    updated_at: str
    signed_by: str | None = None
    signed_at: str | None = None
    mock_edc_ack_id: str | None = None
    sign_attestation_json: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    """The signer's attestation, set once at sign: ``{narrative_reviewed, narrative_source,
    narrative_edited_by_person, missing_info_not_available: [{item, status}]}``."""


# --------------------------------------------------------------------------- #
# Every table (kept at the end so it can list the tables each feature appended above)
# --------------------------------------------------------------------------- #

ALL_TABLES: tuple[type[SQLModel], ...] = (
    Study,
    Participant,
    User,
    Setting,
    Session,
    Answer,
    VitalsSample,
    Draft,
    AEOpen,
    Escalation,
    SAEClock,
    Page,
    AuditEvent,
    EvalRun,
    ChartNote,
    ChartNoteCall,
    SponsorQuery,
    DraftMetrics,
    ParticipantVisit,
    Packet,
)
"""Documentation aid: schema creation uses ``SQLModel.metadata`` (``db.create_all``)."""
