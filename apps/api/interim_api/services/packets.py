"""Serious-event packets: the SAE / AESI report a 24-hour clock calls for (CLAUDE.md §00.2).

One click on a running clock opens a **packet**: report fields pre-filled from evidence
(event term and plain label, onset, seriousness criteria suspected or the possible-AESI
reasons, provisional grade, study drug from the study record, relevant con-meds with their
protocol flags, site awareness time, deadline, reporter role, outcome "unknown", causality
"not yet assessed by the investigator"), each field with its evidence pointers; a list of
**missing information** to chase; and a **draft narrative** written from a fact bundle built
here from database rows (template writer by default, ``writers``). The investigator edits
and signs; signing stops the clock as "reported (mock)" and posts the packet to the mock
EDC. Nothing leaves the system for real.

Follow-ups (CONTRACTS R4.2): a signed packet can start follow-up n+1, pre-filled again from
current evidence (an investigator decision recorded since, a later check-in on the same
open AE), with ``changes_since_previous`` and the missing information recomputed.

Every evidence id a field or a narrative sentence cites resolves in the packet's
``evidence_index``: the check-in / note evidence index of each source involved (answers,
vitals samples, rule firings, table files, chart notes, audit events of human edits) plus
the clock, the study record and the reporting user.

Rules decide; this module only assembles. It never changes a grade, a tier or a clock
except the one stop the investigator's signature implies.
"""

from __future__ import annotations

import html
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlmodel import Session as DbSession
from sqlmodel import select

from interim_rules.plain_language import has_label
from interim_rules.plain_language import label as plain_label
from interim_rules.protocol import PROTOCOL_TABLE_FILE, classify_conmed
from interim_rules.tables import items, protocol_rules

from .. import API_VERSION
from ..audit import Actor, append_event
from ..models import (
    AuditEvent,
    ChartNote,
    Draft,
    Escalation,
    Packet,
    Participant,
    SAEClock,
    Session,
    Study,
)
from ..problems import problem
from ..util import dump_json, load_json, new_id, now_iso
from ..writers.base import Writer
from .checkins import log_clock_stopped, session_answers, session_samples
from .common import (
    answer_to_dict,
    cm_missing_now,
    draft_to_dict,
    get_study,
    sample_to_dict,
    tier_name,
)
from .dashboard import current_drafts, evidence_index
from .exports import sha256_hex
from .notes import current_note_drafts, note_evidence_index, stored_scan

FOOTER = (
    "Interim is a research data-capture tool. It is not a medical device and does not "
    "provide medical advice."
)
MOCK_NOTE = "Mock submission: nothing was sent to a sponsor or a real EDC."

NOT_ASSESSED = "not yet assessed by the investigator"
NOT_DECIDED = "not yet decided by the investigator"
OUTCOME_UNKNOWN = "unknown"
PLACEHOLDERS: frozenset[str] = frozenset({"", OUTCOME_UNKNOWN, NOT_ASSESSED, NOT_DECIDED})

INVESTIGATOR_FIELDS: frozenset[str] = frozenset({"AESER", "AEREL", "INTERIM_IRAE"})
"""Packet fields only an investigator may set (seriousness, causality, immune-related)."""

SIGNED_DECISION = "reported (mock)"
NARRATIVE_KIND = {"sae": "sae_narrative", "aesi": "aesi_narrative"}
EDC_DOMAIN = {"sae": "SAE", "aesi": "AESI"}
REPORTER_ROLES = {
    "coordinator": "study coordinator",
    "investigator": "investigator",
    "admin": "site administrator",
    "system": "Interim (pre-filled from evidence; coordinator to review)",  # [seed agent]
}
_DATE_LIKE = re.compile(r"\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?")

# Plain labels for packet-only fields (SDTM names use ``plain_language.json``).
PACKET_LABELS: dict[str, str] = {
    "PARTICIPANT": "Participant",
    "EVENT_TERM": "Event (standard CTCAE term)",
    "EVENT_PLAIN": "Event, in plain words",
    "OTHER_EVENTS": "Other side effects in the same report",
    "SERIOUSNESS_CRITERIA": "Why it may be serious (suspected, investigator to confirm)",
    "AESI_CRITERIA": "Why it may be of special interest (possible AESI, investigator to confirm)",
    "STUDY_DRUG": "Study drug",
    "LAST_DOSE_DATE": "Last dose of the study drug",
    "CONMEDS": "Medications reported (with protocol flags)",
    "SITE_AWARENESS_AT": "Site became aware",
    "REPORT_DUE_AT": "Report due to the sponsor (24 hours)",
    "REPORTER_ROLE": "Prepared by (role)",
    "HOSPITALIZATION_DATES": "Hospital admission and discharge dates",
    "LATEST_GRADE": "Most recent severity grade (provisional)",
    "LATEST_REPORT_AT": "Most recent report of this side effect",
    "INTERIM_IRAE": "Immune-related? (investigator decides)",
}


def field_label(name: str) -> str:
    if name in PACKET_LABELS:
        return PACKET_LABELS[name]
    return plain_label(name) if has_label(name) else name


