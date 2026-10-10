"""The entry point: :func:`evaluate_checkin`.

Runs the pipeline in the order CONTRACTS.md §1.3 fixes for ``rules_fired``::

    scoring -> grading -> red flags -> vitals -> corroboration -> escalation
            -> seriousness -> con-med -> dedup -> drafting

Each stage is a pure function in its own module; this module only wires them
together and assembles the :class:`~interim_rules.models.CheckInResult`.

Inputs are validated up front (:func:`validate_input`) so that a malformed
timestamp or sequence number is rejected the same way for every check-in,
instead of only when a later stage happens to parse it.
"""

from __future__ import annotations

from .conditions import ConditionContext
from .conmed import conmed_rule, match_conmed
from .corroboration import evaluate_corroboration
from .dedup import decide_dedup
from .drafting import build_ae_drafts, build_cm_draft, build_vs_drafts
from .escalation import compute_tier
from .grading import grade_items, grading_rule
from .models import CheckInInput, CheckInResult, DraftRecord, RuleFired
from .red_flags import evaluate_red_flags
from .scoring import score_responses, scoring_rule
from .seriousness import assess_seriousness
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
        "hospitalization": gates.hospitalization_answer_id or f"{sid}:gate_hospitalization",
        "conmed_changed": conmed_id,
        "conmed_text": conmed_id,
        "conmed_direction": conmed_id,
        "other_text": gates.other_answer_id or f"{sid}:gate_other",
        "temp_c": gates.temp_answer_id or f"{sid}:gate_temp_c",
    }


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
    )

    # 3. Red flags -> tier floor.
    red = evaluate_red_flags(ctx)

    # 5. Corroboration -> at most +1 tier, only when vitals status is ok.
    corroboration = evaluate_corroboration(ctx, assessment)

    # 6. Escalation ladder.
    tier = compute_tier(
        max_grade=max_grade,
        grade_rule_ids=max_grade_rule_ids,
        red_flag_floor=red.tier_floor,
        red_flag_rule_ids=[r.rule_id for r in red.rules_fired],
        corroboration_bump=corroboration.bump,
        corroboration_rule_ids=[r.rule_id for r in corroboration.rules_fired],
    )

    # 7. Seriousness + SAE clock.
    serious = assess_seriousness(inp.gates, gate_ids, inp.completed_at)

    # 8. Con-med matching (verbatim text is never altered). A "yes" with no name
    #    typed is still a reported change: it is matched as empty -> unmatched and
    #    drafted so the coordinator can ask, instead of vanishing.
    conmed_match = None
    conmed_rules: list[RuleFired] = []
    if inp.gates.conmed_changed:
        conmed_match = match_conmed(inp.gates.conmed_text or "")
        conmed_rules.append(conmed_rule(conmed_match, gate_ids["conmed_text"]))

    # 9. De-duplication against open AEs (never against this session's own AEs).
    graded = [ir for ir in item_results if ir.provisional_grade >= 1]
    decisions = decide_dedup(
        graded,
        inp.open_aes,
        inp.completed_at,
        inp.settings,
        {ir.item_id: f"grade.provisional.{ir.item_id}" for ir in graded},
        session_id=inp.session_id,
    )

    # 10. Drafting.
    prior: list[RuleFired] = [
        *scoring_rules,
        *grading_rules,
        *red.rules_fired,
        *assessment.rules_fired,
        *corroboration.rules_fired,
        *tier.rules_fired,
        *serious.rules_fired,
        *conmed_rules,
        *(d.rule for d in decisions),
    ]
    ae_drafts, ae_rules = build_ae_drafts(
        inp, graded, {d.item_id: d for d in decisions}, tier, prior, gate_ids
    )
    vs_drafts, vs_rules = build_vs_drafts(inp, assessment, readings)
    drafts: list[DraftRecord] = [*ae_drafts, *vs_drafts]
    cm_rules: list[RuleFired] = []
    if conmed_match is not None:
        cm_draft, cm_rule = build_cm_draft(inp, conmed_match, gate_ids["conmed_text"])
        drafts.append(cm_draft)
        cm_rules.append(cm_rule)

    rules_fired = (*prior, *ae_rules, *vs_rules, *cm_rules)
    return CheckInResult(
        items=item_results,
        max_grade=max_grade,
        base_tier=tier.base_tier,
        red_flag_tier_floor=red.tier_floor,
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
    )
