#!/usr/bin/env python3
"""Record the Gemini second reader's answers for every text the demo shows (CONTRACTS.md R5.3).

Why: the committed cache ``data/llm_cache/gemini_reader.json`` lets a clean clone (no API key,
no network) show the second reader. This script fills it. It is a build-time tool: the running
API never needs it, and it is the only place besides a live ``INTERIM_LLM_MODE=auto`` request
that sends text to Google. Every text is SYNTHETIC (seed notes, answer-key cases, Synthea).

What it records (skipping any text whose answer is already cached for the current prompt
version, unless ``--force``):

* every seeded chart note and phone call (``apps/api/interim_api/seed.py`` ``NOTE_SEEDS``);
* every case of ``packages/rules/data/reader_answer_key.json`` (the reader eval);
* the DEMO hypothyroidism note (the exact text of ``docs/DEMO.md`` section 5b);
* with ``--synthea``, the 72 Synthea notes (``data/synthetic/synthea/notes.json``).

Usage::

    .venv/Scripts/python.exe scripts/record_gemini_cache.py --dry-run     # list, no network
    .venv/Scripts/python.exe scripts/record_gemini_cache.py               # record what is missing
    .venv/Scripts/python.exe scripts/record_gemini_cache.py --synthea --force

``GEMINI_API_KEY`` comes from the environment or the repo-root ``.env``; it is loaded without
being printed, and nothing this script prints can contain it. Output is counts and short
labels only, never note text and never an answer.

Exit status: 0 when every wanted text is now cached (or on ``--dry-run``); 1 when any text
could not be recorded; 2 when there is no key to record with.
"""

from __future__ import annotations

import argparse
import dataclasses
import importlib
import json
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
for _p in (REPO / "packages" / "rules", REPO / "apps" / "api"):
    if str(_p) not in sys.path:  # a clean clone without editable installs
        sys.path.insert(0, str(_p))

SYNTHEA_NOTES = REPO / "data" / "synthetic" / "synthea" / "notes.json"

DEMO_HYPO_NOTE = (
    "Clinic follow-up, cycle 4 day 1. Pt reports fatigue, worse over 2 weeks. Denies diarrhea. "
    "No rash. TSH 18.2, free T4 low. Assessment: Hypothyroidism, grade 2, likely immune-related. "
    "Started levothyroxine 50 mcg daily. Continue cemiplimab."
)
"""Exact text of docs/DEMO.md section 5b step 2 (a test keeps the two equal)."""

RETRIES = 2
PAUSE_S = 0.4


@dataclass(frozen=True)
class Target:
    """One text to record."""

    label: str
    kind: str  # "note" | "call"
    text: str


def seed_targets() -> list[Target]:
    """The seeded chart notes and calls, exactly as the seed ingests them."""
    seed: Any = importlib.import_module("interim_api.seed")
    notes: Any = importlib.import_module("interim_api.services.notes")
    cases = seed.note_cases()
    out: list[Target] = []
    for entry in seed.NOTE_SEEDS:
        src = seed._note_source(entry, cases)
        out.append(
            Target(
                f"seed:{entry.note_id}",
                str(notes.reader_kind(src["note_type"])),
                str(src["text"]),
            )
        )
    return out


def answer_key_targets() -> list[Target]:
    from interim_rules import llm_verify

    return [Target(f"key:{c.id}", c.kind, c.text) for c in llm_verify.reader_answer_key()]


def demo_targets() -> list[Target]:
    return [Target("demo:hypothyroidism", "note", DEMO_HYPO_NOTE)]


def synthea_targets(path: Path = SYNTHEA_NOTES) -> list[Target]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [Target(f"synthea:{n['id']}", "note", str(n["text"])) for n in raw["notes"]]


def collect(*, synthea: bool) -> list[Target]:
    """All wanted targets, de-duplicated on (kind, text), first label wins."""
    wanted = [*seed_targets(), *answer_key_targets(), *demo_targets()]
    if synthea:
        wanted += synthea_targets()
    seen: set[tuple[str, str]] = set()
    out: list[Target] = []
    for target in wanted:
        key = (target.kind, target.text)
        if key not in seen:
            seen.add(key)
            out.append(target)
    return out


def main(argv: Sequence[str] | None = None, *, transport: Any = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="list what would be recorded")
    parser.add_argument("--synthea", action="store_true", help="also record the Synthea notes")
    parser.add_argument("--force", action="store_true", help="re-record texts already cached")
    parser.add_argument("--cache-dir", type=Path, help="cache directory (default data/llm_cache)")
    parser.add_argument("--pause", type=float, default=PAUSE_S, help="seconds between calls")
    args = parser.parse_args(argv)

    reader: Any = importlib.import_module("interim_api.readers.gemini_reader")
    cache_mod: Any = importlib.import_module("interim_api.readers.cache")
    config_mod: Any = importlib.import_module("interim_api.readers.config")

    cfg = config_mod.ReaderConfig.from_env()
    cfg = dataclasses.replace(cfg, mode="auto")
    if args.cache_dir is not None:
        cfg = dataclasses.replace(cfg, cache_dir=args.cache_dir)
    cache = cache_mod.ReaderCache(cfg.cache_path)

    targets = collect(synthea=args.synthea)
    todo: list[Target] = []
    cached = 0
    for target in targets:
        key = cache_mod.cache_key(reader.PROMPT_VERSION, target.kind, target.text)
        if cache.get(key) is not None and not args.force:
            cached += 1
        else:
            todo.append(target)

    print(
        f"prompt {reader.PROMPT_VERSION}; model {cfg.model}; {len(targets)} texts "
        f"({cached} already cached, {len(todo)} to record)"
    )
    if args.dry_run:
        for target in todo:
            print(f"  would record {target.label} ({target.kind}, {len(target.text)} chars)")
        return 0
    if not todo:
        print("nothing to record")
        return 0
    if not cfg.api_key:
        print("no GEMINI_API_KEY in the environment or .env: nothing recorded", file=sys.stderr)
        return 2

    recorded = 0
    failed: list[tuple[str, str]] = []
    for index, target in enumerate(todo):
        if index and args.pause > 0:
            time.sleep(args.pause)
        key = cache_mod.cache_key(reader.PROMPT_VERSION, target.kind, target.text)
        previous = cache.get(key) if args.force else None
        if previous is not None:
            cache.drop(key)  # so the call below is live and re-records
        result = None
        for attempt in range(RETRIES + 1):
            result = reader.read(target.text, kind=target.kind, config=cfg, transport=transport)
            if result.status == "live" or "429" not in (result.reason or ""):
                break
            time.sleep(2.0 * (attempt + 1))
        assert result is not None
        if result.status == "live" and cache.get(key) is not None:
            recorded += 1
            continue
        if previous is not None and cache.get(key) is None:
            cache.put(
                key,
                model=previous.model or cfg.model,
                prompt_version=previous.prompt_version or reader.PROMPT_VERSION,
                recorded_at=previous.recorded_at or "",
                response=previous.response,
            )
        why = (
            "answered but the cache file could not be written"
            if result.status == "live"
            else f"{result.status}: {result.reason or 'no reason'}"
        )
        failed.append((target.label, why))
    print(f"recorded {recorded}, failed {len(failed)}, skipped (already cached) {cached}")
    for label, why in failed:
        print(f"  FAILED {label}: {why}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
