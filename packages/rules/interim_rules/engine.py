"""The entry point: :func:`evaluate_checkin`.

Runs the pipeline in the order CONTRACTS.md §1.3 fixes for ``rules_fired``::

    scoring -> grading -> red flags -> vitals -> corroboration -> escalation
            -> seriousness -> con-med -> protocol -> dedup -> drafting

The protocol stage (CONTRACTS.md R3.1, :mod:`interim_rules.protocol`) is *computed*
before the ladder, right after con-med matching, because its tier floor (2 for a
prohibited medication) joins the red-flag floor before the vitals bump; its rules are
*listed* after the con-med rules. A possible AESI starts a 24-hour clock of kind
``"aesi"``; it never changes a grade or the tier.

Each stage is a pure function in its own module; this module only wires them
together and assembles the :class:`~interim_rules.models.CheckInResult`.

Inputs are validated up front (:func:`validate_input`) so that a malformed
timestamp or sequence number is rejected the same way for every check-in,
instead of only when a later stage happens to parse it.
"""

from __future__ import annotations

import dataclasses

from .conditions import ConditionContext
from .conmed import conmed_entries, conmed_rule, match_conmed
from .corroboration import evaluate_corroboration
from .dedup import decide_dedup
from .drafting import build_ae_drafts, build_cm_draft, build_vs_drafts
from .escalation import compute_tier
from .free_text import assess_free_text
from .grading import grade_items, grading_rule
from .models import (
    CheckInInput,
    CheckInResult,
    ConMedMatch,
    DraftRecord,
    ProtocolAssessment,
    RuleFired,
)
from .protocol import assess_protocol, parse_last_dose_date, start_aesi_clock
from .red_flags import evaluate_red_flags
from .scoring import score_responses, scoring_rule
from .seriousness import SeriousnessOutcome, assess_seriousness
from .tables import red_flag_table
from .timefmt import parse_iso_utc
from .vitals import assess_vitals, classify_samples, corroboration_maxima


def _check_timestamp(field: str, value: str) -> None:
    try:
        parse_iso_utc(value)
    except ValueError as exc:
        raise ValueError(f"{field}: {exc}") from exc


def validate_input(inp: CheckInInput) -> None:
    """Reject inputs the pipeline could only fail on later (or, worse, silently accept).

    Raises ``ValueError`` naming the offending field. Checks: non-empty
    ``session_id`` / ``usubjid``; ISO-8601 ``completed_at``, every response
    ``ts``, every vitals ``ts_utc`` and both open-AE timestamps; ``next_aeseq``
    >= 1 (SDTM sequence numbers start at 1).
    """
    if not inp.session_id.strip():
        raise ValueError("session_id: must not be empty")
    if not inp.usubjid.strip():
        raise ValueError("usubjid: must not be empty")
    _check_timestamp("completed_at", inp.completed_at)
    for response in inp.responses:
        _check_timestamp(f"responses[{response.answer_id}].ts", response.ts)
    for sample in inp.vitals:
        _check_timestamp(f"vitals[{sample.sample_id}].ts_utc", sample.ts_utc)
    for open_ae in inp.open_aes:
        _check_timestamp(
            f"open_aes[{open_ae.ae_open_id}].first_reported_at", open_ae.first_reported_at
        )
        _check_timestamp(
            f"open_aes[{open_ae.ae_open_id}].last_reported_at", open_ae.last_reported_at
        )
    for name in ("last_dose_date", "new_anticancer_therapy_date"):
        try:
            parse_last_dose_date(getattr(inp.protocol_context, name))
        except ValueError as exc:
            raise ValueError(f"protocol_context.{name}: {exc}") from exc
    if isinstance(inp.next_aeseq, bool) or inp.next_aeseq < 1:
        raise ValueError(
            f"next_aeseq: must be an integer >= 1 (SDTM sequence numbers start at 1), "
            f"got {inp.next_aeseq!r}"
        )


def gate_evidence_ids(inp: CheckInInput) -> dict[str, str]:
    """Evidence ids for every gate field, synthesized deterministically when the caller gave none.

    The synthesized ids follow the API's gate ``Answer.item_id`` naming
    (``gate_hospitalization`` ...) so they read naturally in the dashboard.
    """
    gates, sid = inp.gates, inp.session_id
    conmed_id = gates.conmed_answer_id or f"{sid}:gate_conmed"
    return {
        "urgent_now": gates.urgent_now_answer_id or f"{sid}:gate_urgent_now",
        "hospitalization": gates.hospitalization_answer_id or f"{sid}:gate_hospitalization",
        "conmed_changed": conmed_id,
        "conmed_text": conmed_id,
        "conmed_direction": conmed_id,
        "other_text": gates.other_answer_id or f"{sid}:gate_other",
        "temp_c": gates.temp_answer_id or f"{sid}:gate_temp_c",
    }


