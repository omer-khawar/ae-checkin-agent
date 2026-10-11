"""Table-driven checks: every JSON table loads, carries provenance, and has the agreed shape."""

from __future__ import annotations

import importlib
import json
import pkgutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

import interim_rules
from interim_rules import tables
from interim_rules.chartscan import CHARTSCAN_TABLE_NAMES
from interim_rules.chartscan import RULE_IDS as CHARTSCAN_RULE_IDS
from interim_rules.narrative import NARRATIVE_TABLE_NAMES
from interim_rules.plain_language import PLAIN_LANGUAGE_TABLE_NAMES
from interim_rules.tables import TABLE_NAMES, TableError
from interim_rules.time_saved import TIME_MODEL_TABLE_NAMES

EXPECTED_ITEMS = [
    ("shortness_of_breath", ("severity", "interference"), "Dyspnea"),
    ("cough", ("severity", "interference"), "Cough"),
    ("fatigue", ("severity", "interference"), "Fatigue"),
    ("nausea", ("frequency", "severity"), "Nausea"),
    ("diarrhea", ("frequency",), "Diarrhea"),
    ("rash", ("presence",), "Rash maculo-papular"),
    ("itching", ("severity",), "Pruritus"),
    ("joint_pain", ("severity", "interference"), "Arthralgia"),
    ("fever_or_chills", ("presence",), "Fever"),
    ("mouth_sores", ("severity", "interference"), "Mucositis oral"),
]

CORE_MEDS = [
    "acetaminophen", "tylenol", "ibuprofen", "advil", "motrin", "naproxen", "aleve", "aspirin",
    "loratadine", "claritin", "cetirizine", "zyrtec", "diphenhydramine", "benadryl", "loperamide",
    "imodium", "omeprazole", "prilosec", "pantoprazole", "famotidine", "pepcid", "ondansetron",
    "zofran", "prednisone", "dexamethasone", "amoxicillin", "azithromycin", "ciprofloxacin",
    "doxycycline", "metformin", "lisinopril", "amlodipine", "atorvastatin", "levothyroxine",
    "metoprolol", "hydrocortisone", "triamcinolone", "gabapentin", "sertraline", "albuterol",
    "melatonin", "vitamin d", "multivitamin",
]  # fmt: skip

STOP_SCREEN_TEXT = (
    "Thank you. A member of the study team will contact you today. If you feel you need "
    "urgent help right now, call 911 or go to the nearest emergency room."
)


@pytest.mark.parametrize("name", TABLE_NAMES)
def test_every_table_has_source_and_rationale(name: str) -> None:
    table = tables.load_table(name)
    assert table["source"].strip() and table["rationale"].strip()
    assert (tables.data_dir() / f"{name}.json").is_file()


def _module_owned_table_names() -> set[str]:
    """Tables that a module other than ``tables`` owns, declared as ``*_TABLE_NAMES``.

    A module that loads and validates its own JSON table (``chartscan``, ``narrative``,
    ``plain_language``, ``time_saved``, and any later one) declares it in a module-level
    tuple named ``<SOMETHING>_TABLE_NAMES``; such tables are not loaded through
    ``tables.TABLE_NAMES``. A table no module declares is an unowned file and fails.
    """
    owned: set[str] = set()
    for info in pkgutil.iter_modules(interim_rules.__path__):
        module = importlib.import_module(f"interim_rules.{info.name}")
        for name, value in vars(module).items():
            if name.endswith("_TABLE_NAMES") and name != "TABLE_NAMES" and module is not tables:
                owned.update(str(v) for v in value)
    return owned


def test_table_names_cover_every_json_file_except_personas() -> None:
    # personas.json is owned by the eval harness; module-owned tables (chartscan_*.json,
    # CONTRACTS.md R2.4; the R3.1 narrative, plain-language and time tables) are declared by
    # their modules. Everything else must be loaded through TABLE_NAMES.
    owned = _module_owned_table_names()
    assert {
        *CHARTSCAN_TABLE_NAMES,
        *NARRATIVE_TABLE_NAMES,
        *PLAIN_LANGUAGE_TABLE_NAMES,
        *TIME_MODEL_TABLE_NAMES,
    } <= owned
    assert not owned & set(TABLE_NAMES)
    on_disk = {p.stem for p in tables.data_dir().glob("*.json")} - {"personas", *owned}
    assert on_disk == set(TABLE_NAMES)


