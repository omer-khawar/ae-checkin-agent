"""Evaluator for the small declarative condition language used by rule tables.

Red-flag and corroboration rules are stored as data (``red_flags.json``,
``vitals_corroboration.json``) so that every threshold is visible without
reading code. A condition is one of::

    {"all": [<condition>, ...]}                                    # conjunction
    {"kind": "item_attribute", "item": ID, "attribute": A, "op": OP, "value": N}
    {"kind": "item_composite", "item": ID, "op": OP, "value": N}
    {"kind": "any_severe_item"}                                    # see red_flags.json
    {"kind": "gate_bool", "field": F, "equals": true|false}
    {"kind": "ended_early"}                                        # R5.1 urgent early stop
    {"kind": "gate_text_nonempty", "field": F}
    {"kind": "vital", "metric": "pulse"|"breathing"|"hrv", "op": OP, "value": N}

``OP`` is one of ``>= > == != <= <``. Evaluation returns whether the condition
matched, the evidence pointers it looked at, and the inputs it compared, so a
fired rule can explain itself with the actual values.
"""

from __future__ import annotations

import operator
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .evidence import gate_evidence, pro_evidence, sample_evidence, table_evidence
from .models import Attribute, Evidence, GateAnswers, ItemResult
from .tables import SevereItemDefinition, TableError, item_by_id, vitals_config

_OPS: Mapping[str, Callable[[float, float], bool]] = {
    ">=": operator.ge,
    ">": operator.gt,
    "==": operator.eq,
    "!=": operator.ne,
    "<=": operator.le,
    "<": operator.lt,
}


@dataclass(frozen=True)
class VitalMax:
    """Maximum corroboration-eligible value of one metric in the session and where it came from."""

    value: float
    sample_id: str
    ts: str


@dataclass(frozen=True)
class ConditionContext:
    """Everything a condition may look at."""

    items: Mapping[str, ItemResult]
    gates: GateAnswers
    gate_ids: Mapping[str, str]
    """Evidence ids for gate fields (``hospitalization``, ``conmed_text``, ``other_text``, ...)."""
    vitals_max: Mapping[str, VitalMax]
    severe_item: SevereItemDefinition
    ended_early: str | None = None
    """R5.1: the trigger that ended the check-in at once (``urgent_now`` / ``severe_dyspnea``)."""


@dataclass(frozen=True)
class ConditionOutcome:
    matched: bool
    evidence: tuple[Evidence, ...]
    inputs: dict[str, object]


def _compare(op: str, left: float, right: float) -> bool:
    try:
        return _OPS[op](left, right)
    except KeyError as exc:
        raise TableError(f"unknown comparison operator {op!r}") from exc


def attribute_value(result: ItemResult, attribute: Attribute) -> int | None:
    """Value given for ``attribute`` (0 if unanswered); ``None`` if the item does not ask it."""
    item = item_by_id(result.item_id)
    if not item.has(attribute):
        return None
    for response in result.responses:
        if response.attribute == attribute:
            return response.value
    return 0


def _attribute_evidence(result: ItemResult, attribute: Attribute) -> tuple[Evidence, ...]:
    item = item_by_id(result.item_id)
    return tuple(pro_evidence(r, item) for r in result.responses if r.attribute == attribute)


def is_severe(result: ItemResult, definition: SevereItemDefinition) -> bool:
    """CLAUDE.md 'severe item': severity >= 3; for items without severity, composite == 3."""
    severity = attribute_value(result, "severity")
    if severity is not None:
        return severity >= definition.severity_attribute_min
    return result.composite >= definition.no_severity_attribute_composite_min


def _item(ctx: ConditionContext, item_id: str) -> ItemResult:
    try:
        return ctx.items[item_id]
    except KeyError as exc:
        raise TableError(f"condition references unknown item {item_id!r}") from exc


def _eval_item_attribute(cond: Mapping[str, Any], ctx: ConditionContext) -> ConditionOutcome:
    item_id, attribute, op, target = cond["item"], cond["attribute"], cond["op"], cond["value"]
    if attribute not in ("frequency", "severity", "interference", "presence"):
        raise TableError(f"condition has unknown attribute {attribute!r}")
    result = _item(ctx, item_id)
    value = attribute_value(result, attribute)
    key = f"{item_id}.{attribute}"
    if value is None:
        return ConditionOutcome(False, (), {key: None})
    return ConditionOutcome(
        matched=_compare(op, value, target),
        evidence=_attribute_evidence(result, attribute),
        inputs={key: value, f"{key}.threshold": f"{op} {target}"},
    )


