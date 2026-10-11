"""Plain-language layer for detail payloads (CLAUDE.md §00 "speak to non-clinicians first").

``GET /checkins/{id}`` and ``GET /notes/{id}`` (and ``POST /notes``, which returns the same
shape) gain:

* ``labels: {field: plain label}`` for every field name on every draft (and every name an
  evidence map is keyed by), from ``interim_rules.plain_language.field_labels``; an SDTM
  name the table does not know is returned as itself, so the map always covers every field;
* ``plain`` on every ``rules_fired`` item (top level and, when present, ``protocol``),
  from ``interim_rules.plain_language.rule_sentence(rule_id, inputs)``, which never raises
  and falls back to the rule's input-free sentence.

The SDTM names and rule ids stay in the payload untouched: plain words lead, the codes stay
one click deeper (CONTRACTS.md R3.2 / R3.3). Wording lives in
``packages/rules/data/plain_language.json``; nothing here decides anything.
"""

from __future__ import annotations

import functools
from collections.abc import Callable, Mapping
from typing import Any

from interim_rules.plain_language import field_labels, rule_sentence


def _with_plain(rules: Any) -> Any:
    if not isinstance(rules, list):
        return rules
    out: list[Any] = []
    for rule in rules:
        if isinstance(rule, Mapping) and rule.get("rule_id"):
            inputs = rule.get("inputs")
            plain = rule_sentence(
                str(rule["rule_id"]), inputs if isinstance(inputs, Mapping) else None
            )
            out.append({**rule, "plain": plain})
        else:
            out.append(rule)
    return out


def add_plain_language(detail: dict[str, Any]) -> dict[str, Any]:
    """Add ``labels`` and ``rules_fired[].plain`` to a check-in or note detail, in place."""
    names: set[str] = set()
    for draft in detail.get("drafts") or []:
        if isinstance(draft, Mapping):
            names.update(str(k) for k in (draft.get("fields") or {}))
            names.update(str(k) for k in (draft.get("evidence") or {}))
    detail["labels"] = field_labels(sorted(names))
    detail["rules_fired"] = _with_plain(detail.get("rules_fired"))
    protocol = detail.get("protocol")
    if isinstance(protocol, dict) and "rules_fired" in protocol:
        protocol["rules_fired"] = _with_plain(protocol["rules_fired"])
    return detail


def with_plain_language[**P](
    builder: Callable[P, dict[str, Any]],
) -> Callable[P, dict[str, Any]]:
    """Decorator for a detail builder: its result passes through :func:`add_plain_language`."""

    @functools.wraps(builder)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> dict[str, Any]:
        return add_plain_language(builder(*args, **kwargs))

    return wrapper


__all__ = ["add_plain_language", "with_plain_language"]
