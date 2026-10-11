"""The protocol tables (CONTRACTS.md R3.1): provenance, verbatim quotes and validation.

``protocol_rules.json`` and ``irae_mapping.json`` quote the EMPOWER-Lung 1 protocol. These
tests check every quoted sentence against the cached verbatim excerpt
(``data/public/empower_lung1_protocol_excerpt.json``) at the printed page the table cites,
whitespace-normalized (the excerpt keeps the PDF's line breaks). The excerpt is a
repository file outside the package; the quote tests skip only if it is absent (an
installed wheel), never silently pass.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any, cast

import pytest

from interim_rules import tables
from interim_rules.tables import TableError

REPO_ROOT = Path(__file__).resolve().parents[3]
EXCERPT_PATH = REPO_ROOT / "data" / "public" / "empower_lung1_protocol_excerpt.json"
QUOTE_KEYS = ("quote", "exception_text", "further_exceptions_text", "condition")
BRIEF_IMMUNE_ITEMS = {"shortness_of_breath", "fatigue", "diarrhea", "rash", "itching", "joint_pain"}
"""CLAUDE.md §00.1's list of potentially immune-related kiosk items."""

_CACHES: tuple[Callable[[], object], ...] = (tables.protocol_rules, tables.irae_mapping)


def _norm(text: str) -> str:
    return " ".join(text.split())


def _excerpt() -> dict[str, Any]:
    if not EXCERPT_PATH.is_file():  # pragma: no cover - only in a wheel install
        pytest.skip("protocol excerpt not present (installed package without the repository)")
    with EXCERPT_PATH.open(encoding="utf-8") as fh:
        return cast(dict[str, Any], json.load(fh))


def _pages() -> dict[int, str]:
    pages: dict[int, str] = {}
    for section in _excerpt()["sections"].values():
        for page in section:
            pages[int(page["printed_page"])] = _norm(page["text"])
    return pages


def _quoted(node: object, ref: Mapping[str, Any] | None = None) -> Iterator[tuple[str, int, str]]:
    """Every (key, printed_page, text) quoted in a table, with the nearest protocol_ref."""
    if isinstance(node, list):
        for child in cast(list[object], node):
            yield from _quoted(child, ref)
        return
    if not isinstance(node, dict):
        return
    d = cast(dict[str, Any], node)
    here = d.get("protocol_ref")
    current = cast(Mapping[str, Any], here) if isinstance(here, dict) else ref
    for key in QUOTE_KEYS:
        text = d.get(key)
        if isinstance(text, str):
            assert current is not None, f"{key} {text!r} has no protocol_ref"
            yield key, int(current["printed_page"]), text
    for value in d.values():
        yield from _quoted(value, current)


@pytest.fixture(autouse=True)
def _restore_caches() -> Iterator[None]:
    yield
    for cached in _CACHES:
        cached.cache_clear()  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# Provenance and verbatim quotes
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("name", ["protocol_rules", "irae_mapping"])
def test_tables_are_registered_with_source_and_rationale(name: str) -> None:
    assert name in tables.TABLE_NAMES
    table = tables.load_table(name)
    assert "R2810-ONC-1624" in table["source"] and table["rationale"].strip()


@pytest.mark.parametrize("name", ["protocol_rules", "irae_mapping"])
def test_every_quote_is_verbatim_on_the_cited_page(name: str) -> None:
    pages = _pages()
    quotes = list(_quoted(tables.load_table(name)))
    assert quotes, name
    for key, page, text in quotes:
        assert page in pages, (key, page)
        assert _norm(text) in pages[page], f"{name}: {key} not verbatim on p. {page}: {text!r}"


def test_corticosteroid_exception_text_is_the_protocols_own_words() -> None:
    page = _pages()[69]
    for drug in tables.protocol_rules().by_level("discouraged"):
        assert drug.exception_text == (
            "except in the case of a life-threatening emergency and/or to treat an irAE."
        )
        assert _norm(drug.quote) in page and drug.quote.endswith(drug.exception_text)


