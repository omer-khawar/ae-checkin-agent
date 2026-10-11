"""Coordinator time-saved estimate (CONTRACTS.md R3.1, CLAUDE.md §00.5)."""

from __future__ import annotations

import json
import math
from collections.abc import Iterator
from typing import Any, cast

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from interim_rules import time_saved
from interim_rules.engine import evaluate_checkin
from interim_rules.plain_language import has_label
from interim_rules.serialize import input_from_dict
from interim_rules.tables import TableError, data_dir, load_table
from interim_rules.time_saved import (
    category_key,
    countable_fields,
    edited_count,
    estimate,
    prefilled_count,
    time_model,
    weekly_baseline_minutes,
    weekly_context,
)

CATEGORIES = ("AE", "CM", "VS", "SAE_FORM", "NARRATIVE_PARAGRAPH", "BRIEF_SECTION")

DEMO = {
    "session_id": "01DEMOSESSION000000000000",
    "studyid": "R2810-ONC-1624",
    "usubjid": "R2810-ONC-1624-P-007",
    "completed_at": "2026-10-10T18:04:12.345Z",
    "nct_id": "NCT03088540",
    "responses": {
        "shortness_of_breath": {"severity": 2, "interference": 2},
        "cough": {"severity": 1, "interference": 0},
    },
    "gates": {
        "hospitalization": False,
        "conmed_changed": True,
        "conmed_text": "loratadine",
        "conmed_direction": "started",
        "other_text": "",
    },
    "vitals_samples": [
        {
            "tsOffsetS": 0,
            "source": "mock",
            "isMeasured": False,
            "pulseBpm": 72,
            "pulseConf": 0.9,
            "breathingBpm": 14,
            "breathingConf": 0.85,
            "windowS": 30,
            "qualityFlags": [],
        }
    ],
}


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    time_saved.time_model.cache_clear()
    yield
    time_saved.time_model.cache_clear()


# --------------------------------------------------------------------------- #
# Arithmetic
# --------------------------------------------------------------------------- #


def test_worked_example() -> None:
    out = estimate({"AE": 6, "CM": 7, "VS": 8}, {"AE": 1, "VS": 2})
    # AE 5 x 1.0 + CM 7 x 0.75 + VS 6 x 0.1 = 5 + 5.25 + 0.6
    assert out["minutes_saved"] == 10.85
    # AE 6 x 1.0 + CM 7 x 0.75 + VS 8 x 0.1 = 6 + 5.25 + 0.8
    assert out["minutes_manual_baseline"] == 12.05
    assert out["is_estimate"] is True
    assert out["disclaimer"] == "estimate"
    assert [b["category"] for b in out["breakdown"]] == ["AE", "CM", "VS"]
    ae = out["breakdown"][0]
    assert (ae["prefilled"], ae["edited"], ae["saved_units"]) == (6, 1, 5)
    assert (ae["minutes_saved"], ae["minutes_manual_baseline"], ae["basis"]) == (
        5.0,
        6.0,
        "assumption",
    )
    assert out["breakdown"][2]["basis"] == "source"
    assert out["basis"][0] == (
        "AE fields: 6 pre-filled, 1 edited by a person (edited ones save nothing), so 5 x 1 min "
        "= 5 min saved; typing all 6 by hand would take 6 x 1 min = 6 min (assumed rate)."
    )
    assert "7 x 0.75 min = 5.25 min saved" in out["basis"][1]
    assert out["basis"][2].endswith("(sourced rate).")
    assert out["basis"][-2] == "Total: 10.85 min saved out of 12.05 min of manual work (estimate)."
    assert "estimate" in out["basis"][-1].lower()


def test_edited_fields_earn_nothing() -> None:
    out = estimate({"AE": 4}, {"AE": 4})
    assert out["minutes_saved"] == 0.0
    assert out["minutes_manual_baseline"] == 4.0


def test_packet_narrative_and_brief() -> None:
    out = estimate(
        {"SAE_FORM": 12, "NARRATIVE_PARAGRAPH": 3, "BRIEF_SECTION": 6},
        {"SAE_FORM": 2, "NARRATIVE_PARAGRAPH": 1},
    )
    # 10 x 1.5 + 2 x 10 + 6 x 5 = 15 + 20 + 30
    assert out["minutes_saved"] == 65.0
    # 12 x 1.5 + 3 x 10 + 6 x 5 = 18 + 30 + 30
    assert out["minutes_manual_baseline"] == 78.0
    assert "Narrative paragraphs: 3 pre-filled, 1 edited" in out["basis"][1]


def test_aliases_and_case_are_accepted_and_summed() -> None:
    out = estimate({"aesi": 2, "SAE": 1, "ae": 1, "Brief": 1}, {})
    # SAE_FORM 3 x 1.5 + AE 1 x 1 + BRIEF_SECTION 1 x 5
    assert out["minutes_saved"] == 10.5
    assert category_key(" narrative ") == "NARRATIVE_PARAGRAPH"
    assert category_key("nope") is None


