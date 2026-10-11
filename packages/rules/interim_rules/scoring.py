"""PRO-CTCAE composite scoring (CLAUDE.md §3.4(a)).

Each item's attribute answers (frequency / severity / interference, 0..4, or
presence 0/1) are mapped to a single composite 0..3 using the Basch et al. 2021
lookup tables in ``data/composite_scoring.json``. The tables are data; this
module only looks rows up and documents which row it used.

Missing attributes are treated as 0 ("not reported") and said so in the
evidence note; out-of-range values and unknown items are caller errors.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .evidence import pro_evidence, table_evidence
from .models import Attribute, Evidence, ProResponse, RuleFired
from .tables import ItemDef, TableError, composite_tables, item_map, items

COMPOSITE_TABLE_FILE = "composite_scoring.json"


@dataclass(frozen=True)
class ScoredItem:
    """An item with its attribute values and the composite the table assigned."""

    item: ItemDef
    values: Mapping[Attribute, int]
    responses: tuple[ProResponse, ...]
    composite: int
    lookup_note: str
    evidence: tuple[Evidence, ...]


def validate_response(response: ProResponse, item: ItemDef) -> None:
    """Raise ``ValueError`` if the response does not fit the item's definition."""
    if not item.has(response.attribute):
        raise ValueError(
            f"item {item.id!r} does not ask {response.attribute!r} (asks {list(item.attributes)})"
        )
    upper = item.max_value(response.attribute)
    if isinstance(response.value, bool) or not 0 <= response.value <= upper:
        raise ValueError(
            f"{item.id}.{response.attribute} = {response.value!r} is outside 0..{upper}"
        )


def item_values(item: ItemDef, responses: Sequence[ProResponse]) -> dict[Attribute, int]:
    """Values for every attribute the item asks; missing -> 0; the last duplicate wins."""
    values: dict[Attribute, int] = dict.fromkeys(item.attributes, 0)
    for response in responses:
        if response.item_id != item.id:
            raise ValueError(f"response for {response.item_id!r} passed to item {item.id!r}")
        validate_response(response, item)
        values[response.attribute] = response.value
    return values


def composite_for_values(item: ItemDef, values: Mapping[Attribute, int]) -> tuple[int, str]:
    """Look the composite up for one item; returns ``(composite, note describing the row used)``."""
    tables = composite_tables()
    attrs = item.attributes
    attr_set = frozenset(attrs)

    if attr_set == frozenset({"presence"}):
        value = values["presence"]
        composite = tables.presence[value]
        return (
            composite,
            f"presence = {value} -> composite {composite} (Interim presence convention)",
        )

    if len(attrs) == 1:
        attr = attrs[0]
        value = values[attr]
        composite = tables.single[attr][value]
        return composite, f"single_attribute[{attr}] {attr} = {value} -> composite {composite}"

    table_name: str
    order: tuple[Attribute, ...]
    table: Mapping[tuple[int, ...], int]
    if attr_set == frozenset({"frequency", "severity", "interference"}):
        table_name = "three_attribute"
        order = ("frequency", "severity", "interference")
        table = tables.three
    elif attr_set == frozenset({"frequency", "severity"}):
        table_name = "two_attribute_freq_sev"
        order = ("frequency", "severity")
        table = tables.freq_sev
    elif attr_set == frozenset({"severity", "interference"}):
        table_name = "two_attribute_sev_int"
        order = ("severity", "interference")
        table = tables.sev_int
    elif attr_set == frozenset({"frequency", "interference"}):
        table_name = "two_attribute_freq_int"
        order = ("frequency", "interference")
        table = tables.freq_int
    else:
        raise TableError(f"no composite table for attribute set {sorted(attr_set)}")

    gate = tables.zero_gate[table_name]
    described = ", ".join(f"{a} = {values[a]}" for a in order)
    if values[gate] == 0:
        return 0, f"{table_name}: {gate} = 0 -> composite 0 (published zero rule; {described})"
    key = tuple(values[a] for a in order)
    try:
        composite = table[key]
    except KeyError as exc:
        raise TableError(
            f"{COMPOSITE_TABLE_FILE}: {table_name} has no row for {described}"
        ) from exc
    return composite, f"{table_name} row ({described}) -> composite {composite}"


def score_item(item: ItemDef, responses: Sequence[ProResponse]) -> ScoredItem:
    values = item_values(item, responses)
    composite, note = composite_for_values(item, values)
    evidence: list[Evidence] = [pro_evidence(r, item) for r in responses]
    missing = [a for a in item.attributes if all(r.attribute != a for r in responses)]
    if missing:
        note += f"; not answered, treated as 0: {', '.join(missing)}"
    evidence.append(table_evidence(COMPOSITE_TABLE_FILE, note))
    return ScoredItem(
        item=item,
        values=values,
        responses=tuple(responses),
        composite=composite,
        lookup_note=note,
        evidence=tuple(evidence),
    )


def score_responses(responses: Sequence[ProResponse]) -> tuple[ScoredItem, ...]:
    """Score every shipped item (in display order) from the session's responses."""
    known = item_map()
    by_item: dict[str, list[ProResponse]] = {}
    for response in responses:
        if response.item_id not in known:
            raise ValueError(f"unknown item_id {response.item_id!r}")
        by_item.setdefault(response.item_id, []).append(response)
    return tuple(score_item(item, by_item.get(item.id, [])) for item in items())


def scoring_rule(scored: ScoredItem) -> RuleFired | None:
    """The ``score.composite.<item>`` rule, emitted only when the composite is at least 1."""
    if scored.composite < 1:
        return None
    attributes = ", ".join(
        f"{attr} = {scored.values[attr]}"
        + (
            f" ({label})"
            if (label := scored.item.option_label(attr, scored.values[attr])) is not None
            else ""
        )
        for attr in scored.item.attributes
    )
    return RuleFired(
        rule_id=f"score.composite.{scored.item.id}",
        category="scoring",
        description=(
            f"{scored.item.label}: {attributes} -> composite {scored.composite} "
            f"({scored.lookup_note})"
        ),
        inputs={
            "item_id": scored.item.id,
            **{attr: scored.values[attr] for attr in scored.item.attributes},
            "composite": scored.composite,
        },
        effect=f"composite = {scored.composite}",
        evidence=scored.evidence,
    )