def test_protocol_metadata_matches_the_excerpt() -> None:
    excerpt = _excerpt()
    table = tables.load_table("protocol_rules")["protocol"]
    assert table["pdf_sha256"] == excerpt["pdf_sha256"]
    assert table["nct_id"] == excerpt["nct_id"] == "NCT03088540"
    assert table["source_url"] == excerpt["source_url"]
    assert excerpt["protocol"] == f"{table['protocol_id']} {table['amendment']}"


def test_numbers_and_citations() -> None:
    rules = tables.protocol_rules()
    assert rules.aesi.reporting_hours == 24 and rules.sae_reporting_hours == 24
    assert rules.sae_reporting_hours == tables.seriousness_config().site_to_sponsor_hours
    assert rules.ae_reporting_window_days == 90
    aesi_ref = rules.aesi.reference.protocol_ref
    assert (aesi_ref.section, aesi_ref.printed_page) == ("9.4.3", 92)
    assert rules.sae_reporting.protocol_ref.printed_page == 91
    assert rules.ae_reporting_window.protocol_ref.section == "9.4.1"
    assert rules.cm_required_fields == (
        "CMTRT", "CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC", "CMSTDTC", "CMENDTC"
    )  # fmt: skip
    assert rules.cm_required_reference.protocol_ref.section == "7.7"
    assert rules.prohibited_tier_floor == 2
    assert rules.aesi.label == "possible AESI, investigator to confirm"


def test_aesi_criteria_cover_the_protocol_list() -> None:
    criteria = {c.id: c for c in tables.protocol_rules().aesi.criteria}
    assert set(criteria) == {
        "infusion_reaction_grade2",
        "allergic_reaction_grade2",
        "irae_grade3",
        "irae_any_grade_prior_pi3k",
    }
    assert not criteria["infusion_reaction_grade2"].detectable_from_kiosk
    assert not criteria["allergic_reaction_grade2"].detectable_from_kiosk
    assert criteria["irae_grade3"].min_grade == 3
    assert criteria["irae_grade3"].requires_context is None
    assert criteria["irae_any_grade_prior_pi3k"].min_grade == 1
    assert criteria["irae_any_grade_prior_pi3k"].requires_context == "prior_pi3k_inhibitor"


def test_conmed_lists_match_the_protocol() -> None:
    rules = tables.protocol_rules()
    names = {level: {d.drug for d in rules.by_level(level)} for level in tables.PROTOCOL_LEVELS}
    assert {"bevacizumab", "necitumumab"} <= names["prohibited"]
    assert {"hydrocortisone", "prednisone", "prednisolone", "dexamethasone"} <= names["discouraged"]
    assert {"denosumab", "pemetrexed", "palliative radiation"} <= names["permitted"]
    assert all(d.systemic_only for d in rules.by_level("discouraged"))
    assert {d.drug for d in rules.drugs if d.is_category} == {
        "investigational anti-tumor agent",
        "palliative radiation",
    }
    assert [d.level for d in rules.drugs] == sorted(
        (d.level for d in rules.drugs), key=tables.PROTOCOL_LEVELS.index
    )
    assert "cream" in rules.non_systemic_qualifiers


def test_irae_mapping_covers_every_item_and_follows_the_brief() -> None:
    mapping = tables.irae_mapping()
    assert set(mapping) == {item.id for item in tables.items()}
    immune = {item_id for item_id, row in mapping.items() if row.potentially_immune_related}
    assert immune == BRIEF_IMMUNE_ITEMS
    assert mapping["diarrhea"].irae_category == "colitis"
    assert mapping["rash"].irae_category == "dermatologic"
    assert mapping["fatigue"].irae_category == "endocrine"
    assert mapping["shortness_of_breath"].irae_category == "pneumonitis"
    assert mapping["mouth_sores"].irae_category == "mucosal"
    for row in mapping.values():
        assert row.rationale.strip()
        if row.potentially_immune_related:
            assert row.protocol_ref is not None and row.irae_category != "none"


# --------------------------------------------------------------------------- #
# Malformed tables fail loudly
# --------------------------------------------------------------------------- #


def _patched(
    monkeypatch: pytest.MonkeyPatch, name: str, mutate: Callable[[dict[str, Any]], None]
) -> None:
    """Serve a mutated deep copy of table ``name``; every other table is the real one."""
    real = tables.load_table
    variant = json.loads(json.dumps(real(name)))
    mutate(variant)

    def fake(table_name: str) -> dict[str, Any]:
        return cast(dict[str, Any], variant) if table_name == name else real(table_name)

    monkeypatch.setattr(tables, "load_table", fake)
    for cached in _CACHES:
        cached.cache_clear()  # type: ignore[attr-defined]


