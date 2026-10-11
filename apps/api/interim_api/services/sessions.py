"""The kiosk flow: start a session, record answers/gates/vitals, complete.

Every function here is what the matching ``/sessions`` endpoint does, minus HTTP,
so the seed script and the eval harness can drive a check-in in-process and
get the identical audit trail. Kiosk-originated events are attributed to the
participant (``role = participant``); when an admin used an override field
(backdating, per-session settings) the admin's identity is recorded in the
event payload as ``override_by``.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules import evaluate_checkin
from interim_rules.serialize import protocol_context_from, result_to_dict
from interim_rules.tables import item_by_id, items, vitals_config

from ..audit import BRIDGE_ACTOR, Actor, append_event
from ..models import Answer, Participant, Session, Study, VitalsSample
from ..problems import problem
from ..settings import Settings
from ..util import dump_json, load_json, new_id, normalize_iso, now_iso, seconds_between
from .checkins import (
    EXTRA_CONMED_DIRECTION_PREFIX,
    EXTRA_CONMED_TEXT_PREFIX,
    GATE_ATTRIBUTE,
    GATE_CONMED,
    GATE_CONMED_DIRECTION,
    GATE_CONMED_TEXT,
    GATE_HOSPITALIZATION,
    GATE_ITEM_IDS,
    GATE_OTHER,
    GATE_TEMP_C,
    GATE_URGENT_NOW,
    DraftInput,
    apply_result,
    build_engine_input,
    session_answers,
    session_samples,
)
from .common import (
    get_study,
    require_open,
    session_to_dict,
    stop_screen_text,
    tier_action,
    tier_name,
)
from .participants import create_participant, resolve_participant
from .settings_svc import effective_rule_settings

log = logging.getLogger("interim_api.sessions")

ESCALATION_REASON_CATEGORIES = frozenset({"red_flag", "corroboration"})

CONSENT_BASIS = "enrollment_icf"
"""CLAUDE.md §00 / D-026: camera use is covered by the informed consent form signed at
enrollment; every new session records this basis instead of a per-session consent screen."""


def participant_actor(usubjid: str) -> Actor:
    return Actor(id=usubjid, role="participant")


def _iso_or_422(value: str, what: str) -> str:
    try:
        return normalize_iso(value)
    except ValueError as exc:
        raise problem(422, f"{what}: {exc}", title="Invalid timestamp") from exc


# --------------------------------------------------------------------------- #
# Start
# --------------------------------------------------------------------------- #


def create_session(
    db: DbSession,
    *,
    usubjid: str,
    consent_camera: bool = True,
    override_actor: Actor | None = None,
    started_at_override: str | None = None,
    create_participant_if_missing: bool = False,
    is_eval: bool = False,
    protocol_context: Mapping[str, Any] | None = None,
    now: str | None = None,
) -> Session:
    """Start a check-in for a participant given by USUBJID or display label.

    ``protocol_context`` (admin only, CONTRACTS R3.1) is stored on the participant (created or
    existing) and read by the rules engine when the session completes."""
    stamp = now or now_iso()
    if protocol_context is not None:
        try:
            protocol_context_from(dict(protocol_context))
        except ValueError as exc:
            raise problem(422, str(exc), title="Invalid protocol context") from exc
    study: Study = get_study(db)
    participant: Participant | None = resolve_participant(db, study, usubjid)
    if participant is None:
        if create_participant_if_missing and override_actor is not None:
            label = usubjid.strip()
            prefix = f"{study.study_id}-"
            if label.startswith(prefix):
                label = label[len(prefix) :]
            participant = create_participant(
                db,
                study,
                display_label=label,
                usubjid=usubjid.strip(),
                protocol_context=dict(protocol_context) if protocol_context is not None else None,
                is_eval=is_eval,
                now=stamp,
            )
        else:
            raise problem(
                404, f"No participant with usubjid {usubjid.strip()}", title="Participant not found"
            )
    if protocol_context is not None:
        stored = dump_json(dict(protocol_context))
        if participant.protocol_context_json != stored:
            participant.protocol_context_json = stored
            db.add(participant)
            db.flush()
    started_at = stamp
    backdated = False
    if started_at_override is not None:
        started_at = _iso_or_422(started_at_override, "started_at_override")
        backdated = True
    session = Session(
        id=new_id(),
        usubjid=participant.usubjid,
        study_id=study.study_id,
        started_at=started_at,
        consent_camera=consent_camera,
        vitals_status="pending" if consent_camera else "declined",
        is_eval=is_eval or participant.is_eval,
        backdated=backdated,
        consent_basis=CONSENT_BASIS,
    )
    db.add(session)
    db.flush()
    actor = participant_actor(participant.usubjid)
    append_event(
        db,
        actor,
        "session.started",
        "session",
        session.id,
        {
            "usubjid": participant.usubjid,
            "display_label": participant.display_label,
            "started_at": started_at,
            "backdated": backdated,
            "override_by": override_actor.id if backdated and override_actor else None,
            "is_eval": session.is_eval,
            "protocol_context": dict(protocol_context) if protocol_context is not None else None,
        },
        ts_utc=stamp,
    )
    append_event(
        db,
        actor,
        "session.consent",
        "session",
        session.id,
        {
            "consent_camera": consent_camera,
            "consent_basis": CONSENT_BASIS,
            "camera": "on" if consent_camera else "turned off by the participant",
            "statement": "Camera use is covered by the informed consent form signed at "
            "enrollment (no per-session consent screen, D-026). Camera frames are processed "
            "on the kiosk and never stored; only derived pulse/breathing metrics leave the "
            "bridge.",
        },
        ts_utc=stamp,
    )
    return session


# --------------------------------------------------------------------------- #
# Answers
# --------------------------------------------------------------------------- #


def record_answer(
    db: DbSession,
    session: Session,
    *,
    item_id: str,
    attribute: str,
    value: int,
    value_text: str | None,
    ts_client: str,
    now: str | None = None,
) -> tuple[Answer, bool]:
    """Insert or update the answer for ``(session, item, attribute)``; ``(row, created)``."""
    require_open(session)
    stamp = now or now_iso()
    try:
        item = item_by_id(item_id)
    except ValueError as exc:
        raise problem(422, f"Unknown item_id {item_id!r}", title="Unknown item") from exc
    if not item.has(attribute):
        raise problem(
            422,
            f"Item {item_id!r} has no attribute {attribute!r} (it asks {list(item.attributes)})",
            title="Unknown attribute",
        )
    top = item.max_value(attribute)  # type: ignore[arg-type]
    if not 0 <= value <= top:
        raise problem(
            422,
            f"{item_id}.{attribute} must be between 0 and {top}, got {value}",
            title="Bad value",
        )
    client_ts = _iso_or_422(ts_client, "ts_client")
    actor = participant_actor(session.usubjid)
    existing = db.exec(
        select(Answer)
        .where(Answer.session_id == session.id)
        .where(Answer.item_id == item_id)
        .where(Answer.attribute == attribute)
    ).first()
    if existing is not None:
        before = {"value_int": existing.value_int, "value_text": existing.value_text}
        existing.value_int = value
        existing.value_text = value_text
        existing.ts_client = client_ts
        existing.ts_server = stamp
        db.add(existing)
        db.flush()
        append_event(
            db,
            actor,
            "answer.updated",
            "answer",
            existing.id,
            {
                "session_id": session.id,
                "item_id": item_id,
                "attribute": attribute,
                "before": before,
                "after": {"value_int": value, "value_text": value_text},
                "label": item.option_label(attribute, value),  # type: ignore[arg-type]
                "ts_client": client_ts,
            },
            ts_utc=stamp,
        )
        return existing, False
    row = Answer(
        id=new_id(),
        session_id=session.id,
        item_id=item_id,
        attribute=attribute,
        value_int=value,
        value_text=value_text,
        ts_client=client_ts,
        ts_server=stamp,
    )
    db.add(row)
    db.flush()
    append_event(
        db,
        actor,
        "answer.recorded",
        "answer",
        row.id,
        {
            "session_id": session.id,
            "item_id": item_id,
            "attribute": attribute,
            "value_int": value,
            "value_text": value_text,
            "label": item.option_label(attribute, value),  # type: ignore[arg-type]
            "ts_client": client_ts,
        },
        ts_utc=stamp,
    )
    return row, True


# --------------------------------------------------------------------------- #
# Gates
# --------------------------------------------------------------------------- #


def record_gates(
    db: DbSession,
    session: Session,
    *,
    hospitalization: bool,
    conmed_changed: bool,
    conmed_text: str | None,
    conmed_direction: str | None,
    other_text: str | None,
    temp_c: float | None,
    ts_client: str,
    now: str | None = None,
    urgent_now: bool | None = None,
    conmeds: Sequence[Mapping[str, Any]] | None = None,
) -> list[Answer]:
    """Store the gate answers as ``gate_*`` rows.

    R5.1: ``urgent_now`` (the kiosk's first question) is stored as ``gate_urgent_now`` when sent.
    R5.2: ``conmeds`` (the kiosk's list of medications, each ``{text, direction}``) is the
    source of truth when non-empty: the first entry takes the legacy ``gate_conmed_text`` /
    ``gate_conmed_direction`` rows and the others ``gate_conmed_text_2`` ... so every medication
    keeps its own answer id (the evidence of its CM draft).

    Like :func:`record_answer`, a re-submission (the kiosk's Back button) never
    deletes anything: an existing gate row is updated in place with an
    ``answer.updated`` event carrying before/after, a gate that no longer
    applies (e.g. the con-med name after the answer flipped to "no") is
    *blanked* (both values ``None``) with an ``answer.updated`` event marked
    ``cleared``, and new rows get ``answer.recorded``. Every answer id an
    earlier ``gates.recorded`` event mentioned therefore stays resolvable and
    the original values live on in the event chain (ALCOA+ "original").
    """
    require_open(session)
    stamp = now or now_iso()
    client_ts = _iso_or_422(ts_client, "ts_client")
    if conmed_direction is not None and conmed_direction not in ("started", "stopped", "both"):
        raise problem(422, f"conmed_direction {conmed_direction!r} is not started/stopped/both")

    entries = [
        (str(c.get("text") or ""), c.get("direction") or None)
        for c in (conmeds or [])
        if isinstance(c, Mapping)
    ]
    for _, entry_direction in entries:
        if entry_direction is not None and entry_direction not in ("started", "stopped", "both"):
            raise problem(422, f"conmeds direction {entry_direction!r} is not started/stopped/both")
    if entries:
        conmed_changed = True
        conmed_text, conmed_direction = entries[0]

    desired: dict[str, tuple[int | None, str | None]] = {
        GATE_HOSPITALIZATION: (int(hospitalization), None),
        GATE_CONMED: (int(conmed_changed), None),
    }
    if urgent_now is not None:
        desired[GATE_URGENT_NOW] = (int(urgent_now), None)
    if conmed_changed:
        # Verbatim, even when empty: a "yes" with no name is still a reported change.
        desired[GATE_CONMED_TEXT] = (None, conmed_text if conmed_text is not None else "")
        if conmed_direction is not None:
            desired[GATE_CONMED_DIRECTION] = (None, conmed_direction)
        for number, (extra_text, extra_direction) in enumerate(entries[1:], start=2):
            desired[f"{EXTRA_CONMED_TEXT_PREFIX}{number}"] = (None, extra_text)
            if extra_direction is not None:
                desired[f"{EXTRA_CONMED_DIRECTION_PREFIX}{number}"] = (None, extra_direction)
    if other_text is not None and other_text.strip() != "":
        desired[GATE_OTHER] = (None, other_text)
    if temp_c is not None:
        desired[GATE_TEMP_C] = (None, repr(float(temp_c)))

    existing = {
        row.item_id: row
        for row in db.exec(
            select(Answer)
            .where(Answer.session_id == session.id)
            .where(Answer.attribute == GATE_ATTRIBUTE)
        ).all()
    }
    actor = participant_actor(session.usubjid)
    created: list[str] = []
    updated: list[str] = []
    cleared: list[str] = []
    rows: list[Answer] = []

    def _update(row: Answer, value_int: int | None, value_text: str | None, *, clear: bool) -> None:
        before = {"value_int": row.value_int, "value_text": row.value_text}
        row.value_int = value_int
        row.value_text = value_text
        row.ts_client = client_ts
        row.ts_server = stamp
        db.add(row)
        db.flush()
        append_event(
            db,
            actor,
            "answer.updated",
            "answer",
            row.id,
            {
                "session_id": session.id,
                "item_id": row.item_id,
                "attribute": GATE_ATTRIBUTE,
                "before": before,
                "after": {"value_int": value_int, "value_text": value_text},
                "cleared": clear,
                "ts_client": client_ts,
            },
            ts_utc=stamp,
        )

    for item_id, (value_int, value_text) in desired.items():
        row = existing.get(item_id)
        if row is None:
            row = Answer(
                id=new_id(),
                session_id=session.id,
                item_id=item_id,
                attribute=GATE_ATTRIBUTE,
                value_int=value_int,
                value_text=value_text,
                ts_client=client_ts,
                ts_server=stamp,
            )
            db.add(row)
            db.flush()
            created.append(row.id)
            append_event(
                db,
                actor,
                "answer.recorded",
                "answer",
                row.id,
                {
                    "session_id": session.id,
                    "item_id": item_id,
                    "attribute": GATE_ATTRIBUTE,
                    "value_int": value_int,
                    "value_text": value_text,
                    "ts_client": client_ts,
                },
                ts_utc=stamp,
            )
        elif (row.value_int, row.value_text) != (value_int, value_text):
            _update(row, value_int, value_text, clear=False)
            updated.append(row.id)
        rows.append(row)
    for item_id, row in existing.items():
        if item_id not in desired and not is_blank_gate_row(row):
            _update(row, None, None, clear=True)
            cleared.append(row.id)

    append_event(
        db,
        actor,
        "gates.recorded",
        "session",
        session.id,
        {
            "answer_ids": {r.item_id: r.id for r in rows},
            "hospitalization": hospitalization,
            "urgent_now": urgent_now,
            "conmeds": [{"text": t, "direction": d} for t, d in entries] or None,
            "conmed_changed": conmed_changed,
            "conmed_text": conmed_text if conmed_changed else None,
            "conmed_direction": conmed_direction if conmed_changed else None,
            "other_text_present": bool(other_text and other_text.strip()),
            "other_text_chars": len(other_text or ""),
            "temp_c": temp_c,
            "resubmission": bool(existing),
            "created": created,
            "updated": updated,
            "cleared": cleared,
            "ts_client": client_ts,
            "note": "other_text is stored verbatim; at completion the deterministic scanner "
            "reads it (R5.2) and a person reviews it",
        },
        ts_utc=stamp,
    )
    return rows


# --------------------------------------------------------------------------- #
# Vitals
# --------------------------------------------------------------------------- #


def _reject_vitals(
    db: DbSession, session: Session, *, n: int, reason: str, posted_by: Actor | None, stamp: str
) -> None:
    """Audit a refused batch (nothing else is stored), then let the caller raise.

    The caller raises a ``Problem`` right after, which makes ``Database.write_scope``
    roll back; the event is committed here first so the refusal itself survives
    (a refused measured claim is exactly the kind of thing the chain must show).
    No sample row has been added at this point, so the commit carries only the event.
    """
    append_event(
        db,
        BRIDGE_ACTOR,
        "vitals.rejected",
        "session",
        session.id,
        {
            "n": n,
            "reason": reason,
            "consent_camera": session.consent_camera,
            "posted_by": posted_by.id if posted_by else None,
        },
        ts_utc=stamp,
    )
    db.commit()


def record_vitals(
    db: DbSession,
    session: Session,
    samples: Sequence[Mapping[str, Any]],
    *,
    posted_by: Actor | None = None,
    measured_allowed: bool = False,
    now: str | None = None,
) -> tuple[int, str]:
    """Persist a batch of snake_case samples; returns ``(accepted, vitals_status)``.

    Three refusals protect the "measured vs simulated" label (CLAUDE.md §0):

    * the participant turned the camera off for this session -> 409, nothing stored.
      There is no per-session consent gate any more (CLAUDE.md §00 / D-026: camera use is
      covered by the enrollment ICF, ``consent_basis = "enrollment_icf"``); a session with
      the camera on accepts samples with no further step;
    * a sample from a simulated source (``simulated_sources`` in
      ``vitals_corroboration.json``, i.e. ``mock``) claiming ``is_measured`` -> 422;
    * ``is_measured = true`` from a caller the API cannot vouch for -> 403.
      ``measured_allowed`` is set by the router when the bridge presented a
      configured ``X-Bridge-Token`` or the caller holds an admin token, and by
      the in-process seed / eval harness (admin-driven). With ``BRIDGE_TOKEN``
      empty, no HTTP caller can make a record say MEASURED.

    Every refusal is a ``vitals.rejected`` audit event.
    """
    require_open(session)
    stamp = now or now_iso()
    if not session.consent_camera:
        _reject_vitals(
            db,
            session,
            n=len(samples),
            reason="camera_turned_off",
            posted_by=posted_by,
            stamp=stamp,
        )
        raise problem(
            409,
            f"The participant turned the camera off for session {session.id}; "
            "vitals samples are not accepted",
            title="Camera turned off",
        )
    simulated_sources = vitals_config().simulated_sources
    for index, s in enumerate(samples):
        source = str(s.get("source", "mock"))
        claims_measured = bool(s.get("is_measured", False))
        if claims_measured and source in simulated_sources:
            _reject_vitals(
                db,
                session,
                n=len(samples),
                reason=f"samples[{index}]: simulated source {source!r} claims isMeasured",
                posted_by=posted_by,
                stamp=stamp,
            )
            raise problem(
                422,
                f"samples[{index}]: source {source!r} is simulated by definition "
                f"(vitals_corroboration.json simulated_sources) and cannot claim isMeasured=true",
                title="Simulated source claims measured",
            )
        if claims_measured and not measured_allowed:
            _reject_vitals(
                db,
                session,
                n=len(samples),
                reason=f"samples[{index}]: unverifiable isMeasured claim from {source!r}",
                posted_by=posted_by,
                stamp=stamp,
            )
            raise problem(
                403,
                f"samples[{index}]: isMeasured=true from source {source!r} is accepted only with "
                "a configured BRIDGE_TOKEN presented as X-Bridge-Token, or an admin bearer token. "
                "Set BRIDGE_TOKEN on the API and the bridge, or post the samples as simulated.",
                title="Measured claim not verifiable",
            )
    rows: list[VitalsSample] = []
    for index, s in enumerate(samples):
        ts = _iso_or_422(str(s.get("ts_utc", "")), f"samples[{index}].tsUtc")
        rows.append(
            VitalsSample(
                id=new_id(),
                session_id=session.id,
                ts_utc=ts,
                source=str(s.get("source", "mock")),
                is_measured=bool(s.get("is_measured", False)),
                pulse_bpm=s.get("pulse_bpm"),
                pulse_conf=s.get("pulse_conf"),
                breathing_bpm=s.get("breathing_bpm"),
                breathing_conf=s.get("breathing_conf"),
                hrv_rmssd_ms=s.get("hrv_rmssd_ms"),
                hrv_conf=s.get("hrv_conf"),
                window_s=float(s.get("window_s") or 0.0),
                quality_flags_json=dump_json(list(s.get("quality_flags") or [])),
            )
        )
    for row in rows:
        db.add(row)
    db.flush()
    ordered = sorted(rows, key=lambda r: r.ts_utc)
    sources = sorted({r.source for r in rows})
    append_event(
        db,
        BRIDGE_ACTOR,
        "vitals.batch",
        "session",
        session.id,
        {
            "n": len(rows),
            "first_ts": ordered[0].ts_utc,
            "last_ts": ordered[-1].ts_utc,
            "first_id": ordered[0].id,
            "last_id": ordered[-1].id,
            "sources": sources,
            "is_measured": sorted({r.is_measured for r in rows}),
            "simulated": any(r.source == "mock" or not r.is_measured for r in rows),
            "posted_by": posted_by.id if posted_by else None,
        },
        ts_utc=stamp,
    )
    return len(rows), session.vitals_status


# --------------------------------------------------------------------------- #
# Complete
# --------------------------------------------------------------------------- #


def escalation_reasons(result_dict: Mapping[str, Any]) -> list[str]:
    reasons = [
        str(r["description"])
        for r in result_dict.get("rules_fired", [])
        if r.get("category") in ESCALATION_REASON_CATEGORIES
    ]
    final = [
        str(r["description"])
        for r in result_dict.get("rules_fired", [])
        if r.get("rule_id") == "tier.final"
    ]
    return reasons + final


def is_blank_gate_row(row: Answer) -> bool:
    """A gate row whose answer was withdrawn on re-submission (both values ``None``)."""
    return row.attribute == GATE_ATTRIBUTE and row.value_int is None and row.value_text is None


def missing_instrument_parts(answers: Sequence[Answer]) -> list[str]:
    """Which of the 10 items' attributes and the yes/no gates have no answer yet.

    The instrument is fixed (CLAUDE.md §3.2): every item attribute and both yes/no
    gates must be answered before a check-in can be completed, so a record can
    never look like a clean Tier 0 "Log" when the questions were not asked.
    """
    present = {(a.item_id, a.attribute) for a in answers if not is_blank_gate_row(a)}
    missing = [
        f"{item.id}.{attribute}"
        for item in items()
        for attribute in item.attributes
        if (item.id, attribute) not in present
    ]
    missing.extend(
        gate
        for gate in (GATE_HOSPITALIZATION, GATE_CONMED)
        if (gate, GATE_ATTRIBUTE) not in present
    )
    return missing


def complete_session(
    db: DbSession,
    settings: Settings,
    session: Session,
    *,
    ts_client: str,
    override_actor: Actor | None = None,
    completed_at_override: str | None = None,
    settings_override: Mapping[str, Any] | None = None,
    now: str | None = None,
    ended_early: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run the rules engine and persist everything it decided.

    ``ended_early`` (R5.1; ``urgent_now`` or ``severe_dyspnea``) is the early-stop path: the
    instrument-completeness check is skipped, the unanswered items are "not reported" (the
    engine grades nothing it was not given) and the engine forces tier 3.

    Returns ``(complete_response, result_dict)``.
    """
    require_open(session)
    stamp = now or now_iso()
    client_ts = _iso_or_422(ts_client, "ts_client")
    completed_at = stamp
    if completed_at_override is not None:
        completed_at = _iso_or_422(completed_at_override, "completed_at_override")
        session.backdated = True
    if seconds_between(session.started_at, completed_at) < 0:
        raise problem(
            422,
            f"completed_at {completed_at} is before started_at {session.started_at}",
            title="Invalid completion time",
        )
    missing = [] if ended_early else missing_instrument_parts(session_answers(db, session.id))
    if missing:
        raise problem(
            422,
            f"The check-in is incomplete: {len(missing)} unanswered "
            f"({', '.join(missing[:6])}{', ...' if len(missing) > 6 else ''}). "
            "Every item attribute and both yes/no gates must be answered before completion.",
            title="Check-in incomplete",
            missing=missing,
        )
    study = get_study(db)
    rule_settings = effective_rule_settings(db, settings, dict(settings_override or {}))
    try:
        inp = build_engine_input(
            db, study, session, completed_at, rule_settings, ended_early=ended_early
        )
        result = evaluate_checkin(inp)
    except ValueError as exc:
        raise problem(422, f"The rules engine rejected the check-in: {exc}") from exc
    result_dict = result_to_dict(result)

    samples = session_samples(db, session.id)
    # Camera turned off by the participant means no vitals, whatever is in the table
    # (record_vitals refuses them); "declined" is used for that case only (D-026).
    vitals_status = "declined" if not session.consent_camera else result.vitals.status
    summary = result.vitals.summary

    session.completed_at = completed_at
    session.tier = result.escalation_tier
    session.stop_screen_shown = result.stop_screen
    session.vitals_status = vitals_status
    session.max_grade = result.max_grade
    session.is_measured = bool(summary.is_measured) if summary is not None else False
    session.settings_json = dump_json(rule_settings)
    session.result_json = dump_json(result_dict)
    db.add(session)
    db.flush()

    actor = participant_actor(session.usubjid)
    append_event(
        db,
        actor,
        "session.completed",
        "session",
        session.id,
        {
            "completed_at": completed_at,
            "ts_client": client_ts,
            "backdated": session.backdated,
            "override_by": override_actor.id if override_actor and session.backdated else None,
            "settings": rule_settings,
            "settings_override": dict(settings_override or {}),
            "tier": result.escalation_tier,
            "tier_name": tier_name(result.escalation_tier),
            "max_grade": result.max_grade,
            "vitals_status": vitals_status,
            "n_samples": len(samples),
            "seriousness_suspected": result.seriousness_suspected,
            "stop_screen": result.stop_screen,
            "page_oncall": result.page_oncall,
            "n_rules_fired": len(result.rules_fired),
            "n_drafts": len(result.drafts),
            "ended_early": ended_early,
        },
        ts_utc=stamp,
    )
    if ended_early:
        append_event(
            db,
            actor,
            "session.ended_early",
            "session",
            session.id,
            {
                "trigger": ended_early,
                "completed_at": completed_at,
                "ts_client": client_ts,
                "tier": result.escalation_tier,
                "unanswered_not_reported": True,
                "note": "The kiosk stopped at once; the items not yet asked are not reported "
                "(never zero-filled into a grade).",
            },
            ts_utc=stamp,
        )
    for rule in result_dict["rules_fired"]:
        append_event(db, actor, "rule.fired", "session", session.id, rule, ts_utc=stamp)

    outcome = apply_result(
        db,
        actor,
        usubjid=session.usubjid,
        drafts=[DraftInput.from_record(d) for d in result.drafts],
        tier=result.escalation_tier,
        reasons=escalation_reasons(result_dict),
        seriousness_suspected=result.seriousness_suspected,
        sae_clock=result_dict.get("sae_clock"),
        aesi_clock=result_dict.get("aesi_clock"),
        page_oncall=result.page_oncall,
        reported_at=completed_at,
        session_id=session.id,
        source="check_in",
        now=stamp,
    )
    log.info(
        "session %s completed: tier %s (%s), grades max %s, vitals %s, %d drafts, %d rules",
        session.id,
        result.escalation_tier,
        tier_name(result.escalation_tier),
        result.max_grade,
        vitals_status,
        len(outcome.drafts),
        len(result.rules_fired),
    )
    response = complete_response(session, result.escalation_tier, result.stop_screen, ended_early)
    return response, result_dict


def complete_response(
    session: Session, tier: int, stop_screen: bool, ended_early: str | None = None
) -> dict[str, Any]:
    """The body of ``POST /complete`` (and of ``/urgent``, which adds ``ended_early``)."""
    response: dict[str, Any] = {
        "session_id": session.id,
        "tier": tier,
        "tier_name": tier_name(tier),
        "tier_action": tier_action(tier),
        "stop_screen": stop_screen,
        "checkin_url": f"/dashboard/checkins/{session.id}",
        "session": session_to_dict(session),
    }
    if stop_screen:
        response["stop_screen_text"] = stop_screen_text(tier)
    if ended_early:
        response["ended_early"] = ended_early
    return response


def _upsert_gate_row(
    db: DbSession,
    session: Session,
    item_id: str,
    *,
    value_int: int | None,
    value_text: str | None,
    client_ts: str,
    stamp: str,
) -> Answer:
    """Insert or update one ``gate_*`` row with the same audit events ``record_gates`` writes."""
    actor = participant_actor(session.usubjid)
    row = db.exec(
        select(Answer)
        .where(Answer.session_id == session.id)
        .where(Answer.item_id == item_id)
        .where(Answer.attribute == GATE_ATTRIBUTE)
    ).first()
    if row is None:
        row = Answer(
            id=new_id(),
            session_id=session.id,
            item_id=item_id,
            attribute=GATE_ATTRIBUTE,
            value_int=value_int,
            value_text=value_text,
            ts_client=client_ts,
            ts_server=stamp,
        )
        db.add(row)
        db.flush()
        append_event(
            db,
            actor,
            "answer.recorded",
            "answer",
            row.id,
            {
                "session_id": session.id,
                "item_id": item_id,
                "attribute": GATE_ATTRIBUTE,
                "value_int": value_int,
                "value_text": value_text,
                "ts_client": client_ts,
            },
            ts_utc=stamp,
        )
    elif (row.value_int, row.value_text) != (value_int, value_text):
        before = {"value_int": row.value_int, "value_text": row.value_text}
        row.value_int = value_int
        row.value_text = value_text
        row.ts_client = client_ts
        row.ts_server = stamp
        db.add(row)
        db.flush()
        append_event(
            db,
            actor,
            "answer.updated",
            "answer",
            row.id,
            {
                "session_id": session.id,
                "item_id": item_id,
                "attribute": GATE_ATTRIBUTE,
                "before": before,
                "after": {"value_int": value_int, "value_text": value_text},
                "cleared": False,
                "ts_client": client_ts,
            },
            ts_utc=stamp,
        )
    return row


def end_session_early(
    db: DbSession,
    settings: Settings,
    session: Session,
    *,
    trigger: str,
    ts_client: str,
    now: str | None = None,
) -> dict[str, Any]:
    """R5.1: the kiosk stopped at once (``urgent_now`` = yes, or severe/very severe dyspnea).

    Records ``gate_urgent_now = 1`` when the trigger is ``urgent_now``, completes the session
    with the answers given so far (unanswered items are not reported, never zero-filled into a
    grade), forces tier 3 with a stop screen, pages on-call and returns the ``/complete`` body
    plus ``ended_early``. Idempotent: a second call for a session that already ended early with
    the same trigger returns the same body; any other completed session is a 409.
    """
    if trigger not in ("urgent_now", "severe_dyspnea"):
        raise problem(422, f"trigger {trigger!r} is not urgent_now/severe_dyspnea")
    if session.completed_at is not None:
        stored = load_json(session.result_json, {})
        if stored.get("ended_early") == trigger:
            return complete_response(
                session, int(session.tier or 0), bool(session.stop_screen_shown), trigger
            )
        require_open(session)  # 409: completed some other way
    stamp = now or now_iso()
    client_ts = _iso_or_422(ts_client, "ts_client")
    if trigger == "urgent_now":
        _upsert_gate_row(
            db,
            session,
            GATE_URGENT_NOW,
            value_int=1,
            value_text=None,
            client_ts=client_ts,
            stamp=stamp,
        )
    response, _ = complete_session(
        db, settings, session, ts_client=ts_client, now=stamp, ended_early=trigger
    )
    return response


__all__ = [
    "GATE_ITEM_IDS",
    "complete_session",
    "complete_response",
    "create_session",
    "end_session_early",
    "escalation_reasons",
    "is_blank_gate_row",
    "missing_instrument_parts",
    "participant_actor",
    "record_answer",
    "record_gates",
    "record_vitals",
]
