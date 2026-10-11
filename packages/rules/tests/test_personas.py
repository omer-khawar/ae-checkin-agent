"""The persona answer key (CLAUDE.md §8, CONTRACTS.md §6), replayed through the engine.

``data/personas.json`` is the deterministic answer key the eval harness compares the
running system against. These tests replay every persona through
:func:`interim_rules.engine.evaluate_checkin` directly (the harness replays them through
the API) and assert every expected field, so the answer key and the engine cannot drift
apart silently. ``setup.prior_checkins`` are materialized into :class:`OpenAE` entries
exactly as the API would after confirming their AE drafts.

The file-level tests pin the shape the harness relies on: the category mix, id prefixes,
explicit answers for every attribute of every item, the vitals sample schedule, and that
every rule id named in an expectation exists in ``rules_catalog.json``.

Protocol personas (category ``protocol``, prefix ``P3-``, CONTRACTS.md R3.1) carry an
optional top-level ``protocol_context`` that is passed to the engine, and may pin the
protocol keys ``protocol_tier_floor``, ``aesi_suspected``, ``aesi_clock_started``,
``aesi_items`` and ``cm[].protocol_flag`` / ``cm[].missing_fields``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from itertools import pairwise
from typing import Any, cast

import pytest

from interim_rules.engine import evaluate_checkin
from interim_rules.models import CheckInInput, CheckInResult, DraftRecord, OpenAE
from interim_rules.serialize import input_from_dict, result_to_dict
from interim_rules.tables import data_dir, items, rules_catalog
from interim_rules.timefmt import iso_date, shift

PERSONAS_PATH = data_dir() / "personas.json"
STUDY = "R2810-ONC-1624"
NCT_ID = "NCT03088540"
COMPLETED_AT = "2026-10-10T18:03:00.000Z"
"""A fixed 'now' for every replay: the engine never reads the clock, so neither do we."""
SESSION_SECONDS = 180
"""Kiosk time from session start to completion; vitals offsets are relative to the start."""
SITE_TO_SPONSOR_HOURS = 24

PREFIX_BY_CATEGORY = {
    "tier0": "T0-",
    "tier1": "T1-",
    "tier2": "T2-",
    "tier3": "T3-",
    "edge": "E-",
    "judge": "J-",
    "protocol": "P3-",
}
REQUIRED_MIX = {
    "tier0": 6,
    "tier1": 6,
    "tier2": 5,
    "tier3": 4,
    "edge": 3,
    "judge_hidden": 5,
    "protocol": 7,
}
REQUIRED_EXPECTED_KEYS = {
    "grades",
    "tier",
    "stop_screen",
    "rules_fired_includes",
    "rules_fired_excludes",
    "sae_clock_started",
    "seriousness_suspected",
    "ae_drafts",
    "vs_drafts",
    "cm",
    "dedup_followups",
}
ID_PATTERN = re.compile(r"^(T0|T1|T2|T3|E|J|P3)(-[a-z0-9]+)+$")

Persona = dict[str, Any]


def _load_answer_key() -> dict[str, Any]:
    with PERSONAS_PATH.open(encoding="utf-8") as fh:
        return cast(dict[str, Any], json.load(fh))


ANSWER_KEY = _load_answer_key()
PERSONAS: list[Persona] = list(ANSWER_KEY["personas"])
PERSONA_IDS: list[str] = [str(p["id"]) for p in PERSONAS]
WITH_COUNTERFACTUALS = [p for p in PERSONAS if p.get("counterfactuals")]


# --------------------------------------------------------------------------- #
# Replay helpers
# --------------------------------------------------------------------------- #


def usubjid_for(persona: Persona) -> str:
    """Every persona is its own synthetic participant so open AEs never leak across personas."""
    return f"{STUDY}-EVAL-{persona['id']}"


def _checkin_input(
    *,
    session_id: str,
    usubjid: str,
    completed_at: str,
    responses: object,
    gates: object,
    vitals: Sequence[object],
    open_aes: Sequence[OpenAE],
    settings: object,
    protocol_context: object = None,
) -> CheckInInput:
    return input_from_dict(
        {
            "session_id": session_id,
            "studyid": STUDY,
            "nct_id": NCT_ID,
            "usubjid": usubjid,
            "completed_at": completed_at,
            "started_at": shift(completed_at, seconds=-SESSION_SECONDS),
            "responses": responses,
            "gates": gates,
            "vitals": list(vitals),
            "open_aes": list(open_aes),
            "settings": settings,
            "next_aeseq": 1,
            "protocol_context": protocol_context,
        }
    )


def materialize_open_aes(persona: Persona, completed_at: str) -> list[OpenAE]:
    """Replay ``setup.prior_checkins`` oldest-first; each confirmed AE draft becomes an open AE.

    A prior check-in that itself links to an earlier open AE updates that AE's
    ``last_reported_at`` (what the API does on a confirmed follow-up) instead of opening
    a second one.
    """
    open_aes: list[OpenAE] = []
    priors = sorted(persona["setup"].get("prior_checkins", []), key=lambda p: -float(p["days_ago"]))
    for index, prior in enumerate(priors):
        session_id = f"{persona['id']}:prior{index}"
        prior_completed = shift(completed_at, days=-float(prior["days_ago"]))
        result = evaluate_checkin(
            _checkin_input(
                session_id=session_id,
                usubjid=usubjid_for(persona),
                completed_at=prior_completed,
                responses=prior["responses"],
                gates=prior.get("gates", {}),
                vitals=prior.get("vitals_samples", []),
                open_aes=open_aes,
                settings=persona.get("settings", {}),
                protocol_context=persona.get("protocol_context"),
            )
        )
        for draft in result.drafts:
            if draft.domain != "AE":
                continue
            if draft.linked_ae_open_id is not None:
                open_aes = [
                    OpenAE(
                        ae.ae_open_id, ae.aedecod, ae.first_reported_at, prior_completed, session_id
                    )
                    if ae.ae_open_id == draft.linked_ae_open_id
                    else ae
                    for ae in open_aes
                ]
            else:
                open_aes.append(
                    OpenAE(
                        ae_open_id=f"{session_id}:ae{draft.value('AESEQ')}",
                        aedecod=str(draft.value("AEDECOD")),
                        first_reported_at=str(draft.value("AESTDTC")),
                        last_reported_at=prior_completed,
                        last_session_id=session_id,
                    )
                )
    return open_aes


def replay(persona: Persona, settings: object = None) -> tuple[CheckInResult, list[OpenAE]]:
    """Run the persona's main check-in (after its prior check-ins) and return the result."""
    open_aes = materialize_open_aes(persona, COMPLETED_AT)
    result = evaluate_checkin(
        _checkin_input(
            session_id=f"{persona['id']}:main",
            usubjid=usubjid_for(persona),
            completed_at=COMPLETED_AT,
            responses=persona["responses"],
            gates=persona["gates"],
            vitals=persona["vitals_samples"],
            open_aes=open_aes,
            settings=persona.get("settings", {}) if settings is None else settings,
            protocol_context=persona.get("protocol_context"),
        )
    )
    return result, open_aes