def test_more_edits_than_prefilled_are_capped() -> None:
    out = estimate({"CM": 2}, {"CM": 5})
    assert out["minutes_saved"] == 0.0
    assert out["minutes_manual_baseline"] == 1.5
    assert out["breakdown"][0]["edited"] == 2
    assert "5 edits were reported for 2 pre-filled; counted as 2." in out["basis"][0]


def test_edits_without_prefill_are_listed_but_cost_nothing() -> None:
    out = estimate({}, {"VS": 3})
    assert out["minutes_saved"] == 0.0 and out["minutes_manual_baseline"] == 0.0
    assert out["breakdown"][0]["prefilled"] == 0


def test_unknown_categories_earn_nothing() -> None:
    out = estimate({"LAB": 10, "AE": 1, "XYZ": 0}, {"OTHER": 2})
    assert out["minutes_saved"] == 1.0
    assert "'LAB' is not in the time model, so it counts for no time saved." in out["basis"]
    assert "'OTHER' is not in the time model, so it counts for no time saved." in out["basis"]
    assert not any("XYZ" in line for line in out["basis"])


def test_empty_input() -> None:
    out = estimate({}, {})
    assert out["minutes_saved"] == 0.0 and out["minutes_manual_baseline"] == 0.0
    assert out["breakdown"] == []
    assert out["basis"][0] == "Total: 0 min saved out of 0 min of manual work (estimate)."


@pytest.mark.parametrize("bad", [-1, 1.5, True, "3", None])
def test_bad_counts_raise(bad: Any) -> None:
    with pytest.raises(ValueError, match="prefilled_fields"):
        estimate({"AE": bad}, {})
    with pytest.raises(ValueError, match="edited_fields"):
        estimate({"AE": 1}, {"AE": bad})


def test_result_is_json_safe() -> None:
    out = estimate({"AE": 3, "SAE": 2}, {"AE": 1})
    assert json.loads(json.dumps(out, allow_nan=False)) == out


counts = st.dictionaries(st.sampled_from(CATEGORIES), st.integers(0, 500), max_size=6)


@settings(max_examples=200, deadline=None)
@given(prefilled=counts, edited=counts)
def test_properties(prefilled: dict[str, int], edited: dict[str, int]) -> None:
    out = estimate(prefilled, edited)
    assert 0.0 <= out["minutes_saved"] <= out["minutes_manual_baseline"]
    # The baseline depends only on what was pre-filled.
    assert out["minutes_manual_baseline"] == estimate(prefilled, {})["minutes_manual_baseline"]
    # No edits -> the whole baseline is saved.
    assert estimate(prefilled, {})["minutes_saved"] == out["minutes_manual_baseline"]
    # One more edit never increases the saving; one more pre-filled field never lowers it.
    for key in CATEGORIES:
        more_edits = {**edited, key: edited.get(key, 0) + 1}
        assert estimate(prefilled, more_edits)["minutes_saved"] <= out["minutes_saved"]
        more_prefilled = {**prefilled, key: prefilled.get(key, 0) + 1}
        assert estimate(more_prefilled, edited)["minutes_saved"] >= out["minutes_saved"]
    # Totals equal the sum of the per-category rows.
    assert math.isclose(
        sum(b["minutes_saved"] for b in out["breakdown"]), out["minutes_saved"], abs_tol=0.011
    )


# --------------------------------------------------------------------------- #
# The table
# --------------------------------------------------------------------------- #


def test_table_shape_and_sources() -> None:
    table = load_table("time_model")
    assert table["disclaimer"] == "estimate"
    assert time_saved.TIME_MODEL_TABLE_NAMES == ("time_model",)
    model = time_model()
    assert tuple(model.categories) == CATEGORIES
    for key, raw in table["categories"].items():
        assert raw["source"].strip(), key
        if raw["basis"] == "assumption":
            assert raw["derivation"].startswith("Assumption"), key
            assert "Assumption" in raw["source"], key
        else:
            assert "https://" in raw["source"], key
    for needle in ("12 to 15 hours", "6.57%", "58%", "https://"):
        assert needle in table["source"], needle
    assert "https://" in table["weekly_baseline"]["source"]
    assert {c["id"] for c in table["context_sources"]} == {
        "abstraction_error_rate",
        "msk_productivity",
    }


