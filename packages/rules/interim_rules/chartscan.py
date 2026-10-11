"""Deterministic chart-note scanner: symptoms (CTCAE v5 terms), medication changes, red flags.

Ported from ``backend/app/services/extract.py`` of ``omer-khawar/ae-checkin-agent``
(Omer Khawar, MIT), 2026-10-10. This is Regeneron's "Better" tier (chart scan) inside Interim:
CONTRACTS.md R2.4, decision D-014. No LLM, no network, no clock: regular expressions and lookup
tables only, so every finding can be explained and scored.

What ``scan_text(text, ref_date)`` returns, each item with the exact character offsets of the
words it matched (``text[span_start:span_end] == quote``) and a plain-English ``reason``:

1. :class:`SymptomFinding` -- a possible adverse event mapped to a CTCAE v5 term name, with a
   provisional ``grade_hint`` (explicit "grade 3" > stool count for diarrhea / % BSA for rash >
   nearest severity word > default), ``onset_days`` from a duration ("x5 days") or a relative
   phrase ("since yesterday"), ``onset_date`` when a reference date was given, and ``worsening``;
2. :class:`MedFinding` -- a medication mention normalized to a lowercase generic name with the
   nearest action verb (``started`` / ``stopped`` / ``changed`` / ``taking``);
3. :class:`RedFlag` -- a phrase that needs escalation (``emergency`` / ``urgent``);
4. ``human_requested`` -- a request to talk to a person (checked for utterances only).

Mentions that do not count are returned too (``excluded_symptoms``, ``excluded_meds``) with the
reason, so a reviewer sees what was skipped. The traps handled, NegEx-style (Chapman 2001):
negation before the term in the same clause ("denies nausea, vomiting", "no rash noted", "I
haven't had any cough"), pseudo-negation that does not negate ("I can't stop coughing"), scope
terminators ("no fever but has diarrhea"), post-term negation ("pneumonitis ruled out"), history
("hx of migraines"), instructions and hypotheticals ("call if fever > 100.4", "monitor for rash"),
allergy listings and declined prescriptions.

Differences from the original (behavior on the answer key is identical; see
``tests/test_chartscan.py``, which reproduces the source repository's evaluation exactly):

* The lexicons, context cues, grade thresholds and red flags moved out of code into
  ``data/chartscan_lexicon.json`` and ``data/chartscan_red_flags.json`` (CLAUDE.md section 13:
  regex strings are data). They are loaded through :mod:`interim_rules.tables` and compiled once
  per process (:func:`functools.cache`).
* Results are frozen dataclasses shaped as CONTRACTS.md R2.4 (``term, quote, span_start,
  span_end, reason, grade_hint, grade_basis, onset_days, worsening, excluded_reason`` ...).
  Three additive fields: ``SymptomFinding.onset_date`` (what ``ref_date`` is for),
  ``MedFinding.excluded_reason`` (so ``excluded_meds`` carry a machine-readable reason) and
  ``ScanResult.human_requested``. ``RedFlag`` keeps the match offsets too.
* ``ref_date`` no longer defaults to ``date.today()`` (CONTRACTS.md section 1: no clock inside
  the rules package). Without it ``onset_date`` is ``None``; ``onset_days`` is still reported.
* An excluded symptom mention has ``grade_hint = None`` (a mention that does not count is not
  graded); the original graded it anyway.
* ``RedFlag.quote`` is the matched phrase, not the whole sentence, so the offset invariant holds
  for every finding type; the API slices the sentence from the note when it needs it.
* The original's ``serious_cue`` is folded into the symptom's ``reason`` text and the grade raise
  (``hospital.raise_grade_to``) is kept, but both apply only when the hospital mention itself
  passes the same negation / history / hypothetical check as the symptom ("Not admitted; has
  diarrhea" stays grade 1); seriousness is read from the red-flag table (``seriousness: true``
  on the hospitalization category, :func:`seriousness_suspected`) with the same check. The
  original counted a negated hospital word for both.
* ``dose_changed`` is spelled ``changed`` (R2.4). ``checkin_text`` cases are ``utterance``.
* ``resolved`` and ``indication`` are part of the ``ExcludedReason`` union (R2.4) but are never
  emitted: the answer key expects a resolved symptom ("Nausea resolved", N7) and a medication's
  indication ("Z-pack for bronchitis", T10) to count as reportable findings. Both cues are
  recorded in ``reason``; a resolved symptom also carries the machine-readable
  ``SymptomFinding.resolved = True`` so the API can propose ``AEENDTC`` without parsing prose.
* When two mentions of one term merge, ``onset_days`` and ``onset_date`` travel together (the
  original merged only the date).

Changes after the review of 2026-10-10 (each with a table row and an answer-key or unit case):

* Typographic punctuation is normalized before matching (``text_normalization`` in the lexicon:
  U+2019 and friends -> ``'``, one code point each), so "I haven't had any nausea" typed with a
  U+2019 apostrophe negates like the ASCII version. Offsets index the caller's original text
  and every ``quote`` is sliced from it.
* A comma followed by a severity / quantity / positivity word ends a negation's scope ("No
  fever, mild diarrhea" reports the diarrhea); a bare comma still does not ("Denies nausea,
  vomiting, diarrhea"). Review-of-systems negatives ("Fever: no", "Nausea - none") are
  post-term negations.
* An explicit "grade 4" / "grade 5" in the text is capped at ``composite_to_grade.json``
  ``max_assignable_grade`` (3) with the clinician's number kept in ``grade_basis``.
* "admitted to having ...", "the sob story about ED" and other non-hospital senses of the
  hospital words no longer start an SAE clock; "go to the ER if ..." is an instruction.
* "was not started on X" / "not on X" exclude the drug; "switched from X to Y" is X stopped and
  Y started; "Tmax 101.3" is a fever; "Tylenol PRN for fever" does not report a fever.
* The NegEx scope (8 words) and the character windows around a term live in the lexicon's
  ``scope`` section instead of module constants.

The scanner's remaining limits (a hand-built lexicon misses phrasings outside its patterns; the
grade hint is a heuristic for the investigator; "No rash, itching on the legs" is read as a
negated list; "admission note" counts as a hospital cue; a switch written with doses is a dose
change) are listed in the README's chart-note section and are to be added to
``docs/WHAT_IT_GETS_WRONG.md`` by the docs owner (``docs/ISSUES.md`` #13).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from functools import cache
from typing import Any, Literal, cast

from .serialize import to_jsonable
from .tables import TableError, load_table

# --------------------------------------------------------------------------- #
# Public vocabulary
# --------------------------------------------------------------------------- #

CHARTSCAN_TABLE_NAMES: tuple[str, ...] = (
    "chartscan_lexicon",
    "chartscan_red_flags",
    "chartscan_answer_key",
)
"""The JSON tables this module owns (``tables.TABLE_NAMES`` lists the engine's)."""

RULE_CATEGORY = "chartscan"
RULE_SYMPTOM = "chartscan.symptom"
RULE_SYMPTOM_EXCLUDED = "chartscan.symptom_excluded"
RULE_MED = "chartscan.med"
RULE_MED_EXCLUDED = "chartscan.med_excluded"
RULE_RED_FLAG = "chartscan.red_flag"
RULE_HOSPITALIZATION = "chartscan.hospitalization"
RULE_GEMINI_SYMPTOM = "chartscan.gemini_symptom"
RULE_GEMINI_MED = "chartscan.gemini_med"
RULE_IDS: tuple[str, ...] = (
    RULE_SYMPTOM,
    RULE_SYMPTOM_EXCLUDED,
    RULE_MED,
    RULE_MED_EXCLUDED,
    RULE_RED_FLAG,
    RULE_HOSPITALIZATION,
    RULE_GEMINI_SYMPTOM,
    RULE_GEMINI_MED,
)
"""Rule ids this module emits via :func:`rules_fired`; all listed in ``rules_catalog.json``."""

ExcludedReason = Literal[
    "negated", "historical", "hypothetical", "resolved", "allergy", "indication"
]
"""Why a mention does not count (CONTRACTS.md R2.4). Symptoms: ``negated``, ``historical``,
``hypothetical``. Medications: ``allergy``, ``negated``. ``resolved`` and ``indication`` are
reserved by the contract and never emitted (see the module docstring)."""

MedChange = Literal["started", "stopped", "changed", "taking"]
RedFlagLevel = Literal["emergency", "urgent"]
ScanKind = Literal["note", "utterance"]
EscalationLevel = Literal["none", "human_requested", "urgent", "emergency"]

_SENTENCE_SPLIT = re.compile(r"(?<!\d)[.!?](?!\d)|\n+")
"""Sentence ends: ``. ! ?`` not inside a number (``100.4``), or line breaks."""

_WORD_EDGES = re.compile(r"^\W+|\W+$")
"""Strips the punctuation a post-term cue was matched with (``": no."`` -> ``no``)."""


# --------------------------------------------------------------------------- #
# Result types (frozen; CONTRACTS.md R2.4)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class SymptomFinding:
    """One symptom mention mapped to a CTCAE v5 term.

    ``quote`` is exactly ``text[span_start:span_end]``. ``grade_hint`` is a provisional hint for
    the investigator with its ``grade_basis``; it is ``None`` when the mention is excluded.
    ``onset_days`` is how many days before the note the symptom started, when the text says;
    ``onset_date`` is ``ref_date - onset_days`` (ISO date) when both are known. ``resolved`` is
    true when the text says the symptom resolved ("Nausea resolved"); it still counts as a
    finding (it happened) and the API may propose an end date from it.
    """

    term: str
    quote: str
    span_start: int
    span_end: int
    reason: str
    grade_hint: int | None
    grade_basis: str
    onset_days: int | None
    worsening: bool
    excluded_reason: ExcludedReason | None
    onset_date: str | None = None
    resolved: bool = False


@dataclass(frozen=True)
class MedFinding:
    """One medication mention normalized to a lowercase generic name (not RxNorm)."""

    drug: str
    change: MedChange
    quote: str
    span_start: int
    span_end: int
    reason: str
    excluded_reason: ExcludedReason | None = None


@dataclass(frozen=True)
class RedFlag:
    """A phrase that needs escalation; ``quote`` is the matched phrase."""

    level: RedFlagLevel
    category: str
    quote: str
    reason: str
    span_start: int
    span_end: int


@dataclass(frozen=True)
class ScanResult:
    """Everything the scanner found in one text, kept and excluded."""

    symptoms: tuple[SymptomFinding, ...]
    excluded_symptoms: tuple[SymptomFinding, ...]
    meds: tuple[MedFinding, ...]
    excluded_meds: tuple[MedFinding, ...]
    red_flags: tuple[RedFlag, ...]
    human_requested: bool = False


# --------------------------------------------------------------------------- #
# Tables -> compiled lexicon
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class _SeverityWord:
    pattern: re.Pattern[str]
    grade: int


@dataclass(frozen=True)
class _Band:
    """A grade band ``value < upper`` (or ``<=`` when inclusive); ``upper None`` is unbounded."""

    grade: int
    upper: float | None
    inclusive: bool

    def contains(self, value: float) -> bool:
        if self.upper is None:
            return True
        return value <= self.upper if self.inclusive else value < self.upper


@dataclass(frozen=True)
class _BandedGrade:
    pattern: re.Pattern[str]
    term: str
    bands: tuple[_Band, ...]
    basis: str
    range_basis: str = ""
    reader_basis: str = ""


@dataclass(frozen=True)
class _RelativeDay:
    pattern: re.Pattern[str]
    days: int


@dataclass(frozen=True)
class _Scope:
    """Context windows around a term (``chartscan_lexicon.json`` ``scope``): how far a cue may
    sit from the term and still count. Words for the NegEx negation scope, characters for the
    rest; every window stops at the sentence boundary."""

    negation_max_words: int
    grade_window_chars: int
    severity_before_chars: int
    severity_after_chars: int
    onset_before_chars: int
    onset_after_chars: int
    allergy_lookback_chars: int
    med_negated_lookahead_chars: int
    med_verb_lookahead_chars: int


@dataclass(frozen=True)
class _Lexicon:
    symptoms: tuple[tuple[str, re.Pattern[str]], ...]
    meds: tuple[tuple[str, re.Pattern[str]], ...]
    normalization: Mapping[int, str]
    """``str.translate`` table: typographic punctuation -> ASCII, one code point each."""
    scope: _Scope
    max_grade: int
    """``composite_to_grade.json`` ``max_assignable_grade``: no grade hint exceeds it."""
    negation: re.Pattern[str]
    pseudo_negation: re.Pattern[str]
    terminators: re.Pattern[str]
    historical: re.Pattern[str]
    hypothetical: re.Pattern[str]
    post_negation: re.Pattern[str]
    resolved: re.Pattern[str]
    severity_words: tuple[_SeverityWord, ...]
    explicit_grade: re.Pattern[str]
    default_grade: int
    default_basis: str
    stool_count: _BandedGrade
    bsa: _BandedGrade
    worsening: re.Pattern[str]
    hospital: re.Pattern[str]
    hospital_raise_to: int
    hospital_basis_suffix: str
    number_words: Mapping[str, int]
    duration: re.Pattern[str]
    relative_days: tuple[_RelativeDay, ...]
    med_started: re.Pattern[str]
    med_stopped: re.Pattern[str]
    med_changed: re.Pattern[str]
    med_negated: re.Pattern[str]
    allergy: re.Pattern[str]
    indication: re.Pattern[str]
    human_request: re.Pattern[str]
    temperature_high: str


@dataclass(frozen=True)
class _RedFlagRule:
    category: str
    level: RedFlagLevel
    seriousness: bool
    pattern: re.Pattern[str]
    raw_pattern: str
    reason: str


@dataclass(frozen=True)
class _RedFlagTable:
    rules: tuple[_RedFlagRule, ...]
    escalation_rank: Mapping[str, int]


def _str(value: object, where: str) -> str:
    if not isinstance(value, str):
        raise TableError(f"{where}: expected string, got {type(value).__name__}")
    return value


def _int(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TableError(f"{where}: expected integer, got {type(value).__name__}")
    return value


def _bool(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise TableError(f"{where}: expected boolean, got {type(value).__name__}")
    return value


def _dict(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TableError(f"{where}: expected object, got {type(value).__name__}")
    return cast(dict[str, Any], value)


def _list(value: object, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise TableError(f"{where}: expected list, got {type(value).__name__}")
    return value


def _compile(pattern: object, where: str, *, wrap: str = "{}") -> re.Pattern[str]:
    """Compile a table regex (case-insensitive) with a precise error location."""
    text = _str(pattern, where)
    try:
        return re.compile(wrap.format(text), re.I)
    except re.error as exc:
        raise TableError(f"{where}: invalid regular expression {text!r}: {exc}") from exc


def _section(table: Mapping[str, Any], key: str, where: str) -> dict[str, Any]:
    """A table section; every section must carry its own ``source`` and ``rationale``."""
    section = _dict(table.get(key), f"{where}.{key}")
    for prov in ("source", "rationale"):
        if not _str(section.get(prov), f"{where}.{key}.{prov}").strip():
            raise TableError(f"{where}.{key}: missing non-empty '{prov}'")
    return section


def _section_pattern(table: Mapping[str, Any], key: str, where: str) -> re.Pattern[str]:
    return _compile(_section(table, key, where).get("pattern"), f"{where}.{key}.pattern")


def _banded(table: Mapping[str, Any], key: str, where: str) -> _BandedGrade:
    section = _section(table, key, where)
    bands: list[_Band] = []
    for idx, raw in enumerate(_list(section.get("bands"), f"{where}.{key}.bands")):
        band = _dict(raw, f"{where}.{key}.bands[{idx}]")
        upper = band.get("upper")
        if upper is not None and (isinstance(upper, bool) or not isinstance(upper, int | float)):
            raise TableError(f"{where}.{key}.bands[{idx}].upper: expected number or null")
        bands.append(
            _Band(
                grade=_int(band.get("grade"), f"{where}.{key}.bands[{idx}].grade"),
                upper=None if upper is None else float(upper),
                inclusive=_bool(band.get("inclusive"), f"{where}.{key}.bands[{idx}].inclusive"),
            )
        )
    if not bands or bands[-1].upper is not None:
        raise TableError(f"{where}.{key}.bands: the last band must be unbounded (upper null)")
    return _BandedGrade(
        pattern=_compile(section.get("pattern"), f"{where}.{key}.pattern"),
        term=_str(section.get("term"), f"{where}.{key}.term"),
        bands=tuple(bands),
        basis=_str(section.get("basis"), f"{where}.{key}.basis"),
        range_basis=_optional_str(section.get("range_basis"), f"{where}.{key}.range_basis") or "",
        reader_basis=_optional_str(section.get("reader_basis"), f"{where}.{key}.reader_basis")
        or "",
    )


def _term_patterns(
    table: Mapping[str, Any], key: str, where: str
) -> tuple[tuple[str, re.Pattern[str]], ...]:
    """``{name: [regex]}`` -> ``((name, compiled), ...)`` in table order, wrapped in ``\\b``."""
    out: list[tuple[str, re.Pattern[str]]] = []
    for name, raw in _dict(table.get(key), f"{where}.{key}").items():
        patterns = _list(raw, f"{where}.{key}.{name}")
        if not patterns:
            raise TableError(f"{where}.{key}.{name}: needs at least one pattern")
        for idx, pattern in enumerate(patterns):
            out.append(
                (name, _compile(pattern, f"{where}.{key}.{name}[{idx}]", wrap=r"\b(?:{})\b"))
            )
    return tuple(out)


@cache
def _lexicon() -> _Lexicon:
    """The compiled ``chartscan_lexicon.json``; validated and compiled once per process."""
    where = "chartscan_lexicon"
    table = load_table(where)
    provenance = _dict(table.get("provenance"), f"{where}.provenance")
    for key in ("symptom_patterns", "med_patterns"):
        _section(provenance, key, f"{where}.provenance")
    severity = _section(table, "severity_words", where)
    words = tuple(
        _SeverityWord(
            pattern=_compile(
                _dict(raw, f"{where}.severity_words.words[{idx}]").get("pattern"),
                f"{where}.severity_words.words[{idx}].pattern",
            ),
            grade=_int(
                _dict(raw, f"{where}.severity_words.words[{idx}]").get("grade"),
                f"{where}.severity_words.words[{idx}].grade",
            ),
        )
        for idx, raw in enumerate(_list(severity.get("words"), f"{where}.severity_words.words"))
    )
    default = _section(table, "default_grade", where)
    hospital = _section(table, "hospital", where)
    numbers = _section(table, "number_words", where)
    number_words = {
        _str(k, f"{where}.number_words.values"): _int(v, f"{where}.number_words.values.{k}")
        for k, v in _dict(numbers.get("values"), f"{where}.number_words.values").items()
    }
    relative = _section(table, "relative_days", where)
    relative_days = tuple(
        _RelativeDay(
            pattern=_compile(
                _dict(raw, f"{where}.relative_days.phrases[{idx}]").get("pattern"),
                f"{where}.relative_days.phrases[{idx}].pattern",
            ),
            days=_int(
                _dict(raw, f"{where}.relative_days.phrases[{idx}]").get("days"),
                f"{where}.relative_days.phrases[{idx}].days",
            ),
        )
        for idx, raw in enumerate(_list(relative.get("phrases"), f"{where}.relative_days.phrases"))
    )
    temperature = _section(table, "temperature_high", where)
    normalization: dict[int, str] = {}
    norm_map = _dict(
        _section(table, "text_normalization", where).get("map"),
        f"{where}.text_normalization.map",
    )
    for raw_key, raw_value in norm_map.items():
        key = _str(raw_key, f"{where}.text_normalization.map")
        value = _str(raw_value, f"{where}.text_normalization.map[{key!r}]")
        if len(key) != 1 or len(value) != 1:
            raise TableError(
                f"{where}.text_normalization.map[{key!r}]: entries must map one code point "
                "to one code point so span offsets stay valid"
            )
        normalization[ord(key)] = value
    scope_section = _section(table, "scope", where)
    scope = _Scope(
        **{
            name: _int(scope_section.get(name), f"{where}.scope.{name}")
            for name in _Scope.__dataclass_fields__
        }
    )
    for name, value in scope.__dict__.items():
        if value < 1:
            raise TableError(f"{where}.scope.{name}: must be a positive integer")
    max_grade = _int(
        load_table("composite_to_grade").get("max_assignable_grade"),
        "composite_to_grade.max_assignable_grade",
    )
    hospital_raise_to = _int(hospital.get("raise_grade_to"), f"{where}.hospital.raise_grade_to")
    stool_count, bsa = _banded(table, "stool_count", where), _banded(table, "bsa", where)
    graded: list[tuple[int, str]] = [
        (hospital_raise_to, f"{where}.hospital.raise_grade_to"),
        *((w.grade, f"{where}.severity_words") for w in words),
        *((b.grade, f"{where}.stool_count.bands") for b in stool_count.bands),
        *((b.grade, f"{where}.bsa.bands") for b in bsa.bands),
    ]
    for grade, location in graded:
        if grade > max_grade:
            raise TableError(
                f"{location}: grade {grade} exceeds composite_to_grade.max_assignable_grade "
                f"({max_grade}); this system never assigns a higher grade"
            )
    return _Lexicon(
        symptoms=_term_patterns(table, "symptom_patterns", where),
        meds=_term_patterns(table, "med_patterns", where),
        normalization=normalization,
        scope=scope,
        max_grade=max_grade,
        negation=_section_pattern(table, "negation", where),
        pseudo_negation=_section_pattern(table, "pseudo_negation", where),
        terminators=_section_pattern(table, "terminators", where),
        historical=_section_pattern(table, "historical", where),
        hypothetical=_section_pattern(table, "hypothetical", where),
        post_negation=_section_pattern(table, "post_negation", where),
        resolved=_section_pattern(table, "resolved", where),
        severity_words=words,
        explicit_grade=_section_pattern(table, "explicit_grade", where),
        default_grade=_int(default.get("grade"), f"{where}.default_grade.grade"),
        default_basis=_str(default.get("basis"), f"{where}.default_grade.basis"),
        stool_count=stool_count,
        bsa=bsa,
        worsening=_section_pattern(table, "worsening", where),
        hospital=_compile(hospital.get("pattern"), f"{where}.hospital.pattern"),
        hospital_raise_to=hospital_raise_to,
        hospital_basis_suffix=_str(hospital.get("basis_suffix"), f"{where}.hospital.basis_suffix"),
        number_words=number_words,
        duration=_section_pattern(table, "duration", where),
        relative_days=relative_days,
        med_started=_section_pattern(table, "med_started", where),
        med_stopped=_section_pattern(table, "med_stopped", where),
        med_changed=_section_pattern(table, "med_changed", where),
        med_negated=_section_pattern(table, "med_negated", where),
        allergy=_section_pattern(table, "allergy", where),
        indication=_section_pattern(table, "indication", where),
        human_request=_section_pattern(table, "human_request", where),
        temperature_high=_str(temperature.get("pattern"), f"{where}.temperature_high.pattern"),
    )


@cache
def _red_flag_table() -> _RedFlagTable:
    """The compiled ``chartscan_red_flags.json``."""
    where = "chartscan_red_flags"
    table = load_table(where)
    levels = _dict(table.get("levels"), f"{where}.levels")
    rules: list[_RedFlagRule] = []
    seen: set[str] = set()
    for idx, raw in enumerate(_list(table.get("rules"), f"{where}.rules")):
        entry = _dict(raw, f"{where}.rules[{idx}]")
        category = _str(entry.get("category"), f"{where}.rules[{idx}].category")
        if category in seen:
            raise TableError(f"{where}.rules[{idx}]: duplicate category {category!r}")
        seen.add(category)
        level = _str(entry.get("level"), f"{where}.rules[{idx}].level")
        if level not in levels or level not in ("emergency", "urgent"):
            raise TableError(f"{where}.rules[{idx}].level: unknown level {level!r}")
        raw_pattern = _str(entry.get("pattern"), f"{where}.rules[{idx}].pattern")
        rules.append(
            _RedFlagRule(
                category=category,
                level=cast(RedFlagLevel, level),
                seriousness=_bool(entry.get("seriousness"), f"{where}.rules[{idx}].seriousness"),
                pattern=_compile(
                    raw_pattern, f"{where}.rules[{idx}].pattern", wrap=r"(?<!\w)(?:{})"
                ),
                raw_pattern=raw_pattern,
                reason=_str(entry.get("reason"), f"{where}.rules[{idx}].reason"),
            )
        )
    order = [
        _str(level, f"{where}.escalation_levels")
        for level in _list(table.get("escalation_levels"), f"{where}.escalation_levels")
    ]
    for required in ("none", "human_requested", "urgent", "emergency"):
        if required not in order:
            raise TableError(f"{where}.escalation_levels: missing {required!r}")
    return _RedFlagTable(
        rules=tuple(rules), escalation_rank={lvl: rank for rank, lvl in enumerate(order)}
    )


def lexicon_temperature_pattern() -> str:
    """The fever-range temperature regex (shared by the lexicon and the fever red flag)."""
    return _lexicon().temperature_high


def red_flag_pattern(category: str) -> str:
    """The raw regex of a red-flag category (for tests that pin cross-table consistency)."""
    for rule in _red_flag_table().rules:
        if rule.category == category:
            return rule.raw_pattern
    raise KeyError(category)


def hospital_pattern() -> str:
    """The raw hospital/ER regex from the lexicon (also the hospitalization red flag)."""
    return _str(
        _dict(load_table("chartscan_lexicon").get("hospital"), "chartscan_lexicon.hospital").get(
            "pattern"
        ),
        "chartscan_lexicon.hospital.pattern",
    )


# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #


def _normalize(lex: _Lexicon, text: str) -> str:
    """The text with typographic punctuation mapped to ASCII (``text_normalization``).

    Every substitution is one code point for one, so ``len`` and every offset are unchanged;
    callers match on the result and slice quotes from the original.
    """
    return text.translate(lex.normalization)


def _sentences(text: str) -> list[tuple[int, int]]:
    """``(start, end)`` offsets of sentences; splits on ``. ! ?`` and newlines, not ``100.4``."""
    spans: list[tuple[int, int]] = []
    start = 0
    for m in _SENTENCE_SPLIT.finditer(text):
        end = m.end()
        if text[start:end].strip():
            spans.append((start, end))
        start = end
    if text[start:].strip():
        spans.append((start, len(text)))
    return spans


def _sentence_for(spans: Sequence[tuple[int, int]], pos: int) -> tuple[int, int]:
    for s, e in spans:
        if s <= pos < e:
            return s, e
    return (spans[0][0], spans[-1][1]) if spans else (0, pos + 1)


def _scope_before(lex: _Lexicon, text: str, sent_start: int, pos: int) -> str:
    """Words before ``pos`` in the same sentence, after the last terminator, at most
    ``scope.negation_max_words`` words."""
    pre = text[sent_start:pos]
    terminators = list(lex.terminators.finditer(pre))
    if terminators:
        pre = pre[terminators[-1].end() :]
    words = pre.split()
    return " ".join(words[-lex.scope.negation_max_words :])


@dataclass(frozen=True)
class _Exclusion:
    reason: ExcludedReason
    cue: str
    explanation: str


def _context_exclusion(
    lex: _Lexicon, text: str, sent_start: int, sent_end: int, start: int, end: int
) -> _Exclusion | None:
    """NegEx-style check: negation (before, within the clause; or just after), history,
    hypothetical (any cue that starts earlier in the sentence, even one that runs into the
    term: "go to the ER if" silences the ER cue)."""
    quote = text[start:end]
    scope = lex.pseudo_negation.sub(" ", _scope_before(lex, text, sent_start, start))
    m = lex.negation.search(scope)
    if m:
        return _Exclusion(
            "negated", m.group(0), f"'{m.group(0)}' precedes '{quote}' in the same clause"
        )
    m = lex.post_negation.search(text[end:sent_end])
    if m:
        cue = _WORD_EDGES.sub("", m.group(0))
        return _Exclusion("negated", cue, f"'{cue}' follows '{quote}'")
    m = lex.historical.search(scope)
    if m:
        return _Exclusion(
            "historical", m.group(0), f"'{m.group(0)}' precedes '{quote}': past history"
        )
    for m in lex.hypothetical.finditer(text, sent_start, sent_end):
        if m.start() >= start:
            break
        return _Exclusion(
            "hypothetical",
            m.group(0),
            f"'{m.group(0)}' earlier in the sentence: an instruction or precaution, not a report",
        )
    return None


def _unexcluded_hospital_cue(
    lex: _Lexicon, text: str, sent_start: int, sent_end: int
) -> str | None:
    """The first hospital/ER word in the sentence that is not itself negated, historical or
    hypothetical ("Not admitted; has diarrhea" has no cue), else ``None``."""
    for m in lex.hospital.finditer(text, sent_start, sent_end):
        if _context_exclusion(lex, text, sent_start, sent_end, m.start(), m.end()) is None:
            return m.group(0)
    return None


def _days_from_phrase(lex: _Lexicon, num: str, unit: str) -> int:
    n = int(num) if num.isdigit() else lex.number_words.get(num.lower(), 1)
    return n * 7 if unit.lower().startswith("w") else n


def _onset_days(lex: _Lexicon, window: str) -> int | None:
    m = lex.duration.search(window)
    if m:
        return _days_from_phrase(lex, m.group(1), m.group(2))
    for phrase in lex.relative_days:
        if phrase.pattern.search(window):
            return phrase.days
    return None


def _banded_grade(banded: _BandedGrade, value: float) -> int:
    for band in banded.bands:
        if band.contains(value):
            return band.grade
    return banded.bands[-1].grade  # pragma: no cover - the last band is always unbounded


def _grade_from_context(
    lex: _Lexicon, term: str, pre: str, post: str, window: str, sentence: str
) -> tuple[int, str]:
    """Nearest severity cue wins: explicit grade > stool count / BSA > severity word. An
    explicit grade above ``max_grade`` is capped (this system never assigns G4/G5)."""
    m = lex.explicit_grade.search(window)
    if m:
        g = int(m.group(1) or m.group(2))
        if g > lex.max_grade:
            return lex.max_grade, (
                f"clinician wrote 'grade {g}'; hint capped at {lex.max_grade} because this "
                f"system never assigns a grade above {lex.max_grade}, investigator to confirm"
            )
        return g, f"explicit 'grade {g}' written in the text"
    if term == lex.bsa.term:
        m = lex.bsa.pattern.search(sentence)
        if m:
            pct = float(m.group(1))
            g = _banded_grade(lex.bsa, pct)
            return g, lex.bsa.basis.format(match=m.group(0), grade=g)
    if term == lex.stool_count.term:
        m = lex.stool_count.pattern.search(sentence)
        if m:
            low, high = m.group(1), m.group(2)
            n = max(int(low), int(high)) if low else int(high)
            g = _banded_grade(lex.stool_count, n)
            if low and lex.stool_count.range_basis:
                return g, lex.stool_count.range_basis.format(
                    lo=int(low), hi=int(high), n=n, grade=g
                )
            return g, lex.stool_count.basis.format(n=n, grade=g)
    best: tuple[int, int, str] | None = None  # (distance, grade, word)
    for word in lex.severity_words:
        for before in word.pattern.finditer(pre):
            d = len(pre) - before.end()
            if best is None or d < best[0]:
                best = (d, word.grade, before.group(0))
        after = word.pattern.search(post)
        if after and (best is None or after.start() < best[0]):
            best = (after.start(), word.grade, after.group(0))
    if best:
        _, grade, cue = best
        return grade, f"severity word '{cue}' next to the symptom -> provisional grade {grade}"
    return lex.default_grade, lex.default_basis


# --------------------------------------------------------------------------- #
# Symptoms
# --------------------------------------------------------------------------- #


@dataclass
class _SymptomHit:
    """Mutable working record for one symptom match; frozen into a SymptomFinding at the end."""

    term: str
    start: int
    end: int
    quote: str
    excluded: _Exclusion | None
    grade: int
    basis: str
    onset_days: int | None
    worsening: bool
    resolved_cue: str | None
    hospital_cue: str | None

    def absorb(self, other: _SymptomHit) -> None:
        """Take the onset and hospital cue from ``other`` when this hit lacks them."""
        if self.onset_days is None:
            self.onset_days = other.onset_days
        if self.hospital_cue is None:
            self.hospital_cue = other.hospital_cue

    def finding(self, ref_date: date | None) -> SymptomFinding:
        if self.excluded is not None:
            reason = f"{self.excluded.reason}: {self.excluded.explanation}"
            grade: int | None = None
            basis = f"not graded: mention excluded ({self.excluded.reason})"
        else:
            reason = (
                f"'{self.quote}' matched CTCAE term {self.term}; "
                "no negation, history or instruction cue in scope"
            )
            if self.resolved_cue:
                reason += f"; the text says it resolved ('{self.resolved_cue.strip()}')"
            if self.hospital_cue:
                reason += (
                    f"; '{self.hospital_cue}' in the same sentence, not negated "
                    "(possible hospitalization)"
                )
            grade, basis = self.grade, self.basis
        onset_date = (
            (ref_date - timedelta(days=self.onset_days)).isoformat()
            if ref_date is not None and self.onset_days is not None
            else None
        )
        return SymptomFinding(
            term=self.term,
            quote=self.quote,
            span_start=self.start,
            span_end=self.end,
            reason=reason,
            grade_hint=grade,
            grade_basis=basis,
            onset_days=self.onset_days,
            worsening=self.worsening,
            excluded_reason=None if self.excluded is None else self.excluded.reason,
            onset_date=onset_date,
            resolved=self.excluded is None and self.resolved_cue is not None,
        )


def _overlaps(start: int, end: int, taken: Sequence[tuple[int, int]]) -> bool:
    return any(not (end <= s or start >= e) for s, e in taken)


def find_symptoms(
    text: str, ref_date: date | None = None
) -> tuple[tuple[SymptomFinding, ...], tuple[SymptomFinding, ...]]:
    """``(kept, excluded)`` symptom findings, one kept finding per CTCAE term.

    Two mentions of one term merge into one finding: the higher grade hint wins, the onset and
    hospital cue are kept from either, ``worsening`` is true if either was. A term that is both
    mentioned and negated elsewhere counts as mentioned and its exclusions are dropped.
    """
    lex = _lexicon()
    original, text = text, _normalize(lex, text)
    sc = lex.scope
    spans = _sentences(text)
    hits: list[_SymptomHit] = []
    taken: dict[str, list[tuple[int, int]]] = {}

    for term, rx in lex.symptoms:
        for m in rx.finditer(text):
            start, end = m.span()
            if _overlaps(start, end, taken.get(term, [])):
                continue
            ss, se = _sentence_for(spans, start)
            sentence = text[ss:se].strip()
            window = text[
                max(ss, start - sc.grade_window_chars) : min(se, end + sc.grade_window_chars)
            ]
            exclusion = _context_exclusion(lex, text, ss, se, start, end)
            grade, basis = _grade_from_context(
                lex,
                term,
                text[max(ss, start - sc.severity_before_chars) : start],
                text[end : min(se, end + sc.severity_after_chars)],
                window,
                sentence,
            )
            onset_window = text[
                max(ss, start - sc.onset_before_chars) : min(se, end + sc.onset_after_chars)
            ]
            resolved = lex.resolved.search(text[end:se])
            hospital_cue = None
            if exclusion is None:
                hospital_cue = _unexcluded_hospital_cue(lex, text, ss, se)
                if hospital_cue is not None and grade < lex.hospital_raise_to:
                    grade, basis = lex.hospital_raise_to, basis + lex.hospital_basis_suffix
            hits.append(
                _SymptomHit(
                    term=term,
                    start=start,
                    end=end,
                    quote=original[start:end],
                    excluded=exclusion,
                    grade=grade,
                    basis=basis,
                    onset_days=_onset_days(lex, onset_window),
                    worsening=bool(lex.worsening.search(window)),
                    resolved_cue=None if resolved is None else resolved.group(0),
                    hospital_cue=hospital_cue,
                )
            )
            taken.setdefault(term, []).append((start, end))

    by_term: dict[str, _SymptomHit] = {}
    excluded_hits: list[_SymptomHit] = []
    for hit in sorted(hits, key=lambda h: h.start):
        if hit.excluded is not None:
            excluded_hits.append(hit)
            continue
        current = by_term.get(hit.term)
        if current is None or hit.grade > current.grade:
            if current is not None:
                hit.absorb(current)
            by_term[hit.term] = hit
        else:
            current.absorb(hit)
            current.worsening = current.worsening or hit.worsening
    kept = tuple(hit.finding(ref_date) for hit in by_term.values())
    excluded = tuple(hit.finding(ref_date) for hit in excluded_hits if hit.term not in by_term)
    return kept, excluded


def symptom_terms() -> tuple[str, ...]:
    """Every CTCAE term the scanner's lexicon can emit (part of the reader's closed vocabulary)."""
    return tuple(dict.fromkeys(term for term, _ in _lexicon().symptoms))


def reader_symptom_finding(
    text: str,
    term: str,
    start: int,
    end: int,
    *,
    ref_date: date | None = None,
    count: float | None = None,
) -> SymptomFinding:
    """A kept finding for a span a language-model reader proposed and ``llm_verify`` verified.

    The grade is the scanner's own, never the model's: the stool-count band when ``term`` is
    the diarrhea term and the verified quote carries a ``count``; otherwise the same context
    grading :func:`find_symptoms` applies (an explicit "grade N", a severity word, the
    hospital cue), and the table's default grade when the sentence says nothing about
    severity. ``text[start:end]`` is the quote.
    """
    lex = _lexicon()
    original, norm = text, _normalize(lex, text)
    sc = lex.scope
    ss, se = _sentence_for(_sentences(norm), start)
    window = norm[max(ss, start - sc.grade_window_chars) : min(se, end + sc.grade_window_chars)]
    if term == lex.stool_count.term and count is not None:
        n = int(count)
        grade = _banded_grade(lex.stool_count, n)
        basis = (lex.stool_count.reader_basis or lex.stool_count.basis).format(n=n, grade=grade)
    else:
        grade, basis = _grade_from_context(
            lex,
            term,
            norm[max(ss, start - sc.severity_before_chars) : start],
            norm[end : min(se, end + sc.severity_after_chars)],
            window,
            norm[ss:se].strip(),
        )
    hospital_cue = _unexcluded_hospital_cue(lex, norm, ss, se)
    if hospital_cue is not None and grade < lex.hospital_raise_to:
        grade, basis = lex.hospital_raise_to, basis + lex.hospital_basis_suffix
    onset_window = norm[
        max(ss, start - sc.onset_before_chars) : min(se, end + sc.onset_after_chars)
    ]
    onset_days = _onset_days(lex, onset_window)
    resolved = lex.resolved.search(norm[end:se])
    quote = original[start:end]
    reason = (
        f"'{quote}' read by the second reader as CTCAE term {term}; the quote was found "
        "word for word in the text"
    )
    if hospital_cue is not None:
        reason += f"; '{hospital_cue}' in the same sentence, not negated (possible hospitalization)"
    return SymptomFinding(
        term=term,
        quote=quote,
        span_start=start,
        span_end=end,
        reason=reason,
        grade_hint=grade,
        grade_basis=basis,
        onset_days=onset_days,
        worsening=bool(lex.worsening.search(window)),
        excluded_reason=None,
        onset_date=(
            (ref_date - timedelta(days=onset_days)).isoformat()
            if ref_date is not None and onset_days is not None
            else None
        ),
        resolved=resolved is not None,
    )


# --------------------------------------------------------------------------- #
# Medications
# --------------------------------------------------------------------------- #


def _nearest_action(
    lex: _Lexicon, before: str, drug: str, after: str
) -> tuple[MedChange, str, str] | None:
    """``(change, verb, 'before'|'after')`` for the action verb nearest the drug in its clause:
    the last one before it, else the first within ``scope.med_verb_lookahead_chars`` after it.

    Verbs before the drug are matched over the whole clause and kept only when they end before
    the drug, so a cue with a lookahead ("switched from" only when "<drug> to" follows) can see
    the drug it precedes."""
    best: tuple[int, MedChange, str, str] | None = None
    verbs: tuple[tuple[re.Pattern[str], MedChange], ...] = (
        (lex.med_started, "started"),
        (lex.med_stopped, "stopped"),
        (lex.med_changed, "changed"),
    )
    clause = before + drug + after
    for rx, change in verbs:
        for verb_before in rx.finditer(clause):
            if verb_before.end() > len(before):
                break
            dist = len(before) - verb_before.end()
            if best is None or dist < best[0]:
                best = (dist, change, verb_before.group(0), "before")
        verb_after = rx.search(after[: lex.scope.med_verb_lookahead_chars])
        if verb_after:
            dist = verb_after.start()
            if best is None or dist < best[0]:
                best = (dist, change, verb_after.group(0), "after")
    return None if best is None else (best[1], best[2], best[3])


def _indication(lex: _Lexicon, text: str, ss: int, start: int, end: int, ce: int) -> str | None:
    """The reason a drug was given: 'X for <reason>' right after it (up to the next action
    verb), else a 'for <reason>' earlier in the sentence when no other drug precedes it."""
    region = text[end:ce]
    cuts = [
        m2.start()
        for m2 in (r.search(region) for r in (lex.med_started, lex.med_stopped, lex.med_changed))
        if m2
    ]
    region = region[: min(cuts)] if cuts else region
    im = lex.indication.search(region)
    if not im and not any(r.search(text[ss:start]) for _, r in lex.meds):
        before_hits = list(lex.indication.finditer(text[ss:start]))
        im = before_hits[-1] if before_hits else None
    if not im:
        return None
    raw = im.group(1).strip()
    symptoms, _ = find_symptoms(raw)
    return f"{raw} ({symptoms[0].term})" if symptoms else raw


def _med_clause(text: str, ss: int, se: int, start: int, end: int) -> tuple[str, str, int]:
    """``(before, after, clause_end)``: the sentence segment bounded by commas / semicolons
    around the drug at ``text[start:end]``."""
    cs = max(text.rfind(",", ss, start), text.rfind(";", ss, start), ss - 1) + 1
    ce_candidates = [i for i in (text.find(",", end, se), text.find(";", end, se)) if i != -1]
    ce = min(ce_candidates) if ce_candidates else se
    return text[cs:start], text[end:ce], ce


def _med_exclusion(
    lex: _Lexicon, text: str, ss: int, se: int, start: int, before: str, after: str
) -> tuple[ExcludedReason, str] | None:
    """``(excluded_reason, reason)`` when the drug mention is an allergy listing or a declined
    prescription, else ``None``."""
    sc = lex.scope
    sentence = text[ss:se].strip()
    if lex.allergy.search(
        text[max(ss, start - sc.allergy_lookback_chars) : start]
    ) or sentence.lower().startswith("allerg"):
        return "allergy", "listed as an allergy, not a medication taken"
    negated = lex.med_negated.search(before + " " + after[: sc.med_negated_lookahead_chars])
    if negated:
        return "negated", f"medication was declined / not started ('{negated.group(0)}')"
    return None


def reader_med_exclusion(text: str, start: int, end: int) -> tuple[ExcludedReason, str] | None:
    """The scanner's allergy / declined-prescription rule applied to a span a reader proposed
    as a medication, so a reader cannot add a drug the rules would have excluded."""
    lex = _lexicon()
    norm = _normalize(lex, text)
    ss, se = _sentence_for(_sentences(norm), start)
    before, after, _ = _med_clause(norm, ss, se, start, end)
    return _med_exclusion(lex, norm, ss, se, start, before, after)


def reader_symptom_exclusion(text: str, start: int, end: int) -> tuple[ExcludedReason, str] | None:
    """The scanner's negation / history / hypothetical rule applied to a span a reader proposed
    as a current symptom, so a reader cannot add a mention the rules would have excluded."""
    lex = _lexicon()
    norm = _normalize(lex, text)
    ss, se = _sentence_for(_sentences(norm), start)
    found = _context_exclusion(lex, norm, ss, se, start, end)
    return None if found is None else (found.reason, found.explanation)


def find_meds(text: str) -> tuple[tuple[MedFinding, ...], tuple[MedFinding, ...]]:
    """``(kept, excluded)`` medication findings, one kept finding per generic name.

    The first mention of a drug wins unless it said nothing about an action ("taking") and a
    later mention does ("started"/"stopped"/"changed"). Allergy listings and declined
    prescriptions are returned as excluded.
    """
    lex = _lexicon()
    original, text = text, _normalize(lex, text)
    spans = _sentences(text)
    kept: dict[str, MedFinding] = {}
    excluded: list[MedFinding] = []
    covered: list[tuple[int, int]] = []

    for drug, rx in lex.meds:
        for m in rx.finditer(text):
            start, end = m.span()
            if _overlaps(start, end, covered):
                continue  # e.g. "amoxicillin" inside "amoxicillin-clavulanate"
            covered.append((start, end))
            ss, se = _sentence_for(spans, start)
            before, after, ce = _med_clause(text, ss, se, start, end)
            quote = original[start:end]

            blocked = _med_exclusion(lex, text, ss, se, start, before, after)
            if blocked is not None:
                excluded.append(
                    MedFinding(
                        drug=drug,
                        change="taking",
                        quote=quote,
                        span_start=start,
                        span_end=end,
                        reason=blocked[1],
                        excluded_reason=blocked[0],
                    )
                )
                continue

            action = _nearest_action(lex, before, quote, after)
            if action:
                change, verb, side = action
                reason = f"'{verb}' appears {side} '{quote}' in the same clause -> {change}"
            else:
                change = "taking"
                reason = f"'{quote}' mentioned with no start/stop verb -> currently taking"
            indication = _indication(lex, text, ss, start, end, ce)
            if indication:
                reason += f"; indication: {indication}"

            finding = MedFinding(
                drug=drug,
                change=change,
                quote=quote,
                span_start=start,
                span_end=end,
                reason=reason,
            )
            prev = kept.get(drug)
            if prev is None or (prev.change == "taking" and finding.change != "taking"):
                kept[drug] = finding
    return tuple(kept.values()), tuple(excluded)


# --------------------------------------------------------------------------- #
# Red flags, human request, scan
# --------------------------------------------------------------------------- #


def find_red_flags(text: str) -> tuple[RedFlag, ...]:
    """One red flag per category (its first non-excluded match), in table order."""
    lex = _lexicon()
    original, text = text, _normalize(lex, text)
    spans = _sentences(text)
    out: list[RedFlag] = []
    for rule in _red_flag_table().rules:
        for m in rule.pattern.finditer(text):
            ss, se = _sentence_for(spans, m.start())
            if _context_exclusion(lex, text, ss, se, m.start(), m.end()):
                continue
            out.append(
                RedFlag(
                    level=rule.level,
                    category=rule.category,
                    quote=original[m.start() : m.end()],
                    reason=rule.reason,
                    span_start=m.start(),
                    span_end=m.end(),
                )
            )
            break
    return tuple(out)


def scan_text(
    text: str, ref_date: date | None = None, *, detect_human_request: bool = False
) -> ScanResult:
    """Scan one chart note or participant utterance.

    ``ref_date`` (the note date) turns ``onset_days`` into ``onset_date``; the caller passes it,
    the rules package never reads the clock. ``detect_human_request`` is for utterances typed
    or spoken by a participant; clinician notes mention "representative" in other senses.
    Typographic apostrophes and quotes are normalized before matching; every offset indexes
    ``text`` exactly as given.
    """
    symptoms, excluded_symptoms = find_symptoms(text, ref_date)
    meds, excluded_meds = find_meds(text)
    lex = _lexicon()
    human = bool(detect_human_request and lex.human_request.search(_normalize(lex, text)))
    return ScanResult(
        symptoms=symptoms,
        excluded_symptoms=excluded_symptoms,
        meds=meds,
        excluded_meds=excluded_meds,
        red_flags=find_red_flags(text),
        human_requested=human,
    )


def seriousness_suspected(result: ScanResult) -> bool:
    """True when a red flag of a seriousness category (hospitalization / ER) fired."""
    serious = {rule.category for rule in _red_flag_table().rules if rule.seriousness}
    return any(flag.category in serious for flag in result.red_flags)


def escalation_level(result: ScanResult, kind: ScanKind) -> EscalationLevel:
    """Highest escalation a scan warrants.

    In a chart note every red flag routes to the coordinator as ``urgent`` (notes are
    retrospective; nobody is told to call 911 and a note never produces Tier 3: D-017). In an
    utterance the red flag's own level applies; a request for a person is ``human_requested``.
    """
    rank = _red_flag_table().escalation_rank
    levels: list[EscalationLevel] = ["none"]
    for flag in result.red_flags:
        levels.append("urgent" if kind == "note" else flag.level)
    if result.human_requested:
        levels.append("human_requested")
    return max(levels, key=rank.__getitem__)


# --------------------------------------------------------------------------- #
# Serialization and rules-fired view
# --------------------------------------------------------------------------- #


def scan_result_to_dict(result: ScanResult) -> dict[str, Any]:
    """JSON-safe dict of a scan (dataclasses -> dicts, tuples -> lists)."""
    return cast(dict[str, Any], to_jsonable(result))


def rules_fired(result: ScanResult) -> list[dict[str, object]]:
    """The scan as plain-English rule firings (``rules_catalog.json`` ids, category
    ``chartscan``), one per finding, in a ``RuleFired``-like shape the API can wrap with
    ``chart_note`` evidence: ``rule_id, category, description, inputs, effect, span_start,
    span_end, quote``. ``why`` lines are the descriptions in order.
    """
    out: list[dict[str, object]] = []

    def add(
        rule_id: str,
        description: str,
        effect: str,
        start: int,
        end: int,
        quote: str,
        **inputs: object,
    ) -> None:
        out.append(
            {
                "rule_id": rule_id,
                "category": RULE_CATEGORY,
                "description": description,
                "inputs": {"quote": quote, "span_start": start, "span_end": end, **inputs},
                "effect": effect,
                "span_start": start,
                "span_end": end,
                "quote": quote,
            }
        )

    for s in result.symptoms:
        onset = f"; onset {s.onset_days} day(s) before the note" if s.onset_days is not None else ""
        worsening = "; worsening" if s.worsening else ""
        resolved = "; resolved per the text" if s.resolved else ""
        add(
            RULE_SYMPTOM,
            f"Chart note: '{s.quote}' -> {s.term}, provisional grade hint {s.grade_hint} "
            f"({s.grade_basis}){onset}{worsening}{resolved}",
            f"AE draft candidate: AEDECOD = {s.term}, AETOXGR hint = {s.grade_hint}",
            s.span_start,
            s.span_end,
            s.quote,
            term=s.term,
            grade_hint=s.grade_hint,
            grade_basis=s.grade_basis,
            onset_days=s.onset_days,
            onset_date=s.onset_date,
            worsening=s.worsening,
            resolved=s.resolved,
            reason=s.reason,
        )
    for s in result.excluded_symptoms:
        add(
            RULE_SYMPTOM_EXCLUDED,
            f"Chart note: '{s.quote}' ({s.term}) skipped: {s.reason}",
            "no AE draft (mention does not count)",
            s.span_start,
            s.span_end,
            s.quote,
            term=s.term,
            excluded_reason=s.excluded_reason,
            reason=s.reason,
        )
    for m in result.meds:
        add(
            RULE_MED,
            f"Chart note: '{m.quote}' -> {m.drug} ({m.change}): {m.reason}",
            f"CM draft candidate: CMDECOD = {m.drug}, change = {m.change}",
            m.span_start,
            m.span_end,
            m.quote,
            drug=m.drug,
            change=m.change,
            reason=m.reason,
        )
    for m in result.excluded_meds:
        add(
            RULE_MED_EXCLUDED,
            f"Chart note: '{m.quote}' ({m.drug}) skipped: {m.excluded_reason} ({m.reason})",
            "no CM draft (mention does not count)",
            m.span_start,
            m.span_end,
            m.quote,
            drug=m.drug,
            excluded_reason=m.excluded_reason,
            reason=m.reason,
        )
    for flag in result.red_flags:
        add(
            RULE_RED_FLAG,
            f"Chart note red flag ({flag.level}, {flag.category}): {flag.reason} -- '{flag.quote}'",
            "escalation: coordinator review as urgent (a note never pages or stops a kiosk)",
            flag.span_start,
            flag.span_end,
            flag.quote,
            level=flag.level,
            category=flag.category,
            reason=flag.reason,
        )
    serious = {rule.category for rule in _red_flag_table().rules if rule.seriousness}
    for flag in result.red_flags:
        if flag.category in serious:
            add(
                RULE_HOSPITALIZATION,
                f"Chart note mentions hospitalization or an ER visit ('{flag.quote}') -> "
                "seriousness suspected (ICH E2A); the SAE clock starts when the site reads "
                "the note",
                "seriousness_suspected = true; SAE clock site_awareness_at = ingestion time",
                flag.span_start,
                flag.span_end,
                flag.quote,
                category=flag.category,
            )
            break
    return out


# --------------------------------------------------------------------------- #
# Answer key and evaluation (reproduces backend/scripts/evaluate.py of the source repository)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ExpectedScan:
    """What the answer key expects for one case."""

    ae_terms: tuple[str, ...]
    meds: tuple[tuple[str, str], ...]
    escalation: EscalationLevel
    serious: bool


@dataclass(frozen=True)
class AnswerKeyCase:
    """One scored case: a synthetic chart note or a participant utterance."""

    id: str
    kind: ScanKind
    text: str
    ref_date: str
    expected: ExpectedScan
    note_id: str | None = None
    usubjid_label: str | None = None
    note_date: str | None = None
    author: str | None = None
    note_type: str | None = None


def _optional_str(value: object, where: str) -> str | None:
    return None if value is None else _str(value, where)


@cache
def answer_key() -> tuple[AnswerKeyCase, ...]:
    """The 25 cases of ``chartscan_answer_key.json``, validated."""
    where = "chartscan_answer_key"
    table = load_table(where)
    rank = _red_flag_table().escalation_rank
    utterance_ref = _str(table.get("utterance_ref_date"), f"{where}.utterance_ref_date")
    date.fromisoformat(utterance_ref)
    mapping = {
        _str(k, f"{where}.subject_mapping"): _str(v, f"{where}.subject_mapping.{k}")
        for k, v in _dict(table.get("subject_mapping"), f"{where}.subject_mapping").items()
    }
    out: list[AnswerKeyCase] = []
    seen: set[str] = set()
    for idx, raw in enumerate(_list(table.get("cases"), f"{where}.cases")):
        w = f"{where}.cases[{idx}]"
        entry = _dict(raw, w)
        case_id = _str(entry.get("id"), f"{w}.id")
        if case_id in seen:
            raise TableError(f"{w}: duplicate case id {case_id!r}")
        seen.add(case_id)
        kind = _str(entry.get("kind"), f"{w}.kind")
        if kind not in ("note", "utterance"):
            raise TableError(f"{w}.kind: expected 'note' or 'utterance', got {kind!r}")
        exp = _dict(entry.get("expected"), f"{w}.expected")
        escalation = _str(exp.get("escalation"), f"{w}.expected.escalation")
        if escalation not in rank:
            raise TableError(f"{w}.expected.escalation: unknown level {escalation!r}")
        meds: list[tuple[str, str]] = []
        for midx, pair in enumerate(_list(exp.get("meds"), f"{w}.expected.meds")):
            items = _list(pair, f"{w}.expected.meds[{midx}]")
            if len(items) != 2:
                raise TableError(f"{w}.expected.meds[{midx}]: expected [drug, change]")
            change = _str(items[1], f"{w}.expected.meds[{midx}][1]")
            if change not in ("started", "stopped", "changed", "taking"):
                raise TableError(f"{w}.expected.meds[{midx}][1]: unknown change {change!r}")
            meds.append((_str(items[0], f"{w}.expected.meds[{midx}][0]"), change))
        expected = ExpectedScan(
            ae_terms=tuple(
                _str(t, f"{w}.expected.ae_terms")
                for t in _list(exp.get("ae_terms"), f"{w}.expected.ae_terms")
            ),
            meds=tuple(meds),
            escalation=cast(EscalationLevel, escalation),
            serious=_bool(exp.get("serious", False), f"{w}.expected.serious"),
        )
        if kind == "note":
            note_date = _str(entry.get("note_date"), f"{w}.note_date")
            date.fromisoformat(note_date)
            label = _str(entry.get("usubjid_label"), f"{w}.usubjid_label")
            source_subject = _optional_str(entry.get("source_subject_id"), f"{w}.source_subject_id")
            if source_subject is not None and mapping.get(source_subject) != label:
                raise TableError(f"{w}: usubjid_label {label!r} disagrees with subject_mapping")
            out.append(
                AnswerKeyCase(
                    id=case_id,
                    kind="note",
                    text=_str(entry.get("text"), f"{w}.text"),
                    ref_date=note_date,
                    expected=expected,
                    note_id=_str(entry.get("note_id"), f"{w}.note_id"),
                    usubjid_label=label,
                    note_date=note_date,
                    author=_optional_str(entry.get("author"), f"{w}.author"),
                    note_type=_optional_str(entry.get("note_type"), f"{w}.note_type"),
                )
            )
        else:
            out.append(
                AnswerKeyCase(
                    id=case_id,
                    kind="utterance",
                    text=_str(entry.get("text"), f"{w}.text"),
                    ref_date=utterance_ref,
                    expected=expected,
                )
            )
    return tuple(out)


@dataclass(frozen=True)
class ScanPrediction:
    """What the scanner produced for one case, in answer-key terms."""

    ae_terms: tuple[str, ...]
    meds: tuple[tuple[str, str], ...]
    escalation: EscalationLevel
    serious: bool


def predict(result: ScanResult, kind: ScanKind) -> ScanPrediction:
    """Reduce a scan to the four things the answer key scores."""
    return ScanPrediction(
        ae_terms=tuple(sorted({s.term for s in result.symptoms})),
        meds=tuple(sorted({(m.drug, m.change) for m in result.meds})),
        escalation=escalation_level(result, kind),
        serious=seriousness_suspected(result),
    )


def predict_case(case: AnswerKeyCase) -> ScanPrediction:
    result = scan_text(
        case.text,
        date.fromisoformat(case.ref_date),
        detect_human_request=(case.kind == "utterance"),
    )
    return predict(result, case.kind)


@dataclass(frozen=True)
class PrecisionRecall:
    """Micro-averaged precision / recall / F1 over all cases (an empty class scores 1.0)."""

    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float

    @staticmethod
    def from_counts(tp: int, fp: int, fn: int) -> PrecisionRecall:
        p = tp / (tp + fp) if tp + fp else 1.0
        r = tp / (tp + fn) if tp + fn else 1.0
        f = 2 * p * r / (p + r) if p + r else 0.0
        return PrecisionRecall(tp, fp, fn, round(p, 3), round(r, 3), round(f, 3))


@dataclass(frozen=True)
class CaseOutcome:
    case_id: str
    kind: ScanKind
    ok: bool
    problems: tuple[str, ...]
    expected: ExpectedScan
    got: ScanPrediction


@dataclass(frozen=True)
class AnswerKeyEvaluation:
    """Scanner scores against the answer key, with the same arithmetic as the source
    repository's ``scripts/evaluate.py`` (micro P/R over terms and drugs, change accuracy over
    matched drugs, escalation recall, over-escalations, possible-SAE recall)."""

    n_cases: int
    ae_terms: PrecisionRecall
    meds: PrecisionRecall
    med_change_accuracy: float | None
    escalation_exact_match: float
    urgent_or_emergency_needed: int
    urgent_or_emergency_caught: int
    emergency_needed: int
    emergency_caught: int
    over_escalations: int
    serious_needed: int
    serious_caught: int
    per_case: tuple[CaseOutcome, ...]
    passed: bool
    """Every case matched its expectation exactly (the pass criterion is 100%)."""

    @property
    def misses(self) -> tuple[CaseOutcome, ...]:
        return tuple(c for c in self.per_case if not c.ok)


def evaluate_answer_key(cases: Sequence[AnswerKeyCase] | None = None) -> AnswerKeyEvaluation:
    """Score the scanner against ``cases`` (default: the shipped answer key)."""
    rank = _red_flag_table().escalation_rank
    urgent_rank, emergency_rank = rank["urgent"], rank["emergency"]
    cases = tuple(answer_key() if cases is None else cases)
    ae_tp = ae_fp = ae_fn = med_tp = med_fp = med_fn = 0
    change_hits = change_total = 0
    exact = urgent_needed = urgent_caught = emergency_needed = emergency_caught = over = 0
    serious_needed = serious_caught = 0
    outcomes: list[CaseOutcome] = []

    for case in cases:
        exp, got = case.expected, predict_case(case)
        e_terms, g_terms = set(exp.ae_terms), set(got.ae_terms)
        ae_tp += len(e_terms & g_terms)
        ae_fp += len(g_terms - e_terms)
        ae_fn += len(e_terms - g_terms)

        e_meds, g_meds = set(exp.meds), set(got.meds)
        e_drugs, g_drugs = {d for d, _ in e_meds}, {d for d, _ in g_meds}
        med_tp += len(e_drugs & g_drugs)
        med_fp += len(g_drugs - e_drugs)
        med_fn += len(e_drugs - g_drugs)
        for drug, change in e_meds:
            if drug in g_drugs:
                change_total += 1
                change_hits += (drug, change) in g_meds

        er, gr = rank[exp.escalation], rank[got.escalation]
        exact += er == gr
        if er >= urgent_rank:
            urgent_needed += 1
            urgent_caught += gr >= urgent_rank
        if er == emergency_rank:
            emergency_needed += 1
            emergency_caught += gr == emergency_rank
        over += gr > er
        if exp.serious:
            serious_needed += 1
            serious_caught += got.serious

        problems: list[str] = []
        if e_terms != g_terms:
            problems.append(
                f"AE missed={sorted(e_terms - g_terms)} extra={sorted(g_terms - e_terms)}"
            )
        if e_meds != g_meds:
            problems.append(f"meds expected={sorted(e_meds)} got={sorted(g_meds)}")
        if er != gr:
            problems.append(f"escalation expected={exp.escalation} got={got.escalation}")
        if exp.serious and not got.serious:
            problems.append("missed possible-SAE cue")
        outcomes.append(
            CaseOutcome(
                case_id=case.id,
                kind=case.kind,
                ok=not problems,
                problems=tuple(problems),
                expected=exp,
                got=got,
            )
        )

    return AnswerKeyEvaluation(
        n_cases=len(cases),
        ae_terms=PrecisionRecall.from_counts(ae_tp, ae_fp, ae_fn),
        meds=PrecisionRecall.from_counts(med_tp, med_fp, med_fn),
        med_change_accuracy=round(change_hits / change_total, 3) if change_total else None,
        escalation_exact_match=round(exact / len(cases), 3) if cases else 1.0,
        urgent_or_emergency_needed=urgent_needed,
        urgent_or_emergency_caught=urgent_caught,
        emergency_needed=emergency_needed,
        emergency_caught=emergency_caught,
        over_escalations=over,
        serious_needed=serious_needed,
        serious_caught=serious_caught,
        per_case=tuple(outcomes),
        passed=all(o.ok for o in outcomes),
    )


def evaluation_to_dict(evaluation: AnswerKeyEvaluation) -> dict[str, Any]:
    """JSON-safe dict of an evaluation (for ``docs/eval/results.md`` and ``POST /eval/run``)."""
    payload = cast(dict[str, Any], to_jsonable(evaluation))
    payload["misses"] = [cast(dict[str, Any], to_jsonable(m)) for m in evaluation.misses]
    return payload


__all__ = [
    "CHARTSCAN_TABLE_NAMES",
    "RULE_CATEGORY",
    "RULE_IDS",
    "AnswerKeyCase",
    "AnswerKeyEvaluation",
    "CaseOutcome",
    "EscalationLevel",
    "ExcludedReason",
    "ExpectedScan",
    "MedChange",
    "MedFinding",
    "PrecisionRecall",
    "RedFlag",
    "RedFlagLevel",
    "ScanKind",
    "ScanPrediction",
    "ScanResult",
    "SymptomFinding",
    "answer_key",
    "escalation_level",
    "evaluate_answer_key",
    "evaluation_to_dict",
    "find_meds",
    "find_red_flags",
    "find_symptoms",
    "predict",
    "predict_case",
    "rules_fired",
    "scan_result_to_dict",
    "scan_text",
    "seriousness_suspected",
]
