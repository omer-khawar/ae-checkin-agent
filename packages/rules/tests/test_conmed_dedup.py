"""Con-med matcher (string distance only) and AE de-duplication."""

from __future__ import annotations

import pytest
from helpers import SESSION, T0, drafts, gates, rule_ids, run

from interim_rules.conmed import conmed_rule, levenshtein, match_conmed, normalize
from interim_rules.dedup import OpenAESearch, find_open_ae
from interim_rules.models import OpenAE, RuleSettings
from interim_rules.tables import MedEntry, MedList, conmed_matching_config
from interim_rules.timefmt import shift


@pytest.mark.parametrize(
    ("a", "b", "distance"),
    [
        ("", "", 0),
        ("abc", "", 3),
        ("", "abc", 3),
        ("kitten", "sitting", 3),
        ("loratadine", "loratadine", 0),
        ("loratadine", "loratadin", 1),
        ("claritin", "claratin", 1),
        ("flaw", "lawn", 2),
    ],
)
def test_levenshtein(a: str, b: str, distance: int) -> None:
    assert levenshtein(a, b) == distance == levenshtein(b, a)


def test_normalize_collapses_whitespace_but_keeps_case() -> None:
    assert normalize("  Vitamin   D \n") == "Vitamin D"


@pytest.mark.parametrize(
    ("text", "kind", "matched", "confidence", "distance"),
    [
        ("loratadine", "exact", "loratadine", 1.0, 0),
        ("Loratadine", "case_insensitive", "loratadine", 1.0, 0),
        ("CLARITIN", "case_insensitive", "loratadine", 1.0, 0),
        ("claritin", "exact", "loratadine", 1.0, 0),
        ("loratadin", "levenshtein", "loratadine", 0.9, 1),
        ("Loratidine", "levenshtein", "loratadine", 0.9, 1),
        ("ondansatrone", "levenshtein", "ondansetron", 0.83, 2),
        ("vitamin d", "exact", "vitamin d", 1.0, 0),
        ("started loratadine 10mg", "exact", "loratadine", 1.0, 0),
        ("Tylenol PM", "case_insensitive", "acetaminophen", 1.0, 0),
        ("xqzvwy", "unmatched", None, 0.0, None),
        ("", "unmatched", None, 0.0, None),
        ("   ", "unmatched", None, 0.0, None),
    ],
)
def test_match_conmed(
    text: str, kind: str, matched: str | None, confidence: float, distance: int | None
) -> None:
    match = match_conmed(text)
    assert match.verbatim == text  # never altered
    assert match.match_kind == kind
    assert match.matched_name == matched
    assert match.confidence == confidence
    assert match.distance == distance
    if text.strip():
        assert len(match.candidates) == 3
        assert all(isinstance(n, str) and isinstance(d, int) for n, d in match.candidates)
    else:
        assert match.candidates == ()


def test_short_tokens_are_not_tried_on_their_own() -> None:
    assert match_conmed("took b12").match_kind == "unmatched"


SHORT_NAME_LIST = MedList(
    entries=(MedEntry("iron", "generic", "iron"),), is_rxnorm=False, built_at=T0, source="t"
)


@pytest.mark.parametrize("text", ["from", "the blue pill from the pharmacy"])
def test_near_misses_below_the_confidence_floor_are_unmatched(text: str) -> None:
    """'from' is two edits from a 4-letter entry 'iron' (confidence 0.5): never proposed.

    Uses an explicit list: the shipped medlist.json excludes names shorter than 5 letters
    (data/public/medlist_build_config.json), so the floor is exercised here independently.
    """
    cfg = conmed_matching_config()
    match = match_conmed(text, SHORT_NAME_LIST)
    assert match.match_kind == "unmatched" and match.matched_name is None
    assert match.confidence == 0.0 and match.distance is None
    # The coordinator still sees the nearest names, taken from the closest token.
    assert match.candidates and match.candidates[0][1] <= cfg.max_levenshtein_distance
    rule = conmed_rule(match, "a1")
    assert rule.rule_id == "conmed.unmatched"
    assert "below the confidence floor 0.7" in rule.description
    assert rule.inputs["min_levenshtein_confidence"] == 0.7


