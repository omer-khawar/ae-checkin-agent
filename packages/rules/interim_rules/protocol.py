"""Protocol-aware rules from the real EMPOWER-Lung 1 protocol (CLAUDE.md §00.1, CONTRACTS.md R3.1).

Source: clinical study protocol R2810-ONC-1624 Amendment 9 (NCT03088540), cached as a
verbatim excerpt in ``data/public/empower_lung1_protocol_excerpt.json``. Every number,
list and quoted sentence lives in ``data/protocol_rules.json`` and
``data/irae_mapping.json``; this module only reads them. Three questions are answered:

1. **Possible AESI** (§9.4.3, p. 92). The protocol's adverse events of special interest
   that a kiosk check-in can show are "Grade 3 or greater irAEs" and "An irAE of any
   grade in a patient previously treated with a PI 3-K inhibitor". Interim cannot decide
   that an AE is immune-related (only the investigator can), so it asks a narrower,
   table-driven question: is the item *potentially* immune-related
   (``irae_mapping.json``) and is its provisional grade high enough? A yes is labeled
   "possible AESI, investigator to confirm" and starts a 24-hour clock of kind
   ``"aesi"`` (same machinery as the SAE clock). It never changes a grade or the tier.
2. **Concomitant medication level** (§7.7.1-7.7.2, p. 69). A reported medication is
   matched against the protocol's prohibited, discouraged and permitted lists by the
   medlist match (:class:`~interim_rules.models.ConMedMatch` ``matched_name``) and by
   whole words of the verbatim text (generic names, the table's brand aliases and a few
   category phrases), so a brand the medlist does not know (``Avastin``) still works.
   Prohibited -> tier floor 2, "possible protocol deviation, coordinator to confirm";
   discouraged -> a coordinator flag with the protocol's own exception text, tier
   unchanged; permitted -> an informational note.
3. **CM completeness** (§7.7, p. 69). The protocol requires generic name, dose, dose
   unit, frequency, indication and start/stop date "as appropriate"; the kiosk collects
   only the name and whether it was started or stopped, so the missing fields are listed
   for the coordinator to ask.

Pure: no clock, no I/O beyond the package's own tables, no network, no LLM.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import date, timedelta

from .evidence import gate_evidence, pro_evidence, rule_evidence, table_evidence
from .models import (
    CheckInResult,
    ConMedMatch,
    Evidence,
    GateAnswers,
    ItemResult,
    ProtocolAssessment,
    ProtocolConMedFlag,
    ProtocolContext,
    ProtocolLevel,
    ProtocolMatchBy,
    ProtocolRef,
    RuleFired,
    SAEClock,
)
from .seriousness import build_clock
from .tables import PROTOCOL_LEVELS, ProtocolDrug, irae_mapping, item_by_id, protocol_rules
from .timefmt import parse_iso_utc

__all__ = [
    "IRAE_TABLE_FILE",
    "PROTOCOL_TABLE_FILE",
    "ProtocolAssessment",
    "ProtocolConMedFlag",
    "ProtocolContext",
    "assess_protocol",
    "classify_conmed",
    "cm_missing_fields",
    "parse_last_dose_date",
    "start_aesi_clock",
]

PROTOCOL_TABLE_FILE = "protocol_rules.json"
IRAE_TABLE_FILE = "irae_mapping.json"

_LEVEL_RANK: Mapping[ProtocolLevel, int] = {level: i for i, level in enumerate(PROTOCOL_LEVELS)}
_NON_WORD = re.compile(r"[^a-z0-9]+")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _cite(ref: ProtocolRef) -> str:
    """``§7.7.1, p. 69`` - how a protocol reference is written in every sentence."""
    return f"§{ref.section}, p. {ref.printed_page}"


def _words(text: str) -> str:
    """Lowercase text with every run of non-alphanumerics collapsed to one space, padded.

    Padding with spaces lets a phrase match only on whole words: ``" avastin "`` is found
    in ``" started avastin today "`` but ``" gel "`` is not found in ``" gelatin "``.
    """
    return f" {_NON_WORD.sub(' ', text.lower()).strip()} "


def _has_words(haystack: str, phrase: str) -> bool:
    needle = _NON_WORD.sub(" ", phrase.lower()).strip()
    return bool(needle) and f" {needle} " in haystack


def parse_last_dose_date(value: str | None) -> date | None:
    """Parse ``ProtocolContext.last_dose_date`` (``YYYY-MM-DD``); ``ValueError`` if malformed."""
    if value is None:
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError as exc:
        raise ValueError(f"expected an ISO date YYYY-MM-DD, got {value!r}") from exc


def _items_of(source: Sequence[ItemResult] | CheckInResult) -> tuple[ItemResult, ...]:
    return source.items if isinstance(source, CheckInResult) else tuple(source)


# --------------------------------------------------------------------------- #
# 1. Possible AESI
# --------------------------------------------------------------------------- #


def _aesi(
    items: Sequence[ItemResult], context: ProtocolContext
) -> tuple[tuple[str, ...], tuple[str, ...], RuleFired | None]:
    """AESI items, plain-English reasons and the ``protocol.aesi_suspected`` rule (or None)."""
    rules = protocol_rules()
    mapping = irae_mapping()
    aesi_cite = _cite(rules.aesi.reference.protocol_ref)
    hits: dict[str, list[str]] = {}
    reasons: list[str] = []
    criteria_used: list[str] = []
    for criterion in rules.aesi.criteria:
        if not criterion.detectable_from_kiosk:
            continue
        if (
            criterion.requires_context == "prior_pi3k_inhibitor"
            and not context.prior_pi3k_inhibitor
        ):
            continue
        for result in items:
            row = mapping.get(result.item_id)
            if row is None or not row.potentially_immune_related:
                continue
            if result.provisional_grade < criterion.min_grade:
                continue
            hits.setdefault(result.item_id, []).append(criterion.id)
            if criterion.id not in criteria_used:
                criteria_used.append(criterion.id)
            context_note = (
                "; the participant was previously treated with a PI 3-K inhibitor"
                if criterion.requires_context == "prior_pi3k_inhibitor"
                else ""
            )
            reasons.append(
                f"{result.label}: provisional grade {result.provisional_grade} (provisional, "
                f"investigator to confirm) on a potentially immune-related item "
                f"({row.irae_category}){context_note}. Protocol {aesi_cite}"
                f" lists '{criterion.quote}'."
            )
    if not hits:
        return (), (), None

    aesi_items = tuple(r.item_id for r in items if r.item_id in hits)
    by_id = {r.item_id: r for r in items}
    evidence: list[Evidence] = []
    for item_id in aesi_items:
        result = by_id[item_id]
        item = item_by_id(item_id)
        evidence.extend(pro_evidence(r, item) for r in result.responses)
        evidence.append(
            rule_evidence(
                f"grade.provisional.{item_id}", "provisional grade (investigator to confirm)"
            )
        )
        evidence.append(
            table_evidence(
                IRAE_TABLE_FILE,
                f"{item_id}: potentially immune-related ({mapping[item_id].irae_category})",
            )
        )
    evidence.append(
        table_evidence(
            PROTOCOL_TABLE_FILE,
            f"aesi.criteria {', '.join(criteria_used)} ({aesi_cite})",
        )
    )
    labels = ", ".join(by_id[i].label for i in aesi_items)
    rule = RuleFired(
        rule_id="protocol.aesi_suspected",
        category="protocol",
        description=(
            f"Possible adverse event of special interest ({rules.aesi.label}): {labels}. "
            + " ".join(reasons)
            + f" The protocol asks for AESI reports within {rules.aesi.reporting_hours:g} hours "
            "of identification."
        ),
        inputs={
            "aesi_items": list(aesi_items),
            "criteria": {item_id: list(ids) for item_id, ids in hits.items()},
            "grades": {item_id: by_id[item_id].provisional_grade for item_id in aesi_items},
            "irae_categories": {item_id: mapping[item_id].irae_category for item_id in aesi_items},
            "prior_pi3k_inhibitor": context.prior_pi3k_inhibitor,
            "protocol_ref": _cite(rules.aesi.reference.protocol_ref),
            "label": rules.aesi.label,
        },
        effect="aesi_suspected = true; 24-hour AESI clock starts; grade and tier unchanged",
        evidence=tuple(evidence),
    )
    return aesi_items, tuple(reasons), rule


def start_aesi_clock(
    assessment: ProtocolAssessment,
    site_awareness_at: str,
    *,
    already_clocked: Mapping[str, str] | None = None,
) -> tuple[SAEClock | None, tuple[RuleFired, ...]]:
    """Start the 24-hour AESI clock (kind ``"aesi"``) when an AESI is suspected.

    The site becomes aware when the check-in is completed, so ``site_awareness_at`` is
    ``completed_at``; the due time is ``site_awareness_at + aesi.reporting_hours``.

    ``already_clocked`` maps AESI item ids that are de-duplication follow-ups of an open
    AE which already has an AESI clock to that AE's id. One event gets one clock: when
    every suspected item is already clocked, no new clock starts and
    ``aesi.clock_not_restarted`` says why; otherwise the clock starts for the rest.
    """
    if not assessment.aesi_suspected:
        return None, ()
    rules = protocol_rules()
    ref = rules.aesi.reference
    clocked = dict(already_clocked or {})
    covered = [i for i in assessment.aesi_items if i in clocked]
    new_items = [i for i in assessment.aesi_items if i not in clocked]
    not_restarted: tuple[RuleFired, ...] = ()
    if covered:
        pairs = ", ".join(f"{item_by_id(i).label} (open AE {clocked[i]})" for i in covered)
        not_restarted = (
            RuleFired(
                rule_id="aesi.clock_not_restarted",
                category="protocol",
                description=(
                    f"No second AESI clock for {pairs} ({rules.aesi.label}): this check-in is "
                    "a follow-up of an open AE that already has a 24-hour AESI clock, so the "
                    "existing clock stands (one event, one clock)"
                ),
                inputs={
                    "items": covered,
                    "labels": [item_by_id(i).label for i in covered],
                    "ae_open_ids": [clocked[i] for i in covered],
                    "label": rules.aesi.label,
                },
                effect="no new AESI clock for these items; grade and tier unchanged",
                evidence=(
                    rule_evidence("protocol.aesi_suspected", rules.aesi.label),
                    *(rule_evidence("dedup.followup_linked", clocked[i]) for i in covered),
                ),
            ),
        )
    if not new_items:
        return None, not_restarted
    clock = build_clock(
        site_awareness_at,
        kind="aesi",
        hours=rules.aesi.reporting_hours,
        informational={
            "label": rules.aesi.label,
            "protocol_ref": f"{rules.protocol_id} {rules.amendment} {_cite(ref.protocol_ref)}",
            "protocol_text": ref.quote,
            "note": "Possible AESI from participant-reported answers. The investigator decides "
            "whether the event is immune-related; the clock stops when they record a decision.",
        },
    )
    rule = RuleFired(
        rule_id="aesi.clock_started",
        category="protocol",
        description=(
            f"24-hour AESI clock started ({rules.aesi.label}). The site became aware at "
            f"{clock.site_awareness_at}; the report to the sponsor is due {clock.due_at} "
            f"({rules.aesi.reporting_hours:g} h, protocol {_cite(ref.protocol_ref)}: same process "
            "as an SAE report)"
        ),
        inputs={
            "kind": clock.kind,
            "site_awareness_at": clock.site_awareness_at,
            "due_at": clock.due_at,
            "reporting_hours": rules.aesi.reporting_hours,
            "aesi_items": new_items,
        },
        effect="AESI clock started (stops on investigator decision); grade and tier unchanged",
        evidence=(
            rule_evidence("protocol.aesi_suspected", rules.aesi.label),
            table_evidence(
                PROTOCOL_TABLE_FILE,
                f"aesi.reporting_hours = {rules.aesi.reporting_hours:g} "
                f"({_cite(ref.protocol_ref)})",
            ),
        ),
    )
    return clock, (*not_restarted, rule)


# --------------------------------------------------------------------------- #
# 2. Concomitant medication level
# --------------------------------------------------------------------------- #


def _match_drug(
    drug: ProtocolDrug, words: str, matched_name: str | None
) -> tuple[str, ProtocolMatchBy] | None:
    for name in drug.names:
        if _has_words(words, name):
            return name, "verbatim_name"
    for term in drug.match_terms:
        if _has_words(words, term):
            return term, "verbatim_term"
    if matched_name is not None and matched_name.lower() in drug.names:
        return matched_name.lower(), "medlist"
    return None


def classify_conmed(
    verbatim: str, matched_name: str | None = None
) -> tuple[tuple[ProtocolConMedFlag, ...], tuple[str, ...]]:
    """Protocol flags for one reported medication, most restrictive first, plus notes.

    Words typed by the participant win over the medlist's fuzzy match: when any protocol
    drug is named outright, a medlist-only hit (which may be an edit-distance neighbour,
    e.g. ``prednisolone`` -> ``prednisone``) is dropped so one medication is not flagged
    twice. A discouraged corticosteroid typed together with a non-systemic qualifier
    (``hydrocortisone cream``) is not flagged; a note says why.
    """
    rules = protocol_rules()
    words = _words(verbatim)
    if not words.strip():
        return (), ()
    qualifiers = [w for w in rules.non_systemic_qualifiers if _has_words(words, w)]
    hits: list[tuple[ProtocolDrug, str, ProtocolMatchBy]] = []
    for drug in rules.drugs:
        found = _match_drug(drug, words, matched_name)
        if found is not None:
            hits.append((drug, *found))
    if any(by != "medlist" for _, _, by in hits):
        hits = [hit for hit in hits if hit[2] != "medlist"]

    flags: list[ProtocolConMedFlag] = []
    notes: list[str] = []
    for drug, matched, by in hits:
        if drug.systemic_only and qualifiers:
            notes.append(
                f"'{verbatim}' names {drug.drug} with the word '{qualifiers[0]}', so it is likely "
                f"not a systemic corticosteroid; the protocol's recommendation "
                f"({_cite(drug.protocol_ref)}) is about systemic use, so no flag is raised. "
                "Coordinator to confirm the form."
            )
            continue
        flags.append(
            ProtocolConMedFlag(
                level=drug.level,
                drug=drug.drug,
                matched_text=matched,
                matched_by=by,
                protocol_ref=drug.protocol_ref,
                quote=drug.quote,
                exception_text=drug.exception_text,
                condition=drug.condition,
                is_category=drug.is_category,
            )
        )
    flags.sort(key=lambda f: _LEVEL_RANK[f.level])
    return tuple(flags), tuple(notes)


def _conmed_rule(
    flag: ProtocolConMedFlag, verbatim: str, direction: str | None, gate_id: str, floor: int
) -> RuleFired:
    rules = protocol_rules()
    cite = _cite(flag.protocol_ref)
    how = {
        "verbatim_name": f"the text names '{flag.matched_text}'",
        "verbatim_term": f"the text contains '{flag.matched_text}'",
        "medlist": f"the medication list matched '{flag.matched_text}'",
    }[flag.matched_by]
    if flag.level == "prohibited":
        description = (
            f"Medication '{verbatim}' ({how}) is {flag.drug}, which the protocol does not allow "
            f"({cite}: '{flag.quote}'). {rules.prohibited_reason.capitalize()}, coordinator to "
            f"confirm; tier floor {floor}"
        )
        effect = f"tier floor {floor} (possible protocol deviation)"
    elif flag.level == "discouraged":
        description = (
            f"Medication '{verbatim}' ({how}) is {flag.drug}, a systemic corticosteroid the "
            f"protocol recommends avoiding ({cite}) '{flag.exception_text}' Coordinator to check "
            "the reason with the study team; tier unchanged"
        )
        effect = "coordinator flag (discouraged by the protocol); tier unchanged"
    else:
        condition = f" Condition: '{flag.condition}'" if flag.condition else ""
        description = (
            f"Medication '{verbatim}' ({how}) is {flag.drug}, which the protocol permits "
            f"({cite}: '{flag.quote}').{condition} No protocol issue; tier unchanged"
        )
        effect = "informational (permitted by the protocol); tier unchanged"
    return RuleFired(
        rule_id=f"protocol.conmed_{flag.level}",
        category="protocol",
        description=description,
        inputs={
            "verbatim": verbatim,
            "drug": flag.drug,
            "level": flag.level,
            "matched_text": flag.matched_text,
            "matched_by": flag.matched_by,
            "direction": direction,
            "protocol_ref": cite,
            "exception_text": flag.exception_text,
            "condition": flag.condition,
            "tier_floor": floor if flag.level == "prohibited" else 0,
        },
        effect=effect,
        evidence=(
            gate_evidence(gate_id, f"conmed_text = '{verbatim}' (verbatim)"),
            table_evidence(PROTOCOL_TABLE_FILE, f"conmeds.{flag.level}: {flag.drug} ({cite})"),
        ),
    )


# --------------------------------------------------------------------------- #
# 3. CM completeness
# --------------------------------------------------------------------------- #


def cm_missing_fields(gates: GateAnswers) -> tuple[str, ...]:
    """CM fields the protocol requires (§7.7, p. 69) that a kiosk CM draft cannot fill.

    "Start/stop date, as appropriate": a medication reported as started is still being
    taken, so it needs no stop date; one reported as stopped needs its start date; with
    no direction both dates are missing. Dose, unit, frequency and indication are never
    asked by the kiosk. ``CMTRT`` is missing only when no name was typed.
    """
    direction = gates.conmed_direction
    present = {"CMTRT"} if (gates.conmed_text or "").strip() else set()
    if direction in ("started", "both"):
        present.add("CMSTDTC")
    if direction in ("stopped", "both"):
        present.add("CMENDTC")
    if direction == "started":
        present.add("CMENDTC")  # ongoing: a stop date is not appropriate yet
    return tuple(f for f in protocol_rules().cm_required_fields if f not in present)


def _cm_missing_rule(missing: Sequence[str], verbatim: str, gate_id: str) -> RuleFired:
    rules = protocol_rules()
    labels = {f.field: f.protocol_term for f in rules.cm_required_detail}
    cite = _cite(rules.cm_required_reference.protocol_ref)
    shown = ", ".join(labels[f] for f in missing)
    name = f"'{verbatim}'" if verbatim.strip() else "the reported medication (no name typed)"
    return RuleFired(
        rule_id="protocol.cm_fields_missing",
        category="protocol",
        description=(
            f"The protocol asks for each medication's generic name, dose, dose unit, frequency, "
            f"indication and start/stop date ({cite}). Still missing for {name}: {shown}. "
            "Coordinator to ask the participant"
        ),
        inputs={"missing": list(missing), "required": list(rules.cm_required_fields)},
        effect=f"INTERIM_CM_MISSING_FIELDS = {list(missing)}",
        evidence=(
            gate_evidence(gate_id, f"conmed_text = '{verbatim}'; direction recorded"),
            table_evidence(PROTOCOL_TABLE_FILE, f"cm_required_fields ({cite})"),
        ),
    )


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def assess_protocol(
    items: Sequence[ItemResult] | CheckInResult,
    conmed: ConMedMatch | None,
    gates: GateAnswers,
    context: ProtocolContext,
    *,
    completed_at: str | None = None,
    gate_ids: Mapping[str, str] | None = None,
) -> ProtocolAssessment:
    """Apply the protocol tables to one check-in's graded items and reported medication.

    ``items`` may be the graded items (what :func:`~interim_rules.engine.evaluate_checkin`
    passes, before the ladder runs, because the protocol floor feeds the ladder) or a
    finished :class:`CheckInResult`. ``completed_at`` is only used for the informational
    AE reporting window. Never changes a grade.
    """
    rules = protocol_rules()
    graded = _items_of(items)
    gate_id = (gate_ids or {}).get("conmed_text") or gates.conmed_answer_id or "gate_conmed"

    aesi_items, aesi_reasons, aesi_rule = _aesi(graded, context)
    fired: list[RuleFired] = [aesi_rule] if aesi_rule is not None else []

    flags: tuple[ProtocolConMedFlag, ...] = ()
    notes: tuple[str, ...] = ()
    missing: tuple[str, ...] = ()
    floor = 0
    if gates.conmed_changed:
        verbatim = conmed.verbatim if conmed is not None else (gates.conmed_text or "")
        matched = conmed.matched_name if conmed is not None else None
        flags, notes = classify_conmed(verbatim, matched)
        if any(f.level == "prohibited" for f in flags):
            floor = rules.prohibited_tier_floor
        fired.extend(
            _conmed_rule(f, verbatim, gates.conmed_direction, gate_id, floor) for f in flags
        )
        missing = cm_missing_fields(gates)
        if missing:
            fired.append(_cm_missing_rule(missing, verbatim, gate_id))

    last_dose = parse_last_dose_date(context.last_dose_date)
    new_therapy = parse_last_dose_date(context.new_anticancer_therapy_date)
    window_end: str | None = None
    within: bool | None = None
    if last_dose is not None:
        # §9.4.1, p. 91: until 90 days after the last dose, or until the participant
        # commences another anti-cancer systemic therapy, whichever is earlier.
        end = last_dose + timedelta(days=rules.ae_reporting_window_days)
        if new_therapy is not None:
            end = min(end, new_therapy)
        window_end = end.isoformat()
        if completed_at is not None:
            within = parse_iso_utc(completed_at).date() <= end

    return ProtocolAssessment(
        protocol_id=f"{rules.protocol_id} {rules.amendment}",
        context=context,
        aesi_suspected=bool(aesi_items),
        aesi_items=aesi_items,
        aesi_reasons=aesi_reasons,
        conmed_flags=flags,
        conmed_flag=flags[0].level if flags else None,
        conmed_notes=notes,
        cm_missing_fields=missing,
        tier_floor=floor,
        ae_reporting_window_end=window_end,
        within_ae_reporting_window=within,
        rules_fired=tuple(fired),
    )
