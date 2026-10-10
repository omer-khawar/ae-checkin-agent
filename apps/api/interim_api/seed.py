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
  ``ingested_at_override``, re-anchored to the seed clock (README §4.6):
  note-sourced drafts in the queue, two Tier 2 note escalations (N6 acknowledged,
  N3 left open), one SAE clock started at ingestion (N6), and cross-source
  follow-up links (N2 onto P-002's check-in AEs; N7 onto N1's).

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
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func
from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules import chartscan
from interim_rules.tables import items, load_table

from .audit import Actor, append_event
from .db import Database, create_all, drop_all, make_engine
from .models import Draft, Escalation, Participant, Study, User
from .services.dashboard import ack_escalation
from .services.drafts import confirm_draft
from .services.notes import ingest_note
from .services.participants import create_participant
from .services.sessions import (
    complete_session,
    create_session,
    record_answer,
    record_gates,
    record_vitals,
)
from .services.settings_svc import ensure_defaults
from .settings import Settings
from .util import dump_json, now_iso, seconds_between, shift

log = logging.getLogger("interim_api.seed")

SEED = 20261010
SEED_ACTOR = Actor(id="admin", role="admin")
COORDINATOR_ACTOR = Actor(id="coordinator", role="coordinator")

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
            PriorCheckIn(52, {"diarrhea": {"frequency": 2}}),
            PriorCheckIn(38, {"diarrhea": {"frequency": 3}}),
            PriorCheckIn(24, {"diarrhea": {"frequency": 4}}, conmed=("loperamide", "started")),
            PriorCheckIn(10, {"diarrhea": {"frequency": 3}}),
        ),
        "colitis-like trajectory G1 -> G2 -> G3 (Tier 2, acked) -> improving on loperamide",
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
        (PriorCheckIn(49), PriorCheckIn(28, consent_camera=False), PriorCheckIn(4)),
        "the d28 session declines the camera: fully functional with vitals off",
    ),
)
"""34 prior check-ins in total; the engine (not this table) decides tiers and grades."""


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


