"""Demo seed (CONTRACTS.md §5; ``data/synthetic/README.md`` is the spec).

What it creates, deterministically (``random.Random(20261010)``):

* the demo study from ``data/public/study.json`` (a real, public registry record);
* the three demo users (``coordinator``, ``investigator``, ``admin``);
* twelve synthetic participants ``P-001`` .. ``P-012`` with the profile table of
  §4.3 below, each with 2-4 prior check-ins over the last 60 days;
* for every prior check-in: a session, answers, gates, a simulated ``resting``
  vitals replay (§4.5), completion through the rules engine, confirmation of the
  AE drafts (so open AEs exist; P-007's Cough AE from 5 days ago is what the
  demo's follow-up links to), and acknowledgment of the two Tier 2 escalations;
* the eight synthetic chart notes (``data/synthetic/chart_notes.json``, read here
  through the identical copy in the rules package's answer key, CONTRACTS R2.4)
  ingested for their mapped participants through the ``/notes`` service with
  ``ingested_at_override``, re-anchored to the seed clock (README §4.6 and its
  Notes section): note-sourced drafts in the queue, two Tier 2 note escalations
  (N6 acknowledged, N3 left open), one SAE clock started at ingestion (N6, read
  ~3 h before the seed clock so the countdown is live, not overdue), and
  cross-source follow-up links (N2 onto P-002's check-in AEs; N7 onto N1's).
* the **Monday-morning** state of CLAUDE.md §00.6 / CONTRACTS R3.2 + R4.5, relative to the
  seed clock (``data/synthetic/README.md`` "Monday morning"): overnight, three kiosk
  check-ins (P-003 severe diarrhea -> possible-AESI clock + Tier 2; P-011 started
  prednisone -> discouraged-steroid flag; P-004 routine Tier 0), a caregiver phone call
  (N3 for P-003), an ER note (N6 for P-006 -> SAE clock + Tier 2) and an urgent-care
  record (UC1 for P-002, linking as a follow-up to the open rash/itching AEs), all left
  unacknowledged for the coordinator, with the two running clocks' report packets
  pre-filled (template writer); one signed SAE packet from last week with a follow-up due
  (P-012's hospitalization); one open and one answered sponsor query on confirmed CM
  records missing protocol-required fields; P-003's previous visit (20 days ago) and next
  visit (tomorrow), so the brief defaults to "since the last visit";
* a Synthea baseline (``data/synthetic/synthea/participants.json``, docs/ISSUES #23) on
  every participant with a Synthea chart of the same label, labelled "Synthea synthetic
  EHR (simulated)", whose median pulse and breathing rate centre the simulated vitals.

Everything goes through the service layer with the admin backdating overrides,
so every seeded fact is audited and drafted exactly like a live check-in.
Nothing here is participant data: no names, no demographics.

Deviation from §4.5 of the synthetic README (logged for the docs owner): the
seeded samples carry ``window_s`` = 12 / 30 / 60 depending on which metrics
are published (the bridge contract, D-003), not a flat 30; a flat 30 would make
every HRV reading "window too short" and draft an ``HRV_RMSSD`` row as NOT DONE.
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func
from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules import chartscan
from interim_rules.tables import items, load_table

from .audit import SYSTEM_ACTOR, Actor, append_event, head, verify_chain
from .db import Database, create_all, drop_all, make_engine
from .models import (
    Draft,
    Escalation,
    Packet,
    Participant,
    SAEClock,
    Session,
    SponsorQuery,
    Study,
    User,
)
from .services.baseline import SYNTHEA_LABEL, baseline_from_synthea, load_cohort
from .services.briefs import record_visit
from .services.dashboard import ack_escalation
from .services.drafts import confirm_draft
from .services.exports import post_mock_edc, records_for
from .services.notes import ingest_note
from .services.packets import create_packet, report_past_aesi_clocks, sign_packet
from .services.participants import create_participant
from .services.queries import answer_query, suggested_answer_for
from .services.sessions import (
    complete_session,
    create_session,
    record_answer,
    record_gates,
    record_vitals,
)
from .services.settings_svc import ensure_defaults
from .settings import Settings
from .util import dump_json, load_json, now_iso, seconds_between, shift
from .writers.template import TemplateWriter

log = logging.getLogger("interim_api.seed")

SEED = 20261010
SEED_ACTOR = Actor(id="admin", role="admin")
COORDINATOR_ACTOR = Actor(id="coordinator", role="coordinator")
INVESTIGATOR_ACTOR = Actor(id="investigator", role="investigator")

USERS: tuple[tuple[str, str, str], ...] = (
    ("coordinator", "coordinator", "Demo Coordinator (research nurse)"),
    ("investigator", "investigator", "Demo Investigator"),
    ("admin", "admin", "Demo Admin"),
)


# --------------------------------------------------------------------------- #
# Profile table (data/synthetic/README.md §4.3)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PriorCheckIn:
    days_ago: int
    answers: Mapping[str, Mapping[str, int]] = field(default_factory=dict)
    conmed: tuple[str, str] | None = None
    """(verbatim text, direction) when the con-med gate is yes."""
    consent_camera: bool = True
    hospitalization: bool = False
    """The seriousness gate: a hospital or ER visit since the last visit (SAE clock)."""


@dataclass(frozen=True)
class Profile:
    label: str
    checkins: tuple[PriorCheckIn, ...]
    why: str


def _sev_int(sev: int, inter: int) -> dict[str, int]:
    return {"severity": sev, "interference": inter}


PROFILES: tuple[Profile, ...] = (
    Profile(
        "P-001",
        (
            PriorCheckIn(55, {"fatigue": _sev_int(1, 0)}),
            PriorCheckIn(34, {"fatigue": _sev_int(1, 0)}),
            PriorCheckIn(13, {"fatigue": _sev_int(1, 0)}),
        ),
        "quiet persistent G1 fatigue; flat sparkline",
    ),
    Profile(
        "P-002",
        (
            PriorCheckIn(40, {"rash": {"presence": 1}}),
            PriorCheckIn(6, {"rash": {"presence": 1}, "itching": {"severity": 2}}),
        ),
        "presence-only rash (G1 convention); moderate itching makes Tier 1; the d6 check-in "
        "keeps Rash and Pruritus open so chart note N2 (2 days ago) links as a follow-up",
    ),
    Profile(
        "P-003",
        (
            PriorCheckIn(24, {"diarrhea": {"frequency": 2}}),
            PriorCheckIn(18, {"diarrhea": {"frequency": 3}}),
            PriorCheckIn(12, {"diarrhea": {"frequency": 4}}, conmed=("loperamide", "started")),
            PriorCheckIn(6, {"diarrhea": {"frequency": 3}}),
        ),
        "colitis-like trajectory G1 -> G2 -> G3 (Tier 2, acked; possible-AESI report signed) "
        "-> improving on loperamide; six days apart, so one Diarrhea AE with follow-ups, and "
        "the overnight G3 (Monday morning) is a follow-up of the same AE",
    ),
    Profile("P-004", (PriorCheckIn(45), PriorCheckIn(20)), "entirely quiet"),
    Profile(
        "P-005",
        (
            PriorCheckIn(50, {"nausea": {"frequency": 1, "severity": 1}}),
            PriorCheckIn(
                29, {"nausea": {"frequency": 2, "severity": 2}}, conmed=("Zofran", "started")
            ),
            PriorCheckIn(8, {"nausea": {"frequency": 1, "severity": 1}}),
        ),
        "brand -> generic normalization (Zofran -> ondansetron)",
    ),
    Profile(
        "P-006",
        (
            PriorCheckIn(48, {"joint_pain": _sev_int(2, 2)}, conmed=("ibuprofen", "started")),
            PriorCheckIn(27, {"joint_pain": _sev_int(2, 2)}),
            PriorCheckIn(6, {"joint_pain": _sev_int(2, 2)}),
        ),
        "persistent G2 arthralgia; 21 days apart so three separate AEs (documented limitation)",
    ),
    Profile(
        "P-007",
        (
            PriorCheckIn(47, {"fatigue": _sev_int(1, 0)}),
            PriorCheckIn(26),
            PriorCheckIn(5, {"cough": _sev_int(1, 0)}),
        ),
        "the demo participant: open Cough AE from 5 days ago for the follow-up link",
    ),
    Profile(
        "P-008",
        (PriorCheckIn(33, conmed=("vitamin d", "started")), PriorCheckIn(9)),
        "a con-med change with no symptoms",
    ),
    Profile(
        "P-009",
        (
            PriorCheckIn(58, {"fatigue": _sev_int(1, 0)}),
            PriorCheckIn(41, {"fatigue": _sev_int(2, 2)}),
            PriorCheckIn(30, {"fatigue": _sev_int(3, 3)}),
            PriorCheckIn(15, {"fatigue": _sev_int(2, 2)}),
        ),
        "severe fatigue episode (Tier 2, acked) that improves",
    ),
    Profile(
        "P-010",
        (
            PriorCheckIn(44),
            PriorCheckIn(23, {"mouth_sores": _sev_int(2, 2)}),
            PriorCheckIn(7, {"mouth_sores": _sev_int(1, 1)}),
        ),
        "stomatitis that resolves; 16 days apart so a new AE",
    ),
    Profile(
        "P-011",
        (
            PriorCheckIn(36, {"itching": {"severity": 1}}),
            PriorCheckIn(11, {"cough": _sev_int(1, 0)}),
        ),
        "two different G1 symptoms",
    ),
    Profile(
        "P-012",
        (
            PriorCheckIn(49),
            PriorCheckIn(28, consent_camera=False),
            PriorCheckIn(
                7,
                {"fever_or_chills": {"presence": 1}, "fatigue": _sev_int(2, 2)},
                hospitalization=True,
            ),
            PriorCheckIn(4),
        ),
        "the d28 session declines the camera: fully functional with vitals off; last week "
        "(d7) a hospital admission with fever -> Tier 3 + SAE clock, its initial report "
        "signed within 24 h and a follow-up report due (outcome and causality still missing)",
    ),
)
"""35 prior check-ins in total; the engine (not this table) decides tiers and grades."""


# --------------------------------------------------------------------------- #
# Simulated vitals (data/synthetic/README.md §4.5)
# --------------------------------------------------------------------------- #

PULSE_GATE_S, BREATHING_GATE_S, HRV_GATE_S = 12, 30, 60
CONF_RAMP_S = 15


def resting_samples(
    rng: random.Random,
    *,
    started_at: str,
    duration_s: int,
    baseline_pulse: float,
    baseline_breathing: float,
) -> list[dict[str, Any]]:
    """One simulated sample per second with AR(1) noise and the bridge's timing gates.

    Every sample is ``source = "mock"``, ``is_measured = False``: labeled simulated
    all the way to the exports.
    """
    samples: list[dict[str, Any]] = []
    pulse_noise = breathing_noise = hrv_noise = 0.0
    hrv_base = rng.uniform(25.0, 55.0)
    for t in range(duration_s):
        pulse_noise = 0.8 * pulse_noise + rng.gauss(0.0, 1.2)
        breathing_noise = 0.85 * breathing_noise + rng.gauss(0.0, 0.5)
        hrv_noise = 0.9 * hrv_noise + rng.gauss(0.0, 1.5)
        ramp = min(1.0, t / CONF_RAMP_S)
        conf = 0.3 + 0.65 * ramp
        if t >= CONF_RAMP_S:
            conf = min(0.99, max(0.6, 0.95 + rng.uniform(-0.03, 0.03)))
        flags: list[str] = []
        sample: dict[str, Any] = {
            "ts_utc": shift(started_at, seconds=t),
            "source": "mock",
            "is_measured": False,
            "pulse_bpm": None,
            "pulse_conf": None,
            "breathing_bpm": None,
            "breathing_conf": None,
            "hrv_rmssd_ms": None,
            "hrv_conf": None,
            "window_s": 0.0,
            "quality_flags": flags,
        }
        if t >= PULSE_GATE_S:
            sample["pulse_bpm"] = round(baseline_pulse + pulse_noise, 1)
            sample["pulse_conf"] = round(conf, 2)
            sample["window_s"] = float(PULSE_GATE_S)
        else:
            flags.append("gate_pending_pulse")
        if t >= BREATHING_GATE_S:
            sample["breathing_bpm"] = round(baseline_breathing + breathing_noise, 1)
            sample["breathing_conf"] = round(conf, 2)
            sample["window_s"] = float(BREATHING_GATE_S)
        else:
            flags.append("gate_pending_breathing")
        if t >= HRV_GATE_S:
            sample["hrv_rmssd_ms"] = round(max(5.0, hrv_base + hrv_noise), 1)
            sample["hrv_conf"] = round(rng.uniform(0.7, 0.9), 2)
            sample["window_s"] = float(HRV_GATE_S)
        else:
            flags.append("gate_pending_hrv")
        samples.append(sample)
    return samples


# --------------------------------------------------------------------------- #
# Study / users
# --------------------------------------------------------------------------- #


def load_study_record(settings: Settings) -> dict[str, Any]:
    path = settings.public_data_dir / "study.json"
    if not path.is_file():
        log.error(
            "%s is missing; using a minimal placeholder study. Run "
            "`python scripts/fetch_public.py --offline` to restore the public record.",
            path,
        )
        return {
            "study_id": "DEMO-STUDY",
            "nct_id": settings.demo_nct_id,
            "title_display": "Demo study (registry record unavailable)",
            "sponsor": "unknown",
            "phase": "unknown",
            "status": None,
            "conditions": [],
            "intervention_names": [],
            "fetched_at": now_iso(),
            "official_url": f"https://clinicaltrials.gov/study/{settings.demo_nct_id}",
        }
    with path.open(encoding="utf-8") as fh:
        record = json.load(fh)
    if record.get("nct_id") != settings.demo_nct_id:
        log.warning(
            "DEMO_NCT_ID=%s but the cached study.json is %s; the API never fetches at runtime, "
            "run scripts/fetch_public.py --only study --nct %s to change it",
            settings.demo_nct_id,
            record.get("nct_id"),
            settings.demo_nct_id,
        )
    return record


def seed_study(db: DbSession, settings: Settings) -> Study:
    record = load_study_record(settings)
    title = record.get("title")
    study = Study(
        study_id=str(record["study_id"]),
        nct_id=str(record["nct_id"]),
        title=str(record.get("title_display") or (title or {}).get("brief") or record["nct_id"]),
        title_official=(title or {}).get("official") if isinstance(title, dict) else None,
        sponsor=str(record.get("sponsor", "")),
        phase=str(record.get("phase", "")),
        status=record.get("status"),
        conditions_json=dump_json(record.get("conditions", [])),
        interventions_json=dump_json(record.get("intervention_names", [])),
        fetched_at=str(record.get("fetched_at", now_iso())),
        source_url=str(record.get("official_url") or record.get("source_url", "")),
    )
    db.add(study)
    db.flush()
    return study


def seed_users(db: DbSession, now: str) -> None:
    for username, role, display in USERS:
        db.add(User(username=username, role=role, display_name=display, created_at=now))
    db.flush()


# --------------------------------------------------------------------------- #
# Participants + prior check-ins
# --------------------------------------------------------------------------- #


def _zero_answers() -> dict[str, dict[str, int]]:
    return {item.id: dict.fromkeys(item.attributes, 0) for item in items()}


def _merged(overrides: Mapping[str, Mapping[str, int]]) -> dict[str, dict[str, int]]:
    out = _zero_answers()
    for item_id, attrs in overrides.items():
        out.setdefault(item_id, {}).update(attrs)
    return out


def _session_times(rng: random.Random, now: str, days_ago: int, offset_min: int) -> tuple[str, str]:
    """``started_at`` (09:00-15:30 UTC + per-participant offset) and ``completed_at`` (+4-7 min)."""
    day = shift(now, days=-days_ago)
    date = day[:10]
    hour = rng.randint(9, 15)
    minute = rng.randint(0, 30 if hour == 15 else 59)
    started = f"{date}T{hour:02d}:{minute:02d}:00.000Z"
    started = shift(started, seconds=offset_min * 60 + rng.randint(0, 59))
    completed = shift(started, seconds=rng.randint(240, 420))
    return started, completed


def seed_checkin(
    db: DbSession,
    settings: Settings,
    participant: Participant,
    checkin: PriorCheckIn,
    *,
    rng: random.Random,
    started_at: str,
    completed_at: str,
) -> tuple[Session, dict[str, Any]]:
    """One backdated kiosk check-in through the service layer: session, answers, gates,
    simulated resting vitals around the participant's baseline, completion by the engine."""
    baseline = load_json(participant.baseline_vitals_json, {}) or {}
    duration = int(round(seconds_between(started_at, completed_at)))
    session = create_session(
        db,
        usubjid=participant.usubjid,
        consent_camera=checkin.consent_camera,
        override_actor=SEED_ACTOR,
        started_at_override=started_at,
        now=started_at,
    )
    ts = started_at
    for item_id, attrs in _merged(checkin.answers).items():
        for attribute, value in attrs.items():
            ts = shift(ts, seconds=rng.randint(6, 15))
            record_answer(
                db,
                session,
                item_id=item_id,
                attribute=attribute,
                value=value,
                value_text=None,
                ts_client=ts,
                now=ts,
            )
    ts = shift(ts, seconds=rng.randint(6, 15))
    record_gates(
        db,
        session,
        hospitalization=checkin.hospitalization,
        conmed_changed=checkin.conmed is not None,
        conmed_text=checkin.conmed[0] if checkin.conmed else None,
        conmed_direction=checkin.conmed[1] if checkin.conmed else None,
        other_text="",
        temp_c=None,
        ts_client=ts,
        now=ts,
    )
    if checkin.consent_camera:
        samples = resting_samples(
            rng,
            started_at=started_at,
            duration_s=duration,
            baseline_pulse=float(baseline.get("pulse_bpm") or 72.0),
            baseline_breathing=float(baseline.get("breathing_bpm") or 14.0),
        )
        for start in range(0, len(samples), 120):
            batch = samples[start : start + 120]
            record_vitals(
                db,
                session,
                batch,
                posted_by=SEED_ACTOR,
                measured_allowed=True,  # admin-driven; every seeded sample is simulated anyway
                now=batch[-1]["ts_utc"],
            )
    response, _ = complete_session(
        db,
        settings,
        session,
        ts_client=completed_at,
        override_actor=SEED_ACTOR,
        completed_at_override=completed_at,
        now=completed_at,
    )
    return session, response