def is_placeholder(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip().lower() in PLACEHOLDERS
    if isinstance(value, list):
        return len(value) == 0
    return False


# --------------------------------------------------------------------------- #
# Source context: everything a packet is built from, loaded from rows
# --------------------------------------------------------------------------- #


@dataclass
class CmEntry:
    """One reported medication with its protocol classification."""

    draft: dict[str, Any]
    name: str
    direction: str
    date: str | None
    level: str | None
    section: str | None
    page: int | None
    exception_text: str | None
    missing: list[str]
    evidence: list[dict[str, Any]]


@dataclass
class SourceContext:
    clock: SAEClock
    kind: str
    study: Study
    participant: Participant | None
    session: Session | None
    note: ChartNote | None
    result: dict[str, Any]
    rules: list[dict[str, Any]]
    ae_drafts: list[dict[str, Any]]
    cm_entries: list[CmEntry]
    escalation: Escalation | None
    primary: dict[str, Any] | None
    others: list[dict[str, Any]]
    latest: dict[str, Any] | None
    source_ids: set[str] = field(default_factory=set)

    @property
    def source_label(self) -> str:
        if self.note is not None:
            return "phone call" if self.note.note_type == "phone_call" else "chart note"
        return "kiosk check-in"


def _src(pointer: Mapping[str, Any], *, session_id: str | None, note_id: str | None) -> dict:
    """Copy a pointer and say where it lives (the web links evidence to its source)."""
    out = dict(pointer)
    out.setdefault("session_id", session_id)
    out.setdefault("note_id", note_id)
    return out


def _field_evidence(draft: Mapping[str, Any] | None, name: str) -> list[dict[str, Any]]:
    if draft is None:
        return []
    raw = (draft.get("evidence") or {}).get(name) or []
    return [
        _src(p, session_id=draft.get("session_id"), note_id=draft.get("note_id"))
        for p in raw
        if isinstance(p, Mapping)
    ]


def _grade(draft: Mapping[str, Any]) -> int:
    value = (draft.get("fields") or {}).get("AETOXGR")
    return value if isinstance(value, int) and not isinstance(value, bool) else -1


def _seq(draft: Mapping[str, Any]) -> int:
    value = (draft.get("fields") or {}).get("AESEQ")
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _source_drafts(db: DbSession, clock: SAEClock) -> list[Draft]:
    if clock.session_id is not None:
        return current_drafts(db, [clock.session_id]).get(clock.session_id, [])
    if clock.note_id is not None:
        return current_note_drafts(db, [clock.note_id]).get(clock.note_id, [])
    return []


def _aesi_terms(result: Mapping[str, Any]) -> set[str]:
    protocol = result.get("protocol") or {}
    aesi_items = set(protocol.get("aesi_items") or [])
    return {
        str(i.get("aedecod"))
        for i in result.get("items") or []
        if i.get("item_id") in aesi_items and i.get("aedecod")
    }


def _cm_entry(draft: dict[str, Any]) -> CmEntry:
    fields = draft.get("fields") or {}
    verbatim = str(fields.get("CMTRT") or "")
    decod = fields.get("CMDECOD")
    flags, _ = classify_conmed(verbatim, str(decod) if decod else None)
    flag = flags[0] if flags else None
    stored_level = fields.get("INTERIM_PROTOCOL_FLAG")
    level = stored_level if isinstance(stored_level, str) else (flag.level if flag else None)
    direction = str(fields.get("INTERIM_DIRECTION") or "taking")
    if direction == "both":
        direction = "changed"
    if direction not in ("started", "stopped", "taking", "changed"):
        direction = "taking"
    date = fields.get("CMSTDTC") if direction != "stopped" else fields.get("CMENDTC")
    missing = cm_missing_now(fields)  # recomputed: a later version may have filled one
    evidence = [
        *_field_evidence(draft, "CMTRT"),
        *_field_evidence(draft, "INTERIM_PROTOCOL_FLAG"),
    ]
    return CmEntry(
        draft=draft,
        name=str(decod or verbatim or "medication (no name recorded)"),
        direction=direction,
        date=str(date) if date else None,
        level=level,
        section=flag.protocol_ref.section if flag and flag.level == level else None,
        page=flag.protocol_ref.printed_page if flag and flag.level == level else None,
        exception_text=flag.exception_text if flag and flag.level == level else None,
        missing=[str(m) for m in missing] if isinstance(missing, list) else [],
        evidence=evidence,
    )


def _source_time(db: DbSession, draft: Draft) -> str:
    if draft.session_id is not None:
        s = db.get(Session, draft.session_id)
        if s is not None and s.completed_at:
            return s.completed_at
    if draft.note_id is not None:
        n = db.get(ChartNote, draft.note_id)
        if n is not None:
            return n.ingested_at
    return draft.created_at


def load_context(db: DbSession, clock: SAEClock) -> SourceContext:
    """Everything a packet for ``clock`` is built from, read from current rows."""
    study = get_study(db)
    participant = db.get(Participant, clock.usubjid)
    session = db.get(Session, clock.session_id) if clock.session_id else None
    note = db.get(ChartNote, clock.note_id) if clock.note_id else None
    if session is not None:
        result: dict[str, Any] = load_json(session.result_json, {}) or {}
        rules = list(result.get("rules_fired") or [])
    elif note is not None:
        result = stored_scan(note)
        rules = list(result.get("rules_fired") or [])
    else:
        result, rules = {}, []
    rows = _source_drafts(db, clock)
    ae = [draft_to_dict(d) for d in rows if d.domain == "AE" and d.status != "rejected"]
    kind = clock.kind or "sae"
    candidates = ae
    if kind == "aesi":
        terms = _aesi_terms(result)
        candidates = [d for d in ae if (d.get("fields") or {}).get("AEDECOD") in terms] or ae
    ordered = sorted(candidates, key=lambda d: (-_grade(d), _seq(d)))
    primary = ordered[0] if ordered else None
    others = [d for d in sorted(ae, key=lambda d: (-_grade(d), _seq(d))) if d is not primary]

    # Relevant con-meds: every current CM record of the participant up to site awareness.
    cm_rows = db.exec(
        select(Draft)
        .where(Draft.usubjid == clock.usubjid)
        .where(Draft.domain == "CM")
        .where(Draft.status != "superseded")
    ).all()
    cm_entries: list[CmEntry] = []
    source_ids: set[str] = {x for x in (clock.session_id, clock.note_id) if x}
    for row in sorted(cm_rows, key=lambda d: (d.created_at, d.id)):
        if row.status == "rejected":
            continue
        if _source_time(db, row) > clock.site_awareness_at:
            continue
        cm_entries.append(_cm_entry(draft_to_dict(row)))
        source_ids.update(x for x in (row.session_id, row.note_id) if x)

    # The latest report of the primary side effect (a later check-in or note, R4.2).
    latest = primary
    if primary is not None and primary.get("ae_open_id"):
        linked = db.exec(
            select(Draft)
            .where(Draft.ae_open_id == primary["ae_open_id"])
            .where(Draft.domain == "AE")
            .where(Draft.status != "superseded")
        ).all()
        dated = [(_source_time(db, d), d.id, d) for d in linked if d.status != "rejected"]
        if dated:
            newest = max(dated, key=lambda t: (t[0], t[1]))[2]
            latest = draft_to_dict(newest)
            source_ids.update(x for x in (newest.session_id, newest.note_id) if x)
    if clock.session_id:
        escalation = db.exec(
            select(Escalation).where(Escalation.session_id == clock.session_id)
        ).first()
    elif clock.note_id:
        escalation = db.exec(select(Escalation).where(Escalation.note_id == clock.note_id)).first()
    else:
        escalation = None
    return SourceContext(
        clock=clock,
        kind=kind,
        study=study,
        participant=participant,
        session=session,
        note=note,
        result=result,
        rules=rules,
        ae_drafts=ae,
        cm_entries=cm_entries,
        escalation=escalation,
        primary=primary,
        others=others,
        latest=latest,
        source_ids=source_ids,
    )


# --------------------------------------------------------------------------- #
# Extra evidence pointers (clock, study record, reporting user)
# --------------------------------------------------------------------------- #


def clock_pointer(ctx: SourceContext) -> dict[str, Any]:
    c = ctx.clock
    what = "possible AESI (investigator to confirm)" if ctx.kind == "aesi" else "suspected SAE"
    return {
        "kind": "clock",
        "id": c.id,
        "ts": c.site_awareness_at,
        "note": f"24-hour {what} clock: site aware {c.site_awareness_at}, due {c.due_at}",
        "session_id": c.session_id,
        "note_id": c.note_id,
    }


def study_pointer(study: Study) -> dict[str, Any]:
    return {
        "kind": "study",
        "id": study.nct_id,
        "ts": study.fetched_at,
        "note": f"public registry record {study.nct_id} ({study.source_url}): interventions",
    }


def user_pointer(actor: Actor, ts: str) -> dict[str, Any]:
    return {
        "kind": "user",
        "id": f"user:{actor.id}",
        "ts": ts,
        "note": f"packet prepared by {actor.id} (role {actor.role})",
    }


def table_pointer(file: str, note: str) -> dict[str, Any]:
    return {"kind": "table", "id": file, "ts": None, "note": note}


def _rule_pointers(ctx: SourceContext, rule_id: str) -> list[dict[str, Any]]:
    """The evidence of a rule that fired on the source, plus a pointer to the rule itself."""
    out: list[dict[str, Any]] = []
    for rule in ctx.rules:
        if rule.get("rule_id") == rule_id:
            out.append(
                {
                    "kind": "rule",
                    "id": rule_id,
                    "ts": None,
                    "note": str(rule.get("effect") or rule.get("description") or rule_id),
                }
            )
            out.extend(
                _src(e, session_id=ctx.clock.session_id, note_id=ctx.clock.note_id)
                for e in rule.get("evidence") or []
                if isinstance(e, Mapping)
            )
            break
    return out


# --------------------------------------------------------------------------- #
# Fields
# --------------------------------------------------------------------------- #


def _f(name: str, value: Any, evidence: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    seen: set[tuple[str, str, str]] = set()
    unique: list[dict[str, Any]] = []
    for e in evidence:
        key = (str(e.get("kind")), str(e.get("id")), str(e.get("note")))
        if key not in seen:
            seen.add(key)
            unique.append(dict(e))
    return {"name": name, "plain_label": field_label(name), "value": value, "evidence": unique}


def _event_plain(aedecod: str | None) -> str | None:
    if not aedecod:
        return None
    for item in items():
        if item.ctcae_term == aedecod:
            return item.label
    return aedecod


def _study_drug(study: Study) -> str | None:
    for name in load_json(study.interventions_json, []) or []:
        if "cemiplimab" in str(name).lower():
            return str(name)
    return None


def _cm_text(cm: CmEntry) -> str:
    text = f"{cm.name} ({cm.direction}"
    if cm.date:
        text += f" {cm.date[:10]}"
    text += ")"
    if cm.level:
        cite = f", §{cm.section} p. {cm.page}" if cm.section else ""
        text += f": {cm.level} by the protocol{cite}"
    return text


def _seriousness_evidence(ctx: SourceContext) -> list[dict[str, Any]]:
    return _rule_pointers(ctx, "sae.clock_started") or _rule_pointers(
        ctx, "redflag.hospitalization"
    )


def build_fields(ctx: SourceContext, actor: Actor, stamp: str) -> list[dict[str, Any]]:
    """The report fields, each pre-filled from evidence (or a stated placeholder)."""
    clock_ev = [clock_pointer(ctx)]
    p = ctx.primary
    pf = (p or {}).get("fields") or {}
    drug = _study_drug(ctx.study)
    label = ctx.participant.display_label if ctx.participant is not None else ctx.clock.usubjid
    out: list[dict[str, Any]] = [
        _f("PARTICIPANT", label, clock_ev),
        _f("EVENT_TERM", pf.get("AEDECOD"), _field_evidence(p, "AEDECOD")),
        _f("EVENT_PLAIN", _event_plain(pf.get("AEDECOD")), _field_evidence(p, "AETERM")),
        _f("AETERM", pf.get("AETERM"), _field_evidence(p, "AETERM")),
        _f("AESTDTC", pf.get("AESTDTC"), _field_evidence(p, "AESTDTC")),
        _f("AETOXGR", pf.get("AETOXGR"), _field_evidence(p, "AETOXGR")),
    ]
    if ctx.others:
        out.append(
            _f(
                "OTHER_EVENTS",
                [
                    f"{(d.get('fields') or {}).get('AEDECOD')} (grade "
                    f"{(d.get('fields') or {}).get('AETOXGR')}, provisional)"
                    for d in ctx.others
                ],
                [e for d in ctx.others for e in _field_evidence(d, "AEDECOD")],
            )
        )
    if ctx.kind == "sae":
        out.append(
            _f(
                "SERIOUSNESS_CRITERIA",
                ["hospitalization or emergency visit reported (suspected)"],
                _seriousness_evidence(ctx),
            )
        )
    else:
        protocol = ctx.result.get("protocol") or {}
        reasons = [str(r) for r in protocol.get("aesi_reasons") or []]
        out.append(
            _f(
                "AESI_CRITERIA",
                reasons,
                [
                    *_rule_pointers(ctx, "protocol.aesi_suspected"),
                    table_pointer(PROTOCOL_TABLE_FILE, "aesi criteria (§9.4.3, p. 92)"),
                ],
            )
        )
    out.extend(
        [
            _f("STUDY_DRUG", drug, [study_pointer(ctx.study)] if drug else []),
            _f("LAST_DOSE_DATE", None, []),
            _f(
                "CONMEDS",
                [_cm_text(cm) for cm in ctx.cm_entries],
                [e for cm in ctx.cm_entries for e in cm.evidence],
            ),
            _f("SITE_AWARENESS_AT", ctx.clock.site_awareness_at, clock_ev),
            _f(
                "REPORT_DUE_AT",
                ctx.clock.due_at,
                [*clock_ev, table_pointer(PROTOCOL_TABLE_FILE, _deadline_note(ctx.kind))],
            ),
            _f(
                "REPORTER_ROLE",
                REPORTER_ROLES.get(actor.role, actor.role),
                [user_pointer(actor, stamp)],
            ),
        ]
    )
    if ctx.kind == "sae":
        out.append(_f("HOSPITALIZATION_DATES", None, []))
    latest = ctx.latest or p
    lf = (latest or {}).get("fields") or {}
    out.extend(
        [
            _f("AEONGO", lf.get("AEONGO"), _field_evidence(latest, "AEONGO")),
            _f("AEENDTC", lf.get("AEENDTC"), _field_evidence(latest, "AEENDTC")),
            _f("LATEST_GRADE", lf.get("AETOXGR"), _field_evidence(latest, "AETOXGR")),
            _f(
                "LATEST_REPORT_AT",
                lf.get("AESTDTC") if latest is p else _latest_time(latest),
                _field_evidence(latest, "AESTDTC" if latest is p else "AETERM"),
            ),
            _f("AEACN", pf.get("AEACN"), _field_evidence(p, "AEACN")),
            _f(
                "AEOUT",
                pf.get("AEOUT") or OUTCOME_UNKNOWN,
                _field_evidence(p, "AEOUT") if pf.get("AEOUT") else [],
            ),
            _f(
                "AESER",
                pf.get("AESER") or NOT_DECIDED,
                _field_evidence(p, "AESER") if pf.get("AESER") else [],
            ),
            _f(
                "AEREL",
                pf.get("AEREL") or NOT_ASSESSED,
                _field_evidence(p, "AEREL") if pf.get("AEREL") else [],
            ),
            _f(
                "INTERIM_IRAE",
                pf.get("INTERIM_IRAE") or NOT_ASSESSED,
                _field_evidence(p, "INTERIM_IRAE") if pf.get("INTERIM_IRAE") else [],
            ),
        ]
    )
    return out


def _latest_time(draft: Mapping[str, Any] | None) -> str | None:
    if draft is None:
        return None
    ev = _field_evidence(draft, "AETERM")
    stamps = [str(e["ts"]) for e in ev if e.get("ts")]
    return max(stamps) if stamps else (draft.get("fields") or {}).get("AESTDTC")


def _deadline_note(kind: str) -> str:
    rules = protocol_rules()
    ref = (rules.sae_reporting if kind == "sae" else rules.aesi.reference).protocol_ref
    return f"report within {rules.sae_reporting_hours:g} h (§{ref.section}, p. {ref.printed_page})"


def fields_by_name(fields: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(f["name"]): dict(f) for f in fields}


# --------------------------------------------------------------------------- #
# Missing information
# --------------------------------------------------------------------------- #


def compute_missing(ctx: SourceContext, fields: Sequence[Mapping[str, Any]]) -> list[str]:
    """What the report still needs, recomputed from current field values (R4.2)."""
    f = fields_by_name(fields)
    drug = f.get("STUDY_DRUG", {}).get("value") or "the study drug"
    out: list[str] = []

    def empty(name: str) -> bool:
        return name in f and is_placeholder(f[name].get("value"))

    if ctx.kind == "sae" and ctx.session is not None and not empty("EVENT_TERM"):
        out.append("Confirm which side effect, if any, led to the hospital or emergency visit")
    if empty("EVENT_TERM"):
        out.append(
            "The side effect behind the hospital or emergency visit"
            if ctx.kind == "sae"
            else "The side effect's standard term"
        )
    if empty("AESTDTC"):
        out.append("The date the side effect started")
    if empty("STUDY_DRUG"):
        out.append("The study drug name")
    if empty("LAST_DOSE_DATE"):
        out.append(f"Date of the last dose of {drug}")
    if empty("HOSPITALIZATION_DATES"):
        out.append("Hospital admission and discharge dates, and the hospital records")
    if empty("AEACN"):
        out.append(f"Action taken with {drug}")
    if empty("AEOUT"):
        out.append("Outcome of the event")
    if ctx.kind == "sae" and empty("AESER"):
        out.append("Investigator's seriousness decision")
    if empty("AEREL"):
        out.append(f"Investigator's assessment of the relationship to {drug}")
    if ctx.kind == "aesi" and empty("INTERIM_IRAE"):
        out.append("Investigator's assessment of whether the event is immune-related")
    cm_labels = {
        "CMTRT": "generic name",
        "CMDOSE": "dose",
        "CMDOSU": "dose unit",
        "CMDOSFRQ": "frequency",
        "CMINDC": "indication",
        "CMSTDTC": "start date",
        "CMENDTC": "stop date",
    }
    for cm in ctx.cm_entries:
        if cm.missing:
            what = ", ".join(cm_labels.get(m, m) for m in cm.missing)
            out.append(f"Medication record for {cm.name}: {what}")
    return out


# --------------------------------------------------------------------------- #
# Narrative facts (interim_rules.narrative.SaeFacts) built from the fields and rows
# --------------------------------------------------------------------------- #


def _ids(evidence: Iterable[Mapping[str, Any]]) -> list[str]:
    out: list[str] = []
    for e in evidence:
        ident = str(e.get("id") or "")
        if ident and ident not in out:
            out.append(ident)
    return out


def _text_fact(value: Any, evidence: Iterable[Mapping[str, Any]]) -> dict[str, Any] | None:
    ids = _ids(evidence)
    if is_placeholder(value) or not ids:
        return None
    return {"value": str(value), "evidence_ids": ids}


def build_facts(ctx: SourceContext, fields: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The narrative's fact bundle. Every fact carries the evidence ids of the field or row
    it came from; a placeholder value is left out (the writer lists it as still needed)."""
    f = fields_by_name(fields)
    clock_ids = [ctx.clock.id]
    facts: dict[str, Any] = {"kind": ctx.kind}

    def put(key: str, name: str, *, date_only: bool = False) -> None:
        entry = f.get(name)
        if entry is None:
            return
        value = entry.get("value")
        if date_only and not (isinstance(value, str) and _DATE_LIKE.fullmatch(value.strip())):
            return
        fact = _text_fact(value, entry.get("evidence") or [])
        if fact is not None:
            facts[key] = fact

    put("participant", "PARTICIPANT")
    facts["study_id"] = {
        "value": ctx.study.study_id,
        "evidence_ids": [study_pointer(ctx.study)["id"]],
    }
    put("study_drug", "STUDY_DRUG")
    put("last_dose", "LAST_DOSE_DATE", date_only=True)
    term, plain = f.get("EVENT_TERM", {}), f.get("EVENT_PLAIN", {})
    term_ids = _ids(term.get("evidence") or [])
    if not is_placeholder(term.get("value")) and term_ids:
        facts["event"] = {
            "term": str(term["value"]),
            "plain_label": _sentence_case(str(plain.get("value") or term["value"])),
            "evidence_ids": term_ids,
        }
    put("onset", "AESTDTC", date_only=True)
    grade = f.get("AETOXGR", {})
    grade_ids = _ids(grade.get("evidence") or [])
    value = grade.get("value")
    if isinstance(value, int) and not isinstance(value, bool) and grade_ids:
        facts["provisional_grade"] = {"grade": value, "evidence_ids": grade_ids}
    put("site_awareness_at", "SITE_AWARENESS_AT")
    awareness = {
        "kiosk check-in": "a kiosk check-in completed by the participant",
        "chart note": "a chart note read by the site",
        "phone call": "a phone call logged by the site",
    }[ctx.source_label]
    facts["awareness_source"] = {
        "value": awareness,
        "evidence_ids": [*clock_ids, *([ctx.note.id] if ctx.note else [])],
    }
    quotes = _quotes(ctx)
    if quotes:
        facts["quotes"] = quotes
    if ctx.kind == "sae":
        crit = f.get("SERIOUSNESS_CRITERIA", {})
        ids = _ids(crit.get("evidence") or [])
        if ids:
            facts["seriousness_criteria"] = [
                {"value": "hospitalization or an emergency visit was reported", "evidence_ids": ids}
            ]
    else:
        protocol = ctx.result.get("protocol") or {}
        ids = _ids(_rule_pointers(ctx, "protocol.aesi_suspected")) or clock_ids
        reasons = _short_aesi_reasons(ctx) or [str(r) for r in protocol.get("aesi_reasons") or []]
        if reasons:
            facts["aesi_reasons"] = [{"value": r, "evidence_ids": ids} for r in reasons]
    rules = protocol_rules()
    ref = (rules.sae_reporting if ctx.kind == "sae" else rules.aesi.reference).protocol_ref
    facts["deadline"] = {
        "due_at": ctx.clock.due_at,
        "hours": float(rules.sae_reporting_hours),
        "protocol_section": ref.section,
        "printed_page": ref.printed_page,
        "evidence_ids": [*clock_ids, PROTOCOL_TABLE_FILE],
    }
    conmeds: list[dict[str, Any]] = []
    for cm in ctx.cm_entries:
        ids = _ids(cm.evidence)
        if not ids:
            continue
        entry: dict[str, Any] = {"name": cm.name, "direction": cm.direction, "evidence_ids": ids}
        if cm.date and _DATE_LIKE.fullmatch(cm.date):
            entry["date"] = cm.date
        if cm.level:
            entry["protocol_flag"] = cm.level
            if cm.section:
                entry["protocol_section"] = cm.section
            if cm.page is not None:
                entry["printed_page"] = cm.page
            if cm.exception_text and cm.level == "discouraged":
                entry["exception_text"] = cm.exception_text
        if cm.missing:
            entry["missing_fields"] = list(cm.missing)
        conmeds.append(entry)
    if conmeds:
        facts["conmeds"] = conmeds
    esc = ctx.escalation
    esc_ids = _ids(_rule_pointers(ctx, "tier.final")[:1])
    if esc is not None and esc_ids:
        facts["escalation"] = {
            "tier": esc.tier,
            "tier_name": tier_name(esc.tier),
            "date": esc.created_at,
            "acknowledged": esc.acked_at is not None,
            **({"acknowledged_at": esc.acked_at} if esc.acked_at else {}),
            "evidence_ids": esc_ids,
        }
    put("action_taken", "AEACN")
    put("outcome", "AEOUT")
    put("causality", "AEREL")
    put("reporter_role", "REPORTER_ROLE")
    missing = compute_missing(ctx, fields)
    if missing:
        facts["missing_information"] = [{"value": m, "evidence_ids": clock_ids} for m in missing]
    return facts


def _sentence_case(text: str) -> str:
    """'Skin rash' -> 'skin rash' mid-sentence; acronyms ('COVID') are left alone."""
    if len(text) > 1 and text[0].isupper() and text[1].islower():
        return text[0].lower() + text[1:]
    return text


def _short_aesi_reasons(ctx: SourceContext) -> list[str]:
    """One short reason per possible-AESI item, from the ``protocol.aesi_suspected`` rule's
    inputs (the long protocol-cited reasons stay on the ``AESI_CRITERIA`` field)."""
    rule = next((r for r in ctx.rules if r.get("rule_id") == "protocol.aesi_suspected"), None)
    inputs = (rule or {}).get("inputs") or {}
    grades = inputs.get("grades") or {}
    categories = inputs.get("irae_categories") or {}
    labels = {i.id: i.label for i in items()}
    out: list[str] = []
    for item_id in inputs.get("aesi_items") or []:
        grade = grades.get(item_id)
        if not isinstance(grade, int):
            return []
        name = _sentence_case(labels.get(item_id, str(item_id)))
        category = categories.get(item_id)
        tail = f" ({category})" if category else ""
        out.append(f"{name} at provisional grade {grade}, a potentially immune-related item{tail}")
    return out


def _quotes(ctx: SourceContext) -> list[dict[str, Any]]:
    """Verbatim words from a chart note or call summary (never the kiosk free text)."""
    if ctx.note is None:
        return []
    note = ctx.note
    kind_label = "phone call summary" if note.note_type == "phone_call" else "chart note"
    source = f"{kind_label} dated {note.note_date}"
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    pointers = [
        *(_seriousness_evidence(ctx) if ctx.kind == "sae" else []),
        *_field_evidence(ctx.primary, "AETERM"),
    ]
    for p in pointers:
        if p.get("kind") != "chart_note" or p.get("id") != note.id:
            continue
        quote = str(p.get("note") or "").strip()
        if not quote or quote in seen or quote not in note.text:
            continue
        seen.add(quote)
        out.append({"text": quote, "source_label": source, "evidence_ids": [note.id]})
    return out


# --------------------------------------------------------------------------- #
# Evidence index
# --------------------------------------------------------------------------- #


def _source_index(db: DbSession, source_id: str) -> dict[str, dict[str, Any]]:
    session = db.get(Session, source_id)
    if session is not None:
        result = load_json(session.result_json, {}) or {}
        answers = [answer_to_dict(a) for a in session_answers(db, session.id)]
        samples = [sample_to_dict(v) for v in session_samples(db, session.id)]
        drafts = [draft_to_dict(d) for d in current_drafts(db, [session.id]).get(session.id, [])]
        index = evidence_index(db, session, result, answers, samples, drafts)
        for entry in index.values():
            entry.setdefault("session_id", session.id)
        return index
    note = db.get(ChartNote, source_id)
    if note is not None:
        drafts = [draft_to_dict(d) for d in current_note_drafts(db, [note.id]).get(note.id, [])]
        index = note_evidence_index(note, drafts, stored_scan(note).get("rules_fired", []))
        for entry in index.values():
            entry.setdefault("note_id", note.id)
        return index
    return {}


def _walk_pointers(obj: Any, out: dict[str, dict[str, Any]]) -> None:
    if isinstance(obj, Mapping):
        if "kind" in obj and "id" in obj and "note" in obj:
            out.setdefault(str(obj["id"]), dict(obj))
            return
        for value in obj.values():
            _walk_pointers(value, out)
    elif isinstance(obj, list):
        for value in obj:
            _walk_pointers(value, out)


def build_evidence_index(
    db: DbSession,
    ctx: SourceContext,
    fields: Sequence[Mapping[str, Any]],
    facts: Mapping[str, Any],
    extra: Sequence[Mapping[str, Any]] = (),
) -> dict[str, dict[str, Any]]:
    """Every evidence id the fields and the narrative facts cite, resolved."""
    pointers: dict[str, dict[str, Any]] = {}
    for f in fields:
        _walk_pointers(f.get("evidence") or [], pointers)
    for p in extra:
        _walk_pointers(p, pointers)
    cited: set[str] = set(pointers)
    _cite_ids(facts, cited)
    merged: dict[str, dict[str, Any]] = {}
    for source_id in sorted(ctx.source_ids):
        for key, entry in _source_index(db, source_id).items():
            merged.setdefault(key, entry)
    clock = clock_pointer(ctx)
    study = study_pointer(ctx.study)
    index: dict[str, dict[str, Any]] = {}
    for ident in sorted(cited):
        if ident == ctx.clock.id:
            entry = {**clock, "clock": {"id": ctx.clock.id, "kind": ctx.kind}, "resolved": True}
        elif ident == study["id"]:
            entry = {
                **study,
                "study": {
                    "study_id": ctx.study.study_id,
                    "nct_id": ctx.study.nct_id,
                    "interventions": load_json(ctx.study.interventions_json, []),
                    "source_url": ctx.study.source_url,
                },
                "resolved": True,
            }
        elif ident in merged and merged[ident].get("resolved"):
            entry = {**merged[ident]}
            for key in ("session_id", "note_id"):
                entry.setdefault(key, pointers.get(ident, {}).get(key))
        elif ident == PROTOCOL_TABLE_FILE or (pointers.get(ident, {}).get("kind") == "table"):
            entry = {
                **(pointers.get(ident) or table_pointer(ident, "rules table")),
                "table": {"file": ident, "path": f"packages/rules/data/{ident}"},
                "resolved": True,
            }
        else:
            entry = {**(pointers.get(ident) or {"id": ident, "kind": "unknown", "note": ""})}
            entry["resolved"] = _resolve_generic(db, entry)
        index[ident] = entry
    return index


def _cite_ids(facts: Any, out: set[str]) -> None:
    if isinstance(facts, Mapping):
        for key, value in facts.items():
            if key == "evidence_ids" and isinstance(value, list):
                out.update(str(v) for v in value)
            else:
                _cite_ids(value, out)
    elif isinstance(facts, list):
        for value in facts:
            _cite_ids(value, out)


def _resolve_generic(db: DbSession, entry: dict[str, Any]) -> bool:
    kind, ident = entry.get("kind"), str(entry.get("id"))
    if kind == "edit":
        event = db.get(AuditEvent, ident)
        if event is not None:
            entry["audit_event"] = {
                "id": event.id,
                "seq": event.seq,
                "ts_utc": event.ts_utc,
                "actor_id": event.actor_id,
                "actor_role": event.actor_role,
                "action": event.action,
                "payload": load_json(event.payload_json, {}),
            }
            return True
        return False
    if kind == "user":
        entry["user"] = {"id": ident.removeprefix("user:")}
        return True
    if kind == "chart_note":
        return db.get(ChartNote, ident) is not None
    if kind == "rule":
        return True  # a rule id from a source's rules_fired (catalogued in rules_catalog.json)
    return False


# --------------------------------------------------------------------------- #
# Rows <-> dicts
# --------------------------------------------------------------------------- #


def _edited_names(packet: Packet) -> set[str]:
    names: set[str] = set()
    for edit in load_json(packet.edits_json, []) or []:
        names.update(k for k in (edit.get("diff") or {}) if k != "narrative_text")
    return names


def packet_to_dict(db: DbSession, packet: Packet) -> dict[str, Any]:
    clock = db.get(SAEClock, packet.clock_id)
    participant = db.get(Participant, packet.usubjid)
    edited = _edited_names(packet)
    fields = [{**f, "edited": f["name"] in edited} for f in load_json(packet.fields_json, []) or []]
    followups = db.exec(select(Packet).where(Packet.parent_packet_id == packet.id)).all()
    narrative = load_json(packet.narrative_json, {}) or {}
    return {
        "id": packet.id,
        "clock_id": packet.clock_id,
        "kind": packet.kind,
        "kind_label": "SAE" if packet.kind == "sae" else "possible AESI, investigator to confirm",
        "usubjid": packet.usubjid,
        "display_label": participant.display_label if participant else None,
        "session_id": packet.session_id,
        "note_id": packet.note_id,
        "status": packet.status,
        "sequence": packet.sequence,
        "parent_packet_id": packet.parent_packet_id,
        "version": packet.version,
        "fields": fields,
        "missing_information": load_json(packet.missing_json, []) or [],
        "narrative": narrative,
        "writer": narrative.get("writer", "template"),
        "narrative_edited": load_json(packet.narrative_edited_json, None),
        "changes_since_previous": load_json(packet.changes_json, []) or [],
        "versions": load_json(packet.edits_json, []) or [],
        "evidence_index": load_json(packet.evidence_index_json, {}) or {},
        "created_by": packet.created_by,
        "created_at": packet.created_at,
        "updated_at": packet.updated_at,
        "signed_by": packet.signed_by,
        "signed_at": packet.signed_at,
        "mock_edc_ack_id": packet.mock_edc_ack_id,
        "sign_attestation": load_json(packet.sign_attestation_json, None),
        "followup_packet_ids": sorted(p.id for p in followups),
        "site_awareness_at": clock.site_awareness_at if clock else None,
        "due_at": clock.due_at if clock else None,
        "clock_stopped_at": clock.stopped_at if clock else None,
        "clock_decision": clock.decision if clock else None,
        "footer": FOOTER,
    }


def get_packet_or_404(db: DbSession, packet_id: str) -> Packet:
    row = db.get(Packet, packet_id)
    if row is None:
        raise problem(404, f"No packet with id {packet_id}", title="Packet not found")
    return row


def _aeser_on_record(db: DbSession, packet: Packet) -> dict[str, Any]:
    """``{draft_id: AESER}`` for the current AE records of the packet's check-in, so the
    signature event shows whether an investigator seriousness decision existed."""
    if not packet.session_id:
        return {}
    rows = db.exec(
        select(Draft)
        .where(Draft.session_id == packet.session_id)
        .where(Draft.domain == "AE")
        .where(Draft.status != "superseded")
    ).all()
    return {d.id: (load_json(d.fields_json, {}) or {}).get("AESER") for d in rows}


def _clock_or_404(db: DbSession, clock_id: str) -> SAEClock:
    clock = db.get(SAEClock, clock_id)
    if clock is None:
        raise problem(404, f"No 24-hour clock with id {clock_id}", title="Clock not found")
    return clock


# --------------------------------------------------------------------------- #
# Create / follow-up
# --------------------------------------------------------------------------- #


def _write_narrative(writer: Writer, kind: str, facts: Mapping[str, Any]) -> dict[str, Any]:
    return writer.write(NARRATIVE_KIND[kind], facts)


def _assemble(
    db: DbSession,
    ctx: SourceContext,
    fields: list[dict[str, Any]],
    writer: Writer,
    extra_pointers: Sequence[Mapping[str, Any]] = (),
) -> tuple[list[str], dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]:
    """``(missing, facts, narrative, evidence_index)`` for a field list."""
    missing = compute_missing(ctx, fields)
    facts = build_facts(ctx, fields)
    narrative = _write_narrative(writer, ctx.kind, facts)
    index = build_evidence_index(db, ctx, fields, facts, extra_pointers)
    return missing, facts, narrative, index


def create_packet(
    db: DbSession, actor: Actor, clock_id: str, writer: Writer, *, now: str | None = None
) -> tuple[Packet, bool]:
    """``POST /packets {clock_id}``: the initial report (sequence 0), created once per clock.

    Returns ``(packet, created)``; a second call returns the existing packet unchanged.
    """
    clock = _clock_or_404(db, clock_id)
    existing = db.exec(
        select(Packet).where(Packet.clock_id == clock.id).where(Packet.sequence == 0)
    ).first()
    if existing is not None:
        return existing, False
    stamp = now or now_iso()
    ctx = load_context(db, clock)
    fields = build_fields(ctx, actor, stamp)
    missing, facts, narrative, index = _assemble(db, ctx, fields, writer)
    return _insert(db, actor, ctx, fields, missing, facts, narrative, index, stamp), True


def _insert(
    db: DbSession,
    actor: Actor,
    ctx: SourceContext,
    fields: list[dict[str, Any]],
    missing: list[str],
    facts: dict[str, Any],
    narrative: dict[str, Any],
    index: dict[str, dict[str, Any]],
    stamp: str,
    *,
    sequence: int = 0,
    parent: Packet | None = None,
    changes: list[dict[str, Any]] | None = None,
) -> Packet:
    packet = Packet(
        id=new_id(),
        clock_id=ctx.clock.id,
        kind=ctx.kind,
        sequence=sequence,
        parent_packet_id=parent.id if parent else None,
        usubjid=ctx.clock.usubjid,
        session_id=ctx.clock.session_id,
        note_id=ctx.clock.note_id,
        status="draft",
        version=1,
        fields_json=dump_json(fields),
        missing_json=dump_json(missing),
        narrative_json=dump_json(narrative),
        facts_json=dump_json(facts),
        evidence_index_json=dump_json(index),
        changes_json=dump_json(changes or []),
        edits_json="[]",
        created_by=actor.id,
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(packet)
    db.flush()
    append_event(
        db,
        actor,
        "packet.created",
        "packet",
        packet.id,
        {
            "clock_id": ctx.clock.id,
            "kind": ctx.kind,
            "sequence": sequence,
            "parent_packet_id": packet.parent_packet_id,
            "usubjid": packet.usubjid,
            "session_id": packet.session_id,
            "note_id": packet.note_id,
            "writer": narrative.get("writer"),
            "fallback_reason": narrative.get("fallback_reason"),
            "n_sentences": len(narrative.get("sentences") or []),
            "missing_information": missing,
            "changes": [c["field"] for c in changes or []],
        },
        ts_utc=stamp,
    )
    return packet


def start_follow_up(
    db: DbSession, actor: Actor, packet_id: str, writer: Writer, *, now: str | None = None
) -> tuple[Packet, bool]:
    """``POST /packets/{id}/follow-up`` (R4.2): follow-up n+1 of a **signed** packet.

    Fields are re-filled from current evidence; a value a person entered on the previous
    report survives when the evidence still has nothing better, or when it corrected a
    pre-filled value whose evidence has not changed since. An unsigned follow-up of the
    same report is returned instead of starting a second one.
    """
    parent = get_packet_or_404(db, packet_id)
    if parent.status != "signed":
        raise problem(
            409,
            f"Packet {parent.id} is not signed yet; edit it instead of starting a follow-up",
            title="Packet not signed",
        )
    pending = db.exec(select(Packet).where(Packet.parent_packet_id == parent.id)).all()
    for row in pending:
        if row.status == "draft":
            return row, False
        raise problem(
            409,
            f"Packet {parent.id} already has a signed follow-up ({row.id}); start the next "
            "follow-up from that one",
            title="Not the latest report",
        )
    stamp = now or now_iso()
    clock = _clock_or_404(db, parent.clock_id)
    ctx = load_context(db, clock)
    fresh = build_fields(ctx, actor, stamp)
    previous = fields_by_name(load_json(parent.fields_json, []) or [])
    prefilled = _prefilled_values(parent)
    fields: list[dict[str, Any]] = []
    for f in fresh:
        before = previous.get(f["name"])
        # Carry the signed value forward when the evidence still has nothing better, or
        # when a person corrected the pre-filled value and the evidence has not changed
        # since (otherwise the follow-up would silently undo the correction and report it
        # to the sponsor as a change back to the old value).
        corrected = f["name"] in prefilled and _same(prefilled[f["name"]], f["value"])
        if before is not None and (
            (is_placeholder(f["value"]) and not is_placeholder(before.get("value"))) or corrected
        ):
            carried = dict(before)
            carried["evidence"] = [
                *(before.get("evidence") or []),
                {
                    "kind": "packet",
                    "id": parent.id,
                    "ts": parent.signed_at,
                    "note": f"carried from the signed report (sequence {parent.sequence})",
                },
            ]
            fields.append(carried)
        else:
            fields.append(f)
    changes = _changes(previous, fields)
    missing, facts, narrative, index = _assemble(db, ctx, fields, writer)
    sequence = parent.sequence + 1
    packet = _insert(
        db,
        actor,
        ctx,
        fields,
        missing,
        facts,
        narrative,
        index,
        stamp,
        sequence=sequence,
        parent=parent,
        changes=changes,
    )
    _index_packet_pointer(packet, parent)
    return packet, True


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _prefilled_values(packet: Packet) -> dict[str, Any]:
    """Field name -> the value Interim pre-filled, for every field a person edited on
    ``packet`` (the ``before`` of the first edit that touched it)."""
    out: dict[str, Any] = {}
    for edit in load_json(packet.edits_json, []) or []:
        for name, change in (edit.get("diff") or {}).items():
            if name != "narrative_text" and name not in out and isinstance(change, dict):
                out[name] = change.get("before")
    return out


def _index_packet_pointer(packet: Packet, parent: Packet) -> None:
    index = load_json(packet.evidence_index_json, {}) or {}
    if parent.id in index:
        index[parent.id] = {
            **index[parent.id],
            "packet": {"id": parent.id, "sequence": parent.sequence, "signed_at": parent.signed_at},
            "resolved": True,
        }
        packet.evidence_index_json = dump_json(index)


def _changes(
    previous: Mapping[str, Mapping[str, Any]], fields: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in fields:
        before = previous.get(str(f["name"]), {}).get("value")
        after = f.get("value")
        if json.dumps(before, sort_keys=True) != json.dumps(after, sort_keys=True):
            out.append(
                {
                    "field": f["name"],
                    "plain_label": f.get("plain_label") or field_label(str(f["name"])),
                    "before": before,
                    "after": after,
                    "evidence": list(f.get("evidence") or []),
                }
            )
    return out


# --------------------------------------------------------------------------- #
# Edit
# --------------------------------------------------------------------------- #

_SCALAR = (str, int, float, bool, type(None))


def _check_value(name: str, value: Any) -> None:
    ok = isinstance(value, _SCALAR) or (
        isinstance(value, list) and all(isinstance(v, str | int | float) for v in value)
    )
    if not ok or (isinstance(value, str) and len(value) > 2000):
        raise problem(
            422,
            f"{name}: a value must be text, a number, true/false, null or a list of text",
            title="Invalid field value",
        )


def edit_packet(
    db: DbSession,
    actor: Actor,
    packet: Packet,
    writer: Writer,
    *,
    changes: Mapping[str, Any] | None,
    narrative_text: str | None,
    note: str | None,
    now: str | None = None,
) -> Packet:
    """``PATCH /packets/{id}``: a new version (``version + 1``) with the diff audited.

    Field edits re-derive the missing information and re-write the generated narrative
    (the edit's audit event becomes the evidence for the new value); a person's own
    narrative text is kept separately as ``narrative_edited``.
    """
    if packet.status == "signed":
        raise problem(
            409,
            f"Packet {packet.id} was signed by {packet.signed_by} at {packet.signed_at}; "
            "start a follow-up report to change it",
            title="Packet already signed",
        )
    changes = dict(changes or {})
    if not changes and narrative_text is None:
        raise problem(422, "Provide fields and/or narrative_text", title="Nothing to change")
    fields = load_json(packet.fields_json, []) or []
    by_name = {f["name"]: f for f in fields}
    unknown = sorted(k for k in changes if k not in by_name)
    if unknown:
        raise problem(
            422,
            f"Unknown packet field(s): {', '.join(unknown)}",
            title="Unknown field",
            allowed=sorted(by_name),
        )
    restricted = sorted(k for k in changes if k in INVESTIGATOR_FIELDS)
    if restricted and actor.role != "investigator":
        raise problem(
            403,
            f"{', '.join(restricted)} can only be set by an investigator (you are {actor.role})",
            title="Forbidden",
        )
    for name, value in changes.items():
        _check_value(name, value)
    diff: dict[str, dict[str, Any]] = {
        k: {"before": by_name[k].get("value"), "after": v}
        for k, v in changes.items()
        if json.dumps(by_name[k].get("value"), sort_keys=True) != json.dumps(v, sort_keys=True)
    }
    edited_before = load_json(packet.narrative_edited_json, None) or {}
    current_text = edited_before.get("text") or (load_json(packet.narrative_json, {}) or {}).get(
        "text"
    )
    if narrative_text is not None and narrative_text != current_text:
        if len(narrative_text) > 20000:
            raise problem(422, "narrative_text is too long", title="Invalid narrative")
        diff["narrative_text"] = {"before": current_text, "after": narrative_text}
    if not diff:
        return packet
    stamp = now or now_iso()
    event = append_event(
        db,
        actor,
        "packet.edited",
        "packet",
        packet.id,
        {
            "clock_id": packet.clock_id,
            "kind": packet.kind,
            "sequence": packet.sequence,
            "version": packet.version + 1,
            "diff": diff,
            "note": note,
        },
        ts_utc=stamp,
    )
    for name in diff:
        if name == "narrative_text":
            continue
        entry = by_name[name]
        entry["value"] = changes[name]
        entry["evidence"] = [
            *(entry.get("evidence") or []),
            {
                "kind": "edit",
                "id": event.id,
                "ts": stamp,
                "note": f"{name} set by {actor.id} ({actor.role}): {changes[name]!r}"
                + (f"; note: {note}" if note else ""),
            },
        ]
    if "narrative_text" in diff:
        packet.narrative_edited_json = dump_json(
            {"text": narrative_text, "edited_by": actor.id, "edited_at": stamp}
        )
    clock = _clock_or_404(db, packet.clock_id)
    ctx = load_context(db, clock)
    extra = [{"kind": "packet", "id": packet.parent_packet_id, "ts": None, "note": "previous"}]
    missing, facts, narrative, index = _assemble(
        db, ctx, fields, writer, extra if packet.parent_packet_id else ()
    )
    edits = load_json(packet.edits_json, []) or []
    edits.append(
        {
            "version": packet.version + 1,
            "edited_by": actor.id,
            "edited_role": actor.role,
            "edited_at": stamp,
            "diff": diff,
            "note": note,
            "audit_event_id": event.id,
        }
    )
    packet.fields_json = dump_json(fields)
    packet.missing_json = dump_json(missing)
    packet.facts_json = dump_json(facts)
    packet.narrative_json = dump_json(narrative)
    packet.evidence_index_json = dump_json(index)
    packet.edits_json = dump_json(edits)
    packet.version += 1
    packet.updated_at = stamp
    if packet.parent_packet_id:
        parent = db.get(Packet, packet.parent_packet_id)
        if parent is not None:
            _index_packet_pointer(packet, parent)
    db.add(packet)
    db.flush()
    return packet


# --------------------------------------------------------------------------- #
# Sign (investigator) -> clock stopped "reported (mock)" -> mock EDC
# --------------------------------------------------------------------------- #


def export_record(db: DbSession, packet: Packet) -> dict[str, Any]:
    """The packet as one mock-EDC record: SAE-form fields plus provenance."""
    data = packet_to_dict(db, packet)
    narrative = data["narrative_edited"] or {}
    return {
        "STUDYID": get_study(db).study_id,
        "USUBJID": packet.usubjid,
        "INTERIM_PACKET_ID": packet.id,
        "INTERIM_PACKET_KIND": packet.kind,
        "INTERIM_PACKET_SEQUENCE": packet.sequence,
        "INTERIM_PACKET_VERSION": packet.version,
        "INTERIM_CLOCK_ID": packet.clock_id,
        "INTERIM_PARENT_PACKET_ID": packet.parent_packet_id,
        "fields": {f["name"]: f["value"] for f in data["fields"]},
        "missing_information": data["missing_information"],
        "narrative": narrative.get("text") or data["narrative"].get("text"),
        "narrative_writer": data["writer"],
        "narrative_source": "edited by a person" if narrative.get("text") else "generated",
        "changes_since_previous": [
            {"field": c["field"], "before": c["before"], "after": c["after"]}
            for c in data["changes_since_previous"]
        ],
        "INTERIM_SOURCE": "simulated synthetic participant (demo)",
    }


def _post_mock_edc(
    db: DbSession, actor: Actor, packet: Packet, record: Mapping[str, Any], stamp: str
) -> dict[str, Any]:
    """The mock EDC's acknowledgment for a packet (same ack/audit shape as
    ``POST /mock-edc/{domain}``; domain ``SAE`` or ``AESI``). Nothing is transmitted."""
    domain = EDC_DOMAIN.get(packet.kind, "SAE")
    canonical = json.dumps([record], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = sha256_hex(canonical.encode("utf-8"))
    ack_id = f"EDC-{domain}-{new_id()}"
    append_event(
        db,
        actor,
        "mock_edc.posted",
        "mock_edc",
        ack_id,
        {
            "domain": domain,
            "received": 1,
            "sha256": digest,
            "usubjids": [packet.usubjid],
            "packet_id": packet.id,
            "sequence": packet.sequence,
            "note": "mock EDC: records are acknowledged and logged; nothing is transmitted",
        },
        ts_utc=stamp,
    )
    return {
        "ack_id": ack_id,
        "domain": domain,
        "received": 1,
        "accepted_at": stamp,
        "sha256": digest,
        "note": "Mock EDC acknowledgment. No external system was contacted.",
    }


def sign_packet(
    db: DbSession,
    actor: Actor,
    packet: Packet,
    *,
    note: str | None,
    narrative_reviewed: bool,
    missing_info_acknowledged: bool,
    missing_info_not_available: Sequence[str] | None = None,
    now: str | None = None,
) -> tuple[Packet, dict[str, Any]]:
    """Investigator signature: status ``signed``; the clock stops as "reported (mock)" (if
    still running); the packet is posted to the mock EDC. Returns ``(packet, ack)``.

    The signer must attest: ``narrative_reviewed`` (422 otherwise; a generated narrative is
    never signed unread) and, when the packet lists missing information,
    an explicit "not available" acknowledgment of every open item: either
    ``missing_info_not_available`` naming each item verbatim, or ``missing_info_acknowledged``
    (all listed items at once; 422 otherwise, and 422 for a named item that is not open).
    The attestation (narrative reviewed, whether a person edited it, each item marked "not
    available") is stored on the packet (``sign_attestation``) and in the ``packet.signed``
    event, with the AESER values on the linked AE records."""
    if actor.role != "investigator":
        raise problem(403, "Only an investigator can sign a report packet", title="Forbidden")
    if packet.status == "signed":
        raise problem(
            409,
            f"Packet {packet.id} was already signed by {packet.signed_by} at {packet.signed_at}",
            title="Already signed",
        )
    signed_source, signed_text = reported_narrative(packet)
    if not narrative_reviewed:
        raise problem(
            422,
            f"Confirm you read the {signed_source} narrative before signing "
            "(narrative_reviewed: true)",
            title="Narrative not reviewed",
        )
    open_items = [str(m) for m in (load_json(packet.missing_json, []) or [])]
    named = [str(m).strip() for m in (missing_info_not_available or []) if str(m).strip()]
    stray = [m for m in named if m not in open_items]
    if stray:
        raise problem(
            422,
            f"Not an open missing-information item on this packet: {'; '.join(stray)}. "
            f"Open items: {'; '.join(open_items) or 'none'}",
            title="Unknown missing-information item",
        )
    unacknowledged = [] if missing_info_acknowledged else [m for m in open_items if m not in named]
    if unacknowledged:
        raise problem(
            422,
            f"This packet still lists {len(unacknowledged)} missing-information item(s) not "
            f"acknowledged: {'; '.join(unacknowledged)}. Fill them first, or mark each one "
            "'not available' (missing_info_not_available: [...], or "
            "missing_info_acknowledged: true for all listed items).",
            title="Missing information not acknowledged",
        )
    stamp = now or now_iso()
    attestation: dict[str, Any] = {
        "narrative_reviewed": True,
        "narrative_source": signed_source,
        "narrative_edited_by_person": signed_source == "edited",
        "missing_info_not_available": [{"item": m, "status": "not available"} for m in open_items],
        "missing_info_acknowledged_by": (
            "item_list"
            if named and not missing_info_acknowledged
            else ("all_listed" if open_items else None)
        ),
        "attested_by": actor.id,
        "attested_at": stamp,
    }
    packet.sign_attestation_json = dump_json(attestation)
    packet.status = "signed"
    packet.signed_by = actor.id
    packet.signed_at = stamp
    packet.updated_at = stamp
    record = export_record(db, packet)
    ack = _post_mock_edc(db, actor, packet, record, stamp)
    packet.mock_edc_ack_id = ack["ack_id"]
    db.add(packet)
    db.flush()
    clock = _clock_or_404(db, packet.clock_id)
    stopped_now = False
    if clock.stopped_at is None:
        clock.stopped_at = stamp
        clock.stopped_by = actor.id
        clock.decision = SIGNED_DECISION
        db.add(clock)
        db.flush()
        stopped_now = True
        log_clock_stopped(
            db,
            actor,
            clock,
            {
                "session_id": clock.session_id,
                "note_id": clock.note_id,
                "usubjid": clock.usubjid,
                "decision": SIGNED_DECISION,
                "stopped_at": stamp,
                "due_at": clock.due_at,
                "within_24h": stamp <= clock.due_at,
                "path": "packet.sign",
                "packet_id": packet.id,
            },
            stamp,
        )
    append_event(
        db,
        actor,
        "packet.followup_signed" if packet.sequence > 0 else "packet.signed",
        "packet",
        packet.id,
        {
            "clock_id": packet.clock_id,
            "kind": packet.kind,
            "sequence": packet.sequence,
            "version": packet.version,
            "usubjid": packet.usubjid,
            "mock_edc_ack_id": ack["ack_id"],
            "sha256": ack["sha256"],
            "clock_stopped": stopped_now,
            "decision": SIGNED_DECISION if stopped_now else clock.decision,
            "note": note,
            "narrative_signed": signed_source,
            "narrative_reviewed": True,
            "narrative_edited_by_person": signed_source == "edited",
            "missing_info_acknowledged": open_items,
            "missing_info_not_available": attestation["missing_info_not_available"],
            "aeser_on_record": _aeser_on_record(db, packet),
            "narrative_sha256": (
                sha256_hex(signed_text.encode("utf-8")) if signed_text is not None else None
            ),
        },
        ts_utc=stamp,
    )
    return packet, ack


# --------------------------------------------------------------------------- #
# List, export, print
# --------------------------------------------------------------------------- #


def list_packets(
    db: DbSession,
    *,
    clock_id: str | None,
    usubjid: str | None,
    status: str | None,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    stmt = select(Packet)
    if clock_id:
        stmt = stmt.where(Packet.clock_id == clock_id)
    if usubjid:
        stmt = stmt.where(Packet.usubjid == usubjid)
    if status:
        stmt = stmt.where(Packet.status == status)
    rows = sorted(db.exec(stmt).all(), key=lambda p: (p.created_at, p.id), reverse=True)
    page = rows[offset : offset + limit]
    return {
        "items": [
            {
                "id": p.id,
                "clock_id": p.clock_id,
                "kind": p.kind,
                "sequence": p.sequence,
                "parent_packet_id": p.parent_packet_id,
                "usubjid": p.usubjid,
                "status": p.status,
                "version": p.version,
                "created_at": p.created_at,
                "signed_by": p.signed_by,
                "signed_at": p.signed_at,
                "n_missing": len(load_json(p.missing_json, []) or []),
            }
            for p in page
        ],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }


def export_packet(db: DbSession, actor: Actor, packet: Packet) -> tuple[bytes, str]:
    """``GET /packets/{id}/export.json``: the packet with its evidence, audited."""
    stamp = now_iso()
    body = {
        "generated_at": stamp,
        "generated_by": actor.id,
        "interim_version": API_VERSION,
        "packet": packet_to_dict(db, packet),
        "mock_edc_record": export_record(db, packet),
        "note": f"{MOCK_NOTE} All participants are synthetic. {FOOTER}",
    }
    data = json.dumps(body, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
    digest = sha256_hex(data)
    append_event(
        db,
        actor,
        "export.generated",
        "packet",
        packet.id,
        {"kind": "packet_json", "sha256": digest, "bytes": len(data), "status": packet.status},
        ts_utc=stamp,
    )
    return data, digest


_CSS = """
body{font-family:Georgia,'Times New Roman',serif;color:#111;margin:2rem auto;max-width:52rem;
padding:0 1rem;line-height:1.45}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:1.6rem 0 .5rem;
border-bottom:1px solid #999;padding-bottom:.2rem}
.meta{color:#444;font-size:.9rem}.badge{display:inline-block;border:1px solid #333;
border-radius:3px;padding:0 .35rem;font:600 .75rem/1.5 system-ui,sans-serif;margin-left:.4rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid #bbb;
padding:.35rem .5rem;vertical-align:top;text-align:left}th{background:#f2f2f2;width:30%}
code,.ev{font:.75rem/1.4 ui-monospace,Consolas,monospace;color:#333}
.ev{display:block;margin-top:.2rem}ol li{margin:.35rem 0}
.missing li{margin:.2rem 0}.sig{margin-top:2rem;border-top:1px solid #999;padding-top:.6rem}
footer{margin-top:2.5rem;border-top:2px solid #111;padding-top:.6rem;font-size:.85rem}
@media print{body{margin:0;max-width:none}a{color:#111}}
"""


def _fmt(value: Any) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        return "Not known yet"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, list):
        return "; ".join(str(v) for v in value) if value else "None"
    return str(value)


REVIEW_SENTENCE_MARK = "for investigator review and signature"
"""The template's closing line (``narrative_templates.json``); dropped from a signed print."""


def _is_review_sentence(text: str) -> bool:
    return REVIEW_SENTENCE_MARK in text.lower()


def reported_narrative(packet: Packet) -> tuple[str, str | None]:
    """``(source, text)`` of the narrative a packet reports: a person's edited text when
    there is one (``"edited"``), else the generated draft (``"generated"``)."""
    edited = load_json(packet.narrative_edited_json, None) or {}
    if edited.get("text"):
        return "edited", str(edited["text"])
    text = (load_json(packet.narrative_json, {}) or {}).get("text")
    return "generated", str(text) if text else None


def render_print_html(db: DbSession, packet: Packet) -> str:
    """A self-contained printable page: inline CSS, no scripts, no external resources."""
    data = packet_to_dict(db, packet)
    e = html.escape
    kind_name = (
        "Serious adverse event (SAE) report"
        if packet.kind == "sae"
        else ("Possible adverse event of special interest (AESI) report, investigator to confirm")
    )
    seq = "Initial report" if packet.sequence == 0 else f"Follow-up {packet.sequence}"
    narrative = data["narrative"] or {}
    writer = "Written by Claude" if narrative.get("writer") == "llm" else "Written by template"
    rows = []
    for f in data["fields"]:
        ids = ", ".join(str(ev.get("id")) for ev in f.get("evidence") or [])
        rows.append(
            f"<tr><th>{e(str(f['plain_label']))}<span class='ev'>{e(str(f['name']))}</span></th>"
            f"<td>{e(_fmt(f['value']))}"
            + (f"<span class='ev'>evidence: {e(ids)}</span>" if ids else "")
            + ("<span class='ev'>edited by a person</span>" if f.get("edited") else "")
            + "</td></tr>"
        )
    is_signed = packet.status == "signed"
    edited = data["narrative_edited"]
    has_edit = bool(edited and edited.get("text"))
    # Once signed (or replaced by a person's text), the template's own "for investigator
    # review and signature" line no longer describes the record.
    shown = [
        s
        for s in narrative.get("sentences") or []
        if not ((is_signed or has_edit) and _is_review_sentence(str(s.get("text") or "")))
    ]
    sentences = "".join(
        f"<li>{e(str(s.get('text')))}<span class='ev'>evidence: "
        f"{e(', '.join(str(i) for i in s.get('evidence_ids') or []))}</span></li>"
        for s in shown
    )
    fallback = (
        f"<p class='meta'>Fallback: {e(str(narrative['fallback_reason']))}</p>"
        if narrative.get("fallback_reason")
        else ""
    )
    if has_edit:
        # The person's text is the reported narrative; the template draft is kept for
        # reference only, collapsed, so a reader can never mistake which one was reported.
        who = e(str(edited.get("edited_by")))
        when = e(str(edited.get("edited_at")))
        narrative_html = (
            f"<h2>{'Narrative (signed)' if is_signed else 'Narrative'} "
            f"<span class='badge'>Written by {who}</span></h2>"
            f"<p class='meta'>Edited by {who} at {when} UTC. "
            + (
                "This is the narrative the investigator signed and reported."
                if is_signed
                else "This is the narrative that will be reported when signed."
            )
            + f"</p><p>{e(str(edited.get('text')))}</p>"
            f"<details><summary>Original template draft ({e(writer.lower())}; not the "
            f"reported text)</summary>{fallback}<ol>{sentences}</ol></details>"
        )
    else:
        heading = "Narrative (signed)" if is_signed else "Draft narrative"
        narrative_html = (
            f"<h2>{heading} <span class='badge'>{e(writer)}</span></h2>{fallback}"
            + (
                "<p class='meta'>This is the narrative the investigator signed and reported.</p>"
                if is_signed
                else ""
            )
            + f"<ol>{sentences}</ol>"
        )
    missing = "".join(f"<li>{e(m)}</li>" for m in data["missing_information"]) or "<li>None</li>"
    changes = "".join(
        f"<tr><th>{e(str(c.get('plain_label') or c['field']))}</th><td>{e(_fmt(c['before']))}"
        f"</td><td>{e(_fmt(c['after']))}</td></tr>"
        for c in data["changes_since_previous"]
    )
    changes_html = (
        "<h2>Changes since the previous report</h2><table><tr><th>Field</th><th>Before</th>"
        f"<th>After</th></tr>{changes}</table>"
        if packet.sequence > 0
        else ""
    )
    signed = (
        f"Signed by {e(str(packet.signed_by))} at {e(str(packet.signed_at))} UTC. "
        f"Mock EDC acknowledgment {e(str(packet.mock_edc_ack_id))}."
        if packet.status == "signed"
        else "Not signed yet: draft for investigator review."
    )
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        f"<title>{e(kind_name)} - {e(str(data['display_label'] or packet.usubjid))}</title>"
        f"<style>{_CSS}</style></head><body>"
        f"<h1>{e(kind_name)}<span class='badge'>{e(seq)}</span>"
        f"<span class='badge'>{e(packet.status.upper())}</span></h1>"
        f"<p class='meta'>Participant {e(str(data['display_label'] or ''))} "
        f"(<code>{e(packet.usubjid)}</code>, synthetic) · packet <code>{e(packet.id)}</code> "
        f"version {packet.version} · site aware {e(str(data['site_awareness_at']))} UTC · "
        f"due {e(str(data['due_at']))} UTC</p>"
        f"<p class='meta'>{e(MOCK_NOTE)}</p>"
        f"<h2>Report fields</h2><table>{''.join(rows)}</table>"
        f"<h2>Information still needed</h2><ul class='missing'>{missing}</ul>"
        f"{changes_html}"
        f"{narrative_html}"
        f"<p class='sig'>{signed}</p>"
        f"<footer>{e(FOOTER)}</footer></body></html>"
    )


def print_packet(db: DbSession, actor: Actor, packet: Packet) -> str:
    page = render_print_html(db, packet)
    append_event(
        db,
        actor,
        "export.generated",
        "packet",
        packet.id,
        {
            "kind": "packet_print",
            "sha256": sha256_hex(page.encode("utf-8")),
            "status": packet.status,
        },
    )
    return page


def report_past_aesi_clocks(
    db: DbSession,
    *,
    session_id: str,
    before: str,
    at: str,
    coordinator: Actor,
    investigator: Actor,
) -> list[Packet]:
    """Seed history only: a possible-AESI clock of a past check-in (due before ``before``)
    gets the report it would have had: a packet prepared by the coordinator and signed by
    the investigator at ``at`` (template writer, mock EDC). Keeps a lived-in history from
    showing month-old "overdue" clocks, and shows signed packets on the timeline."""
    from ..writers.template import TemplateWriter

    rows = db.exec(
        select(SAEClock)
        .where(SAEClock.session_id == session_id)
        .where(SAEClock.kind == "aesi")
        .where(SAEClock.stopped_at == None)  # noqa: E711
    ).all()
    out: list[Packet] = []
    for clock in rows:
        if clock.due_at >= before:
            continue
        packet, _ = create_packet(db, coordinator, clock.id, TemplateWriter(), now=at)
        signed, _ = sign_packet(
            db,
            investigator,
            packet,
            note="seed: reported at the time",
            narrative_reviewed=True,
            missing_info_acknowledged=True,
            now=at,
        )
        out.append(signed)
    return out


__all__ = [
    "FOOTER",
    "INVESTIGATOR_FIELDS",
    "SIGNED_DECISION",
    "build_facts",
    "build_fields",
    "compute_missing",
    "create_packet",
    "edit_packet",
    "export_packet",
    "get_packet_or_404",
    "list_packets",
    "load_context",
    "packet_to_dict",
    "print_packet",
    "report_past_aesi_clocks",
    "render_print_html",
    "sign_packet",
    "start_follow_up",
]
