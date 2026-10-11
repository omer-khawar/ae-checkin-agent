"""Deterministic concomitant-medication matcher (CLAUDE.md §3.4(g), CONTRACTS.md §1.7).

The verbatim text the participant typed is never altered. For matching only,
it is stripped, whitespace-collapsed and lower-cased, then compared against the
bundled list (``data/medlist.json``, NOT RxNorm) in this order:

1. exact (the text as typed equals an entry name),
2. case-insensitive,
3. Levenshtein distance <= ``max_levenshtein_distance`` (ties -> shortest name,
   then alphabetical), kept only when its confidence
   ``1 - distance / max(len(input), len(name))`` reaches
   ``min_levenshtein_confidence``; a near-miss below the floor is reported as
   unmatched with the nearest names still listed for the coordinator.

Multi-word input tries the whole string first, then each whitespace token of at
least ``min_token_length`` characters, and keeps the best result. The match
returns the entry's *generic* name so brands normalize (``claritin`` ->
``loratadine``). Nothing else: no stemming, no NLP. All parameters live in
``data/conmed_matching.json``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from .evidence import gate_evidence, table_evidence
from .models import ConMedEntry, ConMedMatch, GateAnswers, MatchKind, RuleFired
from .tables import (
    ConMedMatchingConfig,
    MedEntry,
    MedList,
    conmed_matching_config,
    load_table,
    medlist,
)

MEDLIST_FILE = "medlist.json"
MATCHING_TABLE_FILE = "conmed_matching.json"

_KIND_RANK: dict[MatchKind, int] = {
    "exact": 0,
    "case_insensitive": 1,
    "levenshtein": 2,
    "unmatched": 3,
}


@lru_cache(maxsize=1)
def _split_config() -> tuple[re.Pattern[str], int, int]:
    """Separator pattern, entry cap and per-entry character cap from ``conmed_matching.json``."""
    cfg: dict[str, Any] = load_table("conmed_matching")["split"]
    pattern = re.compile("|".join(re.escape(sep) for sep in cfg["separators"]), re.IGNORECASE)
    return pattern, int(cfg["max_entries"]), int(cfg["max_entry_chars"])


def split_conmed_text(text: str) -> list[str]:
    """Split one box of typed text into one piece per medicine (R5.2).

    Separators are commas, semicolons and the words ``and`` / ``&`` / ``+`` (table:
    ``conmed_matching.json`` ``split``). Empty pieces are dropped; a text with no separator
    comes back whole, exactly as typed. Pieces are stripped, never otherwise altered.
    """
    pattern, max_entries, _ = _split_config()
    pieces = [p.strip() for p in pattern.split(text)]
    pieces = [p for p in pieces if p]
    if not pieces:
        return [text]
    if len(pieces) > max_entries:
        head = pieces[: max_entries - 1]
        head.append(", ".join(pieces[max_entries - 1 :]))
        return head
    return pieces


def conmed_entries(gates: GateAnswers) -> tuple[ConMedEntry, ...]:
    """The medications to match and draft, in order (empty when no change was reported).

    ``gates.conmeds`` (several medications from the kiosk) is the source of truth. Otherwise
    the single ``conmed_text`` is split by :func:`split_conmed_text`, every piece sharing the
    direction and the one gate answer id. A reported change with no name typed still yields
    one empty entry so the coordinator is asked, never silently dropped.
    """
    if not gates.conmed_changed:
        return ()
    if gates.conmeds:
        return gates.conmeds
    text = gates.conmed_text or ""
    if not text.strip():
        return (ConMedEntry(text, gates.conmed_direction, gates.conmed_answer_id),)
    return tuple(
        ConMedEntry(piece, gates.conmed_direction, gates.conmed_answer_id)
        for piece in split_conmed_text(text)
    )


def levenshtein(a: str, b: str) -> int:
    """Classic edit distance (insert / delete / substitute, each cost 1), two-row DP."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(
                min(
                    previous[j] + 1,  # deletion
                    current[j - 1] + 1,  # insertion
                    previous[j - 1] + (ca != cb),  # substitution
                )
            )
        previous = current
    return previous[-1]


def normalize(text: str) -> str:
    """Strip and collapse whitespace (case is preserved so 'exact' keeps its meaning)."""
    return " ".join(text.split())


def levenshtein_confidence(text: str, name: str, distance: int) -> float:
    """``round(1 - d / max(len(input), len(candidate)), 2)`` (CONTRACTS.md §1.7)."""
    return round(1 - distance / max(len(text), len(name)), 2)


@dataclass(frozen=True)
class _Candidate:
    """Best match for one input candidate string (the whole text or one token).

    For an ``unmatched`` candidate ``distance`` is the distance to the nearest
    list entry (so the coordinator is shown the neighbours of the closest token)
    and ``entry`` is ``None``.
    """

    text: str
    kind: MatchKind
    entry: MedEntry | None
    distance: int | None
    confidence: float

    @property
    def sort_key(self) -> tuple[int, int]:
        """Better match kind first, then smaller distance. ``min`` is stable, so on an equal
        key the earlier candidate (the whole string before any token) wins."""
        return (_KIND_RANK[self.kind], self.distance if self.distance is not None else 10**6)


def _nearest(lowered: str, entries: tuple[MedEntry, ...]) -> list[tuple[MedEntry, int]]:
    """Every entry with its distance to ``lowered``; best first (distance, shortest, A-Z)."""
    scored = [(entry, levenshtein(lowered, entry.name)) for entry in entries]
    scored.sort(key=lambda pair: (pair[1], len(pair[0].name), pair[0].name))
    return scored