def test_confidence_floor_boundary() -> None:
    """d=2 needs a 7+ letter name (1 - 2/7 = 0.71); on a 6-letter name it is 0.67 -> unmatched."""
    seven = MedList(
        entries=(MedEntry("abcdefg", "generic", "abcdefg"),),
        is_rxnorm=False,
        built_at=T0,
        source="t",
    )
    six = MedList(
        entries=(MedEntry("abcdef", "generic", "abcdef"),), is_rxnorm=False, built_at=T0, source="t"
    )
    assert levenshtein("abcdexx", "abcdefg") == 2 and levenshtein("abcdxx", "abcdef") == 2
    assert match_conmed("abcdexx", seven).match_kind == "levenshtein"
    assert match_conmed("abcdexx", seven).confidence == 0.71
    assert match_conmed("abcdxx", six).match_kind == "unmatched"
    assert match_conmed("abcdxx", six).candidates == (("abcdef", 2),)
    # A one-edit slip on a 4-letter name (0.75) still clears the floor ('icon' -> iron): a known
    # limitation recorded in docs/WHAT_IT_GETS_WRONG.md. The openFDA build excludes names
    # shorter than 5 letters, but hand-curated core entries such as 'iron' are exempt, so the
    # shipped list reproduces it too.
    assert match_conmed("icon", SHORT_NAME_LIST).matched_name == "iron"
    assert match_conmed("icon", SHORT_NAME_LIST).confidence == 0.75
    assert match_conmed("icon").matched_name == "iron"


def test_levenshtein_ties_prefer_shortest_then_alphabetical() -> None:
    meds = MedList(
        entries=(
            MedEntry("abcde", "generic", "abcde"),
            MedEntry("abc", "generic", "abc"),
            MedEntry("abcf", "generic", "abcf"),
            MedEntry("abce", "generic", "abce"),
        ),
        is_rxnorm=False,
        built_at=T0,
        source="test",
    )
    # 'abcd' is distance 1 from every entry; the shortest ('abc') wins.
    assert match_conmed("abcd", meds).matched_name == "abc"
    # Equal length ties go alphabetical.
    four_letter = MedList(entries=meds.entries[2:], is_rxnorm=False, built_at=T0, source="t")
    assert match_conmed("abcx", four_letter).matched_name == "abce"
    assert match_conmed("abcx", four_letter).confidence == 0.75


def test_whole_string_beats_token_on_equal_rank() -> None:
    meds = MedList(
        entries=(MedEntry("fish oil", "generic", "fish oil"), MedEntry("fish", "generic", "fish")),
        is_rxnorm=False,
        built_at=T0,
        source="test",
    )
    assert match_conmed("fish oil", meds).matched_name == "fish oil"


def test_empty_medlist_is_unmatched() -> None:
    empty = MedList(entries=(), is_rxnorm=False, built_at=T0, source="t")
    match = match_conmed("anything", empty)
    assert match.match_kind == "unmatched" and match.candidates == ()


def test_conmed_rule_texts() -> None:
    exact = conmed_rule(match_conmed("claritin"), "a1")
    assert (
        exact.rule_id == "conmed.exact" and "matched exactly to 'loratadine'" in exact.description
    )
    ci = conmed_rule(match_conmed("Claritin"), "a1")
    assert ci.rule_id == "conmed.case_insensitive" and "case-insensitively" in ci.description
    lev = conmed_rule(match_conmed("claratin"), "a1")
    assert lev.rule_id == "conmed.levenshtein" and "edit distance 1" in lev.description
    none = conmed_rule(match_conmed("zzzzzz"), "a1")
    assert none.rule_id == "conmed.unmatched" and "kept verbatim" in none.description
    assert "confidence floor" not in none.description  # nothing was within reach
    assert none.effect.startswith("CMDECOD = null")
    assert exact.evidence[0].kind == "gate_answer" and exact.evidence[0].id == "a1"
    assert {e.id for e in exact.evidence if e.kind == "table"} == {
        "medlist.json",
        "conmed_matching.json",
    }


