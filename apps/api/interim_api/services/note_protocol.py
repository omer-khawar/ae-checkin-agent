"""Protocol con-med flags for chart-note / phone-call CM drafts (CLAUDE.md §00.1, R3.1).

A kiosk CM draft gets ``INTERIM_PROTOCOL_FLAG`` / ``INTERIM_CM_MISSING_FIELDS`` from the
rules engine (``interim_rules.drafting``). A medication found in a chart note is drafted by
the API (``services.notes._cm_draft``), so this module applies the same protocol table to
it with the rules package's own :func:`interim_rules.protocol.classify_conmed`:

* ``INTERIM_PROTOCOL_FLAG``: the most restrictive level (``prohibited`` > ``discouraged`` >
  ``permitted``) or ``None``;
* ``INTERIM_CM_MISSING_FIELDS``: the protocol's required CM fields (§7.7, p. 69) a note
  draft does not fill. The scanner reads the drug name and whether it was started or
  stopped, never dose, unit, frequency or indication, so those are always listed; the
  start / stop date follows the kiosk rule ("as appropriate").

Decisions stay in the rules package: a note never changes its tier here (D-017 keeps
notes at Tier 2 or below and the note tier is decided by the scanner's red flags); the
flag is a coordinator prompt, with a ``protocol.conmed_<level>`` rule for the Why panel.
"""

from __future__ import annotations

from typing import Any

from interim_rules.protocol import PROTOCOL_TABLE_FILE, classify_conmed
from interim_rules.tables import protocol_rules

RULE_PREFIX = "protocol.conmed_"
RULE_MISSING = "protocol.cm_fields_missing"


def _cite(section: str, page: int) -> str:
    return f"§{section}, p. {page}"


def note_cm_missing_fields(
    *, cmtrt: str | None, cmstdtc: str | None, cmendtc: str | None, change: str
) -> list[str]:
    """Required CM fields (protocol §7.7, p. 69) a chart-note CM draft leaves empty."""
    present: set[str] = set()
    if (cmtrt or "").strip():
        present.add("CMTRT")
    if cmstdtc:
        present.add("CMSTDTC")
    if cmendtc:
        present.add("CMENDTC")
    if change in ("started", "taking", "changed") and not cmendtc:
        present.add("CMENDTC")  # still being taken: a stop date is not appropriate yet
    return [f for f in protocol_rules().cm_required_fields if f not in present]


def note_cm_protocol(
    *,
    quote: str,
    drug: str,
    change: str,
    cmstdtc: str | None,
    cmendtc: str | None,
    note_pointer: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    """``(fields, evidence, rules)`` to merge into one chart-note CM draft."""
    flags, notes = classify_conmed(quote, drug)
    flag = flags[0] if flags else None
    missing = note_cm_missing_fields(cmtrt=quote, cmstdtc=cmstdtc, cmendtc=cmendtc, change=change)
    cfg = protocol_rules()
    req_ref = cfg.cm_required_reference.protocol_ref
    req_cite = _cite(req_ref.section, req_ref.printed_page)
    rules: list[dict[str, Any]] = []
    flag_evidence: list[dict[str, Any]] = []
    if flag is not None:
        cite = _cite(flag.protocol_ref.section, flag.protocol_ref.printed_page)
        rule_id = f"{RULE_PREFIX}{flag.level}"
        table_ev = {
            "kind": "table",
            "id": PROTOCOL_TABLE_FILE,
            "ts": None,
            "note": f"conmeds.{flag.level}: {flag.drug} ({cite})",
        }
        flag_evidence = [
            {"kind": "rule", "id": rule_id, "ts": None, "note": f"{flag.drug}: {flag.level}"},
            table_ev,
            note_pointer,
        ]
        if flag.level == "discouraged":
            description = (
                f"Medication '{quote}' in a chart note is {flag.drug}, a systemic corticosteroid "
                f"the protocol recommends avoiding ({cite}) '{flag.exception_text}' Coordinator "
                "to check the reason with the study team; the note's tier is unchanged"
            )
        elif flag.level == "prohibited":
            description = (
                f"Medication '{quote}' in a chart note is {flag.drug}, which the protocol does not "
                f"allow ({cite}: '{flag.quote}'). Possible protocol deviation, coordinator to "
                "confirm (a chart note never raises its own tier above 2, D-017)"
            )
        else:
            description = (
                f"Medication '{quote}' in a chart note is {flag.drug}, which the protocol permits "
                f"({cite}: '{flag.quote}'). No protocol issue"
            )
        rules.append(
            {
                "rule_id": rule_id,
                "category": "protocol",
                "description": description,
                "inputs": {
                    "verbatim": quote,
                    "drug": flag.drug,
                    "level": flag.level,
                    "matched_text": flag.matched_text,
                    "matched_by": flag.matched_by,
                    "protocol_ref": cite,
                    "exception_text": flag.exception_text,
                    "source": "chart_note",
                },
                "effect": f"INTERIM_PROTOCOL_FLAG = {flag.level}; tier unchanged",
                "evidence": [note_pointer, table_ev],
            }
        )
    missing_evidence: list[dict[str, Any]] = [
        {
            "kind": "table",
            "id": PROTOCOL_TABLE_FILE,
            "ts": None,
            "note": f"cm_required_fields ({req_cite})",
        }
    ]
    if missing:
        missing_evidence.insert(
            0, {"kind": "rule", "id": RULE_MISSING, "ts": None, "note": "fields still to collect"}
        )
        rules.append(
            {
                "rule_id": RULE_MISSING,
                "category": "protocol",
                "description": (
                    "The protocol asks for each medication's generic name, dose, dose unit, "
                    f"frequency, indication and start/stop date ({req_cite}). Still missing for "
                    f"'{quote}' (from a chart note): {', '.join(missing)}. Coordinator to ask"
                ),
                "inputs": {"missing": missing, "required": list(cfg.cm_required_fields)},
                "effect": f"INTERIM_CM_MISSING_FIELDS = {missing}",
                "evidence": [note_pointer, missing_evidence[-1]],
            }
        )
    fields: dict[str, Any] = {
        "INTERIM_PROTOCOL_FLAG": flag.level if flag is not None else None,
        "INTERIM_CM_MISSING_FIELDS": missing,
    }
    if notes:
        fields["INTERIM_PROTOCOL_NOTES"] = list(notes)
    evidence: dict[str, list[dict[str, Any]]] = {
        "INTERIM_PROTOCOL_FLAG": flag_evidence,
        "INTERIM_CM_MISSING_FIELDS": missing_evidence,
    }
    if notes:
        evidence["INTERIM_PROTOCOL_NOTES"] = [note_pointer, missing_evidence[-1]]
    return fields, evidence, rules


__all__ = ["note_cm_missing_fields", "note_cm_protocol"]
