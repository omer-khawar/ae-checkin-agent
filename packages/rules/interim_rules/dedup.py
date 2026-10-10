"""De-duplication against open AEs (CLAUDE.md §3.4(h)).

If the participant reports a symptom whose CTCAE term already has an open AE
last reported within ``window_days`` (inclusive) of this check-in, the new
report is linked as a follow-up instead of becoming a new AE. The window lives
in ``data/dedup.json`` and can be overridden per run through ``RuleSettings``.

Two kinds of candidate are skipped, each with a logged reason:

* an open AE whose ``last_session_id`` is the session being evaluated (the
  API loads open AEs before it persists this session's drafts, but a
  re-evaluation of an already-persisted check-in must never link an AE to
  itself);
* an open AE whose last report is dated more than ``max_future_skew_s`` after
  this check-in (both timestamps come from the same server clock, so a larger
  gap is a backdated override or bad data, not an earlier report).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .evidence import rule_evidence, table_evidence
from .models import ItemResult, OpenAE, RuleFired, RuleSettings
from .tables import dedup_config
from .timefmt import parse_iso_utc, seconds_between

DEDUP_TABLE_FILE = "dedup.json"
_SECONDS_PER_DAY = 86_400


@dataclass(frozen=True)
class OpenAESearch:
    """Outcome of looking for an open AE to link: the best candidate and what was skipped."""

    linked: OpenAE | None
    days_since: float | None
    """Days from the linked AE's last report to this check-in (negative within clock skew)."""
    skipped: tuple[tuple[str, str], ...]
    """``(ae_open_id, reason)`` for every same-term open AE that was not eligible."""


@dataclass(frozen=True)
class DedupDecision:
    item_id: str
    aedecod: str
    linked: OpenAE | None
    days_since: float | None
    rule: RuleFired

    @property
    def is_followup(self) -> bool:
        return self.linked is not None


def effective_window_days(settings: RuleSettings) -> int:
    """The window in force: the settings override, else the table default."""
    return (
        settings.dedup_window_days
        if settings.dedup_window_days is not None
        else dedup_config().window_days
    )


def find_open_ae(
    aedecod: str,
    open_aes: Sequence[OpenAE],
    completed_at: str,
    window_days: int,
    *,
    session_id: str | None = None,
    max_future_skew_s: float | None = None,
) -> OpenAESearch:
    """Most recently reported eligible open AE for ``aedecod`` inside the window.

    ``session_id`` excludes AEs last reported by this very session;
    ``max_future_skew_s`` (table default when ``None``) bounds how far in the
    future a candidate's last report may be dated.
    """
    skew = max_future_skew_s if max_future_skew_s is not None else dedup_config().max_future_skew_s
    best: OpenAE | None = None
    best_days: float | None = None
    skipped: list[tuple[str, str]] = []
    for candidate in open_aes:
        if candidate.aedecod != aedecod:
            continue
        if session_id is not None and candidate.last_session_id == session_id:
            skipped.append(
                (candidate.ae_open_id, "last reported by this same session; cannot follow itself")
            )
            continue
        delta_seconds = seconds_between(candidate.last_reported_at, completed_at)
        if delta_seconds < -skew:
            skipped.append(
                (
                    candidate.ae_open_id,
                    f"last reported {-delta_seconds:.0f} s after this check-in "
                    f"(more than the {skew:g} s clock-skew tolerance)",
                )
            )
            continue
        if delta_seconds > window_days * _SECONDS_PER_DAY:
            skipped.append(
                (
                    candidate.ae_open_id,
                    f"last reported {delta_seconds / _SECONDS_PER_DAY:.1f} days ago, "
                    f"outside the {window_days}-day window",
                )
            )
            continue
        if best is None or parse_iso_utc(candidate.last_reported_at) > parse_iso_utc(
            best.last_reported_at
        ):
            best, best_days = candidate, delta_seconds / _SECONDS_PER_DAY
    return OpenAESearch(best, best_days, tuple(skipped))


def decide_dedup(
    graded_items: Sequence[ItemResult],
    open_aes: Sequence[OpenAE],
    completed_at: str,
    settings: RuleSettings,
    grade_rule_ids: dict[str, str],
    session_id: str | None = None,
) -> tuple[DedupDecision, ...]:
    """One decision per graded item (provisional grade >= 1)."""
    window = effective_window_days(settings)
    decisions: list[DedupDecision] = []
    for result in graded_items:
        search = find_open_ae(result.aedecod, open_aes, completed_at, window, session_id=session_id)
        linked, days = search.linked, search.days_since
        skipped = [list(entry) for entry in search.skipped]
        grade_rule = grade_rule_ids.get(result.item_id, f"grade.provisional.{result.item_id}")
        if linked is not None and days is not None:
            rule = RuleFired(
                rule_id="dedup.followup_linked",
                category="dedup",
                description=(
                    f"{result.aedecod} reported again {days:.1f} day(s) after open AE "
                    f"{linked.ae_open_id} (last reported {linked.last_reported_at}, within the "
                    f"{window}-day window) -> follow-up, no new AE"
                ),
                inputs={
                    "item_id": result.item_id,
                    "aedecod": result.aedecod,
                    "ae_open_id": linked.ae_open_id,
                    "first_reported_at": linked.first_reported_at,
                    "last_reported_at": linked.last_reported_at,
                    "last_session_id": linked.last_session_id,
                    "days_since": round(days, 2),
                    "window_days": window,
                    "open_aes_skipped": skipped,
                },
                effect=f"AE draft linked to {linked.ae_open_id}; AESTDTC kept at first report",
                evidence=(
                    rule_evidence(grade_rule, "symptom graded in this check-in"),
                    table_evidence(DEDUP_TABLE_FILE, f"window_days = {window} (inclusive)"),
                ),
            )
        else:
            rule = RuleFired(
                rule_id="dedup.new_ae",
                category="dedup",
                description=(f"{result.aedecod}: no open AE within {window} days -> new AE"),
                inputs={
                    "item_id": result.item_id,
                    "aedecod": result.aedecod,
                    "window_days": window,
                    "open_aes_checked": [
                        ae.ae_open_id for ae in open_aes if ae.aedecod == result.aedecod
                    ],
                    "open_aes_skipped": skipped,
                },
                effect="new AE draft",
                evidence=(
                    rule_evidence(grade_rule, "symptom graded in this check-in"),
                    table_evidence(DEDUP_TABLE_FILE, f"window_days = {window} (inclusive)"),
                ),
            )
        decisions.append(DedupDecision(result.item_id, result.aedecod, linked, days, rule))
    return tuple(decisions)