def test_conmed_in_full_run_follows_the_yes_no_gate() -> None:
    # "No" to the gate: any stray text is not a reported change.
    assert run(gate_answers=gates(conmed_changed=False, conmed_text="advil")).conmed is None
    result = run(
        gate_answers=gates(conmed_changed=True, conmed_text="Advil", conmed_direction="both")
    )
    assert result.conmed is not None and result.conmed.matched_name == "ibuprofen"
    cm = drafts(result, "CM")[0]
    assert cm.value("CMTRT") == "Advil" and cm.value("CMDECOD") == "ibuprofen"
    assert cm.value("CMSTDTC") == "2026-10-10" and cm.value("CMENDTC") == "2026-10-10"
    assert cm.value("INTERIM_MATCH_KIND") == "case_insensitive"
    assert "conmed.case_insensitive" in rule_ids(result) and "draft.cm" in rule_ids(result)


@pytest.mark.parametrize("text", ["", "   ", None])
def test_yes_without_a_name_is_still_drafted_and_flagged(text: str | None) -> None:
    """A 'yes, I started something' with no name must reach the coordinator, not vanish."""
    result = run(
        gate_answers=gates(conmed_changed=True, conmed_text=text, conmed_direction="started")
    )
    assert result.conmed is not None and result.conmed.match_kind == "unmatched"
    assert result.conmed.verbatim == (text or "")
    ids = rule_ids(result)
    assert "conmed.unmatched" in ids and "draft.cm" in ids
    cm = drafts(result, "CM")[0]
    assert cm.value("CMTRT") == (text or "") and cm.value("CMDECOD") is None
    assert cm.value("INTERIM_MATCH_KIND") == "unmatched"
    assert cm.value("CMSTDTC") == "2026-10-10"  # the reported direction still dates the change
    rule = next(r for r in result.rules_fired if r.rule_id == "conmed.unmatched")
    assert "no medication name was typed" in rule.description
    assert "CMTRT empty" in rule.effect
    draft_rule = next(r for r in result.rules_fired if r.rule_id == "draft.cm")
    assert "coordinator to ask" in draft_rule.description
    for field in cm.fields:
        if field.value is not None:
            assert field.evidence, field.name


# --------------------------------------------------------------------------- #
# Dedup
# --------------------------------------------------------------------------- #


def _open(
    aedecod: str,
    last_days_ago: float,
    ae_id: str = "AE1",
    first_days_ago: float = 10,
    session_id: str = "S0",
) -> OpenAE:
    return OpenAE(
        ae_open_id=ae_id,
        aedecod=aedecod,
        first_reported_at=shift(T0, days=-first_days_ago),
        last_reported_at=shift(T0, days=-last_days_ago),
        last_session_id=session_id,
    )


COUGH = {"cough": {"severity": 1}}


def test_window_boundary_is_inclusive_at_exactly_seven_days() -> None:
    search = find_open_ae("Cough", [_open("Cough", 7)], T0, 7)
    assert search.linked is not None and search.days_since == 7.0 and search.skipped == ()
    just_over = OpenAE(
        "AE1", "Cough", shift(T0, days=-10), shift(T0, seconds=-(7 * 86400 + 1)), "S0"
    )
    search = find_open_ae("Cough", [just_over], T0, 7)
    assert search.linked is None and search.days_since is None
    assert search.skipped == (("AE1", "last reported 7.0 days ago, outside the 7-day window"),)


def test_other_terms_are_not_candidates() -> None:
    assert find_open_ae("Cough", [_open("Dyspnea", 1)], T0, 7) == OpenAESearch(None, None, ())


def test_future_reports_within_clock_skew_count_but_later_ones_are_skipped() -> None:
    # 60 s after this session: same-server clock skew, still linked.
    skewed = find_open_ae("Cough", [_open("Cough", -60 / 86400)], T0, 7)
    assert skewed.linked is not None and skewed.days_since is not None
    assert skewed.days_since < 0
    # 12 hours after this session cannot be an earlier report: skipped with a reason.
    future = find_open_ae("Cough", [_open("Cough", -0.5)], T0, 7)
    assert future.linked is None
    assert future.skipped[0][0] == "AE1" and "clock-skew tolerance" in future.skipped[0][1]
    # The tolerance is a table value and can be widened per call.
    widened = find_open_ae("Cough", [_open("Cough", -0.5)], T0, 7, max_future_skew_s=86400)
    assert widened.linked is not None


