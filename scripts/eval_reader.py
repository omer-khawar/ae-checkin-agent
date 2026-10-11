#!/usr/bin/env python3
"""Evaluate the Gemini second reader against ``reader_answer_key.json`` (CONTRACTS.md R5.3).

Gemini reads, rules decide, people confirm. This script asks the narrow question the reader
exists for: **what does it add that the deterministic scanner misses, and does it add anything
wrong?** For every case of ``packages/rules/data/reader_answer_key.json`` it scores two sides:

* **scanner only**: ``interim_rules.chartscan.scan_text`` (no model, today's behavior);
* **scanner + reader**: the same scan plus the reader's RECORDED answer
  (``data/llm_cache/gemini_reader.json``), verified word for word by ``llm_verify`` and merged
  additively. Replay only: this script never reads an API key and never touches the network.
  A case with no recorded answer is reported as "not recorded yet", never silently scored as
  zero or as a pass (``scripts/record_gemini_cache.py`` records them).

Scored per case: expected symptoms found (term; the quote must overlap the expected text; the
grade, when the key gives one, must equal the rules' provisional grade), expected medications
found (drug and change), forbidden (negated) terms that wrongly became side effects, and any
other kept symptom the key does not list (a false positive).

The key is TWO cases written by the team after the playtest: a smoke test, not an accuracy
estimate, and the document says so. The scanner's own accuracy lives in
``docs/eval/synthea_results.md`` and the 43-case chart-scan key.

Usage::

    .venv/Scripts/python.exe scripts/eval_reader.py            # writes docs/eval/reader_results.md
    .venv/Scripts/python.exe scripts/eval_reader.py --check    # recompute and compare

The output has no clock and no git commit; it changes only when the key, the cache, the prompt
version or the scoring changes. Exit status: 0; 1 when the scanner-only side contradicts the
key's own ``scanner_finds`` flags (the key is wrong) or ``--check`` finds a stale file; 2 when
``--strict-reader`` is given and any case has no recorded answer.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
for _p in (REPO / "packages" / "rules", REPO / "apps" / "api"):
    if str(_p) not in sys.path:  # a clean clone without editable installs
        sys.path.insert(0, str(_p))

from interim_rules import chartscan, llm_verify  # noqa: E402
from interim_rules.tables import data_dir  # noqa: E402

DEFAULT_OUT = REPO / "docs" / "eval" / "reader_results.md"
KEY_FILE = "reader_answer_key.json"
NOT_RECORDED = "not recorded yet"


# --------------------------------------------------------------------------------------
# Scoring (pure)
# --------------------------------------------------------------------------------------


@dataclass
class SideScore:
    """One side (scanner only, or scanner + reader) over one case."""

    recorded: bool = True
    symptom_expected: int = 0
    symptom_found: int = 0
    grade_expected: int = 0
    grade_right: int = 0
    med_expected: int = 0
    med_found: int = 0
    forbidden_hits: list[str] = field(default_factory=list)
    extra_terms: list[str] = field(default_factory=list)
    kept_symptoms: list[str] = field(default_factory=list)
    kept_meds: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    wrong_grade: list[str] = field(default_factory=list)
    found_by: dict[str, str] = field(default_factory=dict)


def _overlaps(start: int, end: int, other: tuple[int, int]) -> bool:
    return start < other[1] and other[0] < end


def score_side(
    case: llm_verify.ReaderCase,
    result: chartscan.ScanResult,
    found_by: dict[str, str] | None = None,
) -> SideScore:
    """Score the kept findings of ``result`` against the case's expectations."""
    side = SideScore(found_by=dict(found_by or {}))
    folded = case.text.casefold()
    expected_terms = {e.term for e in case.symptoms}
    for exp in case.symptoms:
        side.symptom_expected += 1
        if exp.grade is not None:
            side.grade_expected += 1  # a missed finding cannot have the right grade
        at = folded.find(exp.quote_contains.casefold())
        span = (at, at + len(exp.quote_contains)) if at >= 0 else (0, len(case.text))
        hits = [s for s in result.symptoms if s.term == exp.term]
        match = next((s for s in hits if _overlaps(s.span_start, s.span_end, span)), None)
        if match is None:
            side.missing.append(exp.term)
            continue
        side.symptom_found += 1
        if exp.grade is not None:
            if match.grade_hint == exp.grade:
                side.grade_right += 1
            else:
                side.wrong_grade.append(f"{exp.term}: expected {exp.grade}, got {match.grade_hint}")
    for exp_med in case.meds:
        side.med_expected += 1
        if any(m.drug == exp_med.drug and str(m.change) == exp_med.change for m in result.meds):
            side.med_found += 1
        else:
            side.missing.append(exp_med.drug)
    forbidden = {t.casefold() for t in case.forbidden_terms}
    for s in result.symptoms:
        if s.term.casefold() in forbidden:
            side.forbidden_hits.append(s.term)
        elif s.term not in expected_terms:
            side.extra_terms.append(s.term)
    side.kept_symptoms = sorted({s.term for s in result.symptoms})
    side.kept_meds = sorted({m.drug for m in result.meds})
    return side