def seed_participant(
    db: DbSession,
    settings: Settings,
    study: Study,
    profile: Profile,
    *,
    rng: random.Random,
    now: str,
) -> dict[str, Any]:
    baseline_pulse = float(rng.randint(58, 84))
    baseline_breathing = float(rng.randint(12, 17))
    offset_min = rng.randint(0, 40)
    earliest = max(c.days_ago for c in profile.checkins)
    enrolled_days = rng.randint(max(75, earliest + 10), 120)
    participant: Participant = create_participant(
        db,
        study,
        display_label=profile.label,
        enrolled_at=shift(now, days=-enrolled_days),
        baseline_vitals={
            "pulse_bpm": baseline_pulse,
            "breathing_bpm": baseline_breathing,
            "source": "mock",
            "is_measured": False,
            "note": "simulated baseline",
        },
        now=now,
    )
    summary: dict[str, Any] = {"usubjid": participant.usubjid, "sessions": []}
    for checkin in sorted(profile.checkins, key=lambda c: -c.days_ago):
        started_at, completed_at = _session_times(rng, now, checkin.days_ago, offset_min)
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
            hospitalization=False,
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
                baseline_pulse=baseline_pulse,
                baseline_breathing=baseline_breathing,
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
        summary["sessions"].append(
            {
                "session_id": session.id,
                "days_ago": checkin.days_ago,
                "tier": response["tier"],
                "ae_confirmed": len(ae_rows),
                "escalation": escalation is not None,
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
    NoteSeed(
        "N6",
        True,
        "ED note: urgent red flags + hospitalization -> Tier 2 and an SAE clock started at "
        "ingestion; the coordinator acknowledged, the clock waits for the investigator",
    ),
    NoteSeed(
        "N3",
        False,
        "triage phone note: increasing SOB -> urgent red flag, Tier 2 left unacknowledged so "
        "the Escalations page has live work",
    ),
    NoteSeed("N7", False, "nurse call: Diarrhea + Nausea link as follow-ups to N1 (cross-note)"),
)
"""Ingestion order is chronological (oldest note first); ``ack_escalation`` says whether the
seed acknowledges the note's Tier 2 escalation as the coordinator."""


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


def seed_chart_notes(
    db: DbSession, settings: Settings, study: Study, *, rng: random.Random, now: str
) -> list[dict[str, Any]]:
    """Ingest the eight notes for their mapped participants, backdated.

    Each note keeps its distance from the answer key's reference date (N1 is 5 days
    before 2026-10-10, so it is ingested 5 days before the seed clock) and its
    ``note_date`` is rewritten to that day; ``ingested_at`` is the same day at
    09:00-17:00 UTC. That keeps the demo's cross-source follow-up links valid on
    any seed date (dedup compares against the seed-relative check-ins).
    """
    cases = note_cases()
    anchor = note_anchor_date()
    ordered = sorted(
        NOTE_SEEDS,
        key=lambda n: (-_days_before_anchor(cases[n.note_id].note_date, anchor), n.note_id),
    )
    out: list[dict[str, Any]] = []
    for entry in ordered:
        case = cases[entry.note_id]
        days_ago = _days_before_anchor(case.note_date, anchor)
        day = shift(now, days=-days_ago)[:10]
        ingested_at = shift(
            f"{day}T{rng.randint(9, 16):02d}:{rng.randint(0, 59):02d}:00.000Z",
            seconds=rng.randint(0, 59),
        )
        usubjid = f"{study.study_id}-{case.usubjid_label}"
        detail = ingest_note(
            db,
            settings,
            COORDINATOR_ACTOR,
            usubjid=usubjid,
            note_date=day,
            author=case.author or "unknown",
            note_type=case.note_type or "note",
            text=case.text,
            ingested_at_override=ingested_at,
            override_actor=SEED_ACTOR,
            now=ingested_at,
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
        out.append(
            {
                "note_id": detail["note"]["id"],
                "case_id": entry.note_id,
                "usubjid": usubjid,
                "days_ago": days_ago,
                "tier": detail["tier"],
                "drafts": len(detail["drafts"]),
                "followups": sum(1 for d in detail["drafts"] if d["is_followup"]),
                "escalation": escalation is not None,
                "escalation_acked": bool(escalation) and entry.ack_escalation,
                "sae_clock": detail["sae_clock"] is not None,
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def is_seeded(db: DbSession) -> bool:
    return db.exec(select(func.count()).select_from(Study)).one() > 0


def seed_database(
    db: DbSession, settings: Settings, *, now: str | None = None, genesis_action: str = "demo.seed"
) -> dict[str, Any]:
    """Seed an empty database. Returns a summary dict (participants, sessions, tiers)."""
    stamp = now or now_iso()
    rng = random.Random(SEED)
    append_event(
        db,
        SEED_ACTOR,
        genesis_action,
        "database",
        "seed",
        {"seed": SEED, "at": stamp, "note": "all participants are synthetic"},
        ts_utc=stamp,
    )
    study = seed_study(db, settings)
    seed_users(db, stamp)
    ensure_defaults(db, settings, stamp)
    participants = [
        seed_participant(db, settings, study, profile, rng=rng, now=stamp) for profile in PROFILES
    ]
    notes = seed_chart_notes(db, settings, study, rng=rng, now=stamp)
    n_sessions = sum(len(p["sessions"]) for p in participants)
    tiers = [s["tier"] for p in participants for s in p["sessions"]]
    note_tiers = [n["tier"] for n in notes]
    summary = {
        "study_id": study.study_id,
        "nct_id": study.nct_id,
        "participants": len(participants),
        "sessions": n_sessions,
        "tier_counts": {str(t): tiers.count(t) for t in range(4)},
        "notes": len(notes),
        "note_tier_counts": {str(t): note_tiers.count(t) for t in range(4)},
        "note_followups": sum(n["followups"] for n in notes),
        "note_escalations": sum(1 for n in notes if n["escalation"]),
        "note_sae_clocks": sum(1 for n in notes if n["sae_clock"]),
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
    """Drop every table, recreate, write a fresh genesis event and (optionally) reseed."""
    with database.write_lock:
        drop_all(database.engine)
        create_all(database.engine)
    stamp = now_iso()
    with database.write_scope() as db:
        if reseed:
            summary = seed_database(db, settings, now=stamp, genesis_action="demo.reset")
        else:
            append_event(
                db, actor, "demo.reset", "database", "reset", {"reseed": False}, ts_utc=stamp
            )
            ensure_defaults(db, settings, stamp)
            seed_users(db, stamp)
            summary = {"participants": 0, "sessions": 0, "notes": 0, "seeded_at": stamp}
    return {"ok": True, "reseed": reseed, "reset_by": actor.id, **summary}


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
    "PROFILES",
    "SEED",
    "is_seeded",
    "main",
    "reset_and_seed",
    "resting_samples",
    "seed_chart_notes",
    "seed_database",
    "seed_if_empty",
]
