"""Plain-language labels and rule sentences (CONTRACTS.md R3.1, CLAUDE.md §00)."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import date
from typing import Any, cast, get_args

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from interim_rules import chartscan, plain_language
from interim_rules.engine import evaluate_checkin
from interim_rules.models import CheckInResult, EvidenceKind
from interim_rules.plain_language import (
    clock_kind,
    clock_name,
    domain_name,
    evidence_kind_name,
    field_labels,
    grade_label,
    has_label,
    label,
    rule_ids,
    rule_sentence,
    tier_name,
)
from interim_rules.serialize import input_from_dict
from interim_rules.tables import TableError, data_dir, load_table

# CONTRACTS.md §6: the demo persona, plus the identifiers input_from_dict needs.
DEMO_PERSONA: dict[str, Any] = {
    "session_id": "01DEMOSESSION000000000000",
    "studyid": "R2810-ONC-1624",
    "usubjid": "R2810-ONC-1624-P-007",
    "completed_at": "2026-10-10T18:04:12.345Z",
    "nct_id": "NCT03088540",
    "settings": {"simulated_as_measured": False},
    "responses": {
        "shortness_of_breath": {"severity": 2, "interference": 2},
        "cough": {"severity": 1, "interference": 0},
        "fatigue": {"severity": 0, "interference": 0},
        "nausea": {"frequency": 0, "severity": 0},
        "diarrhea": {"frequency": 0},
        "rash": {"presence": 0},
        "itching": {"severity": 0},
        "joint_pain": {"severity": 0, "interference": 0},
        "fever_or_chills": {"presence": 0},
        "mouth_sores": {"severity": 0, "interference": 0},
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

# CONTRACTS.md R3.1: ids the protocol module adds to rules_catalog.json (possibly not yet there).
R31_RULE_IDS = (
    "protocol.aesi_suspected",
    "protocol.conmed_prohibited",
    "protocol.conmed_discouraged",
    "protocol.conmed_permitted",
    "protocol.cm_fields_missing",
    "aesi.clock_started",
    "tier.protocol_floor",
)

# Words that would turn a label into advice or a clinical judgment.
BANNED = (
    "should",
    "recommend",
    "advis",
    "diagnos",
    "prescri",
    "treatment",
    "you must",
    "seek ",
    "call 911",
    "emergency room",
)
# "emergency-room visit" (what the participant reported) is fine; the fixed stop-screen text
# is the only place Interim tells anyone to go to an emergency room, and it is not in here.

PROVISIONAL = "provisional, investigator to confirm"
POSSIBLE_AESI = "possible AESI, investigator to confirm"


def _personas() -> list[dict[str, Any]]:
    table = load_table("personas")
    personas = table["personas"]
    assert isinstance(personas, list)
    return personas


def _persona_input(persona: dict[str, Any]) -> dict[str, Any]:
    data = dict(persona)
    data.setdefault("session_id", f"S-{persona['id']}")
    data.setdefault("studyid", "R2810-ONC-1624")
    data.setdefault("usubjid", "R2810-ONC-1624-P-007")
    data.setdefault("completed_at", "2026-10-10T18:04:12.345Z")
    data.setdefault("nct_id", "NCT03088540")
    return data


def _demo_result() -> CheckInResult:
    return evaluate_checkin(input_from_dict(DEMO_PERSONA))


# Extra check-ins that reach the protocol rules (CONTRACTS.md R3.1): a grade 3 diarrhea
# (potentially immune-related -> possible AESI), a discouraged steroid, a prohibited drug.
PROTOCOL_SCENARIOS: tuple[dict[str, Any], ...] = (
    {"responses": {"diarrhea": {"frequency": 4}}, "conmed_text": "prednisone"},
    {"responses": {"cough": {"severity": 1, "interference": 1}}, "conmed_text": "bevacizumab"},
    {"responses": {}, "conmed_text": "denosumab"},
)


def _scenario_input(scenario: dict[str, Any], n: int) -> dict[str, Any]:
    data = dict(DEMO_PERSONA)
    data["session_id"] = f"01PROTOCOLSCENARIO{n:07d}"
    data["responses"] = scenario["responses"]
    data["gates"] = {**DEMO_PERSONA["gates"], "conmed_text": scenario["conmed_text"]}
    return data


def _all_results() -> Iterator[CheckInResult]:
    yield _demo_result()
    for n, scenario in enumerate(PROTOCOL_SCENARIOS):
        yield evaluate_checkin(input_from_dict(_scenario_input(scenario, n)))
    for persona in _personas():
        yield evaluate_checkin(input_from_dict(_persona_input(persona)))


def _catalog_ids() -> set[str]:
    # Read the file at test time (not the cached tables.rules_catalog()) so ids added by
    # another module during the session are checked too.
    with (data_dir() / "rules_catalog.json").open(encoding="utf-8") as fh:
        catalog = json.load(fh)
    return {str(entry["id"]) for entry in catalog["rules"]}


def _all_texts() -> Iterator[tuple[str, str]]:
    table = plain_language.plain_language()
    for name, text in table.fields.items():
        yield f"field {name}", text
    for rule_id, rule in table.rules.items():
        yield f"rule {rule_id}", rule.sentence
        yield f"rule {rule_id} fallback", rule.fallback
    for tier, text in table.tiers.items():
        yield f"tier {tier}", text
    for kind, clock in table.clock_kinds.items():
        yield f"clock {kind}", clock.name
        yield f"clock {kind} note", clock.note
    for kind, text in table.evidence_kinds.items():
        yield f"evidence {kind}", text
    for domain, text in table.domains.items():
        yield f"domain {domain}", text


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    plain_language.plain_language.cache_clear()
    yield
    plain_language.plain_language.cache_clear()


# --------------------------------------------------------------------------- #
# Coverage of fields and rule ids
# --------------------------------------------------------------------------- #


def test_every_demo_persona_draft_field_has_a_label() -> None:
    result = _demo_result()
    assert [d.domain for d in result.drafts] == ["AE", "AE", "VS", "VS", "CM"]
    missing = sorted({f.name for d in result.drafts for f in d.fields if not has_label(f.name)})
    assert missing == []


def test_every_draft_field_across_all_personas_has_a_label() -> None:
    missing: set[str] = set()
    domains: set[str] = set()
    for result in _all_results():
        for draft in result.drafts:
            domains.add(draft.domain)
            missing |= {f.name for f in draft.fields if not has_label(f.name)}
    assert domains == {"AE", "VS", "CM"}
    assert sorted(missing) == []


def test_contract_labels() -> None:
    assert label("AETOXGR") == "Severity grade (provisional)"
    assert label("AEDECOD") == "Side effect (standard term)"
    assert label("CMTRT") == "Medication, as written"
    # Unknown names come back unchanged so a new column never breaks the UI.
    assert label("ZZUNKNOWN") == "ZZUNKNOWN"
    assert not has_label("ZZUNKNOWN")
    assert field_labels(["AETOXGR", "ZZUNKNOWN"]) == {
        "AETOXGR": "Severity grade (provisional)",
        "ZZUNKNOWN": "ZZUNKNOWN",
    }


def test_cm_protocol_required_fields_have_labels() -> None:
    # protocol §7.7 p.69: generic name, dose, dose unit, frequency, indication, start/stop.
    for name in ("CMTRT", "CMDOSE", "CMDOSU", "CMDOSFRQ", "CMINDC", "CMSTDTC", "CMENDTC"):
        assert has_label(name), name


def test_every_catalog_rule_id_has_a_sentence() -> None:
    missing = sorted(_catalog_ids() - rule_ids())
    assert missing == []


def test_contract_r31_rule_ids_have_sentences() -> None:
    assert set(R31_RULE_IDS) <= rule_ids()


def test_no_sentence_for_a_rule_the_engine_cannot_emit() -> None:
    # Every sentence is for a catalog id or an R3.1 id, so stale entries are caught.
    stray = sorted(rule_ids() - _catalog_ids() - set(R31_RULE_IDS))
    assert stray == []


def test_every_fired_rule_fills_its_template() -> None:
    """With the engine's real inputs, no engine rule falls back or leaves a placeholder."""
    table = plain_language.plain_language()
    seen: set[str] = set()
    for result in _all_results():
        for fired in result.rules_fired:
            sentence = rule_sentence(fired.rule_id, fired.inputs)
            seen.add(fired.rule_id)
            assert "{" not in sentence and "}" not in sentence
            rule = table.rules[fired.rule_id]
            complete = all(
                any(
                    fired.inputs.get(key) not in (None, "")
                    for key in (name, *table.aliases.get(name, ()))
                )
                for name in rule.placeholders
            )
            if complete:
                # Every placeholder has a real input: the full sentence, never the fallback.
                assert sentence != rule.fallback or not rule.placeholders, fired.rule_id
            else:
                # e.g. a "yes" with no medication typed, a NOT DONE vitals row.
                assert sentence == rule.fallback, fired.rule_id
    assert {"tier.final", "draft.ae", "conmed.exact", "sae.clock_started"} <= seen
    # Once protocol.py is wired into the engine, its rules are exercised here too.
    if any(rid.startswith("protocol.") for rid in seen):
        assert {
            "protocol.aesi_suspected",
            "aesi.clock_started",
            "protocol.conmed_discouraged",
            "protocol.conmed_prohibited",
            "protocol.conmed_permitted",
            "tier.protocol_floor",
        } <= seen