def test_open_ae_from_the_same_session_is_never_linked_to_itself() -> None:
    own = _open("Cough", 0, ae_id="AEX", first_days_ago=3, session_id=SESSION)
    search = find_open_ae("Cough", [own], T0, 7, session_id=SESSION)
    assert search.linked is None
    assert search.skipped == (("AEX", "last reported by this same session; cannot follow itself"),)
    # Without a session id the function cannot know, so the candidate is considered.
    assert find_open_ae("Cough", [own], T0, 7).linked is own
    # End to end: a re-evaluation of a persisted check-in drafts a NEW AE with the skip logged.
    result = run(COUGH, open_aes=[own])
    assert "dedup.new_ae" in rule_ids(result) and "dedup.followup_linked" not in rule_ids(result)
    ae = drafts(result, "AE")[0]
    assert not ae.is_followup and ae.value("INTERIM_FOLLOWUP_OF") is None
    assert ae.value("AESTDTC") == T0
    rule = next(r for r in result.rules_fired if r.rule_id == "dedup.new_ae")
    assert rule.inputs["open_aes_skipped"] == [
        ["AEX", "last reported by this same session; cannot follow itself"]
    ]


def test_most_recent_eligible_open_ae_is_linked() -> None:
    search = find_open_ae(
        "Cough",
        [
            _open("Cough", 6, "OLD"),
            _open("Cough", 2, "NEW"),
            _open("Cough", 4, "MID"),
            _open("Cough", -1, "FUTURE"),
            _open("Cough", 1, "SELF", session_id=SESSION),
        ],
        T0,
        7,
        session_id=SESSION,
    )
    assert search.linked is not None and search.linked.ae_open_id == "NEW"
    assert [ae_id for ae_id, _ in search.skipped] == ["FUTURE", "SELF"]


def test_followup_in_full_run_changes_the_ae_draft() -> None:
    open_ae = _open("Cough", 5, first_days_ago=12)
    result = run(COUGH, open_aes=[open_ae])
    assert "dedup.followup_linked" in rule_ids(result) and "dedup.new_ae" not in rule_ids(result)
    ae = drafts(result, "AE")[0]
    assert ae.is_followup and ae.linked_ae_open_id == "AE1"
    assert ae.value("INTERIM_FOLLOWUP_OF") == "AE1"
    assert ae.value("AESTDTC") == open_ae.first_reported_at
    assert ae.value("AEONGO") == "Y" and ae.value("AEENDTC") is None
    rule = next(r for r in result.rules_fired if r.rule_id == "dedup.followup_linked")
    assert rule.inputs["days_since"] == 5.0 and "follow-up" in rule.description
    assert rule.inputs["open_aes_skipped"] == []
    fired = ae.value("INTERIM_RULES_FIRED")
    assert isinstance(fired, list) and "dedup.followup_linked" in fired


def test_new_ae_when_outside_window_or_window_overridden() -> None:
    result = run(COUGH, open_aes=[_open("Cough", 8)])
    assert "dedup.new_ae" in rule_ids(result)
    ae = drafts(result, "AE")[0]
    assert not ae.is_followup and ae.value("INTERIM_FOLLOWUP_OF") is None
    assert ae.value("AESTDTC") == T0
    narrowed = run(COUGH, open_aes=[_open("Cough", 5)], settings=RuleSettings(dedup_window_days=3))
    assert "dedup.new_ae" in rule_ids(narrowed)
    rule = next(r for r in narrowed.rules_fired if r.rule_id == "dedup.new_ae")
    assert rule.inputs["window_days"] == 3 and rule.inputs["open_aes_checked"] == ["AE1"]
    assert rule.inputs["open_aes_skipped"] == [
        ["AE1", "last reported 5.0 days ago, outside the 3-day window"]
    ]
    assert SESSION in ae.fields[0].evidence[0].note


def test_ungraded_items_get_no_dedup_decision() -> None:
    result = run(open_aes=[_open("Cough", 1)])
    assert not any(r.startswith("dedup.") for r in rule_ids(result))
