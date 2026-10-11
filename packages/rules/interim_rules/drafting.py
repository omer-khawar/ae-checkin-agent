"""CDISC SDTM-shaped draft records (CLAUDE.md §3.5, CONTRACTS.md §1.8).

Three domains are drafted:

* **AE** - one record per symptom with provisional grade >= 1 (follow-ups of an
  open AE keep the original ``AESTDTC`` and carry ``INTERIM_FOLLOWUP_OF``);
* **VS** - one summary row per metric (``PULSE``, ``RESP``, and ``HRV_RMSSD``
  when any sample carried HRV), ``VSSTAT = "NOT DONE"`` when the metric had no
  usable sample; no VS rows at all when the session captured no samples;
* **CM** - one record when the participant reported a medication change with text.

Protocol additions (CONTRACTS.md R3.1): an AE draft for an item the protocol rules
flag as a possible AESI carries ``INTERIM_AESI_SUSPECTED = True`` ("possible AESI,
investigator to confirm"); every CM draft carries ``INTERIM_PROTOCOL_FLAG``
(``prohibited | discouraged | permitted | None``) and ``INTERIM_CM_MISSING_FIELDS``
(the protocol-required CM fields the kiosk could not fill), each with evidence pointing
at ``protocol_rules.json``. When the medlist has no match but the participant named a
protocol drug or brand outright (``Avastin``), ``CMDECOD`` takes the protocol table's
generic name, with that table as its evidence. The same happens when the medlist's
only hit is an edit-distance neighbour of a different drug (``prednisolone`` would
otherwise become ``prednisone``): a name typed outright beats a fuzzy match.

Every field with a value carries ``evidence`` pointing at the answers, samples,
rules or tables that produced it. Fields that are null until a human decides
(``AESER``, ``AEREL``, ``AEACN``, ``AEOUT``, ``CMSTAT``) carry no evidence.
Drafts are drafts: nothing here is final until a coordinator confirms it.

Evidence economy on VS rows (a 1 Hz capture can run to hundreds of samples):
only ``VSORRES`` (a median) points at every reading it was computed from;
``VSDTC`` points at the last reading; the label/count fields (``VSMETHOD``,
``INTERIM_SOURCE``, ``INTERIM_IS_MEASURED``, ``INTERIM_N_SAMPLES``,
``INTERIM_CONFIDENCE``) point at the ``vitals.summary`` rule plus the first and
last sample of the span. The full id list is ``vitals.eligible_sample_ids``.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence

from .conmed import MEDLIST_FILE
from .dedup import DedupDecision
from .escalation import TierOutcome
from .evidence import gate_evidence, pro_evidence, rule_evidence, sample_evidence, table_evidence
from .grading import GRADE_TABLE_FILE
from .models import (
    CheckInInput,
    ConMedMatch,
    DraftField,
    DraftRecord,
    Evidence,
    ItemResult,
    ProtocolAssessment,
    RuleFired,
    VitalsAssessment,
    VitalsSampleIn,
)
from .protocol import IRAE_TABLE_FILE, PROTOCOL_TABLE_FILE
from .tables import ctcae_term_for_item, grade_map, item_by_id, protocol_rules, vitals_config
from .timefmt import iso_date, normalize_iso, parse_iso_utc
from .vitals import METRICS, Metric, MetricReading, effective_is_measured, span_evidence

CTCAE_TABLE_FILE = "ctcae_terms.json"

VS_TESTS: Mapping[Metric, tuple[str, str, str]] = {
    "pulse": ("PULSE", "Pulse Rate", "beats/min"),
    "breathing": ("RESP", "Respiratory Rate", "breaths/min"),
    "hrv": ("HRV_RMSSD", "Heart Rate Variability (RMSSD)", "ms"),
}
"""SDTM ``VSTESTCD`` / ``VSTEST`` / ``VSORRESU`` for each metric (CLAUDE.md §3.5)."""


def _field(name: str, value: object, evidence: Sequence[Evidence] = ()) -> DraftField:
    return DraftField(name=name, value=value, evidence=tuple(evidence))


def _unique(ids: Sequence[str]) -> list[str]:
    seen: dict[str, None] = {}
    for rule_id in ids:
        seen.setdefault(rule_id, None)
    return list(seen)


# --------------------------------------------------------------------------- #
# AE
# --------------------------------------------------------------------------- #


def _related_rule_ids(
    answer_ids: set[str], prior_rules: Sequence[RuleFired], decision: DedupDecision
) -> list[str]:
    """Rules that used one of this item's answers, plus the tier rules and the dedup decision."""
    related = [
        rule.rule_id
        for rule in prior_rules
        if rule.rule_id.startswith("tier.")
        or any(e.kind == "pro_response" and e.id in answer_ids for e in rule.evidence)
    ]
    related.append(decision.rule.rule_id)
    return _unique(related)