def _simulated_baseline(
    rng: random.Random, synthea: Mapping[str, Any] | None
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """``(baseline_vitals, synthea_profile)``. The two random draws always happen (so the
    rest of the seed stays deterministic with or without the cohort file); a Synthea chart
    replaces them with its median pulse and breathing rate."""
    pulse = float(rng.randint(58, 84))
    breathing = float(rng.randint(12, 17))
    if synthea is None:
        return {
            "pulse_bpm": pulse,
            "breathing_bpm": breathing,
            "source": "mock",
            "is_measured": False,
            "note": "simulated baseline",
        }, None
    profile = baseline_from_synthea(synthea, synthea.get("_reference_date"))
    synthea_pulse = (profile.get("pulse_bpm") or {}).get("median")
    synthea_breathing = (profile.get("breathing_bpm") or {}).get("median")
    return {
        "pulse_bpm": float(synthea_pulse) if synthea_pulse is not None else pulse,
        "breathing_bpm": float(synthea_breathing) if synthea_breathing is not None else breathing,
        "source": "synthea",
        "is_measured": False,
        "note": "simulated baseline",
        "basis": "median of the Synthea chart's encounter vitals (" + SYNTHEA_LABEL + "); "
        "the kiosk's resting vitals are simulated around it",
    }, profile


def _report_past_sae_clock(
    db: DbSession, session_id: str, *, before: str, prepared_at: str, signed_at: str
) -> Packet | None:
    """Seed history only: a past SAE clock gets its initial report, prepared by the
    coordinator and signed by the investigator inside the 24 hours (template writer, mock
    EDC). Outcome, action taken and causality stay missing: the follow-up report is due."""
    clock = db.exec(
        select(SAEClock)
        .where(SAEClock.session_id == session_id)
        .where(SAEClock.kind == "sae")
        .where(SAEClock.stopped_at == None)  # noqa: E711
    ).first()
    if clock is None or clock.due_at >= before:
        return None
    packet, _ = create_packet(db, COORDINATOR_ACTOR, clock.id, TemplateWriter(), now=prepared_at)
    signed, _ = sign_packet(
        db,
        INVESTIGATOR_ACTOR,
        packet,
        note="seed: initial report signed within 24 h; follow-up due when the outcome and "
        "the hospital records arrive",
        narrative_reviewed=True,
        missing_info_acknowledged=True,
        now=signed_at,
    )
    return signed


def demo_phone(label: str) -> str | None:
    """R6: a synthetic mobile number in the fictional 555-01xx range (P-007 -> +17325550167)."""
    digits = re.sub(r"\D", "", label)
    return f"+1732555{160 + int(digits):04d}" if digits and int(digits) < 40 else None


def seed_participant(
    db: DbSession,
    settings: Settings,
    study: Study,
    profile: Profile,
    *,
    rng: random.Random,
    now: str,
    synthea: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    baseline_vitals, synthea_profile = _simulated_baseline(rng, synthea)
    offset_min = rng.randint(0, 40)
    earliest = max(c.days_ago for c in profile.checkins)
    enrolled_days = rng.randint(max(75, earliest + 10), 120)
    participant: Participant = create_participant(
        db,
        study,
        display_label=profile.label,
        enrolled_at=shift(now, days=-enrolled_days),
        baseline_vitals=baseline_vitals,
        baseline=synthea_profile,
        phone=demo_phone(profile.label),
        now=now,
    )
    summary: dict[str, Any] = {
        "usubjid": participant.usubjid,
        "sessions": [],
        "synthea_baseline": synthea_profile is not None,
    }
    for checkin in sorted(profile.checkins, key=lambda c: -c.days_ago):
        started_at, completed_at = _session_times(rng, now, checkin.days_ago, offset_min)
        session, response = seed_checkin(
            db,
            settings,
            participant,
            checkin,
            rng=rng,
            started_at=started_at,
            completed_at=completed_at,
        )
        # Confirm every AE draft as the coordinator (open AEs for timelines / dedup).
        confirmed_at = shift(completed_at, seconds=rng.randint(600, 2400))
        ae_rows = db.exec(
            select(Draft)
            .where(Draft.session_id == session.id)
            .where(Draft.domain == "AE")
            .where(Draft.status == "draft")
        ).all()
        for row in ae_rows:
            confirm_draft(
                db, COORDINATOR_ACTOR, row, note="seed: confirmed at review", now=confirmed_at
            )
        # Acknowledge Tier >= 2 escalations 20-50 minutes later.
        escalation = db.exec(select(Escalation).where(Escalation.session_id == session.id)).first()
        if escalation is not None:
            ack_at = shift(completed_at, seconds=rng.randint(1200, 3000))
            ack_escalation(
                db, COORDINATOR_ACTOR, escalation.id, note="seed: nurse called", now=ack_at
            )
        # [packets agent] A past possible-AESI clock was reported then (signed packet, mock EDC).
        report_past_aesi_clocks(
            db,
            session_id=session.id,
            before=now,
            at=shift(completed_at, seconds=7200),
            coordinator=COORDINATOR_ACTOR,
            investigator=INVESTIGATOR_ACTOR,
        )
        # A past SAE clock (the hospitalization gate) got its initial report the same day.
        sae_packet = _report_past_sae_clock(
            db,
            session.id,
            before=now,
            prepared_at=shift(completed_at, seconds=3600),
            signed_at=shift(completed_at, seconds=5 * 3600),
        )
        summary["sessions"].append(
            {
                "session_id": session.id,
                "days_ago": checkin.days_ago,
                "tier": response["tier"],
                "ae_confirmed": len(ae_rows),
                "escalation": escalation is not None,
                "sae_packet_id": sae_packet.id if sae_packet is not None else None,
            }
        )
    return summary


# --------------------------------------------------------------------------- #
# Chart notes (data/synthetic/README.md §4.6; CONTRACTS.md R2.4)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class NoteSeed:
    note_id: str
    ack_escalation: bool
    why: str
    ingested_hours_before_seed: float | None = None
    """When set, the note is part of the **overnight** set (Monday morning): it is ingested
    this many hours (±30 min) before the seed clock instead of on its re-anchored
    ``note_date``, in time order with the overnight kiosk check-ins."""
    dated_at_ingestion: bool = False
    """``note_date`` = the day it was ingested (a call logged the same night) instead of the
    answer key's re-anchored date (an outside record written days before it was read)."""
    note_type: str | None = None
    """Overrides the answer key's ``note_type`` (N3 is logged as a ``phone_call``, R4.1)."""
    caller: str | None = None
    call_direction: str | None = None
    label: str | None = None
    author: str | None = None
    text: str | None = None
    """A seed-only note (not in the scanner's answer key) carries its own label/author/text."""


N6_INGEST_HOURS_BEFORE_SEED = 3.0
"""The ED note is dated two days back but is *read* by the site ~3 h before the seed clock, so
its SAE clock (site awareness = ingestion) is a live ~21 h countdown on the first dashboard
load rather than an already-overdue one (CLAUDE.md §3.4(f) "show a live countdown"). Outside
ED records reaching the site a day or two late is the realistic story, and it is exactly the
case ICH E2A's "site awareness" wording is about."""

URGENT_CARE_TEXT = (
    "Urgent care visit last evening: pruritic maculopapular rash, now spreading from the trunk "
    "to both legs and worse at night. Afebrile, no mucosal involvement, no blistering. Advised "
    "to contact the oncology study team in the morning."
)
"""Seed-only synthetic note (UC1). The scanner finds Pruritus + Rash maculo-papular, which
link as follow-ups to P-002's open AEs (the d6 check-in, then N2 two days ago)."""

NOTE_SEEDS: tuple[NoteSeed, ...] = (
    NoteSeed("N8", False, "routine visit: four negated symptoms, one con-med 'taking' (CM only)"),
    NoteSeed("N1", False, "diarrhea + nausea, loperamide started: opens two AEs for P-001"),
    NoteSeed("N4", False, "outside urgent-care record: sinusitis + headache, Augmentin started"),
    NoteSeed(
        "N2",
        False,
        "dermatology consult: Rash maculo-papular + Pruritus link as follow-ups to P-002's "
        "d6 check-in AEs (cross-source dedup)",
    ),
    NoteSeed("N5", False, "headache + oral ulcers; 'hx of migraines' and 'no nausea' are excluded"),
    NoteSeed("N7", False, "nurse call: Diarrhea + Nausea link as follow-ups to N1 (cross-note)"),
    # ---- overnight (Monday morning, CLAUDE.md §00.6) --------------------------------------
    NoteSeed(
        "N3",
        False,
        "overnight caregiver call (R4.1): the daughter reports increasing SOB and a dry cough "
        "-> urgent red flag, Tier 2 left for the coordinator; Dyspnea + Cough link as "
        "follow-ups to P-003's kiosk check-in an hour earlier",
        ingested_hours_before_seed=9.5,
        dated_at_ingestion=True,
        note_type="phone_call",
        caller="caregiver",
        call_direction="inbound",
        author="On-call triage RN",
    ),
    NoteSeed(
        "UC1",
        False,
        "overnight urgent-care record for P-002: Pruritus + Rash maculo-papular link as "
        "follow-ups to the open AEs (Tier 1)",
        ingested_hours_before_seed=6.0,
        dated_at_ingestion=True,
        label="P-002",
        author="Outside urgent care record",
        note_type="outside_record",
        text=URGENT_CARE_TEXT,
    ),
    NoteSeed(
        "N6",
        False,
        "ER note dated two days back, read by the site ~3 h before the seed clock: urgent red "
        "flags + hospitalization -> Tier 2 and an SAE clock started at ingestion (live "
        "countdown), escalation not yet acknowledged; the report packet is pre-filled",
        ingested_hours_before_seed=N6_INGEST_HOURS_BEFORE_SEED,
    ),
)
"""History notes are ingested in time order on their re-anchored days; the overnight ones
(``ingested_hours_before_seed``) are ingested with the overnight kiosk check-ins, in time
order. ``ack_escalation`` says whether the seed acknowledges the note's Tier 2 escalation."""


@dataclass(frozen=True)
class OvernightCheckIn:
    label: str
    hours_before_seed: float
    checkin: PriorCheckIn
    why: str


OVERNIGHT_CHECKINS: tuple[OvernightCheckIn, ...] = (
    OvernightCheckIn(
        "P-004",
        13.0,
        PriorCheckIn(0),
        "routine: nothing to report (Tier 0)",
    ),
    OvernightCheckIn(
        "P-011",
        12.0,
        PriorCheckIn(
            0, {"rash": {"presence": 1}, "itching": {"severity": 2}}, ("prednisone", "started")
        ),
        "itchy rash (Pruritus G2 -> Tier 1) and 'prednisone' started: a discouraged systemic "
        "corticosteroid (protocol §7.7.2 p.69), flagged for the coordinator with the "
        "protocol's exception text; no tier change",
    ),
    OvernightCheckIn(
        "P-003",
        10.5,
        PriorCheckIn(
            0,
            {
                "diarrhea": {"frequency": 4},
                "shortness_of_breath": _sev_int(2, 2),
                "cough": _sev_int(1, 0),
            },
        ),
        "diarrhea 'almost constantly' (composite 3 -> G3, potentially immune-related colitis) "
        "-> possible-AESI 24-hour clock + Tier 2; moderate shortness of breath and a mild "
        "cough (the caregiver calls about them an hour later)",
    ),
)
"""The three overnight kiosk check-ins (CLAUDE.md §00.6). Not a rash: rash is a yes/no item
and can only reach G1, so the G3 that starts the possible-AESI clock is diarrhea."""

QUERY_SEEDS: tuple[tuple[str, str, int, int | None], ...] = (
    ("P-003", "loperamide", 6, 5),
    ("P-005", "Zofran", 3, None),
)
"""(participant, CMTRT verbatim, posted to the mock EDC N days ago, answered N days ago or
``None`` = still open). The sponsor-side edit check ``query.cm_required_fields_missing``
raises one query per record (dose, unit, frequency, indication missing; protocol §7.7)."""

NEXT_VISIT_LABEL = "P-003"
PREVIOUS_VISIT_DAYS_AGO = 20
"""Cemiplimab is given every 3 weeks: the previous visit 20 days ago, the next one tomorrow."""


def note_cases() -> dict[str, chartscan.AnswerKeyCase]:
    """The eight synthetic notes, from the rules package's answer key (identical to
    ``data/synthetic/chart_notes.json`` by test), so the Docker image needs no extra file."""
    return {c.note_id: c for c in chartscan.answer_key() if c.kind == "note" and c.note_id}


def note_anchor_date() -> str:
    """The answer key's reference date: note dates are re-anchored relative to it."""
    return str(load_table("chartscan_answer_key")["utterance_ref_date"])


def _days_before_anchor(note_date: str, anchor: str) -> int:
    return int(
        round(seconds_between(f"{note_date}T00:00:00.000Z", f"{anchor}T00:00:00.000Z") / 86_400)
    )


def _note_source(entry: NoteSeed, cases: Mapping[str, chartscan.AnswerKeyCase]) -> dict[str, Any]:
    """Label, author, type, text and answer-key date of a note seed."""
    if entry.text is not None:
        return {
            "label": entry.label or "",
            "author": entry.author or "unknown",
            "note_type": entry.note_type or "note",
            "text": entry.text,
            "note_date": None,
        }
    case = cases[entry.note_id]
    return {
        "label": case.usubjid_label,
        "author": entry.author or case.author or "unknown",
        "note_type": entry.note_type or case.note_type or "note",
        "text": case.text,
        "note_date": case.note_date,
    }


def _plan_note(
    entry: NoteSeed,
    cases: Mapping[str, chartscan.AnswerKeyCase],
    *,
    rng: random.Random,
    now: str,
    anchor: str,
) -> tuple[str, str, int]:
    """``(note_date, ingested_at, days_ago)`` relative to the seed clock."""
    src = _note_source(entry, cases)
    days_ago = _days_before_anchor(src["note_date"], anchor) if src["note_date"] else 0
    day = shift(now, days=-days_ago)[:10]
    if entry.ingested_hours_before_seed is not None:
        ingested_at = shift(
            now,
            seconds=-int(entry.ingested_hours_before_seed * 3600) + rng.randint(-1800, 1800),
        )
    else:
        ingested_at = shift(
            f"{day}T{rng.randint(9, 16):02d}:{rng.randint(0, 59):02d}:00.000Z",
            seconds=rng.randint(0, 59),
        )
    if entry.dated_at_ingestion:
        day = ingested_at[:10]
        days_ago = int(round(seconds_between(f"{day}T00:00:00.000Z", now) // 86_400))
    return day, ingested_at, days_ago


def _ingest_seed_note(
    db: DbSession,
    settings: Settings,
    study: Study,
    entry: NoteSeed,
    cases: Mapping[str, chartscan.AnswerKeyCase],
    *,
    rng: random.Random,
    note_date: str,
    ingested_at: str,
    days_ago: int,
) -> dict[str, Any]:
    src = _note_source(entry, cases)
    usubjid = f"{study.study_id}-{src['label']}"
    detail = ingest_note(
        db,
        settings,
        COORDINATOR_ACTOR,
        usubjid=usubjid,
        note_date=note_date,
        author=src["author"],
        note_type=src["note_type"],
        text=src["text"],
        ingested_at_override=ingested_at,
        override_actor=SEED_ACTOR,
        now=ingested_at,
        caller=entry.caller,
        call_direction=entry.call_direction,
    )
    escalation = detail["escalation"]
    if escalation is not None and entry.ack_escalation:
        ack_at = shift(ingested_at, seconds=rng.randint(1800, 5400))
        ack_escalation(
            db,
            COORDINATOR_ACTOR,
            escalation["id"],
            note="seed: reviewed; investigator to record seriousness",
            now=ack_at,
        )
    return {
        "note_id": detail["note"]["id"],
        "case_id": entry.note_id,
        "usubjid": usubjid,
        "note_type": src["note_type"],
        "days_ago": days_ago,
        "ingested_at": ingested_at,
        "overnight": entry.ingested_hours_before_seed is not None,
        "tier": detail["tier"],
        "drafts": len(detail["drafts"]),
        "followups": sum(1 for d in detail["drafts"] if d["is_followup"]),
        "escalation": escalation is not None,
        "escalation_acked": bool(escalation) and entry.ack_escalation,
        "sae_clock": detail["sae_clock"] is not None,
    }


def seed_chart_notes(
    db: DbSession, settings: Settings, study: Study, *, rng: random.Random, now: str
) -> list[dict[str, Any]]:
    """Ingest the history notes (not the overnight ones) for their participants, backdated.

    Each note keeps its distance from the answer key's reference date (N1 is 5 days
    before 2026-10-10, so it is dated 5 days before the seed clock) and its
    ``note_date`` is rewritten to that day; ``ingested_at`` is the same day at
    09:00-17:00 UTC. That keeps the demo's cross-source follow-up links valid on any
    seed date (dedup compares against the seed-relative check-ins).
    """
    cases = note_cases()
    anchor = note_anchor_date()
    planned: list[tuple[NoteSeed, str, str, int]] = []
    for entry in NOTE_SEEDS:
        if entry.ingested_hours_before_seed is not None:
            continue
        day, ingested_at, days_ago = _plan_note(entry, cases, rng=rng, now=now, anchor=anchor)
        planned.append((entry, day, ingested_at, days_ago))
    # Chronological by the moment the site read each note, so the audit chain reads naturally
    # and same-participant follow-ups (N7 onto N1) see their predecessor already open.
    planned.sort(key=lambda p: (p[2], p[0].note_id))
    return [
        _ingest_seed_note(
            db,
            settings,
            study,
            entry,
            cases,
            rng=rng,
            note_date=day,
            ingested_at=ingested_at,
            days_ago=days_ago,
        )
        for entry, day, ingested_at, days_ago in planned
    ]


# --------------------------------------------------------------------------- #
# Monday morning (CLAUDE.md §00.6, CONTRACTS R3.2 "Seed" + R4.5)
# --------------------------------------------------------------------------- #


def seed_overnight(
    db: DbSession, settings: Settings, study: Study, *, rng: random.Random, now: str
) -> dict[str, Any]:
    """The overnight set, in time order: kiosk check-ins and notes/calls, none acknowledged;
    then every running 24-hour clock gets its report packet pre-filled (template writer)."""
    cases = note_cases()
    anchor = note_anchor_date()
    events: list[tuple[str, str, Any, tuple[Any, ...]]] = []
    for oc in OVERNIGHT_CHECKINS:
        started = shift(now, seconds=-int(oc.hours_before_seed * 3600) + rng.randint(-900, 900))
        completed = shift(started, seconds=rng.randint(240, 420))
        events.append((completed, "checkin", oc, (started, completed)))
    for entry in NOTE_SEEDS:
        if entry.ingested_hours_before_seed is None:
            continue
        day, ingested_at, days_ago = _plan_note(entry, cases, rng=rng, now=now, anchor=anchor)
        events.append((ingested_at, "note", entry, (day, ingested_at, days_ago)))
    events.sort(key=lambda e: (e[0], e[1]))

    checkins: list[dict[str, Any]] = []
    notes: list[dict[str, Any]] = []
    for _, kind, item, extra in events:
        if kind == "checkin":
            started, completed = extra
            participant = db.get(Participant, f"{study.study_id}-{item.label}")
            assert participant is not None, item.label
            session, response = seed_checkin(
                db,
                settings,
                participant,
                item.checkin,
                rng=rng,
                started_at=started,
                completed_at=completed,
            )
            checkins.append(
                {
                    "session_id": session.id,
                    "label": item.label,
                    "completed_at": completed,
                    "tier": response["tier"],
                }
            )
        else:
            day, ingested_at, days_ago = extra
            notes.append(
                _ingest_seed_note(
                    db,
                    settings,
                    study,
                    item,
                    cases,
                    rng=rng,
                    note_date=day,
                    ingested_at=ingested_at,
                    days_ago=days_ago,
                )
            )

    # Interim pre-fills the report for every 24-hour clock still running (CLAUDE.md §00.2):
    # the coordinator arrives to a drafted packet and narrative, to review, never to sign.
    running = db.exec(
        select(SAEClock).where(SAEClock.stopped_at == None)  # noqa: E711
    ).all()
    prefilled: list[dict[str, Any]] = []
    for clock in sorted(running, key=lambda c: (c.site_awareness_at, c.id)):
        packet, _ = create_packet(
            db,
            SYSTEM_ACTOR,
            clock.id,
            TemplateWriter(),
            now=shift(clock.site_awareness_at, seconds=90),
        )
        prefilled.append({"packet_id": packet.id, "clock_id": clock.id, "kind": clock.kind})
    return {"checkins": checkins, "notes": notes, "packets_prefilled": prefilled}


def _current_cm_draft(db: DbSession, usubjid: str, cmtrt: str) -> Draft | None:
    rows = db.exec(
        select(Draft)
        .where(Draft.usubjid == usubjid)
        .where(Draft.domain == "CM")
        .where(Draft.status == "draft")
        .where(Draft.session_id != None)  # noqa: E711
    ).all()
    for row in sorted(rows, key=lambda d: (d.created_at, d.id)):
        if (load_json(row.fields_json, {}) or {}).get("CMTRT") == cmtrt:
            return row
    return None


def seed_queries(
    db: DbSession, study: Study, *, rng: random.Random, now: str
) -> list[dict[str, Any]]:
    """R4.5: CM records confirmed and posted to the mock EDC last week; the sponsor's edit
    check raises a query on each; one is answered (with a dose correction, re-confirmed),
    one is still open."""
    out: list[dict[str, Any]] = []
    for label, cmtrt, posted_days_ago, answered_days_ago in QUERY_SEEDS:
        usubjid = f"{study.study_id}-{label}"
        draft = _current_cm_draft(db, usubjid, cmtrt)
        assert draft is not None, (label, cmtrt)
        session = db.get(Session, draft.session_id) if draft.session_id else None
        reviewed_from = (
            session.completed_at if session and session.completed_at else draft.created_at
        )
        confirmed = confirm_draft(
            db,
            COORDINATOR_ACTOR,
            draft,
            note="seed: confirmed at review",
            now=shift(reviewed_from, seconds=rng.randint(600, 2400)),
        )
        posted_at = shift(now, days=-posted_days_ago, seconds=rng.randint(-3600, 3600))
        records = [
            r for r in records_for(db, "CM", "confirmed") if r["INTERIM_DRAFT_ID"] == confirmed.id
        ]
        ack = post_mock_edc(db, COORDINATOR_ACTOR, "CM", records, now=posted_at)
        raised = ack["queries"]["raised_ids"]
        assert raised, (label, cmtrt, ack["queries"])
        query = db.get(SponsorQuery, raised[0])
        assert query is not None
        entry: dict[str, Any] = {
            "query_id": query.id,
            "label": label,
            "cmtrt": cmtrt,
            "draft_id": confirmed.id,
            "edc_ack_id": ack["ack_id"],
            "status": "open",
        }
        if answered_days_ago is not None:
            answered_at = shift(now, days=-answered_days_ago, seconds=rng.randint(-3600, 3600))
            written, _ = suggested_answer_for(db, query)
            answer_query(
                db,
                COORDINATOR_ACTOR,
                query,
                answer_text=str(written.get("text") or "").strip()
                + " Participant confirmed by phone: 2 mg after each loose stool, as needed, "
                "for diarrhea.",
                evidence_ids=None,
                also_edit={"field": "CMDOSE", "value": "2"},
                now=answered_at,
            )
            corrected = db.get(Draft, query.answer_edit_draft_id or "")
            if corrected is not None:
                confirm_draft(
                    db,
                    COORDINATOR_ACTOR,
                    corrected,
                    note="seed: re-confirmed after answering the sponsor query",
                    now=shift(answered_at, seconds=120),
                )
            entry["status"] = query.status
        out.append(entry)
    return out


def seed_visits(db: DbSession, study: Study, *, now: str) -> list[dict[str, Any]]:
    """The brief participant's previous (completed) and next (scheduled, tomorrow) visits."""
    participant = db.get(Participant, f"{study.study_id}-{NEXT_VISIT_LABEL}")
    assert participant is not None
    previous_day = shift(now, days=-PREVIOUS_VISIT_DAYS_AGO)[:10]
    recorded_at = f"{previous_day}T16:30:00.000Z"
    rows = [
        record_visit(
            db,
            COORDINATOR_ACTOR,
            participant,
            visit_date=previous_day,
            status="completed",
            label="Cycle 4 Day 1 (synthetic)",
            now=recorded_at,
        ),
        record_visit(
            db,
            COORDINATOR_ACTOR,
            participant,
            visit_date=shift(now, days=1)[:10],
            status="scheduled",
            label="Cycle 5 Day 1 (synthetic)",
            now=recorded_at,
        ),
    ]
    return [{"visit_id": r.id, "visit_date": r.visit_date, "status": r.status} for r in rows]


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def is_seeded(db: DbSession) -> bool:
    return db.exec(select(func.count()).select_from(Study)).one() > 0


def seed_database(
    db: DbSession,
    settings: Settings,
    *,
    now: str | None = None,
    genesis_action: str = "demo.seed",
    previous_chain: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Seed an empty database. Returns a summary dict (participants, sessions, tiers).

    ``previous_chain`` (a demo reset) is written into the genesis payload, so the new chain
    records the head hash and length of the chain it replaced."""
    stamp = now or now_iso()
    rng = random.Random(SEED)
    genesis: dict[str, Any] = {"seed": SEED, "at": stamp, "note": "all participants are synthetic"}
    if previous_chain is not None:
        genesis["previous_chain"] = dict(previous_chain)
    append_event(db, SEED_ACTOR, genesis_action, "database", "seed", genesis, ts_utc=stamp)
    study = seed_study(db, settings)
    seed_users(db, stamp)
    ensure_defaults(db, settings, stamp)
    cohort = load_cohort(settings.public_data_dir)
    participants = [
        seed_participant(
            db,
            settings,
            study,
            profile,
            rng=rng,
            now=stamp,
            synthea=cohort.get(profile.label),
        )
        for profile in PROFILES
    ]
    notes = seed_chart_notes(db, settings, study, rng=rng, now=stamp)
    overnight = seed_overnight(db, settings, study, rng=rng, now=stamp)
    queries = seed_queries(db, study, rng=rng, now=stamp)
    visits = seed_visits(db, study, now=stamp)
    all_notes = notes + overnight["notes"]
    n_sessions = sum(len(p["sessions"]) for p in participants) + len(overnight["checkins"])
    tiers = [s["tier"] for p in participants for s in p["sessions"]] + [
        c["tier"] for c in overnight["checkins"]
    ]
    note_tiers = [n["tier"] for n in all_notes]
    summary = {
        "study_id": study.study_id,
        "nct_id": study.nct_id,
        "participants": len(participants),
        "synthea_baselines": sum(1 for p in participants if p["synthea_baseline"]),
        "sessions": n_sessions,
        "tier_counts": {str(t): tiers.count(t) for t in range(4)},
        "notes": len(all_notes),
        "note_tier_counts": {str(t): note_tiers.count(t) for t in range(4)},
        "note_followups": sum(n["followups"] for n in all_notes),
        "note_escalations": sum(1 for n in all_notes if n["escalation"]),
        "note_sae_clocks": sum(1 for n in all_notes if n["sae_clock"]),
        "overnight": {
            "checkins": len(overnight["checkins"]),
            "notes": sum(1 for n in overnight["notes"] if n["note_type"] != "phone_call"),
            "calls": sum(1 for n in overnight["notes"] if n["note_type"] == "phone_call"),
            "packets_prefilled": len(overnight["packets_prefilled"]),
        },
        "signed_packets": sum(
            1 for p in participants for s in p["sessions"] if s.get("sae_packet_id")
        ),
        "queries": {
            "open": sum(1 for q in queries if q["status"] == "open"),
            "answered": sum(1 for q in queries if q["status"] == "answered"),
        },
        "visits": len(visits),
        "seeded_at": stamp,
    }
    append_event(db, SEED_ACTOR, "demo.seeded", "database", "seed", summary, ts_utc=stamp)
    log.info("seeded %s", summary)
    return summary


def seed_if_empty(database: Database, settings: Settings) -> dict[str, Any] | None:
    with database.write_scope() as db:
        if is_seeded(db):
            return None
        return seed_database(db, settings)


def reset_and_seed(
    database: Database, settings: Settings, actor: Actor, *, reseed: bool = True
) -> dict[str, Any]:
    """Drop every table, recreate, write a fresh genesis event and (optionally) reseed.

    The chain being destroyed is summarized first (head hash, event count, whether it
    verified, running SAE/AESI clocks, signed packets) and that summary goes into the new
    genesis event, so "verify: green" after a reset still shows that history was replaced."""
    previous = previous_chain_summary(database, reset_by=actor.id)
    with database.write_lock:
        drop_all(database.engine)
        create_all(database.engine)
    stamp = now_iso()
    with database.write_scope() as db:
        if reseed:
            summary = seed_database(
                db, settings, now=stamp, genesis_action="demo.reset", previous_chain=previous
            )
        else:
            append_event(
                db,
                actor,
                "demo.reset",
                "database",
                "reset",
                {"reseed": False, "previous_chain": previous},
                ts_utc=stamp,
            )
            ensure_defaults(db, settings, stamp)
            seed_users(db, stamp)
            summary = {"participants": 0, "sessions": 0, "notes": 0, "seeded_at": stamp}
    return {
        "ok": True,
        "reseed": reseed,
        "reset_by": actor.id,
        "previous_chain": previous,
        **summary,
    }


def previous_chain_summary(database: Database, *, reset_by: str) -> dict[str, Any]:
    """What a reset is about to destroy; empty-chain values when the tables are missing."""
    try:
        with database.write_scope() as db:
            check = verify_chain(db)
            last = head(db)
            clocks = db.exec(select(SAEClock)).all()
            running = sum(1 for c in clocks if c.stopped_at is None)
            signed = sum(1 for p in db.exec(select(Packet)).all() if p.status == "signed")
    except Exception:  # noqa: BLE001 - a fresh/broken DB must not block a reset
        return {"head_hash": None, "events": 0, "verified": None, "reset_by": reset_by}
    return {
        "head_hash": last.hash if last is not None else None,
        "events": last.seq if last is not None else 0,
        "verified": check["ok"],
        "running_clocks": running,
        "signed_packets": signed,
        "reset_by": reset_by,
        "reset_at": now_iso(),
    }


# --------------------------------------------------------------------------- #
# CLI (scripts/seed.py is a thin wrapper around this)
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the Interim demo database.")
    parser.add_argument("--reset", action="store_true", help="wipe every table and reseed")
    parser.add_argument("--database-url", default=None, help="override DATABASE_URL")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = Settings() if args.database_url is None else Settings(database_url=args.database_url)
    url = settings.resolved_database_url
    database = Database(make_engine(url))
    create_all(database.engine)
    if args.reset:
        result = reset_and_seed(database, settings, SEED_ACTOR, reseed=True)
    else:
        seeded = seed_if_empty(database, settings)
        result = seeded or {"ok": True, "skipped": "database already seeded; use --reset to wipe"}
    print(json.dumps({"database_url": url, **result}, indent=2))
    database.dispose()
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())


__all__ = [
    "NOTE_SEEDS",
    "OVERNIGHT_CHECKINS",
    "PROFILES",
    "QUERY_SEEDS",
    "SEED",
    "is_seeded",
    "main",
    "reset_and_seed",
    "resting_samples",
    "seed_chart_notes",
    "seed_database",
    "seed_checkin",
    "seed_if_empty",
    "seed_overnight",
    "seed_queries",
    "seed_visits",
]
