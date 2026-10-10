"""ISO-8601 UTC timestamp helpers.

The engine stores and emits timestamps as strings of the form
``YYYY-MM-DDTHH:MM:SS.mmmZ`` (CONTRACTS.md conventions). These helpers are the
only place the package touches :mod:`datetime`, and none of them read the clock.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta


def parse_iso_utc(value: str) -> datetime:
    """Parse an ISO-8601 timestamp into an aware UTC ``datetime``.

    Accepts a trailing ``Z`` or an explicit offset; a naive timestamp is taken
    to be UTC already (the API only ever produces UTC).
    """
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"not an ISO-8601 timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def format_iso_utc(moment: datetime) -> str:
    """Format an aware ``datetime`` as ``YYYY-MM-DDTHH:MM:SS.mmmZ`` (millisecond precision)."""
    utc = moment.astimezone(UTC) if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def normalize_iso(value: str) -> str:
    """Round-trip a timestamp string through parse/format so output is always canonical."""
    return format_iso_utc(parse_iso_utc(value))


def shift(value: str, *, seconds: float = 0.0, hours: float = 0.0, days: float = 0.0) -> str:
    """Return ``value`` moved by the given seconds/hours/days, canonically formatted."""
    delta = timedelta(seconds=seconds, hours=hours, days=days)
    return format_iso_utc(parse_iso_utc(value) + delta)


def iso_date(value: str) -> str:
    """The UTC calendar date (``YYYY-MM-DD``) of a timestamp, for SDTM date-only variables."""
    return parse_iso_utc(value).date().isoformat()


def seconds_between(earlier: str, later: str) -> float:
    """``later - earlier`` in seconds (negative when ``later`` is actually earlier)."""
    return (parse_iso_utc(later) - parse_iso_utc(earlier)).total_seconds()
