"""Read-only reference data for the investigator screen.

* ``GET /reference/label``: the LIBTAYO adverse-reactions text from the cached
  openFDA label (``data/public/libtayo_label_excerpt.json``). Shown collapsed
  beside the attribution controls as "reference safety information (public
  label excerpt)". Never parsed, never used by the rules.
* ``GET /reference/ctcae``: the ten CTCAE v5.0 term rows the instrument uses
  (``packages/rules/data/ctcae_terms.json``), with the mock MedDRA codes
  labeled as such.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from interim_rules.tables import ctcae_terms

from ..problems import problem

LABEL_FILE = "libtayo_label_excerpt.json"
LABEL_NOTE = "public label excerpt, reference only"


def load_label(public_dir: Path, *, section: str = "adverse_reactions") -> dict[str, Any]:
    path = public_dir / LABEL_FILE
    if not path.is_file():
        raise problem(
            404,
            f"{path.name} is not in {public_dir}; run `python scripts/fetch_public.py --offline`",
            title="Label excerpt unavailable",
        )
    with path.open(encoding="utf-8") as fh:
        raw = json.load(fh)
    sections = raw.get("sections") or {}
    text = sections.get(section)
    return {
        "drug": raw.get("drug", "LIBTAYO (cemiplimab-rwlc)"),
        "section": section,
        "text": text,
        "sections_available": sorted(k for k, v in sections.items() if v),
        "source_url": raw.get("source_url"),
        "fetched_at": raw.get("fetched_at"),
        "fetched": raw.get("fetched", False),
        "effective_date": raw.get("effective_date"),
        "license_note": raw.get("license_note"),
        "note": LABEL_NOTE
        + ("" if text else "; section text is not in the cached file (offline fallback)"),
    }


def ctcae_rows() -> list[dict[str, Any]]:
    out = []
    for term in ctcae_terms().values():
        out.append(
            {
                "item_id": term.item_id,
                "aedecod": term.aedecod,
                "meddra_code_mock": term.meddra_code_mock,
                "meddra_soc": term.meddra_soc,
                "definition": term.definition,
                "grade_definitions": {str(k): v for k, v in term.grade_definitions.items()},
                "note": term.note,
                "meddra_note": "mock code; MedDRA is licensed and not shipped",
            }
        )
    return out