def test_items_shape_and_order() -> None:
    shipped = tables.items()
    assert [(i.id, i.attributes, i.ctcae_term) for i in shipped] == EXPECTED_ITEMS
    assert [i.order for i in shipped] == list(range(1, 11))
    for item in shipped:
        assert item.recall_window == "in the last 7 days"
        for attr in item.attributes:
            assert item.prompts[attr].startswith("In the last 7 days")
            options = item.response_options[attr]
            expected_max = 1 if attr == "presence" else 4
            assert sorted(options.values()) == list(range(expected_max + 1))
            assert item.max_value(attr) == expected_max
            assert item.option_label(attr, 0) is not None
        assert item.option_label(item.attributes[0], 99) is None
    assert tables.item_by_id("cough").label == "Cough"
    assert tables.item_map()["rash"].attributes == ("presence",)
    assert tables.recall_window() == "in the last 7 days"
    assert tables.item_by_id("fever_or_chills").optional_gate_fields == ("temp_c",)


def test_unknown_item_raises() -> None:
    with pytest.raises(ValueError):
        tables.item_by_id("nope")


def test_gate_questions() -> None:
    questions = tables.gate_questions()
    assert [q.id for q in questions] == ["hospitalization", "conmed", "other"]
    assert [q.field for q in questions] == ["hospitalization", "conmed_changed", "other_text"]
    assert questions[0].raw["seriousness_trigger"] is True
    assert "never parsed" in questions[2].raw["note"]


def test_composite_tables_reproduce_published_rows() -> None:
    comp = tables.composite_tables()
    assert comp.reproduced_verbatim is True
    # 179 published combinations: 101 three-attribute, 3 x 21 two-attribute, 3 x 5 single.
    assert len(comp.three) == 101
    assert len(comp.freq_sev) == len(comp.sev_int) == len(comp.freq_int) == 21
    assert all(len(comp.single[a]) == 5 for a in ("frequency", "severity", "interference"))
    assert comp.single["severity"] == {0: 0, 1: 1, 2: 2, 3: 3, 4: 3}
    assert comp.single["frequency"] == {0: 0, 1: 1, 2: 1, 3: 2, 4: 3}
    assert comp.single["interference"] == {0: 0, 1: 1, 2: 1, 3: 2, 4: 2}
    assert comp.presence == {0: 0, 1: 1}
    assert comp.zero_gate == {
        "three_attribute": "frequency",
        "two_attribute_freq_sev": "frequency",
        "two_attribute_sev_int": "severity",
        "two_attribute_freq_int": "frequency",
    }
    # Spot checks against the published table.
    assert comp.three[(1, 2, 4)] == 3
    assert comp.three[(4, 1, 2)] == 2
    assert comp.three[(2, 2, 2)] == 2
    assert comp.sev_int[(3, 0)] == 1
    assert comp.sev_int[(2, 2)] == 2
    assert comp.freq_sev[(3, 3)] == 3
    assert comp.freq_sev[(2, 4)] == 2


def test_composite_tables_are_monotone_and_within_range() -> None:
    comp = tables.composite_tables()

    def check(table: dict[tuple[int, ...], int], arity: int) -> None:
        for key, value in table.items():
            assert 0 <= value <= 3
            for pos in range(arity):
                bumped = list(key)
                bumped[pos] += 1
                if tuple(bumped) in table:
                    assert table[tuple(bumped)] >= value, (key, bumped)

    check(dict(comp.three), 3)
    check(dict(comp.freq_sev), 2)
    check(dict(comp.sev_int), 2)
    check(dict(comp.freq_int), 2)
    for mapping in comp.single.values():
        assert [mapping[i] for i in range(5)] == sorted(mapping[i] for i in range(5))