def test_demo_persona_sentences() -> None:
    by_id = {r.rule_id: r for r in _demo_result().rules_fired}
    grade = by_id["grade.provisional.shortness_of_breath"]
    assert rule_sentence(grade.rule_id, grade.inputs) == (
        f"Shortness of breath is graded 2 ({PROVISIONAL})."
    )
    final = by_id["tier.final"]
    assert rule_sentence(final.rule_id, final.inputs) == (
        "Final alert level: tier 1, Coordinator review."
    )
    cm = by_id["conmed.exact"]
    assert rule_sentence(cm.rule_id, cm.inputs) == (
        "The medication 'loratadine' was found in the medication list as loratadine."
    )


def test_chartscan_rules_fill_their_templates() -> None:
    text = (
        "Pt seen in the ED yesterday for severe diarrhea x3 days, admitted overnight. "
        "Started loperamide. Denies rash. Allergic to penicillin."
    )
    fired = chartscan.rules_fired(chartscan.scan_text(text, date(2026, 10, 10)))
    ids = {f["rule_id"] for f in fired}
    assert "chartscan.symptom" in ids and "chartscan.med" in ids
    for f in fired:
        inputs = f["inputs"]
        assert isinstance(inputs, dict)
        sentence = rule_sentence(str(f["rule_id"]), inputs)
        assert "{" not in sentence
        assert sentence != plain_language.plain_language().rules[str(f["rule_id"])].fallback