def _eval_item_composite(cond: Mapping[str, Any], ctx: ConditionContext) -> ConditionOutcome:
    item_id, op, target = cond["item"], cond["op"], cond["value"]
    result = _item(ctx, item_id)
    item = item_by_id(item_id)
    return ConditionOutcome(
        matched=_compare(op, result.composite, target),
        evidence=tuple(pro_evidence(r, item) for r in result.responses),
        inputs={
            f"{item_id}.composite": result.composite,
            f"{item_id}.composite.threshold": f"{op} {target}",
        },
    )


def _eval_any_severe_item(ctx: ConditionContext) -> ConditionOutcome:
    severe_ids: list[str] = []
    evidence: list[Evidence] = []
    for result in ctx.items.values():
        if is_severe(result, ctx.severe_item):
            severe_ids.append(result.item_id)
            severity_ev = _attribute_evidence(result, "severity")
            if severity_ev:
                evidence.extend(severity_ev)
            else:
                item = item_by_id(result.item_id)
                evidence.extend(pro_evidence(r, item) for r in result.responses)
    return ConditionOutcome(bool(severe_ids), tuple(evidence), {"severe_items": severe_ids})


def _eval_gate_bool(cond: Mapping[str, Any], ctx: ConditionContext) -> ConditionOutcome:
    field, expected = cond["field"], cond["equals"]
    if field not in ("hospitalization", "conmed_changed", "urgent_now"):
        raise TableError(f"gate_bool condition has unknown field {field!r}")
    actual = bool(getattr(ctx.gates, field))
    return ConditionOutcome(
        matched=actual == bool(expected),
        evidence=(gate_evidence(ctx.gate_ids[field], f"{field} = {actual}"),),
        inputs={field: actual},
    )


def _eval_ended_early(ctx: ConditionContext) -> ConditionOutcome:
    trigger = ctx.ended_early
    if trigger is None:
        return ConditionOutcome(False, (), {"ended_early": None})
    return ConditionOutcome(
        matched=True,
        evidence=(
            table_evidence(
                "escalation_ladder.json",
                f"the check-in was ended early by the urgent path (trigger: {trigger}); "
                "unanswered items are not reported",
            ),
        ),
        inputs={"ended_early": trigger},
    )


def _eval_gate_text_nonempty(cond: Mapping[str, Any], ctx: ConditionContext) -> ConditionOutcome:
    field = cond["field"]
    if field not in ("other_text", "conmed_text"):
        raise TableError(f"gate_text_nonempty condition has unknown field {field!r}")
    raw = getattr(ctx.gates, field)
    text = raw.strip() if isinstance(raw, str) else ""
    present = bool(text)
    note = (
        f"{field} present ({len(text)} characters; stored verbatim, never parsed)"
        if present
        else f"{field} empty"
    )
    return ConditionOutcome(
        matched=present,
        evidence=(gate_evidence(ctx.gate_ids[field], note),),
        inputs={f"{field}_present": present, f"{field}_length": len(text)},
    )


def _eval_vital(cond: Mapping[str, Any], ctx: ConditionContext) -> ConditionOutcome:
    metric, op, target = cond["metric"], cond["op"], cond["value"]
    bounds = vitals_config().plausibility.get(metric)
    unit = bounds.unit if bounds is not None else ""
    key = f"{metric}_max"
    found = ctx.vitals_max.get(metric)
    if found is None:
        return ConditionOutcome(False, (), {key: None, f"{key}.threshold": f"{op} {target}"})
    return ConditionOutcome(
        matched=_compare(op, found.value, target),
        evidence=(
            sample_evidence(
                found.sample_id,
                found.ts,
                f"max eligible {metric} in session = {found.value} {unit}".rstrip(),
            ),
        ),
        inputs={key: found.value, f"{key}.threshold": f"{op} {target}"},
    )


def evaluate(cond: Mapping[str, Any], ctx: ConditionContext) -> ConditionOutcome:
    """Evaluate a declarative condition against the context."""
    if "all" in cond:
        matched = True
        evidence: list[Evidence] = []
        inputs: dict[str, object] = {}
        for part in cond["all"]:
            outcome = evaluate(part, ctx)
            matched = matched and outcome.matched
            evidence.extend(outcome.evidence)
            inputs.update(outcome.inputs)
        return ConditionOutcome(matched, tuple(evidence), inputs)

    kind = cond.get("kind")
    if kind == "item_attribute":
        return _eval_item_attribute(cond, ctx)
    if kind == "item_composite":
        return _eval_item_composite(cond, ctx)
    if kind == "any_severe_item":
        return _eval_any_severe_item(ctx)
    if kind == "gate_bool":
        return _eval_gate_bool(cond, ctx)
    if kind == "ended_early":
        return _eval_ended_early(ctx)
    if kind == "gate_text_nonempty":
        return _eval_gate_text_nonempty(cond, ctx)
    if kind == "vital":
        return _eval_vital(cond, ctx)
    raise TableError(f"unknown condition kind {kind!r}")