def scanner_flags_hold(case: llm_verify.ReaderCase, side: SideScore) -> list[str]:
    """Contradictions between the key's ``scanner_finds`` flags and the scanner-only result."""
    problems: list[str] = []
    missed = set(side.missing)
    for exp in case.symptoms:
        found = exp.term not in missed
        if found != exp.scanner_finds:
            problems.append(f"{case.id}: {exp.term} scanner_finds={exp.scanner_finds}, got {found}")
    for exp_med in case.meds:
        found = exp_med.drug not in missed
        if found != exp_med.scanner_finds:
            problems.append(
                f"{case.id}: {exp_med.drug} scanner_finds={exp_med.scanner_finds}, got {found}"
            )
    return problems


@dataclass
class CaseReport:
    case: llm_verify.ReaderCase
    scanner: SideScore
    combined: SideScore
    reader_status: str
    reader_model: str | None
    reader_note: str | None
    added: list[str] = field(default_factory=list)
    rejected: list[tuple[str, str]] = field(default_factory=list)
    listed: list[str] = field(default_factory=list)


def evaluate_case(
    case: llm_verify.ReaderCase, reader: Any, config: Any
) -> CaseReport:  # reader: gemini_reader module, config: ReaderConfig
    ref = date.fromisoformat(case.note_date)
    scan = chartscan.scan_text(case.text, ref)
    scanner_side = score_side(case, scan)
    answer = reader.read(case.text, kind=case.kind, note_date=ref, config=config)
    if not answer.usable or answer.raw is None:
        return CaseReport(
            case,
            scanner_side,
            SideScore(recorded=False),
            answer.status,
            answer.model,
            answer.reason,
        )
    verified = llm_verify.verify(case.text, answer.raw)
    merged = llm_verify.merge(case.text, scan, verified, ref_date=ref)
    found_by = {
        **merged.symptom_found_by,
        **{f"med:{k}": v for k, v in merged.med_found_by.items()},
    }
    combined = score_side(case, merged.result, dict(found_by))
    added = [f"{s.term} (found by Gemini)" for s in merged.reader_symptoms] + [
        f"{m.drug} {m.change} (found by Gemini)" for m in merged.reader_meds
    ]
    return CaseReport(
        case,
        scanner_side,
        combined,
        answer.status,
        answer.model,
        answer.reason,
        added=added,
        rejected=[(r.quote, r.reason) for r in merged.rejected],
        listed=[f"{n.term} ({n.status}): {n.quote}" for n in merged.notes],
    )


# --------------------------------------------------------------------------------------
# Document
# --------------------------------------------------------------------------------------


def _pct(num: int, den: int) -> str:
    return "n/a" if den == 0 else f"{num}/{den} ({100.0 * num / den:.0f}%)"


def _side_cell(side: SideScore, getter: str) -> str:
    if not side.recorded:
        return NOT_RECORDED
    pairs = {
        "symptoms": (side.symptom_found, side.symptom_expected),
        "grades": (side.grade_right, side.grade_expected),
        "meds": (side.med_found, side.med_expected),
    }
    return _pct(*pairs[getter])


def _sum(sides: Sequence[SideScore], attr: str) -> int:
    return sum(int(getattr(s, attr)) for s in sides)


def _list(items: Sequence[str]) -> str:
    return ", ".join(items) if items else "none"


