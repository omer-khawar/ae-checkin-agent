"""The evaluation harness (CLAUDE.md §8, CONTRACTS.md §2.2 + R2.2), in process.

Each persona in ``packages/rules/data/personas.json`` is replayed through the
**same service functions the kiosk endpoints call** (``create_session`` ->
``record_answer`` -> ``record_gates`` -> ``record_vitals`` -> ``complete_session``),
as its own fresh eval participant (``is_eval = true``, hidden from the queue),
so open AEs never leak between personas or runs. ``setup.prior_checkins`` are
replayed first, backdated with the admin override, and their AE drafts are
confirmed so the main check-in can exercise de-duplication.

Every key present in ``expected`` that the harness knows how to compute is
compared; unknown keys are reported as notices, never as failures. The shipped
personas are deterministic and must pass 100%.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Mapping, Sequence
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules import chartscan
from interim_rules.serialize import sample_from
from interim_rules.tables import data_dir, items, protocol_rules, seriousness_config

from .. import API_VERSION
from ..audit import Actor, append_event
from ..models import AEOpen, Draft, EvalRun, Session
from ..problems import problem
from ..schemas import CustomPersona
from ..settings import Settings
from ..util import dump_json, iso_date, load_json, new_id, now_iso, shift
from .common import get_study, tier_name
from .drafts import confirm_draft
from .notes import ingest_note
from .participants import create_participant
from .sessions import (
    complete_session,
    create_session,
    record_answer,
    record_gates,
    record_vitals,
)

SESSION_SECONDS = 180
"""Kiosk time from session start to completion; persona vitals offsets are relative to start."""

KNOWN_EXPECTED_KEYS: frozenset[str] = frozenset(
    {
        "grades",
        "max_grade",
        "tier",
        "stop_screen",
        "red_flag_tier_floor",
        "corroboration_bump",
        "rules_fired_includes",
        "rules_fired_excludes",
        "sae_clock_started",
        "seriousness_suspected",
        "ae_drafts",
        "vs_drafts",
        "vs_not_done",
        "cm",
        "dedup_followups",
        "vitals_status",
        # R3.1 protocol logic (possible AESI + its 24 h clock, protocol tier floor).
        "aesi_suspected",
        "aesi_items",
        "aesi_clock_started",
        "protocol_tier_floor",
    }
)

TIERS: tuple[str, ...] = ("0", "1", "2", "3")


# --------------------------------------------------------------------------- #
# Answer key
# --------------------------------------------------------------------------- #

PROTOCOL_CHECK_PREFIXES: tuple[str, ...] = ("aesi", "protocol_tier_floor")
"""Mismatch prefixes that count against the "possible AESI / protocol" correctness block."""


def _compare_protocol(
    actual: Mapping[str, Any],
    expected: Mapping[str, Any],
    aesi_clock: Mapping[str, Any] | None,
    completed_at: str,
    check: Any,
) -> None:
    """R3.1 expectations: possible AESI, its items, its 24 h clock, the protocol tier floor."""
    if "aesi_suspected" in expected:
        check("aesi_suspected", actual["aesi_suspected"], expected["aesi_suspected"])
    if "aesi_items" in expected:
        check("aesi_items", actual["aesi_items"], sorted(expected["aesi_items"]))
    if "aesi_clock_started" in expected:
        check("aesi_clock_started", actual["aesi_clock_started"], expected["aesi_clock_started"])
        if aesi_clock is not None:
            hours = protocol_rules().aesi.reporting_hours
            check("aesi_clock.kind", aesi_clock.get("kind"), "aesi")
            check("aesi_clock.site_awareness_at", aesi_clock.get("site_awareness_at"), completed_at)
            check("aesi_clock.due_at", aesi_clock.get("due_at"), shift(completed_at, hours=hours))
    if "protocol_tier_floor" in expected:
        check("protocol_tier_floor", actual["protocol_tier_floor"], expected["protocol_tier_floor"])


def load_answer_key() -> dict[str, Any]:
    path = data_dir() / "personas.json"
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def personas(*, include_hidden: bool = True) -> list[dict[str, Any]]:
    out = list(load_answer_key()["personas"])
    if not include_hidden:
        out = [p for p in out if not p.get("hidden")]
    return out


def persona_summaries() -> list[dict[str, Any]]:
    return [
        {
            "id": p["id"],
            "name": p["name"],
            "category": p["category"],
            "hidden": bool(p.get("hidden")),
            "description": p.get("description", ""),
            "story": p.get("story"),
            "expected_tier": (p.get("expected") or {}).get("tier"),
            "vitals_scenario": p.get("vitals_scenario"),
            "has_prior_checkins": bool((p.get("setup") or {}).get("prior_checkins")),
            "has_counterfactuals": bool(p.get("counterfactuals")),
        }
        for p in personas()
    ]


def persona_by_id(persona_id: str) -> dict[str, Any]:
    for p in personas():
        if p["id"] == persona_id:
            return p
    raise problem(404, f"No persona with id {persona_id!r}", title="Persona not found")


# --------------------------------------------------------------------------- #
# Replay
# --------------------------------------------------------------------------- #


def _materialize_samples(raw: Sequence[Mapping[str, Any]], started_at: str) -> list[dict[str, Any]]:
    """Persona samples (camelCase, ``tsOffsetS``) -> snake_case dicts with ``ts_utc``."""
    out = []
    for index, s in enumerate(raw):
        sample = sample_from(s, index, "eval", started_at)
        out.append(dataclasses.asdict(sample))
    return out


def _run_checkin(
    db: DbSession,
    settings: Settings,
    actor: Actor,
    *,
    usubjid: str,
    responses: Mapping[str, Mapping[str, int]],
    gates: Mapping[str, Any],
    vitals: Sequence[Mapping[str, Any]],
    consent_camera: bool,
    rule_settings: Mapping[str, Any] | None,
    completed_at: str,
) -> tuple[Session, dict[str, Any], dict[str, Any]]:
    started_at = shift(completed_at, seconds=-SESSION_SECONDS)
    session = create_session(
        db,
        usubjid=usubjid,
        consent_camera=consent_camera,
        override_actor=actor,
        started_at_override=started_at,
        is_eval=True,
        now=started_at,
    )
    # Answer-key convention: an item or attribute a persona omits means "none / never" (0).
    # It is recorded as an explicit 0 so the session satisfies the completeness check that
    # a kiosk check-in must satisfy (sessions.missing_instrument_parts).
    full: dict[str, dict[str, int]] = {
        item.id: dict.fromkeys(item.attributes, 0) for item in items()
    }
    for item_id, attrs in responses.items():
        full.setdefault(item_id, {}).update({str(k): int(v) for k, v in attrs.items()})
    for item_id, attrs in full.items():
        for attribute, value in attrs.items():
            record_answer(
                db,
                session,
                item_id=item_id,
                attribute=attribute,
                value=int(value),
                value_text=None,
                ts_client=completed_at,
                now=completed_at,
            )
    record_gates(
        db,
        session,
        hospitalization=bool(gates.get("hospitalization", False)),
        conmed_changed=bool(gates.get("conmed_changed", False)),
        conmed_text=gates.get("conmed_text"),
        conmed_direction=gates.get("conmed_direction") or None,
        other_text=gates.get("other_text"),
        temp_c=gates.get("temp_c"),
        ts_client=completed_at,
        now=completed_at,
    )
    if vitals:
        # The harness is admin-driven and its sessions are eval-only (hidden from the queue and
        # the exports), so a persona may legitimately say "suppose the sensor measured this".
        record_vitals(
            db,
            session,
            _materialize_samples(vitals, started_at),
            posted_by=actor,
            measured_allowed=True,
            now=completed_at,
        )
    response, result = complete_session(
        db,
        settings,
        session,
        ts_client=completed_at,
        override_actor=actor,
        completed_at_override=completed_at,
        settings_override=dict(rule_settings or {}),
        now=completed_at,
    )
    return session, response, result


def _confirm_ae_drafts(db: DbSession, actor: Actor, session_id: str, now: str) -> int:
    rows = db.exec(
        select(Draft)
        .where(Draft.session_id == session_id)
        .where(Draft.domain == "AE")
        .where(Draft.status == "draft")
    ).all()
    for row in rows:
        confirm_draft(
            db, actor, row, note="confirmed by the eval harness (prior check-in)", now=now
        )
    return len(rows)


def replay_persona(
    db: DbSession,
    settings: Settings,
    actor: Actor,
    persona: Mapping[str, Any],
    *,
    suffix: str,
    completed_at: str,
    rule_settings: Mapping[str, Any] | None = None,
) -> tuple[Session, dict[str, Any], dict[str, Any]]:
    """Replay one persona (priors first) as a fresh eval participant."""
    study = get_study(db)
    pid = str(persona.get("id") or f"custom-{new_id().lower()}")
    label = f"EVAL-{pid}"
    participant = create_participant(
        db,
        study,
        display_label=label,
        usubjid=f"{study.study_id}-{label}-{suffix}",
        enrolled_at=shift(completed_at, days=-90),
        protocol_context=persona.get("protocol_context"),
        is_eval=True,
        now=completed_at,
    )
    setup = persona.get("setup") or {}
    priors = sorted(setup.get("prior_checkins", []), key=lambda p: -float(p["days_ago"]))
    for prior in priors:
        prior_completed = shift(completed_at, days=-float(prior["days_ago"]))
        prior_vitals = prior.get("vitals_samples", [])
        prior_session, _, _ = _run_checkin(
            db,
            settings,
            actor,
            usubjid=participant.usubjid,
            responses=prior["responses"],
            gates=prior.get("gates", {}),
            vitals=prior_vitals,
            consent_camera=bool(prior_vitals),
            rule_settings=persona.get("settings"),
            completed_at=prior_completed,
        )
        _confirm_ae_drafts(db, actor, prior_session.id, prior_completed)
    effective = dict(persona.get("settings") or {})
    if rule_settings is not None:
        effective.update(rule_settings)
    return _run_checkin(
        db,
        settings,
        actor,
        usubjid=participant.usubjid,
        responses=persona["responses"],
        gates=persona.get("gates", {}),
        vitals=persona.get("vitals_samples", []) if persona.get("consent_camera", True) else [],
        consent_camera=bool(persona.get("consent_camera", True)),
        rule_settings=effective,
        completed_at=completed_at,
    )


# --------------------------------------------------------------------------- #
# Comparison
# --------------------------------------------------------------------------- #


def _draft_value(draft: Mapping[str, Any], name: str) -> Any:
    for f in draft.get("fields", []):
        if f.get("name") == name:
            return f.get("value")
    return None


def compare(
    db: DbSession,
    result: Mapping[str, Any],
    expected: Mapping[str, Any],
    *,
    usubjid: str,
    completed_at: str,
) -> tuple[dict[str, Any], list[str], list[str]]:
    """Return ``(actual, mismatches, notices)`` for every expected key the harness knows."""
    mismatches: list[str] = []
    notices: list[str] = []
    fired = [str(r["rule_id"]) for r in result.get("rules_fired", [])]
    drafts = result.get("drafts", [])
    ae_drafts = [d for d in drafts if d["domain"] == "AE"]
    vs_drafts = [d for d in drafts if d["domain"] == "VS"]
    cm_drafts = [d for d in drafts if d["domain"] == "CM"]
    grades = {str(i["item_id"]): int(i["provisional_grade"]) for i in result.get("items", [])}
    sae_clock = result.get("sae_clock")
    aesi_clock = result.get("aesi_clock")
    protocol = result.get("protocol") or {}
    conmed = result.get("conmed")
    actual: dict[str, Any] = {
        "grades": grades,
        "max_grade": result.get("max_grade"),
        "tier": result.get("escalation_tier"),
        "stop_screen": result.get("stop_screen"),
        "page_oncall": result.get("page_oncall"),
        "red_flag_tier_floor": result.get("red_flag_tier_floor"),
        "corroboration_bump": result.get("corroboration_bump"),
        "rules_fired": fired,
        "sae_clock_started": sae_clock is not None,
        "sae_clock": sae_clock,
        "seriousness_suspected": result.get("seriousness_suspected"),
        "ae_drafts": len(ae_drafts),
        "vs_drafts": len(vs_drafts),
        "vs_not_done": sorted(
            str(_draft_value(d, "VSTESTCD"))
            for d in vs_drafts
            if _draft_value(d, "VSSTAT") == "NOT DONE"
        ),
        "cm": [
            {
                "verbatim": _draft_value(d, "CMTRT"),
                "cmdecod": _draft_value(d, "CMDECOD"),
                "confidence": _draft_value(d, "INTERIM_MATCH_CONFIDENCE"),
                "match_kind": _draft_value(d, "INTERIM_MATCH_KIND"),
                "direction": _draft_value(d, "INTERIM_DIRECTION"),
                "distance": conmed.get("distance") if conmed else None,
            }
            for d in cm_drafts
        ],
        "dedup_followups": sum(1 for d in ae_drafts if d.get("is_followup")),
        "vitals_status": (result.get("vitals") or {}).get("status"),
        "aesi_suspected": bool(protocol.get("aesi_suspected")),
        "aesi_items": sorted(str(i) for i in protocol.get("aesi_items") or []),
        "aesi_clock_started": aesi_clock is not None,
        "protocol_tier_floor": result.get("protocol_tier_floor"),
    }

    def check(key: str, got: Any, want: Any) -> None:
        if got != want:
            mismatches.append(f"{key}: expected {want!r}, got {got!r}")

    for key in expected:
        if key not in KNOWN_EXPECTED_KEYS:
            notices.append(f"expected.{key} is not compared by this harness")

    if "grades" in expected:
        check("grades", grades, {k: int(v) for k, v in expected["grades"].items()})
    if "max_grade" in expected:
        check("max_grade", actual["max_grade"], expected["max_grade"])
    if "tier" in expected:
        check("tier", actual["tier"], expected["tier"])
    if "stop_screen" in expected:
        check("stop_screen", actual["stop_screen"], expected["stop_screen"])
    if actual["stop_screen"] != actual["page_oncall"] or actual["stop_screen"] != (
        actual["tier"] == 3
    ):
        mismatches.append("invariant: stop_screen == page_oncall == (tier == 3) violated")
    if "red_flag_tier_floor" in expected:
        check("red_flag_tier_floor", actual["red_flag_tier_floor"], expected["red_flag_tier_floor"])
    if "corroboration_bump" in expected:
        check("corroboration_bump", actual["corroboration_bump"], expected["corroboration_bump"])
    for rule_id in expected.get("rules_fired_includes", []):
        if rule_id not in fired:
            mismatches.append(f"rules_fired_includes: {rule_id} did not fire")
    for rule_id in expected.get("rules_fired_excludes", []):
        if rule_id in fired:
            mismatches.append(f"rules_fired_excludes: {rule_id} fired")
    if "sae_clock_started" in expected:
        check("sae_clock_started", actual["sae_clock_started"], expected["sae_clock_started"])
        if sae_clock is not None:
            hours = seriousness_config().site_to_sponsor_hours
            check("sae_clock.site_awareness_at", sae_clock.get("site_awareness_at"), completed_at)
            check("sae_clock.due_at", sae_clock.get("due_at"), shift(completed_at, hours=hours))
    if "seriousness_suspected" in expected:
        check(
            "seriousness_suspected",
            actual["seriousness_suspected"],
            expected["seriousness_suspected"],
        )
    if "ae_drafts" in expected:
        check("ae_drafts", actual["ae_drafts"], expected["ae_drafts"])
    if "vs_drafts" in expected:
        check("vs_drafts", actual["vs_drafts"], expected["vs_drafts"])
    if "vs_not_done" in expected:
        check("vs_not_done", actual["vs_not_done"], sorted(expected["vs_not_done"]))
        for d in vs_drafts:
            has_value = _draft_value(d, "VSORRES") is not None
            if has_value != (_draft_value(d, "VSSTAT") is None):
                mismatches.append(f"VS {_draft_value(d, 'VSTESTCD')}: VSORRES/VSSTAT inconsistent")
    if "cm" in expected:
        want_cm = list(expected["cm"])
        if len(cm_drafts) != len(want_cm):
            mismatches.append(f"cm: expected {len(want_cm)} CM draft(s), got {len(cm_drafts)}")
        else:
            for index, (exp, got) in enumerate(zip(want_cm, actual["cm"], strict=True)):
                where = f"cm[{index}]"
                check(f"{where}.verbatim", got["verbatim"], exp.get("verbatim"))
                check(f"{where}.cmdecod", got["cmdecod"], exp.get("cmdecod"))
                confidence = got["confidence"]
                if not isinstance(confidence, int | float) or confidence < float(
                    exp.get("min_confidence", 0.0)
                ):
                    mismatches.append(
                        f"{where}.confidence {confidence!r} < {exp.get('min_confidence')}"
                    )
                if "match_kind" in exp:
                    check(f"{where}.match_kind", got["match_kind"], exp["match_kind"])
                if "distance" in exp:
                    check(f"{where}.distance", got["distance"], exp["distance"])
                if "direction" in exp:
                    direction = exp["direction"]
                    date = iso_date(completed_at)
                    check(f"{where}.direction", got["direction"], direction)
                    draft = cm_drafts[index]
                    check(
                        f"{where}.CMSTDTC",
                        _draft_value(draft, "CMSTDTC"),
                        date if direction in ("started", "both") else None,
                    )
                    check(
                        f"{where}.CMENDTC",
                        _draft_value(draft, "CMENDTC"),
                        date if direction in ("stopped", "both") else None,
                    )
            if want_cm and (conmed is None or conmed.get("verbatim") != want_cm[0].get("verbatim")):
                mismatches.append("cm: result.conmed.verbatim does not match the first expected CM")
            if not want_cm and conmed is not None:
                mismatches.append("cm: unexpected con-med match in result")
    if "dedup_followups" in expected:
        check("dedup_followups", actual["dedup_followups"], expected["dedup_followups"])
        open_rows = {
            a.id: a for a in db.exec(select(AEOpen).where(AEOpen.usubjid == usubjid)).all()
        }
        for d in ae_drafts:
            if not d.get("is_followup"):
                continue
            linked = open_rows.get(str(d.get("linked_ae_open_id")))
            if linked is None:
                mismatches.append("dedup: follow-up draft points at an unknown open AE")
                continue
            check("dedup.INTERIM_FOLLOWUP_OF", _draft_value(d, "INTERIM_FOLLOWUP_OF"), linked.id)
            check("dedup.AESTDTC", _draft_value(d, "AESTDTC"), linked.first_reported_at)
            check("dedup.AEDECOD", _draft_value(d, "AEDECOD"), linked.aedecod)
            check("dedup.AEONGO", _draft_value(d, "AEONGO"), "Y")
    if "vitals_status" in expected:
        check("vitals_status", actual["vitals_status"], expected["vitals_status"])
    _compare_protocol(actual, expected, aesi_clock, completed_at, check)
    for d in ae_drafts:
        if _draft_value(d, "INTERIM_TIER") != actual["tier"]:
            mismatches.append("invariant: AE draft INTERIM_TIER differs from the session tier")
        if _draft_value(d, "INTERIM_PROVISIONAL") is not True:
            mismatches.append("invariant: AE draft is not marked provisional")
        if _draft_value(d, "AETOXGR") not in (1, 2, 3):
            mismatches.append("invariant: AE draft AETOXGR outside 1..3")
    for d in vs_drafts:
        if (
            _draft_value(d, "INTERIM_IS_MEASURED") is True
            and _draft_value(d, "VSMETHOD") == "Simulated"
        ):
            mismatches.append("invariant: a measured VS row is labeled Simulated")
        if (
            _draft_value(d, "INTERIM_IS_MEASURED") is False
            and _draft_value(d, "VSMETHOD") != "Simulated"
        ):
            mismatches.append("invariant: a simulated VS row is not labeled Simulated")
    return actual, mismatches, notices


# --------------------------------------------------------------------------- #
# Chart-note scanner (CONTRACTS.md R2.4: the eval's second section)
# --------------------------------------------------------------------------- #

NOTE_TIER_FOR_LEVEL: dict[str, int] = {"none": 1, "urgent": 2, "emergency": 2}
"""Expected note tier per answer-key escalation level: a note with findings is Tier 1,
an urgent/emergency red flag Tier 2, never Tier 3 (D-017)."""


def chartscan_section(
    db: DbSession, settings: Settings, actor: Actor, *, suffix: str, now: str
) -> dict[str, Any]:
    """Score the scanner two ways and return both.

    ``answer_key``: ``interim_rules.chartscan.evaluate_answer_key`` over all 25 cases
    (8 notes + 17 utterances): AE-term and medication precision/recall, change
    accuracy, escalation recall, over-escalations, possible-SAE recall.

    ``via_api``: the 8 notes ingested through the same ``ingest_note`` service
    ``POST /notes`` calls, one fresh eval participant per answer-key subject, so the
    drafts, tier, escalation row, SAE clock and cross-note follow-up links are
    checked end to end (N7 must link onto N1's AEs for the same subject).
    """
    evaluation = chartscan.evaluate_answer_key()
    answer_key = chartscan.evaluation_to_dict(evaluation)
    study = get_study(db)
    participants: dict[str, str] = {}
    opened: dict[str, set[str]] = {}
    per_note: list[dict[str, Any]] = []
    hours = seriousness_config().site_to_sponsor_hours
    for case in (c for c in chartscan.answer_key() if c.kind == "note"):
        label = case.usubjid_label or "P-000"
        usubjid = participants.get(label)
        if usubjid is None:
            participant = create_participant(
                db,
                study,
                display_label=f"EVAL-NOTE-{label}",
                usubjid=f"{study.study_id}-EVAL-NOTE-{label}-{suffix}",
                enrolled_at=shift(now, days=-90),
                is_eval=True,
                now=now,
            )
            usubjid = participants[label] = participant.usubjid
        detail = ingest_note(
            db,
            settings,
            actor,
            usubjid=usubjid,
            note_date=case.note_date or iso_date(now),
            author=case.author or "eval harness",
            note_type=case.note_type or "eval",
            text=case.text,
            now=now,
        )
        ae_drafts = [d for d in detail["drafts"] if d["domain"] == "AE"]
        cm_drafts = [d for d in detail["drafts"] if d["domain"] == "CM"]
        terms = sorted({str(d["fields"]["AEDECOD"]) for d in ae_drafts})
        meds = sorted(
            {
                (str(d["fields"]["CMDECOD"]), str(d["fields"]["INTERIM_DIRECTION"]))
                for d in cm_drafts
            }
        )
        expected_terms = sorted(set(case.expected.ae_terms))
        expected_meds = sorted(set(case.expected.meds))
        already_open = opened.setdefault(usubjid, set())
        expected_followups = len(set(expected_terms) & already_open)
        followups = sum(1 for d in ae_drafts if d["is_followup"])
        expected_tier = NOTE_TIER_FOR_LEVEL.get(case.expected.escalation, 1)
        if not expected_terms and not expected_meds:
            expected_tier = 0
        mismatches: list[str] = []
        if terms != expected_terms:
            mismatches.append(f"ae_terms: expected {expected_terms}, got {terms}")
        if meds != expected_meds:
            mismatches.append(f"meds: expected {expected_meds}, got {meds}")
        if detail["tier"] != expected_tier:
            mismatches.append(f"tier: expected {expected_tier}, got {detail['tier']}")
        if detail["tier"] is not None and detail["tier"] >= 3:
            mismatches.append("invariant: a chart note reached Tier 3")
        if (detail["escalation"] is not None) != (expected_tier >= 2):
            mismatches.append(
                f"escalation row: expected {expected_tier >= 2}, "
                f"got {detail['escalation'] is not None}"
            )
        clock = detail["sae_clock"]
        if case.expected.serious:
            if clock is None:
                mismatches.append("sae_clock: expected one, got none")
            else:
                ingested = detail["note"]["ingested_at"]
                if clock["site_awareness_at"] != ingested:
                    mismatches.append("sae_clock.site_awareness_at != ingested_at")
                if clock["due_at"] != shift(ingested, hours=hours):
                    mismatches.append("sae_clock.due_at != ingested_at + site_to_sponsor_hours")
        elif clock is not None:
            mismatches.append("sae_clock: started without a hospitalization cue")
        if followups != expected_followups:
            mismatches.append(f"dedup_followups: expected {expected_followups}, got {followups}")
        if len(detail["why"]) != len(detail["rules_fired"]):
            mismatches.append("invariant: why[] and rules_fired[] differ in length")
        for d in detail["drafts"]:
            if (
                d["source"] != "chart_note"
                or d["fields"].get("INTERIM_RECORD_SOURCE") != "chart_note"
            ):
                mismatches.append(f"invariant: draft {d['id']} is not labeled chart_note")
            if d["domain"] == "AE" and d["fields"].get("INTERIM_TIER") != detail["tier"]:
                mismatches.append("invariant: AE draft INTERIM_TIER differs from the note tier")
        already_open.update(terms)
        per_note.append(
            {
                "case_id": case.id,
                "note_id": detail["note"]["id"],
                "usubjid": usubjid,
                "expected": {
                    "ae_terms": expected_terms,
                    "meds": [list(m) for m in expected_meds],
                    "escalation": case.expected.escalation,
                    "serious": case.expected.serious,
                    "tier": expected_tier,
                    "dedup_followups": expected_followups,
                },
                "actual": {
                    "ae_terms": terms,
                    "meds": [list(m) for m in meds],
                    "tier": detail["tier"],
                    "escalation": detail["escalation"] is not None,
                    "sae_clock": clock is not None,
                    "dedup_followups": followups,
                    "n_drafts": len(detail["drafts"]),
                },
                "mismatches": mismatches,
                "pass": not mismatches,
            }
        )
    n_pass = sum(1 for n in per_note if n["pass"])
    return {
        "answer_key": answer_key,
        "via_api": {"n_notes": len(per_note), "n_pass": n_pass, "per_note": per_note},
        "passed": bool(answer_key["passed"]) and n_pass == len(per_note),
    }


def render_chartscan_markdown(section: Mapping[str, Any]) -> list[str]:
    key = section["answer_key"]
    via = section["via_api"]
    lines: list[str] = []
    lines.append("## Chart-note scanner (CONTRACTS R2.4; deterministic, no LLM)")
    lines.append("")
    lines.append(
        f"Answer key: {key['n_cases']} cases (8 synthetic notes + 17 participant utterances) "
        f"scored by `interim_rules.chartscan.evaluate_answer_key`; "
        f"**{'PASS' if key['passed'] else 'FAIL'}** "
        f"(criterion: every case exact). Scanner ported from omer-khawar/ae-checkin-agent "
        "(Omer Khawar, MIT)."
    )
    lines.append("")
    lines.append("| Metric | Precision | Recall | F1 | TP | FP | FN |")
    lines.append("|---|---|---|---|---|---|---|")
    for label, block in (("AE terms (CTCAE v5)", key["ae_terms"]), ("Medications", key["meds"])):
        lines.append(
            f"| {label} | {block['precision']:.2f} | {block['recall']:.2f} | {block['f1']:.2f} | "
            f"{block['tp']} | {block['fp']} | {block['fn']} |"
        )
    lines.append("")
    change = key["med_change_accuracy"]
    lines.append("| Check | Value |")
    lines.append("|---|---|")
    lines.append(
        f"| Medication change accuracy (started/stopped/changed/taking) | "
        f"{'n/a' if change is None else f'{change:.2f}'} |"
    )
    lines.append(f"| Escalation level exact match | {key['escalation_exact_match']:.2f} |")
    lines.append(
        f"| Urgent/emergency cases caught | {key['urgent_or_emergency_caught']} / "
        f"{key['urgent_or_emergency_needed']} |"
    )
    lines.append(
        f"| Emergency cases caught | {key['emergency_caught']} / {key['emergency_needed']} |"
    )
    lines.append(f"| Over-escalations | {key['over_escalations']} |")
    lines.append(
        f"| Possible-SAE cues caught | {key['serious_caught']} / {key['serious_needed']} |"
    )
    if key.get("misses"):
        lines.append("")
        lines.append("Misses:")
        for miss in key["misses"]:
            lines.append(f"- `{miss['case_id']}`: {'; '.join(miss['problems'])}")
    lines.append("")
    lines.append(
        f"Through the API (`POST /notes` service, fresh eval participants): "
        f"**{via['n_pass']} / {via['n_notes']} notes pass**: AE drafts carry the expected terms, "
        "CM drafts the expected drug + change, the tier follows the red flags (2 at most), the "
        "SAE clock starts at ingestion on a hospitalization cue, and a repeated term for the same "
        "subject links as a follow-up."
    )
    lines.append("")
    lines.append(
        "| Note | Subject | AE terms | Meds | Tier | Escalation | SAE clock | Follow-ups | "
        "Pass | Mismatches |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for n in via["per_note"]:
        a = n["actual"]
        meds = ", ".join(f"{d} ({c})" for d, c in a["meds"]) or "-"
        mism = "; ".join(n["mismatches"]) if n["mismatches"] else "-"
        lines.append(
            f"| `{n['case_id']}` | {n['usubjid'].split('-EVAL-NOTE-')[-1].rsplit('-', 1)[0]} | "
            f"{', '.join(a['ae_terms']) or '-'} | {meds} | {a['tier']} | "
            f"{'yes' if a['escalation'] else 'no'} | {'yes' if a['sae_clock'] else 'no'} | "
            f"{a['dedup_followups']} | {'PASS' if n['pass'] else 'FAIL'} | {mism} |"
        )
    return lines


# --------------------------------------------------------------------------- #
# Metrics + markdown
# --------------------------------------------------------------------------- #


def _prf(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return round(precision, 4), round(recall, 4), round(f1, 4)


def tier_metrics(pairs: Sequence[tuple[int, int]]) -> dict[str, dict[str, float | int]]:
    """``pairs`` = (expected_tier, actual_tier)."""
    out: dict[str, dict[str, float | int]] = {}
    for tier in TIERS:
        t = int(tier)
        tp = sum(1 for e, a in pairs if e == t and a == t)
        fp = sum(1 for e, a in pairs if e != t and a == t)
        fn = sum(1 for e, a in pairs if e == t and a != t)
        precision, recall, f1 = _prf(tp, fp, fn)
        out[tier] = {
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "support": sum(1 for e, _ in pairs if e == t),
            "predicted": sum(1 for _, a in pairs if a == t),
        }
    return out


def grade_confusion(pairs: Sequence[tuple[int, int]]) -> list[list[int]]:
    matrix = [[0] * 4 for _ in range(4)]
    for expected, actual in pairs:
        if 0 <= expected <= 3 and 0 <= actual <= 3:
            matrix[expected][actual] += 1
    return matrix


def render_markdown(results: Mapping[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Interim evaluation results")
    lines.append("")
    lines.append(
        f"Run `{results['run_id']}` at {results['ran_at']} by `{results['ran_by']}` "
        f"(include_hidden = {str(results['include_hidden']).lower()}, "
        f"Interim {results['interim_version']}). Personas are replayed in-process through the "
        "same service layer the kiosk endpoints use; every expected key the harness knows is "
        "compared. **Generated file; do not edit.**"
    )
    lines.append("")
    n, n_pass, n_fail = results["n_personas"], results["n_pass"], results["n_fail"]
    rate = (100.0 * n_pass / n) if n else 0.0
    lines.append(f"**{n_pass} / {n} personas pass ({rate:.1f}%)**; {n_fail} fail.")
    scanner = results.get("chartscan")
    if scanner:
        key, via = scanner["answer_key"], scanner["via_api"]
        lines.append(
            f"**Chart-note scanner: {key['n_cases'] - len(key.get('misses', []))} / "
            f"{key['n_cases']} answer-key cases and {via['n_pass']} / {via['n_notes']} notes "
            f"through the API pass** ({'PASS' if scanner['passed'] else 'FAIL'})."
        )
    lines.append("")
    lines.append("## Tier precision / recall / F1")
    lines.append("")
    lines.append("| Tier | Name | Precision | Recall | F1 | Support | Predicted |")
    lines.append("|---|---|---|---|---|---|---|")
    for tier, m in results["tier_metrics"].items():
        note = "" if m["support"] or m["predicted"] else " (no cases; 1.00 by convention)"
        lines.append(
            f"| {tier} | {tier_name(int(tier))} | {m['precision']:.2f} | {m['recall']:.2f} | "
            f"{m['f1']:.2f}{note} | {m['support']} | {m['predicted']} |"
        )
    lines.append("")
    lines.append("## Provisional grade confusion (rows = expected, columns = actual)")
    lines.append("")
    lines.append("| expected \\ actual | G0 | G1 | G2 | G3 |")
    lines.append("|---|---|---|---|---|")
    for row_index, row in enumerate(results["grade_confusion"]):
        lines.append(f"| G{row_index} | " + " | ".join(str(c) for c in row) + " |")
    lines.append("")
    lines.append("## Correctness checks")
    lines.append("")
    lines.append("| Check | Correct | Of |")
    lines.append("|---|---|---|")
    for key, label in (
        ("dedup_correct", "De-duplication (follow-up vs new AE)"),
        ("sae_clock_correct", "SAE clock started / not started"),
        ("conmed_correct", "Con-med match (name, kind, confidence)"),
        ("aesi_correct", "Possible AESI, its 24 h clock and the protocol tier floor (R3.1)"),
    ):
        block = results.get(key) or {"correct": 0, "n": 0}
        lines.append(f"| {label} | {block['correct']} | {block['n']} |")
    lines.append("")
    lines.append("## Per persona")
    lines.append("")
    lines.append("| Persona | Hidden | Expected tier | Actual tier | Pass | Mismatches |")
    lines.append("|---|---|---|---|---|---|")
    for p in results["per_persona"]:
        mism = "; ".join(p["mismatches"]) if p["mismatches"] else "-"
        lines.append(
            f"| `{p['persona_id']}` {p['name']} | {'yes' if p['hidden'] else 'no'} | "
            f"{p['expected'].get('tier', '-')} | {p['actual'].get('tier', '-')} | "
            f"{'PASS' if p['pass'] else 'FAIL'} | {mism} |"
        )
    if results.get("counterfactuals"):
        lines.append("")
        lines.append("## Counterfactuals (change one input, watch the output change)")
        lines.append("")
        lines.append("| Persona | Counterfactual | Baseline tier | Tier | Pass | Mismatches |")
        lines.append("|---|---|---|---|---|---|")
        for c in results["counterfactuals"]:
            mism = "; ".join(c["mismatches"]) if c["mismatches"] else "-"
            lines.append(
                f"| `{c['persona_id']}` | {c['label']} | {c['baseline_tier']} | {c['tier']} | "
                f"{'PASS' if c['pass'] else 'FAIL'} | {mism} |"
            )
    if results.get("chartscan"):
        lines.append("")
        lines.extend(render_chartscan_markdown(results["chartscan"]))
    notices = results.get("notices", [])
    if notices:
        lines.append("")
        lines.append("## Notices")
        lines.append("")
        for n_ in notices:
            lines.append(f"- {n_}")
    lines.append("")
    lines.append(
        "Conventions: a tier with no expected and no predicted cases reports 1.00 by convention. "
        "Grades compared are the engine's provisional CTCAE grades per item (CLAUDE.md §3.4(b)); "
        "the answer key is a regression guarantee for the rules, not a clinical validation "
        "(docs/WHAT_IT_GETS_WRONG.md)."
    )
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


def run_eval(
    db: DbSession,
    settings: Settings,
    actor: Actor,
    *,
    include_hidden: bool,
    persona_ids: Sequence[str] | None,
    now: str | None = None,
) -> dict[str, Any]:
    stamp = now or now_iso()
    run_id = new_id()
    suffix = run_id[-8:].lower()
    selected = personas(include_hidden=True)
    if persona_ids:
        wanted = set(persona_ids)
        unknown = sorted(wanted - {p["id"] for p in selected})
        if unknown:
            raise problem(
                404, f"Unknown persona id(s): {', '.join(unknown)}", title="Persona not found"
            )
        selected = [p for p in selected if p["id"] in wanted]
    elif not include_hidden:
        selected = [p for p in selected if not p.get("hidden")]

    per_persona: list[dict[str, Any]] = []
    counterfactuals: list[dict[str, Any]] = []
    notices: list[str] = []
    tier_pairs: list[tuple[int, int]] = []
    grade_pairs: list[tuple[int, int]] = []
    dedup = {"n": 0, "correct": 0}
    sae = {"n": 0, "correct": 0}
    conmed = {"n": 0, "correct": 0}
    aesi = {"n": 0, "correct": 0}

    for persona in selected:
        expected = persona.get("expected") or {}
        session, _, result = replay_persona(
            db, settings, actor, persona, suffix=suffix, completed_at=stamp
        )
        actual, mismatches, persona_notices = compare(
            db, result, expected, usubjid=session.usubjid, completed_at=stamp
        )
        notices.extend(f"{persona['id']}: {n}" for n in persona_notices)
        passed = not mismatches
        if "tier" in expected:
            tier_pairs.append((int(expected["tier"]), int(actual["tier"])))
        for item_id, grade in (expected.get("grades") or {}).items():
            grade_pairs.append((int(grade), int(actual["grades"].get(item_id, -1))))
        for block, key in ((dedup, "dedup"), (sae, "sae_clock"), (conmed, "cm")):
            if key in expected or f"{key}_followups" in expected or f"{key}_started" in expected:
                block["n"] += 1
                if not any(m.startswith(key) for m in mismatches):
                    block["correct"] += 1
        if any(k in expected for k in ("aesi_suspected", "aesi_items", "aesi_clock_started")) or (
            "protocol_tier_floor" in expected
        ):
            aesi["n"] += 1
            if not any(m.startswith(PROTOCOL_CHECK_PREFIXES) for m in mismatches):
                aesi["correct"] += 1
        per_persona.append(
            {
                "persona_id": persona["id"],
                "name": persona["name"],
                "category": persona.get("category"),
                "hidden": bool(persona.get("hidden")),
                "pass": passed,
                "expected": expected,
                "actual": actual,
                "mismatches": mismatches,
                "session_id": session.id,
                "usubjid": session.usubjid,
            }
        )
        for index, cf in enumerate(persona.get("counterfactuals") or []):
            cf_session, _, cf_result = replay_persona(
                db,
                settings,
                actor,
                persona,
                suffix=f"{suffix}-cf{index}",
                completed_at=stamp,
                rule_settings=cf.get("settings"),
            )
            cf_actual, cf_mismatches, _ = compare(
                db,
                cf_result,
                cf.get("expected") or {},
                usubjid=cf_session.usubjid,
                completed_at=stamp,
            )
            if cf_actual["grades"] != actual["grades"]:
                cf_mismatches.append("invariant: settings changed a provisional grade")
            if cf_actual["tier"] == actual["tier"]:
                cf_mismatches.append("counterfactual changed nothing: tier identical to baseline")
            counterfactuals.append(
                {
                    "persona_id": persona["id"],
                    "label": cf.get("label", f"counterfactual {index}"),
                    "settings": cf.get("settings"),
                    "baseline_tier": actual["tier"],
                    "tier": cf_actual["tier"],
                    "pass": not cf_mismatches,
                    "mismatches": cf_mismatches,
                    "session_id": cf_session.id,
                }
            )

    n_pass = sum(1 for p in per_persona if p["pass"])
    scanner = chartscan_section(db, settings, actor, suffix=suffix, now=stamp)
    results: dict[str, Any] = {
        "run_id": run_id,
        "ran_at": stamp,
        "ran_by": actor.id,
        "include_hidden": include_hidden,
        "persona_ids": list(persona_ids) if persona_ids else None,
        "interim_version": API_VERSION,
        "n_personas": len(per_persona),
        "n_pass": n_pass,
        "n_fail": len(per_persona) - n_pass,
        "tier_metrics": tier_metrics(tier_pairs),
        "grade_confusion": grade_confusion(grade_pairs),
        "dedup_correct": dedup,
        "sae_clock_correct": sae,
        "conmed_correct": conmed,
        "aesi_correct": aesi,
        "per_persona": per_persona,
        "counterfactuals": counterfactuals,
        "notices": sorted(set(notices)),
        "chartscan": scanner,
        "all_passed": n_pass == len(per_persona) and bool(scanner["passed"]),
    }
    results["markdown"] = render_markdown(results)
    row = EvalRun(
        id=run_id,
        ran_at=stamp,
        ran_by=actor.id,
        include_hidden=include_hidden,
        n_personas=results["n_personas"],
        n_pass=n_pass,
        n_fail=results["n_fail"],
        results_json=dump_json(results),
    )
    db.add(row)
    db.flush()
    append_event(
        db,
        actor,
        "eval.run",
        "eval_run",
        run_id,
        {
            "include_hidden": include_hidden,
            "persona_ids": results["persona_ids"],
            "n_personas": results["n_personas"],
            "n_pass": n_pass,
            "n_fail": results["n_fail"],
            "failed": [p["persona_id"] for p in per_persona if not p["pass"]],
            "chartscan_passed": scanner["passed"],
            "chartscan_notes_via_api": scanner["via_api"]["n_pass"],
        },
        ts_utc=stamp,
    )
    return results


def run_custom(
    db: DbSession,
    settings: Settings,
    actor: Actor,
    persona: CustomPersona | Mapping[str, Any],
    *,
    now: str | None = None,
) -> dict[str, Any]:
    """One ad-hoc persona (the "build your own" form).

    The persona is validated by :class:`interim_api.schemas.CustomPersona`
    (typed responses, gates, samples with ``tsOffsetS``, prior check-ins), so
    a malformed judge input is a 422 problem, never a 500. Item ids and
    attributes are checked against the instrument by ``record_answer``.
    """
    model = persona if isinstance(persona, CustomPersona) else CustomPersona.model_validate(persona)
    stamp = now or now_iso()
    # camelCase samples (``tsOffsetS``) exactly as personas.json spells them; ``sample_from``
    # reads either spelling. ``exclude_none`` keeps the echoed persona compact.
    body = model.model_dump(mode="json", by_alias=True, exclude_none=True)
    body.setdefault("id", f"custom-{new_id().lower()[-10:]}")
    body.setdefault("name", "custom persona")
    body.setdefault("consent_camera", bool(body.get("vitals_samples")))
    try:
        session, response, result = replay_persona(
            db,
            settings,
            actor,
            body,
            suffix=stamp.replace(":", "").replace("-", "")[-10:].lower(),
            completed_at=stamp,
        )
    except ValueError as exc:  # a sample/timestamp the serializer could not materialize
        raise problem(422, f"persona could not be replayed: {exc}", title="Bad persona") from exc
    out: dict[str, Any] = {
        "persona": body,
        "result": result,
        "session_id": session.id,
        "usubjid": session.usubjid,
        "complete_response": response,
        "checkin_url": response["checkin_url"],
    }
    expected = body.get("expected")
    if isinstance(expected, Mapping) and expected:
        actual, mismatches, notices = compare(
            db, result, expected, usubjid=session.usubjid, completed_at=stamp
        )
        out.update(
            {"actual": actual, "mismatches": mismatches, "pass": not mismatches, "notices": notices}
        )
    append_event(
        db,
        actor,
        "eval.run",
        "session",
        session.id,
        {"custom": True, "persona_id": body["id"], "tier": result["escalation_tier"]},
        ts_utc=stamp,
    )
    return out


def latest_results(db: DbSession) -> dict[str, Any] | None:
    row = db.exec(select(EvalRun).order_by(EvalRun.ran_at.desc()).limit(1)).first()  # type: ignore[attr-defined]
    return load_json(row.results_json) if row else None
