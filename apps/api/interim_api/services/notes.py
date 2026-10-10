"""Chart-note ingestion and scanning (CONTRACTS.md R2.4, decisions D-014 / D-017).

A clinician note is the second source of adverse-event evidence next to the
kiosk check-in (Regeneron's "Better" tier). Nothing here reads prose on its
own: ``interim_rules.chartscan`` (the deterministic scanner ported from
``omer-khawar/ae-checkin-agent``, Omer Khawar, MIT) returns findings with the
exact character spans they came from, and this module turns them into the same
rows a check-in produces, through the same ``apply_result`` path:

* one **AE draft** per kept symptom finding (``AETERM`` = the quoted words,
  ``AEDECOD`` = the CTCAE v5 term, ``AETOXGR`` = the scanner's grade hint,
  ``AESTDTC`` = the onset date when the note says one, else the note date; a
  "resolved / improved" cue is flagged as ``INTERIM_RESOLVED_CUE`` for the
  coordinator to set ``AEENDTC``, never turned into an end date by the API);
* one **CM draft** per kept medication finding (``CMTRT`` = the quoted words,
  ``CMDECOD`` = the lexicon's generic name, ``CMSTDTC``/``CMENDTC`` from the
  nearest action verb);
* **cross-source de-duplication**: the same ``AEDECOD`` already open for the
  participant (from a check-in or an earlier note) within the dedup window is
  a follow-up, not a new AE, using the engine's own ``find_open_ae``;
* **escalation**: an urgent/emergency red flag or a hospitalization mention
  makes a Tier 2 escalation (``source = "chart_note"``); a note never pages,
  never shows a stop screen and never reaches Tier 3 (D-017), because the
  participant is not in front of a kiosk and the note is retrospective;
* **seriousness**: a hospitalization/ER mention sets ``seriousness_suspected``
  and starts the SAE clock with ``site_awareness_at = ingested_at``, the moment
  the site read the note (ICH E2A: the site clock runs from awareness).

Every field of every draft points at its evidence: a ``chart_note`` pointer
``{kind, id: note_id, ts: ingested_at, note: quote, span_start, span_end}`` so
the dashboard can highlight the exact words, plus the rule and table pointers
the engine uses. ``rules_fired`` / ``why`` use the catalogued ``chartscan.*``
ids and the shared ``dedup.*``, ``tier.final``, ``sae.clock_started`` and
``draft.*`` ids, so the "Why" panel reads the same for both sources.

The tier of a note (not a PRO instrument, so no composite grades):
``2`` when the scan found an urgent/emergency red flag or a hospitalization,
``1`` when it produced at least one draft for the coordinator to review,
``0`` when nothing was found (log only). Names and actions come from
``escalation_ladder.json``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules import chartscan
from interim_rules.dedup import DEDUP_TABLE_FILE, effective_window_days, find_open_ae
from interim_rules.models import OpenAE, RuleSettings
from interim_rules.seriousness import SERIOUSNESS_TABLE_FILE, build_clock
from interim_rules.tables import escalation_ladder, seriousness_config

from ..audit import Actor, append_event
from ..models import AEOpen, ChartNote, Draft, Escalation, Participant, SAEClock, Study
from ..problems import problem
from ..settings import Settings
from ..util import dump_json, iso_date, load_json, new_id, normalize_iso, now_iso, to_jsonable
from .checkins import DraftInput, apply_result, next_aeseq_for, open_aes_for
from .common import (
    ae_open_to_dict,
    chart_note_to_dict,
    draft_to_dict,
    escalation_to_dict,
    get_study,
    sae_clock_to_dict,
    tier_action,
    tier_name,
)
from .participants import require_participant, resolve_participant
from .settings_svc import effective_rule_settings

LEXICON_TABLE_FILE = "chartscan_lexicon.json"
RED_FLAG_TABLE_FILE = "chartscan_red_flags.json"
LADDER_TABLE_FILE = "escalation_ladder.json"
NOTE_MAX_TIER = 2
"""A chart note escalates to Tier 2 at most (D-017); asserted, never exceeded."""
MATCH_KIND_LEXICON = "lexicon"
"""``INTERIM_MATCH_KIND`` of a note CM draft: the scanner's lexicon matched the words
(an exact pattern match, confidence 1.0), as opposed to the kiosk's string-distance kinds."""
DOMAINS: tuple[str, ...] = ("AE", "VS", "CM")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def parse_iso_date(value: str, what: str) -> date:
    """``YYYY-MM-DD`` -> ``date``; anything else is a 422 problem."""
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise problem(
            422, f"{what} must be an ISO-8601 calendar date (YYYY-MM-DD), got {value!r}"
        ) from exc


def _iso_or_422(value: str, what: str) -> str:
    try:
        return normalize_iso(value)
    except ValueError as exc:
        raise problem(422, f"{what}: {exc}", title="Invalid timestamp") from exc


def note_pointer(
    note_id: str, ingested_at: str, quote: str, span_start: int, span_end: int
) -> dict[str, Any]:
    """The ``chart_note`` evidence pointer (R2.4): which words of which note, and when."""
    return {
        "kind": "chart_note",
        "id": note_id,
        "ts": ingested_at,
        "note": quote,
        "span_start": span_start,
        "span_end": span_end,
    }