def render(
    reports: Sequence[CaseReport], *, key_sha: str, prompt_version: str, cache_n: int
) -> str:
    lines: list[str] = []
    out = lines.append
    recorded = [r for r in reports if r.combined.recorded]
    scanner_sides = [r.scanner for r in reports]
    combined_sides = [r.combined for r in recorded]
    out("# Second-reader evaluation (Gemini)")
    out("")
    out(
        "> **Gemini reads, rules decide, people confirm. Nothing is accepted without a "
        "word-for-word quote.** Both texts are SYNTHETIC. Generated by "
        "`scripts/eval_reader.py`; do not edit by hand. `eval_reader.py --check` recomputes "
        "this file. Replay only: no API key is read and no network is used."
    )
    out("")
    out("## What this is, and is not")
    out("")
    out(
        f"The key (`packages/rules/data/{KEY_FILE}`) holds **{len(reports)} cases** written by "
        "the team after the playtest. That is a **smoke test, not an accuracy estimate**: it "
        "shows the reader can add a finding the scanner cannot reach, with its quote, and that "
        "negated mentions do not become side effects. It does not say how often it will. The "
        "scanner's own accuracy is measured on the 43-case chart-scan key and on Synthea "
        "(`docs/eval/synthea_results.md`), with no model involved."
    )
    out("")
    out("## Headline")
    out("")
    out("| Measure | Scanner only | Scanner + reader (recorded answers) |")
    out("|---|---|---|")
    n_rec = len(recorded)
    comb_note = f"{n_rec}/{len(reports)} cases have a recorded answer"
    for label, attr_pair in (
        ("Expected side effects found", ("symptom_found", "symptom_expected")),
        ("Grades equal to the key (rules grade them)", ("grade_right", "grade_expected")),
        ("Expected medication changes found", ("med_found", "med_expected")),
    ):
        s_den = _sum(scanner_sides, attr_pair[1])
        s_num = _sum(scanner_sides, attr_pair[0])
        if recorded:
            c_num = _sum(combined_sides, attr_pair[0])
            c_den = _sum(combined_sides, attr_pair[1])
            sc_num = _sum([r.scanner for r in recorded], attr_pair[0])
            sc_den = _sum([r.scanner for r in recorded], attr_pair[1])
            same = (
                f" (scanner on the same {n_rec}: {_pct(sc_num, sc_den)})"
                if n_rec != len(reports)
                else ""
            )
            out(f"| {label} | {_pct(s_num, s_den)} | {_pct(c_num, c_den)}{same} |")
        else:
            out(f"| {label} | {_pct(s_num, s_den)} | {NOT_RECORDED} |")
    forb_s = sum(len(s.forbidden_hits) for s in scanner_sides)
    extra_s = sum(len(s.extra_terms) for s in scanner_sides)
    if recorded:
        forb_c = sum(len(s.forbidden_hits) for s in combined_sides)
        extra_c = sum(len(s.extra_terms) for s in combined_sides)
        out(f"| Negated terms wrongly kept as side effects (want 0) | {forb_s} | {forb_c} |")
        out(f"| Other kept side effects not in the key | {extra_s} | {extra_c} |")
    else:
        out(f"| Negated terms wrongly kept as side effects (want 0) | {forb_s} | {NOT_RECORDED} |")
        out(f"| Other kept side effects not in the key | {extra_s} | {NOT_RECORDED} |")
    out("")
    out(f"Reader status: {comb_note}.")
    if len(recorded) != len(reports):
        missing = ", ".join(r.case.id for r in reports if not r.combined.recorded)
        out("")
        out(
            f"**Not recorded yet:** {missing}. Run `scripts/record_gemini_cache.py` with a "
            "`GEMINI_API_KEY` (it records every key case), then regenerate this file. Until then "
            "the right-hand column is empty on purpose; a missing answer is never scored."
        )
    out("")
    out("## Cases")
    for r in reports:
        c = r.case
        out("")
        out(f"### {c.id} ({'phone-call summary' if c.kind == 'call' else 'chart note'})")
        out("")
        out(f"> {c.text}")
        out("")
        out("| | Scanner only | Scanner + reader |")
        out("|---|---|---|")
        out(
            f"| Expected side effects found | {_side_cell(r.scanner, 'symptoms')} | "
            f"{_side_cell(r.combined, 'symptoms')} |"
        )
        out(
            f"| Grades equal to the key | {_side_cell(r.scanner, 'grades')} | "
            f"{_side_cell(r.combined, 'grades')} |"
        )
        out(
            f"| Expected medication changes found | {_side_cell(r.scanner, 'meds')} | "
            f"{_side_cell(r.combined, 'meds')} |"
        )
        comb = r.combined
        out(
            f"| Kept side effects | {_list(r.scanner.kept_symptoms)} | "
            f"{_list(comb.kept_symptoms) if comb.recorded else NOT_RECORDED} |"
        )
        out(
            f"| Kept medications | {_list(r.scanner.kept_meds)} | "
            f"{_list(comb.kept_meds) if comb.recorded else NOT_RECORDED} |"
        )
        out(
            f"| Missed | {_list(r.scanner.missing)} | "
            f"{_list(comb.missing) if comb.recorded else NOT_RECORDED} |"
        )
        out(
            f"| Negated terms wrongly kept | {_list(r.scanner.forbidden_hits)} | "
            f"{_list(comb.forbidden_hits) if comb.recorded else NOT_RECORDED} |"
        )
        out("")
        if comb.recorded:
            model = r.reader_model or "unknown model"
            out(f"Reader: recorded answer from `{model}`.")
            out("")
            out(f"- Added by the reader: {_list(r.added)}")
            out(f"- Listed only (not drafted): {_list(r.listed)}")
            if r.rejected:
                out("- Rejected by the quote check:")
                for quote, reason in r.rejected:
                    out(f"  - `{quote}`: {reason}")
            else:
                out("- Rejected by the quote check: none")
            if comb.wrong_grade:
                out(f"- Grade differences: {_list(comb.wrong_grade)}")
        else:
            out(f"Reader: {NOT_RECORDED} ({r.reader_status}: {r.reader_note or 'no reason'}).")
    out("")
    out("## Provenance")
    out("")
    out("| Input | Value |")
    out("|---|---|")
    out(f"| Answer key | `packages/rules/data/{KEY_FILE}` sha256 `{key_sha}` |")
    out(f"| Prompt version (cache key) | `{prompt_version}` |")
    out(f"| Cache | `data/llm_cache/gemini_reader.json`, {cache_n} recorded answers |")
    out("| Mode | replay (never network, never a key) |")
    out("")
    out(
        "Grades and tiers always come from the rules. The reader supplies a term and a quote "
        "(and a count when the quote has a number); a finding without a verbatim quote is "
        "rejected and listed above."
    )
    out("")
    return "\n".join(lines)


