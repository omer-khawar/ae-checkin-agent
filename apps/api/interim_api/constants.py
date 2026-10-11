"""Closed vocabularies the API validates against (no clinical numbers here).

* ``VITALS_SOURCES``: the three ``VitalsSource.name`` values of CLAUDE.md §7.1 /
  CONTRACTS.md §1.2. ``POST /sessions/{id}/vitals`` refuses any other ``source``
  so an unknown label can never reach the rules engine, whose measured gate
  only knows how to treat the sources it was told about (``simulated_sources``
  in ``vitals_corroboration.json``; D-022).
* ``MOCK_SCENARIOS``: the mock bridge's scenario names (CLAUDE.md §7.2). The
  bridge keeps the simulation parameters in
  ``apps/vitals-bridge/src/sources/scenarios.ts`` (``SCENARIO_NAMES``); this
  tuple is the API-side twin of that name list and ``tests/test_hardening.py``
  checks the two stay identical. ``PUT /admin/settings`` validates
  ``mock_scenario`` against it so a typo cannot be stored and handed to the
  bridge through ``GET /settings/public``.
"""

from __future__ import annotations

VITALS_SOURCES: tuple[str, ...] = ("mock", "presage", "arduino")
MOCK_SCENARIOS: tuple[str, ...] = (
    "resting",
    "post_exercise",
    "tachypnea",
    "low_quality",
    "dropout",
)