def _drafts(result: CheckInResult, domain: str) -> list[DraftRecord]:
    return [d for d in result.drafts if d.domain == domain]


def assert_matches(
    result: CheckInResult,
    expected: Mapping[str, Any],
    open_aes: Sequence[OpenAE],
    where: str,
) -> None:
    """Assert every key present in ``expected``; keys absent from a partial block are skipped."""
    fired = [rule.rule_id for rule in result.rules_fired]

    if "grades" in expected:
        actual = {item.item_id: item.provisional_grade for item in result.items}
        assert actual == expected["grades"], f"{where}: grades {actual}"
    if "max_grade" in expected:
        assert result.max_grade == expected["max_grade"], f"{where}: max_grade {result.max_grade}"
    if "tier" in expected:
        assert result.escalation_tier == expected["tier"], (
            f"{where}: tier {result.escalation_tier} (rules: {fired})"
        )
    if "stop_screen" in expected:
        assert result.stop_screen is expected["stop_screen"], f"{where}: stop_screen"
    assert result.stop_screen is result.page_oncall is (result.escalation_tier == 3), where
    if "red_flag_tier_floor" in expected:
        assert result.red_flag_tier_floor == expected["red_flag_tier_floor"], f"{where}: floor"
    if "corroboration_bump" in expected:
        assert result.corroboration_bump == expected["corroboration_bump"], f"{where}: bump"

    for rule_id in expected.get("rules_fired_includes", []):
        assert rule_id in fired, f"{where}: expected rule {rule_id!r} to fire; fired = {fired}"
    for rule_id in expected.get("rules_fired_excludes", []):
        assert rule_id not in fired, f"{where}: rule {rule_id!r} must not fire; fired = {fired}"

    if "sae_clock_started" in expected:
        started = result.sae_clock is not None
        assert started is expected["sae_clock_started"], f"{where}: sae_clock_started {started}"
        if result.sae_clock is not None:
            assert result.sae_clock.site_awareness_at == COMPLETED_AT, where
            assert result.sae_clock.due_at == shift(COMPLETED_AT, hours=SITE_TO_SPONSOR_HOURS), (
                where
            )
    if "seriousness_suspected" in expected:
        assert result.seriousness_suspected is expected["seriousness_suspected"], where

    ae_drafts = _drafts(result, "AE")
    vs_drafts = _drafts(result, "VS")
    cm_drafts = _drafts(result, "CM")
    if "ae_drafts" in expected:
        assert len(ae_drafts) == expected["ae_drafts"], f"{where}: {len(ae_drafts)} AE drafts"
    if "vs_drafts" in expected:
        assert len(vs_drafts) == expected["vs_drafts"], f"{where}: {len(vs_drafts)} VS drafts"
    if "vs_not_done" in expected:
        not_done = sorted(
            str(d.value("VSTESTCD")) for d in vs_drafts if d.value("VSSTAT") == "NOT DONE"
        )
        assert not_done == sorted(expected["vs_not_done"]), f"{where}: NOT DONE rows {not_done}"
        for draft in vs_drafts:
            has_value = draft.value("VSORRES") is not None
            assert has_value is (draft.value("VSSTAT") is None), (where, draft.value("VSTESTCD"))

    if "cm" in expected:
        assert len(cm_drafts) == len(expected["cm"]), f"{where}: {len(cm_drafts)} CM drafts"
        for exp, draft in zip(expected["cm"], cm_drafts, strict=True):
            assert draft.value("CMTRT") == exp["verbatim"], f"{where}: CMTRT"
            assert draft.value("CMDECOD") == exp["cmdecod"], f"{where}: CMDECOD"
            confidence = draft.value("INTERIM_MATCH_CONFIDENCE")
            assert isinstance(confidence, int | float) and not isinstance(confidence, bool)
            assert confidence >= exp["min_confidence"], f"{where}: confidence {confidence}"
            if "match_kind" in exp:
                assert draft.value("INTERIM_MATCH_KIND") == exp["match_kind"], f"{where}: kind"
            if "distance" in exp:
                assert result.conmed is not None and result.conmed.distance == exp["distance"]
            if "direction" in exp:
                direction = exp["direction"]
                date = iso_date(COMPLETED_AT)
                assert draft.value("INTERIM_DIRECTION") == direction, f"{where}: direction"
                expected_start = date if direction in ("started", "both") else None
                expected_end = date if direction in ("stopped", "both") else None
                assert draft.value("CMSTDTC") == expected_start, f"{where}: CMSTDTC"
                assert draft.value("CMENDTC") == expected_end, f"{where}: CMENDTC"
            if "protocol_flag" in exp:
                assert draft.value("INTERIM_PROTOCOL_FLAG") == exp["protocol_flag"], (
                    f"{where}: INTERIM_PROTOCOL_FLAG {draft.value('INTERIM_PROTOCOL_FLAG')}"
                )
            if "missing_fields" in exp:
                assert draft.value("INTERIM_CM_MISSING_FIELDS") == exp["missing_fields"], (
                    f"{where}: INTERIM_CM_MISSING_FIELDS {draft.value('INTERIM_CM_MISSING_FIELDS')}"
                )
        if expected["cm"]:
            assert (
                result.conmed is not None
                and result.conmed.verbatim == expected["cm"][0]["verbatim"]
            )
        else:
            assert result.conmed is None, f"{where}: unexpected con-med match"

    if "dedup_followups" in expected:
        followups = [d for d in ae_drafts if d.is_followup]
        assert len(followups) == expected["dedup_followups"], f"{where}: follow-ups"
        by_id = {ae.ae_open_id: ae for ae in open_aes}
        for draft in followups:
            assert draft.linked_ae_open_id is not None, where
            linked = by_id[draft.linked_ae_open_id]
            assert draft.value("INTERIM_FOLLOWUP_OF") == linked.ae_open_id, where
            assert draft.value("AESTDTC") == linked.first_reported_at, where
            assert draft.value("AEDECOD") == linked.aedecod, where
            assert draft.value("AEONGO") == "Y", where

    assert_protocol_matches(result, expected, where)

    if "vitals_status" in expected:
        assert result.vitals.status == expected["vitals_status"], (
            f"{where}: vitals status {result.vitals.status}"
        )

    for draft in ae_drafts:
        assert draft.value("INTERIM_TIER") == result.escalation_tier, where
        assert draft.value("INTERIM_PROVISIONAL") is True, where
        assert draft.value("AETOXGR") in (1, 2, 3), where
    for draft in vs_drafts:
        assert draft.value("INTERIM_IS_MEASURED") is False, f"{where}: mock vitals are simulated"
        assert draft.value("VSMETHOD") == "Simulated", f"{where}: simulated must be labeled"


