"""Composite scoring and provisional grading, table-driven."""

from __future__ import annotations

import itertools

import pytest
from helpers import response

from interim_rules import grading, scoring
from interim_rules.models import ProResponse
from interim_rules.tables import TableError, composite_tables, item_by_id, items


@pytest.mark.parametrize(
    ("item_id", "values", "expected"),
    [
        ("shortness_of_breath", {"severity": 0, "interference": 4}, 0),  # zero rule
        ("shortness_of_breath", {"severity": 2, "interference": 2}, 2),
        ("shortness_of_breath", {"severity": 3, "interference": 0}, 1),
        ("shortness_of_breath", {"severity": 3, "interference": 3}, 3),
        ("shortness_of_breath", {"severity": 4, "interference": 2}, 2),
        ("cough", {"severity": 1, "interference": 0}, 1),
        ("nausea", {"frequency": 0, "severity": 4}, 0),  # zero rule on frequency
        ("nausea", {"frequency": 2, "severity": 2}, 2),
        ("nausea", {"frequency": 3, "severity": 3}, 3),
        ("nausea", {"frequency": 4, "severity": 1}, 1),
        ("diarrhea", {"frequency": 1}, 1),
        ("diarrhea", {"frequency": 2}, 1),
        ("diarrhea", {"frequency": 3}, 2),
        ("diarrhea", {"frequency": 4}, 3),
        ("itching", {"severity": 2}, 2),
        ("itching", {"severity": 4}, 3),
        ("rash", {"presence": 0}, 0),
        ("rash", {"presence": 1}, 1),
        ("fever_or_chills", {"presence": 1}, 1),
    ],
)
def test_composite_rows(item_id: str, values: dict[str, int], expected: int) -> None:
    item = item_by_id(item_id)
    composite, note = scoring.composite_for_values(item, values)  # type: ignore[arg-type]
    assert composite == expected
    assert "composite" in note


def test_every_combination_has_a_row_or_the_zero_rule() -> None:
    for item in items():
        ranges = [range(item.max_value(a) + 1) for a in item.attributes]
        for combo in itertools.product(*ranges):
            values = dict(zip(item.attributes, combo, strict=True))
            composite, _ = scoring.composite_for_values(item, values)
            assert 0 <= composite <= 3


def test_monotone_in_every_attribute_for_every_item() -> None:
    for item in items():
        ranges = [range(item.max_value(a) + 1) for a in item.attributes]
        for combo in itertools.product(*ranges):
            values = dict(zip(item.attributes, combo, strict=True))
            base, _ = scoring.composite_for_values(item, values)
            for attr in item.attributes:
                if values[attr] < item.max_value(attr):
                    raised = {**values, attr: values[attr] + 1}
                    higher, _ = scoring.composite_for_values(item, raised)
                    assert higher >= base, (item.id, values, attr)


def test_three_attribute_table_through_a_synthetic_item() -> None:
    """No shipped item has all three attributes, so exercise that table directly."""
    base = item_by_id("nausea")
    synthetic = type(base)(
        id="synthetic",
        order=99,
        label="Synthetic",
        short_label="Syn",
        ctcae_term="Nausea",
        attributes=("frequency", "severity", "interference"),
        prompts={"frequency": "f", "severity": "s", "interference": "i"},
        response_options={
            a: base.response_options["severity"] for a in ("frequency", "severity", "interference")
        },
        recall_window=base.recall_window,
        optional_gate_fields=(),
    )
    assert (
        scoring.composite_for_values(synthetic, {"frequency": 0, "severity": 4, "interference": 4})[
            0
        ]
        == 0
    )
    assert (
        scoring.composite_for_values(synthetic, {"frequency": 1, "severity": 2, "interference": 4})[
            0
        ]
        == 3
    )
    assert (
        scoring.composite_for_values(synthetic, {"frequency": 4, "severity": 4, "interference": 4})[
            0
        ]
        == 3
    )
    freq_int = type(synthetic)(
        **{**synthetic.__dict__, "attributes": ("frequency", "interference")}
    )
    assert scoring.composite_for_values(freq_int, {"frequency": 3, "interference": 3})[0] == 3
    unsupported = type(synthetic)(**{**synthetic.__dict__, "attributes": ("presence", "severity")})
    with pytest.raises(TableError):
        scoring.composite_for_values(unsupported, {"presence": 1, "severity": 1})
    assert composite_tables().three[(4, 4, 4)] == 3


def test_missing_attribute_is_treated_as_zero_and_noted() -> None:
    item = item_by_id("shortness_of_breath")
    scored = scoring.score_item(item, [response("shortness_of_breath", "severity", 2)])
    assert scored.values == {"severity": 2, "interference": 0}
    assert scored.composite == 1
    assert "treated as 0: interference" in scored.lookup_note
    assert scored.evidence[-1].kind == "table"


def test_duplicate_response_last_wins() -> None:
    item = item_by_id("itching")
    scored = scoring.score_item(
        item,
        [response("itching", "severity", 4), response("itching", "severity", 1, answer_id="b")],
    )
    assert scored.values["severity"] == 1 and scored.composite == 1


def test_invalid_responses_raise() -> None:
    item = item_by_id("diarrhea")
    with pytest.raises(ValueError, match="does not ask"):
        scoring.score_item(item, [response("diarrhea", "severity", 1)])
    with pytest.raises(ValueError, match="outside"):
        scoring.score_item(item, [response("diarrhea", "frequency", 5)])
    with pytest.raises(ValueError, match="outside"):
        scoring.score_item(item, [response("diarrhea", "frequency", -1)])
    with pytest.raises(ValueError, match="passed to item"):
        scoring.score_item(item, [response("cough", "severity", 1)])
    with pytest.raises(ValueError, match="unknown item_id"):
        scoring.score_responses([response("unicorn", "severity", 1)])


def test_score_responses_covers_every_item_in_order() -> None:
    scored = scoring.score_responses([response("cough", "severity", 2)])
    assert [s.item.id for s in scored] == [i.id for i in items()]
    assert {s.item.id: s.composite for s in scored}["cough"] == 1
    rules = [scoring.scoring_rule(s) for s in scored]
    fired = [r for r in rules if r is not None]
    assert [r.rule_id for r in fired] == ["score.composite.cough"]
    assert fired[0].inputs["severity"] == 2 and fired[0].effect == "composite = 1"
    assert "Moderate" in fired[0].description


def test_grade_from_composite_and_cap() -> None:
    assert [grading.grade_for_composite(c) for c in range(4)] == [0, 1, 2, 3]
    with pytest.raises(ValueError):
        grading.grade_for_composite(4)


def test_grade_items_and_rules() -> None:
    scored = scoring.score_responses(
        [response("shortness_of_breath", "severity", 2), response("rash", "presence", 1)]
    )
    results = grading.grade_items(scored)
    by_id = {r.item_id: r for r in results}
    assert by_id["shortness_of_breath"].provisional_grade == 1  # severity 2, interference 0
    assert by_id["shortness_of_breath"].aedecod == "Dyspnea"
    assert by_id["rash"].provisional_grade == 1 and by_id["rash"].aedecod == "Rash maculo-papular"
    assert by_id["cough"].provisional_grade == 0
    assert grading.grading_rule(by_id["cough"]) is None
    rule = grading.grading_rule(by_id["rash"])
    assert rule is not None and rule.rule_id == "grade.provisional.rash"
    assert rule.effect == "AETOXGR = 1 (provisional)"
    assert any(e.kind == "table" and e.id == "composite_to_grade.json" for e in rule.evidence)
    assert isinstance(results[0].responses[0], ProResponse)