_PROTOCOL_LEVEL_RANK = {"prohibited": 0, "discouraged": 1, "permitted": 2}
_PER_ENTRY_PROTOCOL_RULES = ("protocol.conmed_", "protocol.cm_fields")


def _merge_protocol(
    primary: ProtocolAssessment, extras: list[ProtocolAssessment]
) -> ProtocolAssessment:
    """Fold the medication-specific parts of the other entries' assessments into the first.

    Each extra entry was assessed with the full protocol stage; only its medication rules,
    flags, notes, missing CM fields and tier floor are taken (the AESI half is identical).
    """
    if not extras:
        return primary
    flags = sorted(
        [*primary.conmed_flags, *(f for e in extras for f in e.conmed_flags)],
        key=lambda f: _PROTOCOL_LEVEL_RANK[f.level],
    )
    missing = list(primary.cm_missing_fields)
    for extra in extras:
        missing.extend(f for f in extra.cm_missing_fields if f not in missing)
    extra_rules = [
        r for e in extras for r in e.rules_fired if r.rule_id.startswith(_PER_ENTRY_PROTOCOL_RULES)
    ]
    return dataclasses.replace(
        primary,
        conmed_flags=tuple(flags),
        conmed_flag=flags[0].level if flags else None,
        conmed_notes=(*primary.conmed_notes, *(n for e in extras for n in e.conmed_notes)),
        cm_missing_fields=tuple(missing),
        tier_floor=max([primary.tier_floor, *(e.tier_floor for e in extras)]),
        rules_fired=(*primary.rules_fired, *extra_rules),
    )


