"""Glue between the reader's raw answer and the scan (CONTRACTS.md R5.3).

``apply_reader`` verifies the answer with ``interim_rules.llm_verify`` and merges the verified
findings additively into the scanner's result. It touches no database and no network, so it is
safe to call while a write lock is held; the *model call itself* (``gemini_reader.read``) is
made earlier, in the router, outside the lock.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from interim_rules import chartscan, llm_verify

from ..schemas_reader import ReaderInfo, ReaderNote, ReaderRejected
from .gemini_reader import PROMPT_VERSION, ReaderResult


@dataclass
class ReaderOutcome:
    """The reader's contribution to one scan."""

    result: chartscan.ScanResult
    """The scanner's result plus the reader's verified additions (the scanner's own when the
    reader was off or found nothing new)."""
    info: dict[str, Any]
    rejected: list[dict[str, Any]] = field(default_factory=list)
    notes: list[dict[str, Any]] = field(default_factory=list)
    merge: llm_verify.ReaderMerge | None = None
    reader: ReaderResult | None = None

    @property
    def used(self) -> bool:
        """True when a recorded or live answer was verified and merged."""
        return self.merge is not None

    def symptom_found_by(self, term: str) -> str:
        return self.merge.symptom_found_by.get(term, "scanner") if self.merge else "scanner"

    def med_found_by(self, drug: str) -> str:
        return self.merge.med_found_by.get(drug, "scanner") if self.merge else "scanner"

    def reader_meta(self) -> dict[str, Any] | None:
        """The ``reader`` block of an evidence pointer: ``{model, prompt_version, cached}``."""
        if self.reader is None or not self.used:
            return None
        return {
            "model": self.reader.model,
            "prompt_version": PROMPT_VERSION,
            "cached": self.reader.cached,
        }

    def reader_rules(self) -> list[dict[str, object]]:
        return llm_verify.reader_rules_fired(self.merge) if self.merge else []

    def counts(self) -> dict[str, int]:
        merge = self.merge
        return {
            "n_added_symptoms": len(merge.reader_symptoms) if merge else 0,
            "n_added_meds": len(merge.reader_meds) if merge else 0,
            "n_both": merge.n_both if merge else 0,
            "n_listed": len(merge.notes) if merge else 0,
            "n_rejected": len(self.rejected),
        }

    def scan_dict(self) -> dict[str, Any]:
        """``scan_result_to_dict`` of the merged result with ``found_by`` on every finding."""
        return llm_verify.apply_found_by(chartscan.scan_result_to_dict(self.result), self.merge)

    def annotate_scanner_rules(self, rules: list[dict[str, Any]]) -> None:
        """Mark a scanner rule firing whose finding the reader also found (``found_by``)."""
        if self.merge is None:
            return
        for rule in rules:
            inputs = rule.get("inputs")
            if not isinstance(inputs, dict):
                continue
            if rule.get("rule_id") == chartscan.RULE_SYMPTOM:
                inputs["found_by"] = self.symptom_found_by(str(inputs.get("term")))
            elif rule.get("rule_id") == chartscan.RULE_MED:
                inputs["found_by"] = self.med_found_by(str(inputs.get("drug")))

    def stored(self) -> dict[str, Any]:
        """The keys saved next to the scan (and returned by the note detail)."""
        return {
            "reader": self.info,
            "reader_rejected": self.rejected,
            "reader_notes": self.notes,
        }


def apply_reader(
    text: str,
    scan: chartscan.ScanResult,
    reader: ReaderResult | None,
    *,
    ref_date: date | None = None,
) -> ReaderOutcome:
    """Verify ``reader``'s answer against ``text`` and merge it into ``scan`` (additively)."""
    if reader is None:
        return ReaderOutcome(
            scan, ReaderInfo(reason="the second reader was not called").model_dump()
        )
    info = ReaderInfo(**reader.info()).model_dump()
    if not reader.usable or reader.raw is None:
        return ReaderOutcome(scan, info, reader=reader)
    verified = llm_verify.verify(text, reader.raw)
    merged = llm_verify.merge(text, scan, verified, ref_date=ref_date)
    rejected = [
        ReaderRejected(**r).model_dump() for r in llm_verify.rejection_dicts(merged.rejected)
    ]
    notes = [ReaderNote(**n).model_dump() for n in llm_verify.reader_note_dicts(merged.notes)]
    return ReaderOutcome(merged.result, info, rejected, notes, merged, reader)