def test_grade_map() -> None:
    grade = tables.grade_map()
    assert grade.map == {0: 0, 1: 1, 2: 2, 3: 3}
    assert grade.max_assignable_grade == 3
    assert "provisional" in grade.grade_label


def test_red_flags_table() -> None:
    table = tables.red_flag_table()
    assert [r.id for r in table.rules] == [
        "redflag.severe_dyspnea",
        "redflag.fever_with_severe",
        "redflag.hospitalization",
        "redflag.other_text_with_severe",
    ]
    floors = {r.id: r.tier_floor for r in table.rules}
    assert floors["redflag.severe_dyspnea"] == 3
    assert floors["redflag.hospitalization"] == 3
    assert floors["redflag.fever_with_severe"] == 2
    assert floors["redflag.other_text_with_severe"] == 2
    assert [r.seriousness for r in table.rules] == [False, False, True, False]
    assert "never parsed" in floors and False or "never parsed" in table.rules[3].effect
    assert table.severe_item.severity_attribute_min == 3
    assert table.severe_item.no_severity_attribute_composite_min == 3


def test_vitals_config() -> None:
    cfg = tables.vitals_config()
    assert cfg.min_confidence == 0.6
    assert cfg.plausibility["pulse"].min == 35 and cfg.plausibility["pulse"].max == 180
    assert cfg.plausibility["breathing"].min == 5 and cfg.plausibility["breathing"].max == 45
    assert cfg.plausibility["pulse"].contains(72) and not cfg.plausibility["pulse"].contains(200)
    assert cfg.min_window_s == {"pulse": 12.0, "breathing": 30.0, "hrv": 60.0}
    assert cfg.simulated_sources == ("mock",)
    assert cfg.max_tier_bump == 1
    assert cfg.method_measured == "Contactless optical, camera-based"
    assert cfg.method_simulated == "Simulated"
    assert [r.id for r in cfg.rules] == [
        "corr.tachypnea_dyspnea",
        "corr.tachycardia_dyspnea",
        "corr.tachycardia_fever",
    ]
    reasons = {r.id: r.reason for r in cfg.rules}
    assert reasons["corr.tachypnea_dyspnea"] == "tachypnea corroborates reported dyspnea"
    assert reasons["corr.tachycardia_dyspnea"] == "tachycardia with reported dyspnea"
    assert all(r.tier_bump == 1 for r in cfg.rules)


def test_escalation_ladder() -> None:
    ladder = tables.escalation_ladder()
    assert ladder.max_tier == 3
    assert ladder.base_tier_by_max_grade == {0: 0, 1: 0, 2: 1, 3: 2}
    assert [ladder.tiers[t].name for t in range(4)] == [
        "Log",
        "Coordinator review",
        "Nurse call today",
        "Urgent",
    ]
    assert ladder.tiers[3].stop_screen and ladder.tiers[3].page_oncall
    assert ladder.tiers[3].stop_screen_text == STOP_SCREEN_TEXT
    assert not any(ladder.tiers[t].stop_screen for t in range(3))


def test_seriousness_config() -> None:
    cfg = tables.seriousness_config()
    assert cfg.site_to_sponsor_hours == 24
    assert cfg.fatal_or_life_threatening_days == 7
    assert cfg.other_serious_days == 15
    assert "312.32" in cfg.sponsor_clock_source
    assert cfg.trigger_gates == ("hospitalization",)
    assert len(cfg.criteria) == 6


def test_ctcae_terms() -> None:
    terms = tables.ctcae_terms()
    assert set(terms) == {item_id for item_id, _, _ in EXPECTED_ITEMS}
    for item_id, _, aedecod in EXPECTED_ITEMS:
        term = terms[item_id]
        assert term.aedecod == aedecod
        assert term.aedecod == tables.item_by_id(item_id).ctcae_term
        assert term.meddra_code_mock.startswith("MOCK-")
        assert term.grade_definitions[1] and term.grade_definitions[3]
    assert terms["shortness_of_breath"].grade_definitions[3] == (
        "Shortness of breath at rest; limiting self care ADL"
    )
    assert terms["fever_or_chills"].note is not None and "chills" in terms["fever_or_chills"].note
    assert terms["cough"].grade_definitions[4] is None
    assert tables.ctcae_term_for_item("nausea").aedecod == "Nausea"
    with pytest.raises(TableError):
        tables.ctcae_term_for_item("nope")