# --------------------------------------------------------------------------- #
# Wording rules
# --------------------------------------------------------------------------- #


def test_no_medical_advice_words() -> None:
    offenders = [
        (where, word) for where, text in _all_texts() for word in BANNED if word in text.lower()
    ]
    assert offenders == []


def test_grades_always_say_provisional() -> None:
    table = plain_language.plain_language()
    graded = [
        rid
        for rid in table.rules
        if rid.startswith("grade.provisional.")
        or rid in ("draft.ae", "chartscan.symptom", "tier.base")
    ]
    assert len(graded) == 13
    for rid in graded:
        assert PROVISIONAL in table.rules[rid].sentence, rid
        assert PROVISIONAL in table.rules[rid].fallback, rid


def test_aesi_always_says_possible() -> None:
    table = plain_language.plain_language()
    for rid in ("protocol.aesi_suspected", "aesi.clock_started"):
        assert POSSIBLE_AESI in table.rules[rid].sentence
        assert POSSIBLE_AESI in table.rules[rid].fallback
    assert POSSIBLE_AESI in label("INTERIM_AESI_SUSPECTED")
    assert POSSIBLE_AESI.lower() in clock_kind("aesi").note.lower()


def test_sentences_are_short_single_sentences() -> None:
    for rid, rule in plain_language.plain_language().rules.items():
        for text in (rule.sentence, rule.fallback, *(v.sentence for v in rule.variants)):
            assert len(text) <= 240, rid
            assert text[0].isupper() or text[0] == "{", rid
            assert text.endswith("."), rid