def assert_protocol_matches(result: CheckInResult, expected: Mapping[str, Any], where: str) -> None:
    """The R3.1 protocol keys; each is optional so the original 29 personas are unaffected."""
    protocol = result.protocol
    assert protocol is not None, where
    if "protocol_tier_floor" in expected:
        assert result.protocol_tier_floor == expected["protocol_tier_floor"], f"{where}: floor"
        assert protocol.tier_floor == expected["protocol_tier_floor"], where
    if "aesi_suspected" in expected:
        assert protocol.aesi_suspected is expected["aesi_suspected"], f"{where}: aesi_suspected"
    if "aesi_items" in expected:
        assert list(protocol.aesi_items) == expected["aesi_items"], f"{where}: aesi_items"
        flagged = [
            str(d.value("AEDECOD"))
            for d in _drafts(result, "AE")
            if d.value("INTERIM_AESI_SUSPECTED") is True
        ]
        by_item = {i.item_id: i.aedecod for i in result.items}
        assert flagged == [by_item[i] for i in expected["aesi_items"]], f"{where}: {flagged}"
    if "aesi_clock_started" in expected:
        clock = result.aesi_clock
        assert (clock is not None) is expected["aesi_clock_started"], f"{where}: aesi clock"
        if clock is not None:
            assert clock.kind == "aesi", where
            assert clock.site_awareness_at == COMPLETED_AT, where
            assert clock.due_at == shift(COMPLETED_AT, hours=SITE_TO_SPONSOR_HOURS), where
    if result.sae_clock is not None:
        assert result.sae_clock.kind == "sae", where
    # Protocol rules never change a grade, and never lower the tier below the ladder's floors.
    assert result.escalation_tier >= max(result.base_tier, result.protocol_tier_floor), where


