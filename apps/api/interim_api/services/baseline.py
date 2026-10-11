"""Participant baselines from the Synthea cohort (docs/ISSUES #23).

``data/synthetic/synthea/participants.json`` holds twelve Synthea NSCLC patients relabelled
``P-001`` .. ``P-012`` (``data/synthetic/synthea/README.md``). The seed attaches each one's
compact profile to the kiosk participant with the same label (``Participant.baseline_json``)
and centres that participant's simulated resting vitals on the Synthea median pulse and
breathing rate (``Participant.baseline_vitals_json``).

Every value here is simulated and is labelled ``"Synthea synthetic EHR (simulated)"``
wherever it is shown (timeline, brief, printable brief). Nothing is re-anchored: dates are
as Synthea generated them relative to its own reference date. A missing cohort file (a
trimmed image) means no baseline, never an error.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from pathlib import Path
from typing import Any

log = logging.getLogger("interim_api.baseline")

SYNTHEA_LABEL = "Synthea synthetic EHR (simulated)"
COHORT_RELATIVE = Path("synthetic") / "synthea" / "participants.json"
"""Relative to the ``data/`` directory (``Settings.public_data_dir.parent``)."""


def cohort_path(public_data_dir: Path) -> Path:
    return Path(public_data_dir).parent / COHORT_RELATIVE


def load_cohort(public_data_dir: Path) -> dict[str, dict[str, Any]]:
    """``{label: Synthea participant record}`` (plus the cohort's ``_reference_date``); empty
    when the file is absent or unreadable."""
    path = cohort_path(public_data_dir)
    if not path.is_file():
        log.warning("%s is missing; participants are seeded without a Synthea baseline", path)
        return {}
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        log.warning("could not read %s (%s); seeding without a Synthea baseline", path, exc)
        return {}
    out: dict[str, dict[str, Any]] = {}
    for record in data.get("participants", []) if isinstance(data, Mapping) else []:
        label = record.get("label") if isinstance(record, Mapping) else None
        if isinstance(label, str):
            out[label] = {**record, "_reference_date": data.get("reference_date")}
    return out


def _unique(values: list[str]) -> list[str]:
    seen: list[str] = []
    for v in values:
        if v and v not in seen:
            seen.append(v)
    return seen


def _vital(record: Mapping[str, Any], key: str) -> dict[str, Any] | None:
    raw = (record.get("baseline_vitals") or {}).get(key)
    if not isinstance(raw, Mapping) or raw.get("median") is None:
        return None
    values = [v for v in raw.get("values") or [] if isinstance(v, Mapping)]
    return {
        "median": float(raw["median"]),
        "unit": raw.get("unit"),
        "n_observations": len(values),
        "dates": [v.get("date") for v in values],
    }


def baseline_from_synthea(record: Mapping[str, Any], reference_date: str | None) -> dict[str, Any]:
    """The compact profile stored on ``Participant.baseline_json``."""
    nsclc = record.get("nsclc") or {}
    comorbidities = _unique([str(c.get("display", "")) for c in record.get("comorbidities") or []])
    meds = record.get("active_medications") or []
    therapy = record.get("cancer_therapy") or []
    return {
        "label": SYNTHEA_LABEL,
        "source": SYNTHEA_LABEL,
        "is_measured": False,
        "synthea_ref": record.get("synthea_ref"),
        "reference_date": reference_date,
        "sex": record.get("sex"),
        "age_at_reference": record.get("age_at_reference"),
        "nsclc_stage": nsclc.get("stage"),
        "nsclc_diagnosis_date": nsclc.get("diagnosis_date"),
        "nsclc_display": (nsclc.get("displays") or [None])[0],
        "comorbidities": comorbidities,
        "active_medications": _unique([str(m.get("ingredient") or "") for m in meds]),
        "prior_cancer_therapy": [
            {
                "ingredient": t.get("ingredient"),
                "first_date": t.get("first_date"),
                "last_date": t.get("last_date"),
                "n_administrations": t.get("n_administrations"),
            }
            for t in therapy
        ],
        "smoking": (record.get("smoking") or {}).get("status"),
        "pulse_bpm": _vital(record, "pulse_bpm"),
        "breathing_bpm": _vital(record, "breathing_bpm"),
    }


def summary_lines(baseline: Mapping[str, Any] | None) -> list[str]:
    """Plain-language lines for the brief and the printable page (data, not prose: each
    line restates one stored field). Empty when there is no baseline."""
    if not baseline:
        return []
    lines: list[str] = []
    who = " ".join(
        str(x)
        for x in (
            f"{baseline['age_at_reference']}-year-old"
            if baseline.get("age_at_reference")
            else None,
            baseline.get("sex"),
        )
        if x
    )
    if who:
        lines.append(f"{who[0].upper()}{who[1:]}.")
    if baseline.get("nsclc_stage"):
        when = baseline.get("nsclc_diagnosis_date")
        lines.append(
            f"Non-small cell lung cancer, stage {baseline['nsclc_stage']}"
            + (f", diagnosed {when}." if when else ".")
        )
    if baseline.get("comorbidities"):
        lines.append("Other conditions: " + "; ".join(baseline["comorbidities"]) + ".")
    if baseline.get("active_medications"):
        lines.append("Medications on record: " + ", ".join(baseline["active_medications"]) + ".")
    therapy = _unique(
        [str(t.get("ingredient") or "") for t in baseline.get("prior_cancer_therapy") or []]
    )
    if therapy:
        lines.append("Earlier cancer therapy in the record: " + ", ".join(therapy) + ".")
    if baseline.get("smoking"):
        lines.append(f"Smoking status: {baseline['smoking']}.")
    vitals = []
    for key, word in (("pulse_bpm", "pulse"), ("breathing_bpm", "breathing rate")):
        v = baseline.get(key)
        if isinstance(v, Mapping):
            vitals.append(
                f"{word} {v['median']:g} {v.get('unit') or ''}".strip()
                + f" (median of {v.get('n_observations', 0)} visits)"
            )
    if vitals:
        lines.append("Baseline " + "; ".join(vitals) + ".")
    return lines


def baseline_view(baseline: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """What the timeline and the brief return: the profile plus its labelled summary."""
    if not baseline:
        return None
    return {**baseline, "label": SYNTHEA_LABEL, "summary": summary_lines(baseline)}


__all__ = [
    "SYNTHEA_LABEL",
    "baseline_from_synthea",
    "baseline_view",
    "cohort_path",
    "load_cohort",
    "summary_lines",
]