# --------------------------------------------------------------------------- #
# Safe formatting
# --------------------------------------------------------------------------- #


def test_dedup_sentence_says_earlier_today_for_a_same_day_follow_up() -> None:
    """A repeat check-in on the same day must not read '0 days ago' (tester finding)."""
    rid = "dedup.followup_linked"
    same_day = rule_sentence(rid, {"aedecod": "Diarrhea", "days_since": 0})
    assert "earlier today" in same_day and "0 days" not in same_day
    assert "earlier today" in rule_sentence(rid, {"aedecod": "Diarrhea", "days_since": 0.0})
    assert "less than a day ago" in rule_sentence(rid, {"aedecod": "Diarrhea", "days_since": 0.4})
    assert "from 1 day ago" in rule_sentence(rid, {"aedecod": "Diarrhea", "days_since": 1})
    assert "from 3.5 days ago" in rule_sentence(rid, {"aedecod": "Diarrhea", "days_since": 3.5})
    # A missing or non-numeric input never picks a variant and never crashes.
    rule = plain_language.plain_language().rules[rid]
    assert rule_sentence(rid, {"aedecod": "Diarrhea"}) == rule.fallback
    assert "earlier today" not in rule_sentence(rid, {"aedecod": "Diarrhea", "days_since": True})


def test_variant_tables_are_validated() -> None:
    with pytest.raises(TableError):
        plain_language._variants(
            [{"when": {"input": "x", "op": "ne", "value": 0}, "sentence": "A."}], "t"
        )
    with pytest.raises(TableError):
        plain_language._variants(
            [{"when": {"input": "x", "op": "eq", "value": "0"}, "sentence": "A."}], "t"
        )
    with pytest.raises(TableError):
        plain_language._variants({"when": {}}, "t")


def test_missing_inputs_use_the_fallback() -> None:
    rule = plain_language.plain_language().rules["grade.provisional.cough"]
    assert rule_sentence("grade.provisional.cough") == rule.fallback
    assert rule_sentence("grade.provisional.cough", {}) == rule.fallback
    assert rule_sentence("grade.provisional.cough", {"grade": None}) == rule.fallback
    assert rule_sentence("grade.provisional.cough", {"grade": "  "}) == rule.fallback
    assert rule_sentence("grade.provisional.cough", {"grade": float("nan")}) == rule.fallback
    assert rule_sentence("grade.provisional.cough", {"grade": {"nested": 1}}) == rule.fallback


def test_rules_without_placeholders_ignore_inputs() -> None:
    expected = plain_language.plain_language().rules["vitals.unavailable"].sentence
    assert rule_sentence("vitals.unavailable", {"n_samples": 0}) == expected
    assert rule_sentence("vitals.unavailable") == expected


def test_unknown_rule_id_does_not_crash() -> None:
    assert rule_sentence("made.up", {"x": 1}) == "Interim applied the rule 'made.up'."


def test_value_rendering() -> None:
    assert rule_sentence("grade.provisional.cough", {"grade": 2.0}).startswith("Cough is graded 2 ")
    assert "graded 2.5 " in rule_sentence("grade.provisional.cough", {"grade": 2.5})
    assert "graded yes " in rule_sentence("grade.provisional.cough", {"grade": True})
    sentence = rule_sentence(
        "redflag.fever_with_severe", {"severe_items": ["shortness_of_breath", None, "rash"]}
    )
    assert "(shortness_of_breath, rash)" in sentence
    assert "(none)" in rule_sentence("redflag.fever_with_severe", {"severe_items": []})
    long_quote = "x" * 500
    out = rule_sentence("chartscan.med", {"quote": long_quote, "drug": "a", "change": "started"})
    assert "..." in out and len(out) < 300
    assert "'a b'" in rule_sentence("conmed.unmatched", {"verbatim": "  a \n b "})