# --------------------------------------------------------------------------- #
# Per-persona tests
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("persona", PERSONAS, ids=PERSONA_IDS)
def test_persona_matches_answer_key(persona: Persona) -> None:
    result, open_aes = replay(persona)
    assert_matches(result, persona["expected"], open_aes, persona["id"])
    # The harness stores results as JSON; make sure every result survives the trip.
    assert (
        json.loads(json.dumps(result_to_dict(result)))["escalation_tier"] == result.escalation_tier
    )
    assert len(result.why) == len(result.rules_fired)


@pytest.mark.parametrize(
    "persona", WITH_COUNTERFACTUALS, ids=[p["id"] for p in WITH_COUNTERFACTUALS]
)
def test_counterfactuals_change_only_what_they_claim(persona: Persona) -> None:
    """'Change the input, watch the output change': each counterfactual re-runs the persona."""
    baseline, _ = replay(persona)
    for counterfactual in persona["counterfactuals"]:
        where = f"{persona['id']} [{counterfactual['label']}]"
        result, open_aes = replay(persona, settings=counterfactual["settings"])
        assert_matches(result, counterfactual["expected"], open_aes, where)
        # Settings never touch a grade: the toggle moves the tier, never AETOXGR.
        assert [i.provisional_grade for i in result.items] == [
            i.provisional_grade for i in baseline.items
        ], where
        assert result.escalation_tier != baseline.escalation_tier, f"{where}: nothing changed"