def test_vs_rate_is_derived_from_the_msk_anchor() -> None:
    anchor = load_table("time_model")["anchor_rate"]
    per_field = 60 / (anchor["data_points"] / anchor["person_hours"])
    assert round(per_field, 3) == anchor["minutes_per_field"] == 0.099
    model = time_model()
    assert model.categories["VS"].minutes_per_unit == round(per_field, 1)
    # Assumed field rates are stated multiples of the sourced one.
    vs = model.categories["VS"].minutes_per_unit
    for key, multiple in (("AE", 10), ("CM", 7.5), ("SAE_FORM", 15)):
        assert model.categories[key].minutes_per_unit == pytest.approx(vs * multiple)
        assert f"{multiple:g} x the MSK" in model.categories[key].derivation


def test_sae_form_cites_the_protocol() -> None:
    ref = load_table("time_model")["categories"]["SAE_FORM"]["protocol_ref"]
    assert ref == {"section": "9.4.2", "printed_page": 91}
    cm_ref = load_table("time_model")["countable_fields"]["protocol_ref"]
    assert cm_ref == {"section": "7.7", "printed_page": 69}


def test_weekly_baseline() -> None:
    assert weekly_baseline_minutes() == (720.0, 900.0)
    text = weekly_context(72)
    assert text == (
        "About 72 min saved (estimate); for comparison, coordinators report 12-15 h per study "
        "per week copying EHR data into the EDC, so this is about 10% of the lower figure."
    )
    for bad in (-1, float("nan"), True, "5"):
        with pytest.raises(ValueError, match="minutes_saved"):
            weekly_context(bad)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Field counting helpers (used by the API on confirm)
# --------------------------------------------------------------------------- #


def _demo_drafts() -> list[tuple[str, dict[str, object]]]:
    result = evaluate_checkin(input_from_dict(DEMO))
    return [(d.domain, {f.name: f.value for f in d.fields}) for d in result.drafts]


def test_prefilled_counts_on_the_demo_persona() -> None:
    drafts = _demo_drafts()
    assert [(domain, prefilled_count(domain, fields)) for domain, fields in drafts] == [
        ("AE", 5),  # AETERM, AEDECOD, AESTDTC, AEONGO, AETOXGR
        ("AE", 5),
        ("VS", 5),  # VSTESTCD, VSORRES, VSORRESU, VSDTC, VSMETHOD (VSSTAT empty)
        ("VS", 5),
        ("CM", 3),  # CMTRT, CMDECOD, CMSTDTC
    ]


def test_edited_count() -> None:
    domain, fields = _demo_drafts()[0]
    confirmed = {**fields, "AETOXGR": 1, "AEOUT": "RECOVERING", "STUDYID": "changed"}
    # AETOXGR was pre-filled and changed; AEOUT was empty (the person's own work); STUDYID
    # is not a countable field.
    assert edited_count(domain, fields, confirmed) == 1
    assert edited_count(domain, fields, fields) == 0


def test_filled_values() -> None:
    fields: dict[str, object] = {
        "CMTRT": "  ",
        "CMDECOD": "x",
        "CMDOSE": 0,
        "CMDOSU": [],
        "CMDOSFRQ": ["QD"],
    }
    assert prefilled_count("cm", fields) == 3


def test_countable_fields() -> None:
    assert countable_fields("AE")[0] == "AETERM"
    assert "STUDYID" not in countable_fields("AE")
    with pytest.raises(ValueError, match="unknown domain"):
        countable_fields("LB")
    for domain in ("AE", "VS", "CM"):
        for name in countable_fields(domain):
            assert has_label(name), name


# --------------------------------------------------------------------------- #
# Table validation
# --------------------------------------------------------------------------- #


def _good_table() -> dict[str, Any]:
    return cast(
        dict[str, Any], json.loads((data_dir() / "time_model.json").read_text(encoding="utf-8"))
    )


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda t: t.update(disclaimer="measured"), "must be 'estimate'"),
        (lambda t: t.update(disclaimer=""), "non-empty string"),
        (lambda t: t.update(categories={}), "must not be empty"),
        (lambda t: t.update(categories=[]), "expected an object"),
        (lambda t: t["categories"]["AE"].update(basis="guess"), "'source' or 'assumption'"),
        (lambda t: t["categories"]["AE"].update(minutes_per_unit=-1), "finite number"),
        (lambda t: t["categories"]["AE"].update(minutes_per_unit=True), "expected a number"),
        (lambda t: t["aliases"].update(X="NOPE"), "unknown category"),
        (lambda t: t["countable_fields"].update(AE=[]), "non-empty list"),
        (lambda t: t["weekly_baseline"].update(hours_low=20), "hours_low must be"),
    ],
)
def test_malformed_table_fails_loudly(
    monkeypatch: pytest.MonkeyPatch, mutate: Any, message: str
) -> None:
    table = _good_table()
    mutate(table)
    monkeypatch.setattr(time_saved, "load_table", lambda name: table)
    time_saved.time_model.cache_clear()
    with pytest.raises(TableError, match=message):
        time_model()