def build_ae_drafts(
    inp: CheckInInput,
    graded_items: Sequence[ItemResult],
    decisions: Mapping[str, DedupDecision],
    tier: TierOutcome,
    prior_rules: Sequence[RuleFired],
    gate_ids: Mapping[str, str],
    protocol: ProtocolAssessment | None = None,
) -> tuple[tuple[DraftRecord, ...], tuple[RuleFired, ...]]:
    """One AE draft per graded item, numbered from ``inp.next_aeseq``.

    Items in ``protocol.aesi_items`` also get ``INTERIM_AESI_SUSPECTED = True``.
    """
    aesi_items = set(protocol.aesi_items) if protocol is not None else set()
    aesi_label = protocol_rules().aesi.label
    drafts: list[DraftRecord] = []
    rules: list[RuleFired] = []
    context = rule_evidence("draft.ae", f"session {inp.session_id} context")
    provisional_note = f"{grade_map().grade_label}; grade from participant answers only"

    for offset, result in enumerate(graded_items):
        item = item_by_id(result.item_id)
        term = ctcae_term_for_item(result.item_id)
        decision = decisions[result.item_id]
        aeseq = inp.next_aeseq + offset
        grade_rule_id = f"grade.provisional.{result.item_id}"
        response_ev = tuple(pro_evidence(r, item) for r in result.responses)
        answer_ids = {r.answer_id for r in result.responses}

        # Optional gate fields that belong with this item (e.g. the typed temperature) are
        # attached as evidence only; they never change the grade.
        extra_ev: list[Evidence] = []
        for field_name in item.optional_gate_fields:
            value = getattr(inp.gates, field_name, None)
            if value is not None:
                extra_ev.append(
                    gate_evidence(
                        gate_ids.get(field_name, f"{inp.session_id}:gate_{field_name}"),
                        f"{field_name} = {value} (participant-typed; evidence only)",
                    )
                )

        first_report = (
            normalize_iso(min(result.responses, key=lambda r: parse_iso_utc(r.ts)).ts)
            if result.responses
            else normalize_iso(inp.completed_at)
        )
        if decision.linked is not None:
            aestdtc = normalize_iso(decision.linked.first_reported_at)
            aestdtc_ev: tuple[Evidence, ...] = (
                rule_evidence(
                    decision.rule.rule_id,
                    f"follow-up of open AE {decision.linked.ae_open_id}; first reported {aestdtc}",
                ),
            )
        else:
            aestdtc = first_report
            aestdtc_ev = response_ev or (context,)

        related = _related_rule_ids(answer_ids, prior_rules, decision)
        is_aesi = result.item_id in aesi_items
        if is_aesi:
            related = _unique([*related, "protocol.aesi_suspected", "aesi.clock_started"])
        followup_of = decision.linked.ae_open_id if decision.linked is not None else None

        fields: tuple[DraftField, ...] = (
            _field("STUDYID", inp.studyid, (context,)),
            _field("INTERIM_NCT_ID", inp.nct_id, (context,) if inp.nct_id is not None else ()),
            _field("USUBJID", inp.usubjid, (context,)),
            _field("AESEQ", aeseq, (context,)),
            _field("AETERM", result.label, (*response_ev, *extra_ev)),
            _field(
                "AEDECOD",
                term.aedecod,
                (
                    *response_ev,
                    table_evidence(
                        CTCAE_TABLE_FILE,
                        f"{result.item_id} -> {term.aedecod} (CTCAE v5.0; "
                        f"mock MedDRA code {term.meddra_code_mock})",
                    ),
                ),
            ),
            _field("AESTDTC", aestdtc, aestdtc_ev),
            _field("AEENDTC", None),
            _field("AEONGO", "Y", (context,)),
            _field(
                "AETOXGR",
                result.provisional_grade,
                (rule_evidence(grade_rule_id, provisional_note), *response_ev),
            ),
            _field("AESER", None),
            _field("AEREL", None),
            _field("AEACN", None),
            _field("AEOUT", None),
            _field("INTERIM_TIER", tier.final_tier, (rule_evidence("tier.final", "final tier"),)),
            _field(
                "INTERIM_RULES_FIRED",
                related,
                tuple(rule_evidence(rid, "rule fired for this item") for rid in related),
            ),
            _field(
                "INTERIM_PROVISIONAL", True, (table_evidence(GRADE_TABLE_FILE, provisional_note),)
            ),
            _field(
                "INTERIM_FOLLOWUP_OF",
                followup_of,
                (rule_evidence(decision.rule.rule_id, "dedup decision"),)
                if followup_of is not None
                else (),
            ),
        )
        if is_aesi:
            fields = (
                *fields,
                _field(
                    "INTERIM_AESI_SUSPECTED",
                    True,
                    (
                        rule_evidence("protocol.aesi_suspected", aesi_label),
                        rule_evidence("aesi.clock_started", "24-hour AESI clock"),
                        table_evidence(
                            IRAE_TABLE_FILE, f"{result.item_id}: potentially immune-related"
                        ),
                    ),
                ),
            )
        drafts.append(
            DraftRecord(
                domain="AE",
                fields=fields,
                linked_ae_open_id=followup_of,
                is_followup=followup_of is not None,
            )
        )
        followup_note = f"; follow-up of open AE {followup_of}" if followup_of else ""
        if is_aesi:
            followup_note += f"; {aesi_label}"
        rules.append(
            RuleFired(
                rule_id="draft.ae",
                category="drafting",
                description=(
                    f"AE draft {aeseq}: {term.aedecod} ({result.label}), provisional grade "
                    f"{result.provisional_grade}{followup_note}"
                ),
                inputs={
                    "aeseq": aeseq,
                    "aeterm": result.label,
                    "aedecod": term.aedecod,
                    "aetoxgr": result.provisional_grade,
                    "aestdtc": aestdtc,
                    "tier": tier.final_tier,
                    "followup_of": followup_of,
                    "aesi_suspected": is_aesi,
                },
                effect=f"AE draft created (AESEQ {aeseq}); awaiting coordinator confirmation",
                evidence=(
                    *response_ev,
                    rule_evidence(grade_rule_id, "provisional grade"),
                    rule_evidence(decision.rule.rule_id, "dedup decision"),
                ),
            )
        )
    return tuple(drafts), tuple(rules)