def test_demo_persona_is_the_first_tier1_persona_and_matches_the_contract() -> None:
    """CONTRACTS.md §6 shows this persona verbatim; the kiosk demo (CLAUDE.md §11) relies on it."""
    tier1 = [p for p in PERSONAS if p["category"] == "tier1"]
    demo = tier1[0]
    assert demo["id"] == "T1-dyspnea-moderate"
    assert demo["responses"]["shortness_of_breath"] == {"severity": 2, "interference": 2}
    assert demo["responses"]["cough"] == {"severity": 1, "interference": 0}
    assert demo["gates"]["conmed_text"] == "loratadine"
    assert demo["gates"]["conmed_direction"] == "started"
    assert demo["settings"] == {"simulated_as_measured": False}
    expected = demo["expected"]
    assert expected["tier"] == 1 and expected["ae_drafts"] == 2 and expected["vs_drafts"] == 2
    assert expected["cm"] == [
        {"verbatim": "loratadine", "cmdecod": "loratadine", "min_confidence": 1.0}
    ]
    assert expected["rules_fired_includes"] == [
        "grade.provisional.shortness_of_breath",
        "tier.base",
        "conmed.exact",
        "vitals.simulated_ignored",
    ]
    assert expected["rules_fired_excludes"] == ["corr.tachypnea_dyspnea", "sae.clock_started"]


def test_demo_pair_differs_only_by_vitals_and_toggle() -> None:
    """The demo's two check-ins share answers; only the vitals/toggle move the tier 1 -> 2."""
    by_id = {p["id"]: p for p in PERSONAS}
    first, second = by_id["T1-dyspnea-moderate"], by_id["T2-dyspnea-tachypnea-corroborated"]
    assert first["responses"] == second["responses"]
    assert first["gates"] == second["gates"]
    assert first["expected"]["grades"] == second["expected"]["grades"]
    assert (first["expected"]["tier"], second["expected"]["tier"]) == (1, 2)
    assert second["settings"]["simulated_as_measured"] is True


# --------------------------------------------------------------------------- #
# File-level tests (the shape the harness depends on)
# --------------------------------------------------------------------------- #


def test_answer_key_carries_source_rationale_and_counts() -> None:
    for key in ("source", "rationale"):
        assert isinstance(ANSWER_KEY.get(key), str) and ANSWER_KEY[key].strip(), key
    counts = ANSWER_KEY["counts"]
    actual = {
        category: sum(1 for p in PERSONAS if p["category"] == category)
        for category in ("tier0", "tier1", "tier2", "tier3", "edge", "protocol")
    }
    actual["judge_hidden"] = sum(1 for p in PERSONAS if p["hidden"])
    assert actual == REQUIRED_MIX, actual
    assert {k: counts[k] for k in REQUIRED_MIX} == REQUIRED_MIX
    assert counts["total"] == len(PERSONAS) == sum(REQUIRED_MIX.values())