def test_braces_in_values_are_not_reinterpreted() -> None:
    out = rule_sentence("draft.cm", {"cmtrt": "{verbatim} {__class__}"})
    assert out == "Drafted a medication record for '{verbatim} {__class__}'."


def test_input_aliases() -> None:
    assert rule_sentence("protocol.conmed_prohibited", {"matched_name": "bevacizumab"}).startswith(
        "Bevacizumab is on the study protocol's prohibited list"
    )
    assert rule_sentence("tier.protocol_floor", {"tier_before": 1, "tier_floor": 2}) == (
        "A study-protocol check lifts the alert level from tier 1 to tier 2."
    )
    assert rule_sentence("tier.protocol_floor", {"floor": 2}) == (
        "A study-protocol check lifts the alert level to at least tier 2."
    )
    # SDTM names in the inputs are shown as plain field labels.
    assert rule_sentence("protocol.cm_fields_missing", {"missing": ["CMDOSE", "CMINDC", "ZZ"]}) == (
        "The medication record still needs: Dose, Taken for, ZZ."
    )
    assert rule_sentence("protocol.cm_fields_missing", {"missing": "CMDOSU"}) == (
        "The medication record still needs: Dose unit."
    )
    # Item ids are shown as the item's plain label.
    assert rule_sentence("protocol.aesi_suspected", {"aesi_items": ["rash", "nope", 3]}) == (
        "Possible event of special interest under the study protocol: Skin rash, nope, 3 "
        f"({POSSIBLE_AESI})."
    )
    # The primary name wins over an alias; a missing primary falls through to the alias.
    assert rule_sentence(
        "protocol.conmed_prohibited", {"drug": "bevacizumab", "matched_name": "other"}
    ).startswith("Bevacizumab is")
    assert rule_sentence(
        "protocol.conmed_prohibited", {"drug": None, "cmdecod": "xdrug"}
    ).startswith("Xdrug is")


def test_dotted_input_keys_work() -> None:
    # Engine inputs include dotted keys such as "shortness_of_breath.composite".
    table = plain_language.plain_language()
    assert all(
        re.fullmatch(r"[A-Za-z0-9_.]+", p) for r in table.rules.values() for p in r.placeholders
    )


@settings(max_examples=200, deadline=None)
@given(
    rule_id=st.sampled_from(sorted(plain_language.plain_language().rules) + ["nope"]),
    inputs=st.dictionaries(
        st.text(min_size=1, max_size=20),
        st.one_of(
            st.none(),
            st.booleans(),
            st.integers(),
            st.floats(allow_nan=True, allow_infinity=True),
            st.text(max_size=300),
            st.lists(st.one_of(st.integers(), st.text(max_size=10), st.none()), max_size=5),
            st.dictionaries(st.text(max_size=5), st.integers(), max_size=2),
        ),
        max_size=6,
    ),
)
def test_rule_sentence_never_raises(rule_id: str, inputs: dict[str, object]) -> None:
    out = rule_sentence(rule_id, inputs)
    assert isinstance(out, str) and out


def test_non_mapping_inputs_are_treated_as_empty() -> None:
    bad: Any = ["not", "a", "mapping"]
    rule = plain_language.plain_language().rules["draft.cm"]
    assert rule_sentence("draft.cm", bad) == rule.fallback


# --------------------------------------------------------------------------- #
# Tiers, grades, clocks, evidence kinds, domains
# --------------------------------------------------------------------------- #


def test_tier_names() -> None:
    assert [tier_name(t) for t in range(4)] == [
        "Logged, no action needed",
        "Coordinator review within 1 business day",
        "Nurse call today",
        "Urgent: study team contacts the participant today",
    ]
    for bad in (-1, 4):
        with pytest.raises(ValueError, match="unknown tier"):
            tier_name(bad)
    bad_type: Any = "1"
    with pytest.raises(ValueError, match="integer"):
        tier_name(bad_type)
    with pytest.raises(ValueError, match="integer"):
        tier_name(True)