# --------------------------------------------------------------------------- #
# VS
# --------------------------------------------------------------------------- #


def _quality_rule_id(assessment: VitalsAssessment) -> str | None:
    for rule in assessment.rules_fired:
        if rule.rule_id in ("vitals.low_quality", "vitals.implausible", "vitals.simulated_ignored"):
            return rule.rule_id
    return None


def build_vs_drafts(
    inp: CheckInInput, assessment: VitalsAssessment, readings: Sequence[MetricReading]
) -> tuple[tuple[DraftRecord, ...], tuple[RuleFired, ...]]:
    """One summary row per metric present; empty when the session captured no samples."""
    samples = inp.vitals
    if not samples:
        return (), ()
    cfg = vitals_config()
    context = rule_evidence("draft.vs", f"session {inp.session_id} context")
    present: list[Metric] = [m for m in METRICS if m != "hrv"]
    if any(s.hrv_rmssd_ms is not None for s in samples):
        present.append("hrv")
    ordered_samples = sorted(samples, key=lambda s: parse_iso_utc(s.ts_utc))
    last_sample = ordered_samples[-1]
    sample_span = span_evidence([(s.sample_id, s.ts_utc) for s in samples], "captured sample(s)")
    quality_rule = _quality_rule_id(assessment)

    drafts: list[DraftRecord] = []
    rules: list[RuleFired] = []
    for seq, metric in enumerate(present, start=1):
        code, test, unit = VS_TESTS[metric]
        usable = sorted(
            (r for r in readings if r.metric == metric and r.state == "usable"),
            key=lambda r: parse_iso_utc(r.ts),
        )
        rejected = [r for r in readings if r.metric == metric and r.state != "usable"]

        if usable:
            values = [r.value for r in usable]
            confidences = [r.conf for r in usable if r.conf is not None]
            vsorres: float | None = round(statistics.median(values), 1)
            last = usable[-1]
            vsdtc = last.ts
            is_measured = all(r.is_measured for r in usable)
            sources = sorted({r.source for r in usable})
            n_samples = len({r.sample_id for r in usable})
            confidence: float | None = (
                round(statistics.median(confidences), 2) if confidences else None
            )
            vsstat: str | None = None
            span = span_evidence(
                [(r.sample_id, r.ts) for r in usable], f"usable {metric} reading(s)"
            )
            summary_ev = rule_evidence(
                "vitals.summary",
                f"{code}: {n_samples} usable reading(s), source {'/'.join(sources)}, "
                f"measured = {is_measured}",
            )
            # VSORRES is a median: it genuinely derives from every usable reading, so it is
            # the one field that keeps a pointer per reading.
            value_ev: tuple[Evidence, ...] = (
                *(
                    sample_evidence(
                        r.sample_id, r.ts, f"{metric} = {r.value:g} {unit} (conf {r.conf:.2f})"
                    )
                    for r in usable
                    if r.conf is not None
                ),
                rule_evidence(
                    "vitals.summary", f"{code} = median of {len(values)} usable readings"
                ),
            )
            vsdtc_ev: tuple[Evidence, ...] = (
                sample_evidence(last.sample_id, last.ts, f"last usable {metric} reading"),
            )
            method_ev: tuple[Evidence, ...] = (summary_ev, *span)
            confidence_ev: tuple[Evidence, ...] = (
                rule_evidence(
                    "vitals.summary", f"{code}: median confidence of {len(confidences)} readings"
                ),
                *span,
            )
            count_ev: tuple[Evidence, ...] = (summary_ev, *span)
            stat_ev: tuple[Evidence, ...] = ()
            rule_ev: tuple[Evidence, ...] = (summary_ev, *span)
        else:
            vsorres = None
            vsdtc = last_sample.ts_utc
            is_measured = all(effective_is_measured(s, cfg) for s in samples)
            sources = sorted({s.source for s in samples})
            n_samples = 0
            confidence = None
            vsstat = "NOT DONE"
            if rejected:
                ordered_rejected = sorted(rejected, key=lambda r: parse_iso_utc(r.ts))
                first_bad, last_bad = ordered_rejected[0], ordered_rejected[-1]
                reasons: list[Evidence] = [
                    sample_evidence(
                        first_bad.sample_id,
                        first_bad.ts,
                        f"{first_bad.reason or 'ignored'} (first of {len(rejected)} ignored "
                        f"{metric} reading(s); all reasons in vitals.ignored)",
                    )
                ]
                if last_bad is not first_bad:
                    reasons.append(
                        sample_evidence(
                            last_bad.sample_id,
                            last_bad.ts,
                            f"{last_bad.reason or 'ignored'} (last of {len(rejected)})",
                        )
                    )
            else:
                reasons = [
                    sample_evidence(s.sample_id, s.ts_utc, f"no {metric} value in sample ({note})")
                    for s, note in _first_last(ordered_samples)
                ]
            if quality_rule is not None:
                reasons.append(rule_evidence(quality_rule, "session vitals status"))
            value_ev = ()
            vsdtc_ev = (
                sample_evidence(last_sample.sample_id, last_sample.ts_utc, "last captured sample"),
            )
            method_ev = (
                *span_evidence(
                    [(s.sample_id, s.ts_utc) for s in samples],
                    f"captured sample(s); measured = {is_measured} ({'/'.join(sources)})",
                ),
                *((rule_evidence(quality_rule, "session vitals status"),) if quality_rule else ()),
            )
            confidence_ev = ()
            count_ev = (context,)
            stat_ev = tuple(reasons)
            rule_ev = tuple(reasons) or sample_span

        method = cfg.method_measured if is_measured else cfg.method_simulated
        source = sources[0] if len(sources) == 1 else "mixed"
        fields = (
            _field("STUDYID", inp.studyid, (context,)),
            _field("INTERIM_NCT_ID", inp.nct_id, (context,) if inp.nct_id is not None else ()),
            _field("USUBJID", inp.usubjid, (context,)),
            _field("VSSEQ", seq, (context,)),
            _field("VSTESTCD", code, (context,)),
            _field("VSTEST", test, (context,)),
            _field("VSORRES", vsorres, value_ev),
            _field("VSORRESU", unit, (context,)),
            _field("VSDTC", vsdtc, vsdtc_ev),
            _field("VSMETHOD", method, method_ev),
            _field("VSSTAT", vsstat, stat_ev),
            _field("INTERIM_CONFIDENCE", confidence, confidence_ev),
            _field("INTERIM_SOURCE", source, method_ev),
            _field("INTERIM_N_SAMPLES", n_samples, count_ev),
            _field("INTERIM_IS_MEASURED", is_measured, method_ev),
        )
        drafts.append(
            DraftRecord(domain="VS", fields=fields, linked_ae_open_id=None, is_followup=False)
        )
        shown = "NOT DONE" if vsorres is None else f"{vsorres:g} {unit}"
        rules.append(
            RuleFired(
                rule_id="draft.vs",
                category="drafting",
                description=f"VS draft {code}: {shown} ({method}, n = {n_samples})",
                inputs={
                    "vsseq": seq,
                    "vstestcd": code,
                    "vsorres": vsorres,
                    "vsorresu": unit,
                    "vsmethod": method,
                    "vsstat": vsstat,
                    "n_samples": n_samples,
                    "is_measured": is_measured,
                    "source": source,
                },
                effect=f"VS draft created ({code}); awaiting coordinator confirmation",
                evidence=rule_ev,
            )
        )
    return tuple(drafts), tuple(rules)