def test_ids_are_unique_kebab_case_and_prefixed_by_category() -> None:
    assert len(set(PERSONA_IDS)) == len(PERSONA_IDS)
    for persona in PERSONAS:
        pid = persona["id"]
        assert ID_PATTERN.match(pid), pid
        assert pid.startswith(PREFIX_BY_CATEGORY[persona["category"]]), pid
        assert persona["hidden"] is (persona["category"] == "judge"), pid
        for key in ("name", "description", "story", "derivation"):
            assert isinstance(persona.get(key), str) and persona[key].strip(), (pid, key)
        assert persona["setup"].keys() == {"prior_checkins"}, pid
        assert REQUIRED_EXPECTED_KEYS <= persona["expected"].keys(), pid


def test_expected_tiers_match_categories() -> None:
    for persona in PERSONAS:
        category, tier = persona["category"], persona["expected"]["tier"]
        if category.startswith("tier"):
            assert tier == int(category[-1]), persona["id"]
        assert persona["expected"]["stop_screen"] is (tier == 3), persona["id"]
        assert persona["expected"]["sae_clock_started"] is persona["gates"]["hospitalization"]


def test_every_persona_answers_every_attribute_of_every_item_explicitly() -> None:
    shipped = {item.id: item for item in items()}
    for persona in PERSONAS:
        checkins = [persona, *persona["setup"]["prior_checkins"]]
        for checkin in checkins:
            responses = checkin["responses"]
            assert set(responses) == set(shipped), persona["id"]
            for item_id, attrs in responses.items():
                item = shipped[item_id]
                assert tuple(attrs) == item.attributes, (persona["id"], item_id)
                for attribute, value in attrs.items():
                    assert isinstance(value, int) and not isinstance(value, bool)
                    assert 0 <= value <= item.max_value(attribute), (persona["id"], item_id)
        assert set(persona["expected"]["grades"]) == set(shipped), persona["id"]


def test_vitals_samples_follow_the_bridge_schedule() -> None:
    for persona in PERSONAS:
        pid, samples = persona["id"], persona["vitals_samples"]
        if not persona["consent_camera"]:
            assert samples == [], pid
            assert persona["expected"]["vs_drafts"] == 0, pid
            continue
        assert len(samples) >= 6, pid
        offsets = [s["tsOffsetS"] for s in samples]
        assert all(b - a == 2 for a, b in pairwise(offsets)), pid
        for sample in samples:
            assert sample["source"] == "mock" and sample["isMeasured"] is False, pid
            assert sample["qualityFlags"] == [], pid
            assert "pulseBpm" in sample and "pulseConf" in sample, pid
            has_breathing = "breathingBpm" in sample
            has_hrv = "hrvRmssdMs" in sample
            assert has_breathing is (sample["tsOffsetS"] >= 30), (pid, sample["tsOffsetS"])
            # windowS is the window of the longest-window metric present (VITALS_SOURCES.md):
            # 12 s pulse-only, 30 s once breathing is published, 60 s once HRV is.
            assert sample["windowS"] == (60 if has_hrv else 30 if has_breathing else 12), pid
            if has_hrv:
                assert sample["tsOffsetS"] >= 60 and "hrvConf" in sample, pid
        assert any("breathingBpm" in s for s in samples), pid


def test_rule_ids_named_in_expectations_exist_in_the_catalog() -> None:
    catalog = rules_catalog()
    for persona in PERSONAS:
        blocks = [persona["expected"], *(c["expected"] for c in persona.get("counterfactuals", []))]
        for block in blocks:
            for key in ("rules_fired_includes", "rules_fired_excludes"):
                for rule_id in block.get(key, []):
                    assert rule_id in catalog, (persona["id"], rule_id)
            overlap = set(block.get("rules_fired_includes", [])) & set(
                block.get("rules_fired_excludes", [])
            )
            assert not overlap, (persona["id"], overlap)
