"""Small constructors for :class:`~interim_rules.models.Evidence` pointers.

Every derived value in a result carries evidence; these helpers keep the
``note`` wording consistent so the dashboard can render it directly.
"""

from __future__ import annotations

from .models import Evidence, ProResponse
from .tables import ItemDef


def pro_evidence(response: ProResponse, item: ItemDef) -> Evidence:
    """Point at one participant answer, e.g. ``shortness_of_breath.severity = 2 (Moderate)``."""
    label = item.option_label(response.attribute, response.value)
    suffix = f" ({label})" if label is not None else ""
    return Evidence(
        kind="pro_response",
        id=response.answer_id,
        ts=response.ts,
        note=f"{response.item_id}.{response.attribute} = {response.value}{suffix}",
    )


def sample_evidence(sample_id: str, ts: str, note: str) -> Evidence:
    return Evidence(kind="vitals_sample", id=sample_id, ts=ts, note=note)


def gate_evidence(answer_id: str, note: str) -> Evidence:
    return Evidence(kind="gate_answer", id=answer_id, ts=None, note=note)


def rule_evidence(rule_id: str, note: str) -> Evidence:
    return Evidence(kind="rule", id=rule_id, ts=None, note=note)


def table_evidence(table_file: str, note: str) -> Evidence:
    return Evidence(kind="table", id=table_file, ts=None, note=note)