def _match_one(text: str, entries: tuple[MedEntry, ...], cfg: ConMedMatchingConfig) -> _Candidate:
    lowered = text.lower()
    by_name = {entry.name: entry for entry in entries}
    if text in by_name:
        return _Candidate(text, "exact", by_name[text], 0, 1.0)
    if lowered in by_name:
        return _Candidate(text, "case_insensitive", by_name[lowered], 0, 1.0)
    nearest = _nearest(lowered, entries)
    if not nearest:
        return _Candidate(text, "unmatched", None, None, 0.0)
    entry, distance = nearest[0]
    if distance <= cfg.max_levenshtein_distance:
        confidence = levenshtein_confidence(lowered, entry.name, distance)
        if confidence >= cfg.min_levenshtein_confidence:
            return _Candidate(text, "levenshtein", entry, distance, confidence)
    # Either too far, or within reach but below the confidence floor: unmatched, but
    # remember how close it was so the nearest names shown are the most useful ones.
    return _Candidate(text, "unmatched", None, distance, 0.0)


def match_conmed(text: str, medications: MedList | None = None) -> ConMedMatch:
    """Match the verbatim medication text; see the module docstring for the algorithm."""
    cfg = conmed_matching_config()
    meds = medications if medications is not None else medlist()
    entries = meds.entries
    normalized = normalize(text)
    if not normalized:
        return ConMedMatch(text, None, "unmatched", 0.0, None, ())

    inputs = [normalized]
    tokens = normalized.split(" ")
    if len(tokens) > 1:
        inputs.extend(tok for tok in tokens if len(tok) >= cfg.min_token_length)

    candidates = [_match_one(candidate, entries, cfg) for candidate in inputs]
    best = min(candidates, key=lambda c: c.sort_key)  # stable: the whole string wins ties

    nearest = _nearest(best.text.lower(), entries)[: cfg.top_candidates]
    top = tuple((entry.name, distance) for entry, distance in nearest)

    if best.kind == "unmatched" or best.entry is None:
        return ConMedMatch(text, None, "unmatched", 0.0, None, top)
    if best.kind == "levenshtein":
        return ConMedMatch(
            text, best.entry.generic, "levenshtein", best.confidence, best.distance, top
        )
    return ConMedMatch(text, best.entry.generic, best.kind, 1.0, 0, top)


def _unmatched_description(match: ConMedMatch, cfg: ConMedMatchingConfig) -> str:
    nearest = ", ".join(f"{name} (d={distance})" for name, distance in match.candidates)
    description = (
        f"Con-med '{match.verbatim}' did not match the bundled list; kept verbatim for the "
        f"coordinator (nearest: {nearest or 'none'})"
    )
    if match.candidates and match.candidates[0][1] <= cfg.max_levenshtein_distance:
        description += (
            f"; the nearest name is within edit distance {cfg.max_levenshtein_distance} but "
            f"below the confidence floor {cfg.min_levenshtein_confidence:g}, so it is not proposed"
        )
    return description


def conmed_rule(match: ConMedMatch, conmed_answer_id: str) -> RuleFired:
    """Explain a match as a ``conmed.<kind>`` rule."""
    cfg = conmed_matching_config()
    if not match.verbatim.strip():
        # The participant said a medication changed but typed no name: still a reported
        # change, so it is drafted and flagged rather than silently dropped.
        description = (
            "Con-med: a medication change was reported but no medication name was typed; "
            "kept empty for the coordinator to ask the participant"
        )
        effect = "CMDECOD = null; CMTRT empty; flagged for coordinator"
    elif match.match_kind == "unmatched":
        description = _unmatched_description(match, cfg)
        effect = "CMDECOD = null; flagged for coordinator"
    elif match.match_kind == "levenshtein":
        description = (
            f"Con-med '{match.verbatim}' matched to '{match.matched_name}' at edit distance "
            f"{match.distance} (confidence {match.confidence})"
        )
        effect = f"CMDECOD = {match.matched_name} (confidence {match.confidence})"
    else:
        how = "exactly" if match.match_kind == "exact" else "case-insensitively"
        description = (
            f"Con-med '{match.verbatim}' matched {how} to '{match.matched_name}' "
            f"(confidence {match.confidence})"
        )
        effect = f"CMDECOD = {match.matched_name} (confidence {match.confidence})"
    return RuleFired(
        rule_id=f"conmed.{match.match_kind}",
        category="conmed",
        description=description,
        inputs={
            "verbatim": match.verbatim,
            "matched_name": match.matched_name,
            "match_kind": match.match_kind,
            "confidence": match.confidence,
            "distance": match.distance,
            "candidates": [list(c) for c in match.candidates],
            "max_levenshtein_distance": cfg.max_levenshtein_distance,
            "min_levenshtein_confidence": cfg.min_levenshtein_confidence,
        },
        effect=effect,
        evidence=(
            gate_evidence(conmed_answer_id, f"conmed_text = '{match.verbatim}' (verbatim)"),
            table_evidence(MEDLIST_FILE, "bundled medication list (NOT RxNorm)"),
            table_evidence(
                MATCHING_TABLE_FILE,
                f"Levenshtein <= {cfg.max_levenshtein_distance}, confidence floor "
                f"{cfg.min_levenshtein_confidence:g}",
            ),
        ),
    )