def test_medlist_core_and_schema() -> None:
    meds = tables.medlist()
    assert meds.is_rxnorm is False
    names = {e.name: e for e in meds.entries}
    for core in CORE_MEDS:
        assert core in names, core
    assert names["claritin"].generic == "loratadine" and names["claritin"].kind == "brand"
    assert names["loratadine"].kind == "generic"
    assert all(e.name == e.name.lower() for e in meds.entries)
    assert len(meds.entries) >= 200
    raw = json.loads((tables.data_dir() / "medlist.json").read_text(encoding="utf-8"))
    assert set(raw["entries"][0]) == {"name", "kind", "generic"}
    assert "NOT RxNorm" in raw["source"] or "NOT RxNorm" in raw["rationale"]


def test_conmed_matching_and_dedup_config() -> None:
    cfg = tables.conmed_matching_config()
    assert (cfg.max_levenshtein_distance, cfg.min_token_length, cfg.top_candidates) == (2, 4, 3)
    assert cfg.min_levenshtein_confidence == 0.7
    dedup = tables.dedup_config()
    assert dedup.window_days == 7 and dedup.max_future_skew_s == 300.0


def test_rules_catalog_is_complete() -> None:
    catalog = tables.rules_catalog()
    expected = {
        *(f"score.composite.{i}" for i, _, _ in EXPECTED_ITEMS),
        *(f"grade.provisional.{i}" for i, _, _ in EXPECTED_ITEMS),
        "redflag.severe_dyspnea",
        "redflag.fever_with_severe",
        "redflag.hospitalization",
        "redflag.other_text_with_severe",
        "vitals.unavailable",
        "vitals.low_quality",
        "vitals.implausible",
        "vitals.simulated_ignored",
        "vitals.simulated_as_measured",
        "vitals.summary",
        "corr.tachypnea_dyspnea",
        "corr.tachycardia_dyspnea",
        "corr.tachycardia_fever",
        "tier.base",
        "tier.redflag_floor",
        "tier.corroboration_bump",
        "tier.final",
        "sae.clock_started",
        "conmed.exact",
        "conmed.case_insensitive",
        "conmed.levenshtein",
        "conmed.unmatched",
        "dedup.followup_linked",
        "dedup.new_ae",
        "draft.ae",
        "draft.vs",
        "draft.cm",
        "tier.protocol_floor",
        "protocol.aesi_suspected",
        "aesi.clock_started",
        "aesi.clock_not_restarted",
        "protocol.conmed_prohibited",
        "protocol.conmed_discouraged",
        "protocol.conmed_permitted",
        "protocol.cm_fields_missing",
        *CHARTSCAN_RULE_IDS,
    }
    assert set(catalog) == expected
    categories = set(tables.load_table("rules_catalog")["categories"])
    assert all(entry.category in categories for entry in catalog.values())
    assert all(entry.description_template for entry in catalog.values())


# --------------------------------------------------------------------------- #
# Malformed tables fail loudly
# --------------------------------------------------------------------------- #


_CONFIG_CACHES = (
    tables.vitals_config,
    tables.dedup_config,
    tables.conmed_matching_config,
)


def _with_tables(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **files: object) -> None:
    for name, content in files.items():
        (tmp_path / f"{name}.json").write_text(json.dumps(content), encoding="utf-8")
    monkeypatch.setattr(tables, "data_dir", lambda: tmp_path)
    tables.load_table.cache_clear()
    for cached in _CONFIG_CACHES:
        cached.cache_clear()


def _variant(name: str, **changes: object) -> dict[str, Any]:
    """The real table ``name`` with top-level keys replaced (``None`` deletes the key)."""
    table = dict(tables.load_table(name))
    for key, value in changes.items():
        if value is None:
            table.pop(key, None)
        else:
            table[key] = value
    return table