def _first_last(ordered: Sequence[VitalsSampleIn]) -> list[tuple[VitalsSampleIn, str]]:
    """The first and last of an ordered sample list with a note, or just the one sample."""
    if len(ordered) == 1:
        return [(ordered[0], "the only sample")]
    return [(ordered[0], f"first of {len(ordered)}"), (ordered[-1], f"last of {len(ordered)}")]


# --------------------------------------------------------------------------- #
# CM
# --------------------------------------------------------------------------- #


def _protocol_cm_fields(
    match: ConMedMatch, protocol: ProtocolAssessment | None
) -> tuple[str | None, tuple[Evidence, ...], tuple[DraftField, ...]]:
    """Protocol-derived CM pieces: the CMDECOD fallback (+ evidence) and the two new fields."""
    if protocol is None:
        return None, (), ()
    cfg = protocol_rules()
    flag = protocol.conmed_flags[0] if protocol.conmed_flags else None
    flag_ev: tuple[Evidence, ...] = ()
    if flag is not None:
        cite = f"§{flag.protocol_ref.section}, p. {flag.protocol_ref.printed_page}"
        flag_ev = (
            rule_evidence(f"protocol.conmed_{flag.level}", f"{flag.drug}: {flag.level}"),
            table_evidence(PROTOCOL_TABLE_FILE, f"conmeds.{flag.level}: {flag.drug} ({cite})"),
        )
    ref = cfg.cm_required_reference.protocol_ref
    missing_ev: tuple[Evidence, ...] = (
        *(
            (rule_evidence("protocol.cm_fields_missing", "fields still to collect"),)
            if protocol.cm_missing_fields
            else ()
        ),
        table_evidence(
            PROTOCOL_TABLE_FILE, f"cm_required_fields (§{ref.section}, p. {ref.printed_page})"
        ),
    )
    fields = (
        _field("INTERIM_PROTOCOL_FLAG", protocol.conmed_flag, flag_ev),
        _field("INTERIM_CM_MISSING_FIELDS", list(protocol.cm_missing_fields), missing_ev),
    )
    named = [
        f for f in protocol.conmed_flags if f.matched_by == "verbatim_name" and not f.is_category
    ]
    if not named:
        return None, (), fields
    first = named[0]
    if match.matched_name is not None:
        # A medlist hit wins unless it is only an edit-distance neighbour of a different
        # protocol drug the participant named outright ('prednisolone' is one edit from
        # 'prednisone'); the typed name is the better evidence (protocol §7.7.2 names both).
        if match.match_kind != "levenshtein" or match.matched_name == first.drug:
            return None, (), fields
        why = (
            f"the medication list's closest entry '{match.matched_name}' is only an "
            f"edit-distance match, and the text names {first.drug} itself"
        )
    else:
        why = "the medication list has no entry"
    decod_ev: tuple[Evidence, ...] = (
        rule_evidence(f"protocol.conmed_{first.level}", f"named '{first.matched_text}'"),
        table_evidence(
            PROTOCOL_TABLE_FILE,
            f"{first.matched_text} -> {first.drug} (protocol table name or brand; {why})",
        ),
    )
    return first.drug, decod_ev, fields


