"""Provisional CTCAE grade from the composite (CLAUDE.md §3.4(b)).

The composite -> grade crosswalk lives in ``data/composite_to_grade.json``.
The grade comes only from the participant's answers; nothing downstream
(vitals, red flags) can change it. Grades above ``max_assignable_grade`` (3)
are never produced.
"""

from __future__ import annotations

from collections.abc import Sequence

from .evidence import table_evidence
from .models import ItemResult, RuleFired
from .scoring import ScoredItem
from .tables import ctcae_term_for_item, grade_map

GRADE_TABLE_FILE = "composite_to_grade.json"


def grade_for_composite(composite: int) -> int:
    """Map a composite 0..3 to a provisional grade, capped at the table's maximum."""
    table = grade_map()
    if composite not in table.map:
        raise ValueError(f"composite {composite!r} has no grade mapping")
    return min(table.map[composite], table.max_assignable_grade)


def grade_item(scored: ScoredItem) -> ItemResult:
    grade = grade_for_composite(scored.composite)
    term = ctcae_term_for_item(scored.item.id)
    note = (
        f"composite {scored.composite} -> provisional grade {grade} "
        f"({grade_map().grade_label}; max assignable {grade_map().max_assignable_grade})"
    )
    return ItemResult(
        item_id=scored.item.id,
        label=scored.item.label,
        aedecod=term.aedecod,
        composite=scored.composite,
        provisional_grade=grade,
        responses=scored.responses,
        evidence=(*scored.evidence, table_evidence(GRADE_TABLE_FILE, note)),
    )


def grade_items(scored: Sequence[ScoredItem]) -> tuple[ItemResult, ...]:
    return tuple(grade_item(s) for s in scored)


def grading_rule(result: ItemResult) -> RuleFired | None:
    """The ``grade.provisional.<item>`` rule, emitted only when the grade is at least 1."""
    if result.provisional_grade < 1:
        return None
    label = grade_map().grade_label
    return RuleFired(
        rule_id=f"grade.provisional.{result.item_id}",
        category="grading",
        description=(
            f"{result.label} ({result.aedecod}): composite {result.composite} -> "
            f"provisional CTCAE grade {result.provisional_grade} ({label})"
        ),
        inputs={
            "item_id": result.item_id,
            "aedecod": result.aedecod,
            "composite": result.composite,
            "grade": result.provisional_grade,
        },
        effect=f"AETOXGR = {result.provisional_grade} (provisional)",
        evidence=result.evidence,
    )