def test_tier_names_cover_the_ladder() -> None:
    ladder = load_table("escalation_ladder")
    assert set(plain_language.plain_language().tiers) == {t["tier"] for t in ladder["tiers"]}


def test_grade_label() -> None:
    assert grade_label(0) == "none reported"
    assert grade_label(3) == f"severe (grade 3, {PROVISIONAL})"
    with pytest.raises(ValueError, match="0 to 3"):
        grade_label(4)
    with pytest.raises(ValueError, match="integer"):
        grade_label(False)


def test_clock_names_and_protocol_refs() -> None:
    assert clock_name("sae") == "Serious event report due"
    assert clock_name("aesi") == "Special-interest event report due"
    with pytest.raises(ValueError, match="clock kind"):
        clock_name("other")
    with pytest.raises(ValueError, match="clock kind"):
        clock_kind("other")
    excerpt_path = data_dir().parent.parent.parent / "data" / "public"
    excerpt_file = excerpt_path / "empower_lung1_protocol_excerpt.json"
    if not excerpt_file.is_file():  # pragma: no cover - wheel installs do not ship it
        pytest.skip("protocol excerpt not available next to this install")
    excerpt = json.loads(excerpt_file.read_text(encoding="utf-8"))
    pages = {
        page["printed_page"]: page["text"]
        for section in excerpt["sections"].values()
        for page in section
    }
    for kind in ("sae", "aesi"):
        clock = clock_kind(kind)
        assert clock.section in pages[clock.printed_page], kind
        assert "within 24 hours" in pages[clock.printed_page]


def test_evidence_kind_names() -> None:
    for kind in (*get_args(EvidenceKind), "chart_note"):
        assert evidence_kind_name(kind) != kind, kind
    assert evidence_kind_name("pro_response") == "Participant's answer"
    assert evidence_kind_name("brand_new_kind") == "brand_new_kind"


def test_domain_names() -> None:
    assert domain_name("AE") == "Side effect"
    assert domain_name("VS") == "Vital signs"
    assert domain_name("CM") == "Medication change"
    assert domain_name("XX") == "XX"


# --------------------------------------------------------------------------- #
# Table validation
# --------------------------------------------------------------------------- #


def _good_table() -> dict[str, Any]:
    return cast(
        dict[str, Any], json.loads((data_dir() / "plain_language.json").read_text(encoding="utf-8"))
    )


def _break(monkeypatch: pytest.MonkeyPatch, table: dict[str, Any]) -> None:
    monkeypatch.setattr(plain_language, "load_table", lambda name: table)
    plain_language.plain_language.cache_clear()


def test_table_has_source_and_rationale() -> None:
    table = load_table("plain_language")
    assert table["source"].strip() and table["rationale"].strip()
    assert plain_language.PLAIN_LANGUAGE_TABLE_NAMES == ("plain_language",)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda t: t.update(fields=[]), "expected an object"),
        (lambda t: t["fields"].update(AETERM={"label": ""}), "non-empty string"),
        (lambda t: t["fields"].update(AETERM={"label": "x", "domains": "AE"}), "expected a list"),
        (lambda t: t["rules"].update(x={"sentence": "a {b", "fallback": "c."}), "malformed"),
        (lambda t: t["rules"].update(x={"sentence": "a.", "fallback": "{b}."}), "placeholders"),
        (lambda t: t["input_aliases"].update(x="y"), "expected a list"),
        (lambda t: t["render_as"].update(x="shout"), "must be one of"),
        (lambda t: t["tiers"].update(one="x"), "whole numbers"),
        (lambda t: t["clock_kinds"]["sae"]["protocol_ref"].update(printed_page="91"), "integer"),
    ],
)
def test_malformed_table_fails_loudly(
    monkeypatch: pytest.MonkeyPatch, mutate: Any, message: str
) -> None:
    table = _good_table()
    mutate(table)
    _break(monkeypatch, table)
    with pytest.raises(TableError, match=message):
        plain_language.plain_language()