def evaluate_checkin(inp: CheckInInput) -> CheckInResult:
    """Evaluate one completed check-in. Pure: no clock, no network, no database."""
    validate_input(inp)
    gate_ids = gate_evidence_ids(inp)

    # 1. Scoring: attribute answers -> composite 0..3 per item.
    scored = score_responses(inp.responses)
    scoring_rules = [rule for s in scored if (rule := scoring_rule(s)) is not None]

    # 2. Grading: composite -> provisional CTCAE grade (answers only).
    item_results = grade_items(scored)
    grading_rules = [rule for ir in item_results if (rule := grading_rule(ir)) is not None]
    items_by_id = {ir.item_id: ir for ir in item_results}
    max_grade = max((ir.provisional_grade for ir in item_results), default=0)
    max_grade_rule_ids = [
        f"grade.provisional.{ir.item_id}"
        for ir in item_results
        if max_grade >= 1 and ir.provisional_grade == max_grade
    ]

    # 4. Vitals quality is computed before red flags only because the condition
    #    context carries the eligible maxima; red flags themselves never read vitals.
    assessment = assess_vitals(inp.vitals, inp.settings)
    readings = classify_samples(inp.vitals, inp.settings)
    maxima = corroboration_maxima(readings) if assessment.status == "ok" else {}
    ctx = ConditionContext(
        items=items_by_id,
        gates=inp.gates,
        gate_ids=gate_ids,
        vitals_max=maxima,
        severe_item=red_flag_table().severe_item,
        ended_early=inp.ended_early,
    )

    # 3. Red flags -> tier floor. R5.1: an early stop and urgent_now are red-flag table rules.
    red = evaluate_red_flags(ctx)
    # 3b. R5.2: the comment box is read by the deterministic scanner (utterance mode).
    free_text = assess_free_text(inp.gates, gate_ids["other_text"])
    red_flag_floor = max(red.tier_floor, free_text.tier_floor)
    red_flag_rules = (*red.rules_fired, *free_text.rules_fired)

    # 5. Corroboration -> at most +1 tier, only when vitals status is ok.
    corroboration = evaluate_corroboration(ctx, assessment)

    # 8. Con-med matching (verbatim text is never altered). A "yes" with no name
    #    typed is still a reported change: it is matched as empty -> unmatched and
    #    drafted so the coordinator can ask, instead of vanishing. R5.2: several medicines
    #    (the kiosk's list, or one box split on commas / "and") are matched one by one.
    #    Computed before the ladder because the protocol stage reads it.
    entries = conmed_entries(inp.gates)
    entry_gate_ids: list[str] = []
    entry_inputs: list[CheckInInput] = []
    conmed_matches: list[ConMedMatch] = []
    conmed_rules: list[RuleFired] = []
    entry_protocols: list[ProtocolAssessment] = []
    for entry in entries:
        answer_id = entry.answer_id or gate_ids["conmed_text"]
        entry_gates = dataclasses.replace(
            inp.gates,
            conmed_changed=True,
            conmed_text=entry.text,
            conmed_direction=entry.direction,
            conmed_answer_id=answer_id,
            conmeds=(),
        )
        match = match_conmed(entry.text)
        conmed_matches.append(match)
        conmed_rules.append(conmed_rule(match, answer_id))
        entry_gate_ids.append(answer_id)
        entry_inputs.append(dataclasses.replace(inp, gates=entry_gates))
        # 8b. Protocol: possible AESI, con-med level, CM completeness, tier floor.
        entry_protocols.append(
            assess_protocol(
                item_results,
                match,
                entry_gates,
                inp.protocol_context,
                completed_at=inp.completed_at,
                gate_ids={**gate_ids, "conmed_text": answer_id},
            )
        )
    conmed_match = conmed_matches[0] if conmed_matches else None
    if entry_protocols:
        protocol = _merge_protocol(entry_protocols[0], entry_protocols[1:])
    else:
        protocol = assess_protocol(
            item_results,
            None,
            inp.gates,
            inp.protocol_context,
            completed_at=inp.completed_at,
            gate_ids=gate_ids,
        )
    protocol_floor_rule_ids = [
        r.rule_id for r in protocol.rules_fired if r.rule_id == "protocol.conmed_prohibited"
    ]

    # 6. Escalation ladder (protocol floor joins the red-flag floor before the bump).
    tier = compute_tier(
        max_grade=max_grade,
        grade_rule_ids=max_grade_rule_ids,
        red_flag_floor=red_flag_floor,
        red_flag_rule_ids=[r.rule_id for r in red_flag_rules],
        corroboration_bump=corroboration.bump,
        corroboration_rule_ids=[r.rule_id for r in corroboration.rules_fired],
        protocol_floor=protocol.tier_floor,
        protocol_rule_ids=protocol_floor_rule_ids,
    )

    # 7. Seriousness + SAE clock.
    serious = assess_seriousness(inp.gates, gate_ids, inp.completed_at)
    if not serious.suspected:
        # R5.2: a hospital/ER mention in the comment box that conflicts with a No answer.
        conflict = free_text.seriousness_clock(gate_ids["other_text"], inp.completed_at)
        if conflict is not None:
            serious = SeriousnessOutcome(True, conflict[0], (conflict[1],))

    # 9. De-duplication against open AEs (never against this session's own AEs).
    # Decided before the AESI clock (pure; its rules are still listed after the protocol's)
    # so a follow-up of an AE that already has an AESI clock does not start a second one.
    graded = [ir for ir in item_results if ir.provisional_grade >= 1]
    decisions = decide_dedup(
        graded,
        inp.open_aes,
        inp.completed_at,
        inp.settings,
        {ir.item_id: f"grade.provisional.{ir.item_id}" for ir in graded},
        session_id=inp.session_id,
    )
    already_clocked = {
        d.item_id: d.linked.ae_open_id
        for d in decisions
        if d.linked is not None and d.linked.aesi_clock_started
    }

    # 7b. Possible AESI -> 24-hour clock of kind "aesi" (site aware at completion).
    aesi_clock, aesi_rules = start_aesi_clock(
        protocol, inp.completed_at, already_clocked=already_clocked
    )
    protocol_rules_ordered = [
        *(r for r in protocol.rules_fired if r.rule_id == "protocol.aesi_suspected"),
        *aesi_rules,
        *(r for r in protocol.rules_fired if r.rule_id != "protocol.aesi_suspected"),
    ]

    # 10. Drafting.
    prior: list[RuleFired] = [
        *scoring_rules,
        *grading_rules,
        *red_flag_rules,
        *assessment.rules_fired,
        *corroboration.rules_fired,
        *tier.rules_fired,
        *serious.rules_fired,
        *conmed_rules,
        *protocol_rules_ordered,
        *(d.rule for d in decisions),
    ]
    ae_drafts, ae_rules = build_ae_drafts(
        inp, graded, {d.item_id: d for d in decisions}, tier, prior, gate_ids, protocol
    )
    vs_drafts, vs_rules = build_vs_drafts(inp, assessment, readings)
    drafts: list[DraftRecord] = [*ae_drafts, *vs_drafts]
    cm_rules: list[RuleFired] = []
    for index, match in enumerate(conmed_matches):
        cm_draft, cm_rule = build_cm_draft(
            entry_inputs[index],
            match,
            entry_gate_ids[index],
            entry_protocols[index],
            seq=index + 1,
        )
        drafts.append(cm_draft)
        cm_rules.append(cm_rule)

    rules_fired = (*prior, *ae_rules, *vs_rules, *cm_rules)
    return CheckInResult(
        items=item_results,
        max_grade=max_grade,
        base_tier=tier.base_tier,
        red_flag_tier_floor=red_flag_floor,
        corroboration_bump=tier.bump,
        escalation_tier=tier.final_tier,
        stop_screen=tier.stop_screen,
        page_oncall=tier.page_oncall,
        seriousness_suspected=serious.suspected,
        sae_clock=serious.clock,
        conmed=conmed_match,
        vitals=assessment,
        drafts=tuple(drafts),
        rules_fired=rules_fired,
        why=tuple(rule.description for rule in rules_fired),
        protocol=protocol,
        aesi_clock=aesi_clock,
        protocol_tier_floor=protocol.tier_floor,
        conmeds=tuple(conmed_matches),
        ended_early=inp.ended_early,
    )