def build(cache_dir: Path | None = None) -> tuple[str, list[str], int]:
    """``(markdown, scanner-flag problems, n cases without a recorded answer)``."""
    reader: Any = importlib.import_module("interim_api.readers.gemini_reader")
    config_mod: Any = importlib.import_module("interim_api.readers.config")
    cache_mod: Any = importlib.import_module("interim_api.readers.cache")
    cfg = config_mod.ReaderConfig(mode="replay")
    if cache_dir is not None:
        cfg = config_mod.ReaderConfig(mode="replay", cache_dir=cache_dir)
    cases = llm_verify.reader_answer_key()
    reports = [evaluate_case(c, reader, cfg) for c in cases]
    problems = [p for r in reports for p in scanner_flags_hold(r.case, r.scanner)]
    key_sha = hashlib.sha256((data_dir() / KEY_FILE).read_bytes()).hexdigest()
    doc = render(
        reports,
        key_sha=key_sha,
        prompt_version=str(reader.PROMPT_VERSION),
        cache_n=len(cache_mod.ReaderCache(cfg.cache_path)),
    )
    return doc, problems, sum(1 for r in reports if not r.combined.recorded)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--cache-dir", type=Path, help="directory holding gemini_reader.json")
    parser.add_argument("--check", action="store_true", help="compare with the committed file")
    parser.add_argument("--strict-reader", action="store_true", help="fail on unrecorded cases")
    args = parser.parse_args(argv)
    doc, problems, unrecorded = build(args.cache_dir)
    for problem in problems:
        print(f"key contradiction: {problem}", file=sys.stderr)
    if args.check:
        have = args.out.read_text(encoding="utf-8").replace("\r\n", "\n")
        if have != doc:
            print(f"check: {args.out} is stale; run scripts/eval_reader.py", file=sys.stderr)
            return 1
        print(f"check: OK, {args.out} is byte-identical to a fresh run")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(doc, encoding="utf-8", newline="\n")
        print(f"wrote {args.out} ({len(doc):,} bytes); {unrecorded} case(s) not recorded yet")
    if problems:
        return 1
    return 2 if args.strict_reader and unrecorded else 0


if __name__ == "__main__":
    raise SystemExit(main())