@pytest.fixture(autouse=True)
def _restore_table_cache() -> Iterator[None]:
    yield
    tables.load_table.cache_clear()
    for cached in _CONFIG_CACHES:
        cached.cache_clear()


def test_data_dir_skips_a_candidate_without_the_sentinel_table(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An unrelated ``data/`` directory next to the package must not shadow the real one."""
    real = tables.data_dir()
    stray = tmp_path / "data"
    stray.mkdir()
    (stray / "unrelated.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(tables, "_CANDIDATE_DATA_DIRS", (stray, real))
    assert tables.data_dir() == real


def test_missing_table(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _with_tables(monkeypatch, tmp_path)
    with pytest.raises(TableError, match="not found"):
        tables.load_table("dedup")


def test_table_without_provenance(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _with_tables(monkeypatch, tmp_path, dedup={"window_days": 7})
    with pytest.raises(TableError, match="source"):
        tables.load_table("dedup")


def test_table_not_an_object(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _with_tables(monkeypatch, tmp_path, dedup=[1, 2, 3])
    with pytest.raises(TableError, match="top level"):
        tables.load_table("dedup")


def test_missing_data_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tables, "_CANDIDATE_DATA_DIRS", (tmp_path / "nope",))
    with pytest.raises(TableError, match="data directory"):
        tables.data_dir()


_PROVENANCE = {"source": "s", "rationale": "r"}


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ({**_PROVENANCE, "window_days": "7", "max_future_skew_s": 300}, "expected integer"),
        ({**_PROVENANCE, "window_days": True, "max_future_skew_s": 300}, "expected integer"),
        ({**_PROVENANCE, "window_days": 7}, "max_future_skew_s"),
        ({**_PROVENANCE, "window_days": 7, "max_future_skew_s": -1}, "negative"),
    ],
)
def test_validators_reject_wrong_types(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, raw: object, message: str
) -> None:
    _with_tables(monkeypatch, tmp_path, dedup=raw)
    with pytest.raises(TableError, match=message):
        tables.dedup_config()


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"min_window_s": None}, "min_window_s"),
        ({"min_window_s": {"pulse": 0}}, "must be positive"),
        ({"min_window_s": {"pulse": "12"}}, "expected number"),
        ({"simulated_sources": None}, "simulated_sources"),
        ({"simulated_sources": [1]}, "expected string"),
    ],
)
def test_vitals_table_validates_window_and_source_keys(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, changes: dict[str, object], message: str
) -> None:
    variant = _variant("vitals_corroboration", **changes)
    _with_tables(monkeypatch, tmp_path, vitals_corroboration=variant)
    with pytest.raises(TableError, match=message):
        tables.vitals_config()


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"min_levenshtein_confidence": None}, "min_levenshtein_confidence"),
        ({"min_levenshtein_confidence": 1.5}, "within 0..1"),
        ({"min_levenshtein_confidence": "0.7"}, "expected number"),
    ],
)
def test_conmed_table_validates_the_confidence_floor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, changes: dict[str, object], message: str
) -> None:
    variant = _variant("conmed_matching", **changes)
    _with_tables(monkeypatch, tmp_path, conmed_matching=variant)
    with pytest.raises(TableError, match=message):
        tables.conmed_matching_config()


def test_validator_helpers_directly() -> None:
    assert tables._as_str("x", "w") == "x"
    assert tables._as_int(3, "w") == 3
    assert tables._as_number(3, "w") == 3.0
    assert tables._as_bool(True, "w") is True
    assert tables._as_list([1], "w") == [1]
    assert tables._as_dict({"a": 1}, "w") == {"a": 1}
    assert tables._as_attribute("severity", "w") == "severity"
    assert tables._int_keyed({"1": 2}, "w") == {1: 2}
    for fn, bad in [
        (tables._as_str, 1),
        (tables._as_int, "1"),
        (tables._as_number, "1"),
        (tables._as_number, True),
        (tables._as_bool, 1),
        (tables._as_list, {}),
        (tables._as_dict, []),
        (tables._as_attribute, "colour"),
        (tables._int_keyed, {"x": 1}),
    ]:
        with pytest.raises(TableError):
            fn(bad, "w")