def _first(level: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    return lambda t: cast(dict[str, Any], t["conmeds"][level][0])


PROTOCOL_BREAKAGE: list[tuple[str, Callable[[dict[str, Any]], None], str]] = [
    ("upper-case name", lambda t: _first("prohibited")(t).update(drug="Bevacizumab"), "lowercase"),
    (
        "name in two levels",
        lambda t: _first("permitted")(t)["aliases"].append("avastin"),
        "already classified",
    ),
    (
        "discouraged without exception",
        lambda t: _first("discouraged")(t).update(exception_text=None),
        "exception_text",
    ),
    ("bad page", lambda t: _first("prohibited")(t)["protocol_ref"].update(printed_page=0), ">= 1"),
    (
        "empty section",
        lambda t: _first("prohibited")(t)["protocol_ref"].update(section=" "),
        "empty",
    ),
    ("empty quote", lambda t: _first("prohibited")(t).update(quote=""), "empty"),
    ("floor out of range", lambda t: t["conmeds"].update(prohibited_tier_floor=4), "0..3"),
    ("negative window", lambda t: t.update(ae_reporting_window_days_after_last_dose=-1), ">= 0"),
    ("zero sae hours", lambda t: t.update(sae_reporting_hours=0), "positive"),
    ("zero aesi hours", lambda t: t["aesi"].update(reporting_hours=0), "positive"),
    (
        "unknown context",
        lambda t: t["aesi"]["criteria"][3].update(requires_context="prior_chemo"),
        "unknown context",
    ),
    ("grade out of range", lambda t: t["aesi"]["criteria"][2].update(min_grade=0), "1..5"),
    (
        "duplicate criterion",
        lambda t: t["aesi"]["criteria"].append(dict(t["aesi"]["criteria"][0])),
        "duplicate criterion",
    ),
    (
        "detail out of order",
        lambda t: t["cm_required_fields_detail"]["fields"].reverse(),
        "same order",
    ),
    ("missing aesi", lambda t: t.pop("aesi"), "expected object"),
]


@pytest.mark.parametrize(
    ("label", "mutate", "message"), PROTOCOL_BREAKAGE, ids=[b[0] for b in PROTOCOL_BREAKAGE]
)
def test_malformed_protocol_rules(
    monkeypatch: pytest.MonkeyPatch,
    label: str,
    mutate: Callable[[dict[str, Any]], None],
    message: str,
) -> None:
    _patched(monkeypatch, "protocol_rules", mutate)
    with pytest.raises(TableError, match=message):
        tables.protocol_rules()


def _row(item_id: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    return lambda t: next(r for r in t["items"] if r["item_id"] == item_id)


IRAE_BREAKAGE: list[tuple[str, Callable[[dict[str, Any]], None], str]] = [
    ("unknown category", lambda t: _row("rash")(t).update(irae_category="hepatic"), "unknown"),
    ("category list", lambda t: t["categories"].append("hepatic"), "expected"),
    ("immune without ref", lambda t: _row("rash")(t).update(protocol_ref=None), "protocol_ref"),
    ("immune with none", lambda t: _row("rash")(t).update(irae_category="none"), "irae_category"),
    ("duplicate item", lambda t: t["items"].append(dict(t["items"][0])), "duplicate"),
    ("missing item", lambda t: t["items"].pop(), "exactly the shipped items"),
    ("empty rationale", lambda t: _row("cough")(t).update(rationale=" "), "empty"),
]


@pytest.mark.parametrize(
    ("label", "mutate", "message"), IRAE_BREAKAGE, ids=[b[0] for b in IRAE_BREAKAGE]
)
def test_malformed_irae_mapping(
    monkeypatch: pytest.MonkeyPatch,
    label: str,
    mutate: Callable[[dict[str, Any]], None],
    message: str,
) -> None:
    _patched(monkeypatch, "irae_mapping", mutate)
    with pytest.raises(TableError, match=message):
        tables.irae_mapping()
