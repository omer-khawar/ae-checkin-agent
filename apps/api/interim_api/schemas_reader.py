"""Response shapes the second reader adds to the scan / note endpoints (CONTRACTS.md R5.3).

* ``reader`` on a dry-run scan and on a note: ``{status, model, cached, reason}``;
* ``reader_rejected``: the items the verifier refused, each with the reason;
* ``found_by`` on every symptom and medication finding.

The endpoints return plain dicts (like the rest of the note API); these models document and
validate the added keys.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

FoundBy = Literal["scanner", "gemini", "both"]
ReaderStatus = Literal["off", "cache", "live", "error"]


class ReaderInfo(BaseModel):
    """What the second reader did for this text."""

    status: ReaderStatus = "off"
    model: str | None = None
    cached: bool = False
    reason: str | None = Field(
        default=None,
        description="Why the reader was off or failed, or a note such as a model fallback.",
    )


class ReaderRejected(BaseModel):
    """One reader item the verifier did not accept (never becomes a draft)."""

    quote: str
    reason: str
    kind: Literal["symptom", "medication"] = "symptom"
    label: str = ""


class ReaderNote(BaseModel):
    """A verified reader symptom that is listed but never drafted (negated, historical, ...)."""

    term: str
    status: str
    quote: str
    span_start: int
    span_end: int


DEFAULT_READER = ReaderInfo()