def _rule_pointer(rule_id: str, ts: str, note: str) -> dict[str, Any]:
    return {"kind": "rule", "id": rule_id, "ts": ts, "note": note}


def _table_pointer(table_file: str, note: str) -> dict[str, Any]:
    return {"kind": "table", "id": table_file, "ts": None, "note": note}


def _rule(
    rule_id: str,
    category: str,
    description: str,
    inputs: Mapping[str, Any],
    effect: str,
    evidence: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """A ``RuleFired``-shaped dict (the engine's shape, as ``result_to_dict`` emits it)."""
    return {
        "rule_id": rule_id,
        "category": category,
        "description": description,
        "inputs": dict(inputs),
        "effect": effect,
        "evidence": [dict(e) for e in evidence],
    }


def open_ae_inputs(rows: Sequence[AEOpen]) -> list[OpenAE]:
    """``AEOpen`` rows -> the engine's ``OpenAE`` (a note-opened AE's last note id stands in
    for ``last_session_id``, exactly as ``build_engine_input`` does for check-ins)."""
    return [
        OpenAE(
            ae_open_id=ae.id,
            aedecod=ae.aedecod,
            first_reported_at=ae.first_reported_at,
            last_reported_at=ae.last_reported_at,
            last_session_id=ae.last_session_id or ae.last_note_id or "",
        )
        for ae in rows
    ]


# --------------------------------------------------------------------------- #
# Dry run
# --------------------------------------------------------------------------- #


def scan_only(text: str, ref_date: str | None) -> dict[str, Any]:
    """``POST /scan``: the ``ScanResult`` plus the rules it would fire; nothing is stored."""
    ref = parse_iso_date(ref_date, "ref_date") if ref_date else None
    result = chartscan.scan_text(text, ref)
    rules = [
        {
            **r,
            "evidence": [
                note_pointer(
                    "dry-run", "", str(r["quote"]), int(r["span_start"]), int(r["span_end"])
                )
            ],
        }  # type: ignore[arg-type]
        for r in chartscan.rules_fired(result)
    ]
    level = chartscan.escalation_level(result, "note")
    serious = chartscan.seriousness_suspected(result)
    n_drafts = len(result.symptoms) + len(result.meds)
    tier = note_tier(level=level, seriousness_suspected=serious, n_drafts=n_drafts)
    out = chartscan.scan_result_to_dict(result)
    out.update(
        {
            "ref_date": ref.isoformat() if ref else None,
            "escalation_level": level,
            "seriousness_suspected": serious,
            "tier": tier,
            "tier_name": tier_name(tier),
            "rules_fired": rules,
            "why": [str(r["description"]) for r in rules],
            "dry_run": True,
        }
    )
    return out


# --------------------------------------------------------------------------- #
# Tier
# --------------------------------------------------------------------------- #


def note_tier(*, level: str, seriousness_suspected: bool, n_drafts: int) -> int:
    """Tier 2 for an urgent/emergency red flag or a hospitalization, Tier 1 when there is
    anything to review, Tier 0 otherwise. Never Tier 3 (D-017)."""
    ladder = escalation_ladder()
    if level in ("urgent", "emergency") or seriousness_suspected:
        tier = 2
    elif n_drafts > 0:
        tier = 1
    else:
        tier = 0
    tier = min(tier, NOTE_MAX_TIER, ladder.max_tier)
    assert not ladder.tiers[tier].page_oncall and not ladder.tiers[tier].stop_screen
    return tier


# --------------------------------------------------------------------------- #
# Drafts from findings
# --------------------------------------------------------------------------- #


@dataclass
class _Built:
    drafts: list[DraftInput] = field(default_factory=list)
    rules: list[dict[str, Any]] = field(default_factory=list)
    dedup_rules: list[dict[str, Any]] = field(default_factory=list)
    followups: int = 0
    ae_terms: list[str] = field(default_factory=list)


def _ae_draft(
    *,
    study: Study,
    usubjid: str,
    note: ChartNote,
    finding: chartscan.SymptomFinding,
    aeseq: int,
    tier: int,
    open_aes: Sequence[OpenAE],
    window_days: int,
    built: _Built,
) -> None:
    ingested = note.ingested_at
    quote_ev = note_pointer(note.id, ingested, finding.quote, finding.span_start, finding.span_end)
    symptom_rule_ev = _rule_pointer(
        chartscan.RULE_SYMPTOM, ingested, f"'{finding.quote}' -> {finding.term}"
    )
    term_ev = _table_pointer(
        LEXICON_TABLE_FILE, f"symptom_patterns: '{finding.quote}' -> {finding.term} (CTCAE v5.0)"
    )
    context = _rule_pointer("draft.ae", ingested, f"chart note {note.id} context")

    search = find_open_ae(finding.term, open_aes, ingested, window_days, session_id=note.id)
    linked, days = search.linked, search.days_since
    skipped = [list(entry) for entry in search.skipped]
    if linked is not None and days is not None:
        dedup_rule_id = "dedup.followup_linked"
        dedup_rule = _rule(
            dedup_rule_id,
            "dedup",
            f"{finding.term} reported again in a chart note {days:.1f} day(s) after open AE "
            f"{linked.ae_open_id} (last reported {linked.last_reported_at}); within the "
            f"{window_days}-day window -> follow-up, no new AE",
            {
                "aedecod": finding.term,
                "window_days": window_days,
                "linked_ae_open_id": linked.ae_open_id,
                "days_since_last_report": round(days, 2),
                "first_reported_at": linked.first_reported_at,
                "skipped": skipped,
                "source": "chart_note",
            },
            f"AE draft links to open AE {linked.ae_open_id} (AEONGO stays Y)",
            (_table_pointer(DEDUP_TABLE_FILE, "window_days"), quote_ev),
        )
        aestdtc = normalize_iso(linked.first_reported_at)
        aestdtc_ev: list[dict[str, Any]] = [
            _rule_pointer(
                dedup_rule_id,
                ingested,
                f"follow-up of open AE {linked.ae_open_id}; first reported {aestdtc}",
            )
        ]
        built.followups += 1
    else:
        dedup_rule_id = "dedup.new_ae"
        dedup_rule = _rule(
            dedup_rule_id,
            "dedup",
            f"{finding.term}: no open AE within {window_days} days -> new AE",
            {
                "aedecod": finding.term,
                "window_days": window_days,
                "skipped": skipped,
                "source": "chart_note",
            },
            "new AE draft",
            (_table_pointer(DEDUP_TABLE_FILE, "window_days"), quote_ev),
        )
        if finding.onset_date is not None:
            aestdtc = finding.onset_date
            aestdtc_ev = [
                quote_ev,
                _rule_pointer(
                    chartscan.RULE_SYMPTOM,
                    ingested,
                    f"onset {finding.onset_days} day(s) before the note dated {note.note_date}",
                ),
            ]
        else:
            aestdtc = note.note_date
            aestdtc_ev = [
                quote_ev,
                _rule_pointer(
                    chartscan.RULE_SYMPTOM,
                    ingested,
                    "no onset stated in the note; the note date stands in",
                ),
            ]
    built.dedup_rules.append(dedup_rule)

    # A "resolved / improved" cue is flagged for the coordinator, never turned into an end
    # date by the API: the scanner's cue covers "improved" too, and only a human decides
    # whether an AE has ended (AEONGO stays "Y"; an edit to AEENDTC closes the open AE).
    resolved = bool(finding.resolved)
    resolved_ev: list[dict[str, Any]] = (
        [
            quote_ev,
            _rule_pointer(
                chartscan.RULE_SYMPTOM,
                ingested,
                "the note says the symptom resolved or improved; coordinator to set AEENDTC",
            ),
        ]
        if resolved
        else []
    )
    grade_note = (
        f"grade hint from the note text ({finding.grade_basis}); provisional, "
        "investigator to confirm"
    )
    rules_for_ae = [chartscan.RULE_SYMPTOM, dedup_rule_id]
    followup_of = linked.ae_open_id if linked is not None else None

    fields: dict[str, Any] = {
        "STUDYID": study.study_id,
        "INTERIM_NCT_ID": study.nct_id,
        "USUBJID": usubjid,
        "AESEQ": aeseq,
        "AETERM": finding.quote,
        "AEDECOD": finding.term,
        "AESTDTC": aestdtc,
        "AEENDTC": None,
        "AEONGO": "Y",
        "AETOXGR": finding.grade_hint,
        "AESER": None,
        "AEREL": None,
        "AEACN": None,
        "AEOUT": None,
        "INTERIM_TIER": tier,
        "INTERIM_RULES_FIRED": rules_for_ae,
        "INTERIM_PROVISIONAL": True,
        "INTERIM_FOLLOWUP_OF": followup_of,
        "INTERIM_SOURCE": "chart_note",
        "INTERIM_NOTE_DATE": note.note_date,
        "INTERIM_GRADE_BASIS": finding.grade_basis,
        "INTERIM_ONSET_DAYS": finding.onset_days,
        "INTERIM_WORSENING": finding.worsening,
        "INTERIM_RESOLVED_CUE": resolved,
    }
    evidence: dict[str, list[dict[str, Any]]] = {
        "STUDYID": [context],
        "INTERIM_NCT_ID": [context],
        "USUBJID": [context],
        "AESEQ": [context],
        "AETERM": [quote_ev],
        "AEDECOD": [quote_ev, term_ev],
        "AESTDTC": aestdtc_ev,
        "AEENDTC": [],
        "AEONGO": [context],
        "AETOXGR": [
            symptom_rule_ev,
            quote_ev,
            _rule_pointer(chartscan.RULE_SYMPTOM, ingested, grade_note),
        ],
        "AESER": [],
        "AEREL": [],
        "AEACN": [],
        "AEOUT": [],
        "INTERIM_TIER": [_rule_pointer("tier.final", ingested, "final tier of the note")],
        "INTERIM_RULES_FIRED": [
            _rule_pointer(rid, ingested, "rule fired for this finding") for rid in rules_for_ae
        ],
        "INTERIM_PROVISIONAL": [_table_pointer(LEXICON_TABLE_FILE, grade_note)],
        "INTERIM_FOLLOWUP_OF": (
            [_rule_pointer(dedup_rule_id, ingested, "dedup decision")] if followup_of else []
        ),
        "INTERIM_SOURCE": [context],
        "INTERIM_NOTE_DATE": [context],
        "INTERIM_GRADE_BASIS": [symptom_rule_ev, quote_ev],
        "INTERIM_ONSET_DAYS": [quote_ev] if finding.onset_days is not None else [],
        "INTERIM_WORSENING": [quote_ev] if finding.worsening else [],
        "INTERIM_RESOLVED_CUE": resolved_ev,
    }
    built.drafts.append(
        DraftInput(
            domain="AE",
            fields=fields,
            evidence=evidence,
            linked_ae_open_id=followup_of,
            is_followup=followup_of is not None,
        )
    )
    built.ae_terms.append(finding.term)
    followup_note = f"; follow-up of open AE {followup_of}" if followup_of else ""
    resolved_note = (
        "; the note says it resolved or improved (coordinator to set AEENDTC)" if resolved else ""
    )
    built.rules.append(
        _rule(
            "draft.ae",
            "drafting",
            f"AE draft {aeseq}: {finding.term} ('{finding.quote}'), provisional grade hint "
            f"{finding.grade_hint}{followup_note}{resolved_note}",
            {
                "aeseq": aeseq,
                "aeterm": finding.quote,
                "aedecod": finding.term,
                "aetoxgr": finding.grade_hint,
                "aestdtc": aestdtc,
                "resolved_cue": resolved,
                "tier": tier,
                "followup_of": followup_of,
                "source": "chart_note",
            },
            f"AE draft created (AESEQ {aeseq}); awaiting coordinator confirmation",
            (quote_ev, symptom_rule_ev, _rule_pointer(dedup_rule_id, ingested, "dedup decision")),
        )
    )


def _cm_draft(
    *,
    study: Study,
    usubjid: str,
    note: ChartNote,
    finding: chartscan.MedFinding,
    cmseq: int,
    built: _Built,
) -> None:
    ingested = note.ingested_at
    quote_ev = note_pointer(note.id, ingested, finding.quote, finding.span_start, finding.span_end)
    med_rule_ev = _rule_pointer(
        chartscan.RULE_MED, ingested, f"'{finding.quote}' -> {finding.drug} ({finding.change})"
    )
    lexicon_ev = _table_pointer(
        LEXICON_TABLE_FILE, f"med_patterns: '{finding.quote}' -> {finding.drug} (NOT RxNorm)"
    )
    context = _rule_pointer("draft.cm", ingested, f"chart note {note.id} context")
    cmstdtc = note.note_date if finding.change in ("started", "changed") else None
    cmendtc = note.note_date if finding.change == "stopped" else None
    fields: dict[str, Any] = {
        "STUDYID": study.study_id,
        "INTERIM_NCT_ID": study.nct_id,
        "USUBJID": usubjid,
        "CMSEQ": cmseq,
        "CMTRT": finding.quote,
        "CMDECOD": finding.drug,
        "CMSTDTC": cmstdtc,
        "CMENDTC": cmendtc,
        "CMSTAT": None,
        "INTERIM_MATCH_CONFIDENCE": 1.0,
        "INTERIM_MATCH_KIND": MATCH_KIND_LEXICON,
        "INTERIM_DIRECTION": finding.change,
        "INTERIM_SOURCE": "chart_note",
        "INTERIM_NOTE_DATE": note.note_date,
        "INTERIM_CHANGE_REASON": finding.reason,
    }
    evidence: dict[str, list[dict[str, Any]]] = {
        "STUDYID": [context],
        "INTERIM_NCT_ID": [context],
        "USUBJID": [context],
        "CMSEQ": [context],
        "CMTRT": [quote_ev],
        "CMDECOD": [quote_ev, lexicon_ev, med_rule_ev],
        "CMSTDTC": [quote_ev, med_rule_ev] if cmstdtc is not None else [],
        "CMENDTC": [quote_ev, med_rule_ev] if cmendtc is not None else [],
        "CMSTAT": [],
        "INTERIM_MATCH_CONFIDENCE": [lexicon_ev, med_rule_ev],
        "INTERIM_MATCH_KIND": [lexicon_ev, med_rule_ev],
        "INTERIM_DIRECTION": [quote_ev, med_rule_ev],
        "INTERIM_SOURCE": [context],
        "INTERIM_NOTE_DATE": [context],
        "INTERIM_CHANGE_REASON": [med_rule_ev],
    }
    built.drafts.append(DraftInput(domain="CM", fields=fields, evidence=evidence))
    built.rules.append(
        _rule(
            "draft.cm",
            "drafting",
            f"CM draft {cmseq}: '{finding.quote}' -> {finding.drug} ({finding.change}); "
            f"started {cmstdtc or '-'}, stopped {cmendtc or '-'}",
            {
                "cmseq": cmseq,
                "cmtrt": finding.quote,
                "cmdecod": finding.drug,
                "change": finding.change,
                "cmstdtc": cmstdtc,
                "cmendtc": cmendtc,
                "source": "chart_note",
            },
            f"CM draft created (CMSEQ {cmseq}); awaiting coordinator confirmation",
            (quote_ev, med_rule_ev),
        )
    )


# --------------------------------------------------------------------------- #
# Ingest
# --------------------------------------------------------------------------- #


def ingest_note(
    db: DbSession,
    settings: Settings,
    actor: Actor,
    *,
    usubjid: str,
    note_date: str,
    author: str,
    note_type: str,
    text: str,
    ingested_at_override: str | None = None,
    override_actor: Actor | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    """``POST /notes``: store, scan, draft, de-duplicate, escalate, start the SAE clock.

    ``ingested_at_override`` (admin only, enforced by the router) backdates the
    moment the site read the note; the seed uses it. Returns the same shape as
    :func:`note_detail`.
    """
    stamp = now or now_iso()
    study = get_study(db)
    participant = require_participant(db, study, usubjid)
    ref = parse_iso_date(note_date, "note_date")
    ingested_at = stamp
    backdated = False
    if ingested_at_override is not None:
        ingested_at = _iso_or_422(ingested_at_override, "ingested_at_override")
        backdated = True
    if ref.isoformat() > iso_date(ingested_at):
        raise problem(
            422,
            f"note_date {ref.isoformat()} is after the ingestion time {ingested_at}; "
            "a note cannot be read before it was written",
            title="Invalid note date",
        )
    if not text.strip():
        raise problem(422, "text must not be blank", title="Empty note")

    note = ChartNote(
        id=new_id(),
        usubjid=participant.usubjid,
        note_date=ref.isoformat(),
        author=author.strip(),
        note_type=note_type.strip(),
        text=text,
        ingested_at=ingested_at,
        ingested_by=actor.id,
    )
    db.add(note)
    db.flush()
    append_event(
        db,
        actor,
        "note.ingested",
        "note",
        note.id,
        {
            "usubjid": participant.usubjid,
            "display_label": participant.display_label,
            "note_date": note.note_date,
            "author": note.author,
            "note_type": note.note_type,
            "chars": len(text),
            "ingested_at": ingested_at,
            "backdated": backdated,
            "override_by": override_actor.id if backdated and override_actor else None,
            "statement": "The note text is stored verbatim; the scanner is deterministic "
            "(regular expressions and lookup tables, no LLM).",
        },
        ts_utc=stamp,
    )

    # Scan (clinician text: never detect a "talk to a human" request).
    result = chartscan.scan_text(text, ref)
    scan_rules = [
        {
            **r,
            "evidence": [
                note_pointer(
                    note.id, ingested_at, str(r["quote"]), int(r["span_start"]), int(r["span_end"])
                )  # type: ignore[arg-type]
            ],
        }
        for r in chartscan.rules_fired(result)
    ]
    level = chartscan.escalation_level(result, "note")
    serious = chartscan.seriousness_suspected(result)
    n_candidates = len(result.symptoms) + len(result.meds)
    tier = note_tier(level=level, seriousness_suspected=serious, n_drafts=n_candidates)

    # De-duplication inputs: every open AE of the participant, from any source.
    rule_settings = effective_rule_settings(db, settings, None)
    window_days = effective_window_days(RuleSettings(**rule_settings))
    open_aes = open_ae_inputs(open_aes_for(db, participant.usubjid))

    built = _Built()
    next_seq = next_aeseq_for(db, participant.usubjid)
    for offset, finding in enumerate(result.symptoms):
        _ae_draft(
            study=study,
            usubjid=participant.usubjid,
            note=note,
            finding=finding,
            aeseq=next_seq + offset,
            tier=tier,
            open_aes=open_aes,
            window_days=window_days,
            built=built,
        )
    for index, med in enumerate(result.meds, start=1):
        _cm_draft(
            study=study,
            usubjid=participant.usubjid,
            note=note,
            finding=med,
            cmseq=index,
            built=built,
        )

    # Escalation (tier.final) and seriousness (sae.clock_started) in the engine's wording.
    flag_rules = [
        r
        for r in scan_rules
        if r["rule_id"] in (chartscan.RULE_RED_FLAG, chartscan.RULE_HOSPITALIZATION)
    ]
    reasons = [str(r["description"]) for r in flag_rules]
    tier_rule = _rule(
        "tier.final",
        "escalation",
        f"Chart note escalation tier {tier} ({tier_name(tier)}): {tier_action(tier)} "
        f"Scan level '{level}'"
        + (", hospitalization/ER mentioned" if serious else "")
        + f"; {len(built.drafts)} draft(s) for review. A note never pages or stops a kiosk "
        "and never reaches Tier 3 (D-017).",
        {
            "escalation_level": level,
            "seriousness_suspected": serious,
            "n_ae_drafts": sum(1 for d in built.drafts if d.domain == "AE"),
            "n_cm_drafts": sum(1 for d in built.drafts if d.domain == "CM"),
            "max_note_tier": NOTE_MAX_TIER,
            "red_flags": [
                {"level": f.level, "category": f.category, "quote": f.quote}
                for f in result.red_flags
            ],
        },
        f"tier = {tier} ({tier_name(tier)}); stop_screen = false; page_oncall = false",
        [
            _table_pointer(LADDER_TABLE_FILE, f"tier {tier}: {tier_name(tier)}"),
            _table_pointer(RED_FLAG_TABLE_FILE, f"escalation level {level}"),
            *(e for r in flag_rules for e in r["evidence"]),
        ],
    )
    reasons.append(str(tier_rule["description"]))
    sae_rules: list[dict[str, Any]] = []
    sae_clock: dict[str, Any] | None = None
    if serious:
        clock = build_clock(ingested_at)
        sae_clock = to_jsonable(clock)
        hours = seriousness_config().site_to_sponsor_hours
        hosp = next((r for r in scan_rules if r["rule_id"] == chartscan.RULE_HOSPITALIZATION), None)
        sae_rules.append(
            _rule(
                "sae.clock_started",
                "seriousness",
                f"Seriousness suspected (chart note mentions hospitalization or an ER visit; ICH "
                f"E2A hospitalization criterion). Site became aware when the note was read at "
                f"{clock.site_awareness_at}; investigator-to-sponsor report due {clock.due_at} "
                f"({hours:g} h)",
                {
                    "trigger": chartscan.RULE_HOSPITALIZATION,
                    "site_awareness_at": clock.site_awareness_at,
                    "due_at": clock.due_at,
                    "site_to_sponsor_hours": hours,
                    "informational": dict(clock.informational),
                },
                "seriousness_suspected = true; SAE clock started at ingestion "
                "(stops on investigator decision)",
                [
                    *(hosp["evidence"] if hosp else []),
                    _table_pointer(
                        SERIOUSNESS_TABLE_FILE, "site_to_sponsor_hours; ICH E2A criteria"
                    ),
                ],
            )
        )

    rules_fired = [*scan_rules, tier_rule, *sae_rules, *built.dedup_rules, *built.rules]
    why = [str(r["description"]) for r in rules_fired]

    note.tier = tier
    note.scan_json = dump_json(
        {
            "scan": chartscan.scan_result_to_dict(result),
            "ref_date": ref.isoformat(),
            "escalation_level": level,
            "seriousness_suspected": serious,
            "tier": tier,
            "reasons": reasons,
            "dedup_window_days": window_days,
            "settings": rule_settings,
            "rules_fired": rules_fired,
            "why": why,
        }
    )
    db.add(note)
    db.flush()
    append_event(
        db,
        actor,
        "note.scanned",
        "note",
        note.id,
        {
            "usubjid": participant.usubjid,
            "n_symptoms": len(result.symptoms),
            "n_excluded_symptoms": len(result.excluded_symptoms),
            "n_meds": len(result.meds),
            "n_excluded_meds": len(result.excluded_meds),
            "n_red_flags": len(result.red_flags),
            "ae_terms": built.ae_terms,
            "escalation_level": level,
            "seriousness_suspected": serious,
            "tier": tier,
            "tier_name": tier_name(tier),
            "followups": built.followups,
            "n_rules_fired": len(rules_fired),
            "rule_ids": [str(r["rule_id"]) for r in rules_fired],
            "scanner": "interim_rules.chartscan (deterministic; Omer Khawar, MIT)",
        },
        ts_utc=stamp,
    )
    for rule in rules_fired:
        append_event(db, actor, "rule.fired", "note", note.id, rule, ts_utc=stamp)

    apply_result(
        db,
        actor,
        usubjid=participant.usubjid,
        drafts=built.drafts,
        tier=tier,
        reasons=reasons,
        seriousness_suspected=serious,
        sae_clock=sae_clock,
        page_oncall=False,
        reported_at=ingested_at,
        note_id=note.id,
        source="chart_note",
        now=stamp,
    )
    return note_detail(db, note, participant=participant)


# --------------------------------------------------------------------------- #
# Read models
# --------------------------------------------------------------------------- #


def get_note_or_404(db: DbSession, note_id: str) -> ChartNote:
    note = db.get(ChartNote, note_id)
    if note is None:
        raise problem(404, f"No chart note with id {note_id}", title="Note not found")
    return note


def current_note_drafts(db: DbSession, note_ids: Sequence[str]) -> dict[str, list[Draft]]:
    """Current (non-superseded) draft rows grouped by note id, AE then VS then CM."""
    ids = list(note_ids)
    out: dict[str, list[Draft]] = {nid: [] for nid in ids}
    if not ids:
        return out
    rows = db.exec(
        select(Draft).where(Draft.note_id.in_(ids)).where(Draft.status != "superseded")  # type: ignore[union-attr]
    ).all()
    for row in rows:
        out.setdefault(row.note_id or "", []).append(row)
    for nid in out:
        out[nid].sort(
            key=lambda d: (
                DOMAINS.index(d.domain) if d.domain in DOMAINS else 9,
                d.created_at,
                d.id,
            )
        )
    return out


def stored_scan(note: ChartNote) -> dict[str, Any]:
    return load_json(note.scan_json, {}) or {}


def note_evidence_index(
    note: ChartNote, drafts: Sequence[Mapping[str, Any]], rules: Sequence[Mapping[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Every evidence id on the note's drafts and rules, resolved (the note itself, a rule
    firing, or a table file), mirroring the check-in detail's ``evidence_index``."""
    rules_by_id: dict[str, list[dict[str, Any]]] = {}
    for rule in rules:
        rules_by_id.setdefault(str(rule["rule_id"]), []).append(dict(rule))
    pointers: dict[str, dict[str, Any]] = {}

    def collect(items: Any) -> None:
        if isinstance(items, dict):
            if "kind" in items and "id" in items and "note" in items:
                pointers.setdefault(
                    str(items["id"]), {k: items.get(k) for k in ("kind", "id", "ts", "note")}
                )
                return
            for value in items.values():
                collect(value)
        elif isinstance(items, list):
            for value in items:
                collect(value)

    for d in drafts:
        collect(d.get("evidence", {}))
    for r in rules:
        collect(r.get("evidence", []))
    index: dict[str, dict[str, Any]] = {}
    for key, pointer in pointers.items():
        entry: dict[str, Any] = dict(pointer)
        kind = pointer.get("kind")
        resolved = False
        if kind == "chart_note" and key == note.id:
            entry["chart_note"] = {
                "id": note.id,
                "note_date": note.note_date,
                "author": note.author,
                "note_type": note.note_type,
                "ingested_at": note.ingested_at,
                "chars": len(note.text),
            }
            resolved = True
        elif kind == "rule":
            fired = rules_by_id.get(key, [])
            if fired:
                entry["rule"] = fired[0]
                entry["rules"] = fired
                resolved = True
        elif kind == "table":
            entry["table"] = {"file": key, "path": f"packages/rules/data/{key}"}
            resolved = True
        entry["resolved"] = resolved
        index[key] = entry
    return index


def note_detail(
    db: DbSession, note: ChartNote, *, participant: Participant | None = None
) -> dict[str, Any]:
    """``{note, scan, drafts, escalation, sae_clock, rules_fired, why, ae_links, ...}``."""
    participant = participant or db.get(Participant, note.usubjid)
    stored = stored_scan(note)
    draft_rows = current_note_drafts(db, [note.id]).get(note.id, [])
    drafts = [draft_to_dict(d) for d in draft_rows]
    escalation = db.exec(select(Escalation).where(Escalation.note_id == note.id)).first()
    clock = db.exec(select(SAEClock).where(SAEClock.note_id == note.id)).first()
    rules = list(stored.get("rules_fired", []))
    ae_links = []
    for d in draft_rows:
        if d.is_followup and d.linked_ae_open_id:
            opened = db.get(AEOpen, d.linked_ae_open_id)
            ae_links.append(
                {
                    "draft_id": d.id,
                    "ae_open_id": d.linked_ae_open_id,
                    "first_session_id": opened.first_session_id if opened else None,
                    "first_note_id": opened.first_note_id if opened else None,
                    "first_reported_at": opened.first_reported_at if opened else None,
                    "aedecod": opened.aedecod if opened else None,
                    "open_ae": ae_open_to_dict(opened) if opened else None,
                }
            )
    return {
        "note": chart_note_to_dict(
            note, display_label=participant.display_label if participant else None
        ),
        "participant": {
            "usubjid": note.usubjid,
            "display_label": participant.display_label if participant else None,
            "is_eval": bool(participant.is_eval) if participant else False,
        },
        "scan": stored.get("scan", {}),
        "escalation_level": stored.get("escalation_level"),
        "seriousness_suspected": bool(stored.get("seriousness_suspected", False)),
        "tier": note.tier,
        "tier_name": tier_name(note.tier) if note.tier is not None else None,
        "reasons": stored.get("reasons", []),
        "settings": stored.get("settings"),
        "drafts": drafts,
        "escalation": escalation_to_dict(escalation) if escalation else None,
        "sae_clock": sae_clock_to_dict(clock) if clock else None,
        "ae_links": ae_links,
        "rules_fired": rules,
        "why": list(stored.get("why", [])),
        "evidence_index": note_evidence_index(note, drafts, rules),
    }


def _counts(drafts: Sequence[Draft]) -> dict[str, int]:
    counts = dict.fromkeys(DOMAINS, 0)
    for d in drafts:
        counts[d.domain] = counts.get(d.domain, 0) + 1
    return counts


def note_list_item(
    note: ChartNote,
    participant: Participant | None,
    drafts: Sequence[Draft],
    escalation: Escalation | None,
    clock: SAEClock | None,
) -> dict[str, Any]:
    """``ChartNoteListItem`` (R2.6): the note's metadata plus scan and draft counts."""
    stored = stored_scan(note)
    scan = stored.get("scan", {}) or {}
    counts = _counts(drafts)
    return {
        **chart_note_to_dict(
            note, display_label=participant.display_label if participant else None
        ),
        "n_symptoms": len(scan.get("symptoms", [])),
        "n_excluded_symptoms": len(scan.get("excluded_symptoms", [])),
        "n_meds": len(scan.get("meds", [])),
        "n_excluded_meds": len(scan.get("excluded_meds", [])),
        "n_red_flags": len(scan.get("red_flags", [])),
        "escalation_level": stored.get("escalation_level"),
        "seriousness_suspected": bool(stored.get("seriousness_suspected", False)),
        "draft_counts": counts,
        "n_drafts": sum(counts.values()),
        "draft_status_summary": draft_status_summary(drafts),
        "escalation_id": escalation.id if escalation else None,
        "escalation_acked": (escalation.acked_at is not None) if escalation else None,
        "has_sae_clock": clock is not None,
        "sae_due_at": clock.due_at if clock else None,
        "sae_stopped": (clock.stopped_at is not None) if clock else None,
        "is_eval": bool(participant.is_eval) if participant else False,
    }


def draft_status_summary(drafts: Sequence[Draft]) -> str:
    if not drafts:
        return "no drafts"
    counts: dict[str, int] = {}
    for d in drafts:
        counts[d.status] = counts.get(d.status, 0) + 1
    return ", ".join(f"{counts[s]} {s}" for s in ("draft", "confirmed", "rejected") if s in counts)


def notes_with_context(
    db: DbSession, notes: Sequence[ChartNote]
) -> list[tuple[ChartNote, Participant | None, list[Draft], Escalation | None, SAEClock | None]]:
    """Each note with its participant, current drafts, escalation and SAE clock (batched)."""
    ids = [n.id for n in notes]
    if not ids:
        return []
    drafts = current_note_drafts(db, ids)
    escalations = {
        e.note_id: e
        for e in db.exec(select(Escalation).where(Escalation.note_id.in_(ids))).all()  # type: ignore[union-attr]
    }
    clocks = {
        c.note_id: c
        for c in db.exec(select(SAEClock).where(SAEClock.note_id.in_(ids))).all()  # type: ignore[union-attr]
    }
    usubjids = sorted({n.usubjid for n in notes})
    participants = {
        p.usubjid: p
        for p in db.exec(select(Participant).where(Participant.usubjid.in_(usubjids))).all()  # type: ignore[union-attr]
    }
    return [
        (
            n,
            participants.get(n.usubjid),
            drafts.get(n.id, []),
            escalations.get(n.id),
            clocks.get(n.id),
        )
        for n in notes
    ]


def list_notes(
    db: DbSession,
    study: Study,
    *,
    usubjid: str | None,
    include_eval: bool,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    """``GET /notes``: newest ingestion first; label or USUBJID filter; eval notes hidden."""
    stmt = select(ChartNote, Participant).join(
        Participant,
        Participant.usubjid == ChartNote.usubjid,  # type: ignore[arg-type]
    )
    if usubjid:
        participant = resolve_participant(db, study, usubjid)
        if participant is None:
            return {"items": [], "total": 0, "limit": limit, "offset": offset}
        stmt = stmt.where(ChartNote.usubjid == participant.usubjid)
    if not include_eval:
        stmt = stmt.where(Participant.is_eval == False)  # noqa: E712
    pairs = sorted(
        db.exec(stmt).all(), key=lambda pair: (pair[0].ingested_at, pair[0].id), reverse=True
    )
    page = pairs[offset : offset + limit]
    context = notes_with_context(db, [n for n, _ in page])
    return {
        "items": [note_list_item(n, p, d, e, c) for (n, p, d, e, c) in context],
        "total": len(pairs),
        "limit": limit,
        "offset": offset,
    }


def notes_for_participant(db: DbSession, usubjid: str) -> list[ChartNote]:
    rows = db.exec(select(ChartNote).where(ChartNote.usubjid == usubjid)).all()
    return sorted(rows, key=lambda n: (n.ingested_at, n.id))


def timeline_note(
    note: ChartNote, drafts: Sequence[Draft], escalation: Escalation | None, clock: SAEClock | None
) -> dict[str, Any]:
    """One entry of ``timeline.notes[]``: the note, what the scan found, and what it opened."""
    stored = stored_scan(note)
    scan = stored.get("scan", {}) or {}
    counts = _counts(drafts)
    return {
        **chart_note_to_dict(note),
        "symptoms": [
            {
                "term": s.get("term"),
                "quote": s.get("quote"),
                "grade_hint": s.get("grade_hint"),
                "onset_date": s.get("onset_date"),
                "resolved": bool(s.get("resolved", False)),
                "worsening": bool(s.get("worsening", False)),
            }
            for s in scan.get("symptoms", [])
        ],
        "meds": [
            {"drug": m.get("drug"), "change": m.get("change"), "quote": m.get("quote")}
            for m in scan.get("meds", [])
        ],
        "red_flags": [
            {"level": f.get("level"), "category": f.get("category"), "quote": f.get("quote")}
            for f in scan.get("red_flags", [])
        ],
        "escalation_level": stored.get("escalation_level"),
        "seriousness_suspected": bool(stored.get("seriousness_suspected", False)),
        "escalation_tier": escalation.tier if escalation else None,
        "escalation_acked": (escalation.acked_at is not None) if escalation else None,
        "has_sae_clock": clock is not None,
        "draft_counts": counts,
        "draft_count": sum(counts.values()),
        "drafts": [
            {
                "id": d.id,
                "domain": d.domain,
                "status": d.status,
                "is_followup": d.is_followup,
                "linked_ae_open_id": d.linked_ae_open_id,
                "ae_open_id": d.ae_open_id,
            }
            for d in drafts
        ],
    }


__all__ = [
    "MATCH_KIND_LEXICON",
    "NOTE_MAX_TIER",
    "current_note_drafts",
    "get_note_or_404",
    "ingest_note",
    "list_notes",
    "note_detail",
    "note_list_item",
    "note_pointer",
    "note_tier",
    "notes_for_participant",
    "notes_with_context",
    "open_ae_inputs",
    "parse_iso_date",
    "scan_only",
    "stored_scan",
    "timeline_note",
]
