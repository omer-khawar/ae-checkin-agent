#!/usr/bin/env python3
"""Seed the Interim demo database (thin wrapper around ``interim_api.seed``).

    python scripts/seed.py            # seed an empty database (no-op if already seeded)
    python scripts/seed.py --reset    # wipe every table and reseed
    python scripts/seed.py --database-url sqlite:///./data/runtime/other.db

The seed goes through the API's service layer, so every seeded participant,
answer, vitals sample, draft, escalation and confirmation is an audited event,
exactly as if it had come from the kiosk, and the eight synthetic chart notes
(``data/synthetic/chart_notes.json``) are ingested through the ``/notes``
service exactly as a coordinator would post them (backdated, re-anchored to
the seed clock). The spec for what gets created is ``data/synthetic/README.md``
(§4.3 check-ins, §4.6 notes); the profile and note tables live in
``apps/api/interim_api/seed.py``. All participants are synthetic.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _import_seed_main():  # type: ignore[no-untyped-def]
    try:
        from interim_api.seed import main
    except ModuleNotFoundError:
        # Fallback when apps/api is not pip-installed: import it from the source tree.
        sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))
        sys.path.insert(0, str(REPO_ROOT / "packages" / "rules"))
        from interim_api.seed import main
    return main


if __name__ == "__main__":
    sys.exit(_import_seed_main()())
