"""Interim API (``interim_api``): the system of record.

FastAPI service that:

* runs kiosk check-ins (sessions, answers, gates, vitals) through the pure
  ``interim_rules`` engine on completion and persists what came out of it
  (drafts, open AEs, escalations, SAE clocks, pages);
* keeps an append-only, hash-chained audit log (ALCOA+) that ``GET /audit/verify``
  recomputes end to end;
* serves the coordinator dashboard (queue, check-in detail with evidence,
  timelines, draft review, escalations, SAE clocks, exports, mock EDC, eval);
* seeds a demo study with twelve synthetic participants through the very same
  service layer a live kiosk uses, so every seeded fact is audited and drafted.

No LLM, no generative component, no network calls at runtime. Entry point:
``uvicorn interim_api.main:app``.
"""

from interim_rules import INTERIM_VERSION

API_VERSION = INTERIM_VERSION
"""Exports and the bundle manifest carry this (CONTRACTS.md §7)."""

__all__ = ["API_VERSION"]