def build_cm_draft(
    inp: CheckInInput,
    match: ConMedMatch,
    conmed_answer_id: str,
    protocol: ProtocolAssessment | None = None,
    seq: int = 1,
) -> tuple[DraftRecord, RuleFired]:
    """The CM draft for the reported medication change.

    ``CMTRT`` is the text exactly as typed (``""`` when the participant answered
    "yes" but typed nothing); an empty name is still a reported change and is
    drafted so the coordinator can ask, never silently dropped.
    """
    gates = inp.gates
    direction = gates.conmed_direction
    date = iso_date(inp.completed_at)
    cmstdtc = date if direction in ("started", "both") else None
    cmendtc = date if direction in ("stopped", "both") else None
    context = rule_evidence("draft.cm", f"session {inp.session_id} context")
    named = bool(match.verbatim.strip())
    gate_ev = gate_evidence(
        conmed_answer_id,
        f"conmed_changed = True; text as typed: '{match.verbatim}'"
        f"{'' if named else ' (no medication name typed)'}; direction = {direction}",
    )
    match_rule = f"conmed.{match.match_kind}"
    match_ev: tuple[Evidence, ...] = (
        rule_evidence(match_rule, f"{match.match_kind}; confidence {match.confidence}"),
        table_evidence(MEDLIST_FILE, "bundled medication list (NOT RxNorm)"),
    )
    protocol_decod, protocol_decod_ev, protocol_fields = _protocol_cm_fields(match, protocol)
    cmdecod = protocol_decod if protocol_decod is not None else match.matched_name
    cmdecod_ev = protocol_decod_ev if protocol_decod is not None else match_ev
    fields = (
        _field("STUDYID", inp.studyid, (context,)),
        _field("INTERIM_NCT_ID", inp.nct_id, (context,) if inp.nct_id is not None else ()),
        _field("USUBJID", inp.usubjid, (context,)),
        _field("CMSEQ", seq, (context,)),
        _field("CMTRT", match.verbatim, (gate_ev,)),
        _field("CMDECOD", cmdecod, cmdecod_ev),
        _field("CMSTDTC", cmstdtc, (gate_ev,) if cmstdtc is not None else ()),
        _field("CMENDTC", cmendtc, (gate_ev,) if cmendtc is not None else ()),
        _field("CMSTAT", None),
        _field("INTERIM_MATCH_CONFIDENCE", match.confidence, match_ev),
        _field("INTERIM_MATCH_KIND", match.match_kind, match_ev),
        _field("INTERIM_DIRECTION", direction, (gate_ev,) if direction is not None else ()),
        *protocol_fields,
    )
    draft = DraftRecord(domain="CM", fields=fields, linked_ae_open_id=None, is_followup=False)
    if named:
        outcome = cmdecod or "unmatched (verbatim kept)"
    else:
        outcome = "no medication name typed (coordinator to ask)"
    if protocol_decod is None:
        how = f"{match.match_kind}, confidence {match.confidence}"
    elif match.matched_name is None:
        how = "not in the medication list; generic name from the protocol table"
    else:
        how = (
            f"named outright; generic name from the protocol table instead of the medication "
            f"list's edit-distance neighbour '{match.matched_name}'"
        )
    rule = RuleFired(
        rule_id="draft.cm",
        category="drafting",
        description=(
            f"CM draft: '{match.verbatim}' -> {outcome} ({how}); "
            f"started {cmstdtc or '-'}, stopped {cmendtc or '-'}"
        ),
        inputs={
            "cmtrt": match.verbatim,
            "cmdecod": cmdecod,
            "cmstdtc": cmstdtc,
            "cmendtc": cmendtc,
            "direction": direction,
            "match_kind": match.match_kind,
            "confidence": match.confidence,
            "protocol_flag": protocol.conmed_flag if protocol is not None else None,
            "cm_missing_fields": list(protocol.cm_missing_fields) if protocol is not None else [],
        },
        effect="CM draft created; awaiting coordinator confirmation",
        evidence=(gate_ev, *match_ev, *protocol_decod_ev),
    )
    return draft, rule
