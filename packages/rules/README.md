# `interim_rules` — the deterministic rules engine

The core of Interim. One pure function, `evaluate_checkin(CheckInInput) -> CheckInResult`,
turns a completed between-visit check-in into:

| Output | What it is |
|---|---|
| `items[]` | PRO-CTCAE composite (0–3) and **provisional** CTCAE grade (0–3) per symptom |
| `escalation_tier` | 0 Log · 1 Coordinator review · 2 Nurse call today · 3 Urgent (stop screen + page) |
| `seriousness_suspected`, `sae_clock` | ICH E2A hospitalization trigger; site 24 h clock (`kind: "sae"`) + informational sponsor 7/15-day deadlines |
| `protocol`, `aesi_clock`, `protocol_tier_floor` | What the EMPOWER-Lung 1 protocol says about this check-in: possible AESI (24 h clock, `kind: "aesi"`), prohibited / discouraged / permitted con-med, CM fields still missing; a prohibited drug floors the tier at 2 (see [Protocol-aware rules](#protocol-aware-rules-protocolpy-empower-lung-1)) |
| `conmed` | Deterministic string match of the verbatim medication text (exact → case-insensitive → Levenshtein ≤ 2) |
| `vitals` | Per-sample, per-metric eligibility, quality status, medians/maxima |
| `drafts[]` | CDISC SDTM-shaped **AE**, **VS**, **CM** records; every field carries `evidence[]` |
| `rules_fired[]`, `why[]` | Every rule that fired, in plain English, with the inputs it used |

Design rules (CLAUDE.md §3.4, CONTRACTS.md §1):

* **No LLM, no network, no clock, no database.** Pure Python 3.12, frozen dataclasses, lookup tables
  and arithmetic. The only I/O is reading the package's own JSON tables in `../data/`.
* **Every clinical number lives in a table** with a `source` and a `rationale`. Code reads tables;
  code never hardcodes a threshold.
* **Vitals never change a grade.** They may raise the escalation tier by at most one step, and only
  when measured (or the admin demo toggle is on), confident, plausible and a documented rule matches.
* **Everything is provisional** until a coordinator confirms it and an investigator decides
  seriousness and causality.

## How the engine works

```
responses ──▶ scoring ──▶ grading ──▶ red flags ──┐
gates ──▶ con-med ──▶ protocol (floor) ────────────┼─▶ escalation ──▶ seriousness ──▶ AESI clock ──▶ dedup ──▶ drafting
vitals ─────▶ vitals quality ──▶ corroboration ───┘
```

(The con-med match and the protocol assessment are *computed* before the ladder because the
protocol floor feeds it; their rules are *listed* after `seriousness`, in the order
`conmed.* -> protocol.aesi_suspected -> aesi.clock_started -> protocol.conmed_* ->
protocol.cm_fields_missing`.)

| Stage | Module | Table | What it does |
|---|---|---|---|
| 1 Scoring | `scoring.py` | `composite_scoring.json` | Attribute answers → composite 0–3 using the **Basch et al. 2021** PRO-CTCAE composite grading tables (reproduced row-for-row from the ProAE reference implementation; 179 published combinations) |
| 2 Grading | `grading.py` | `composite_to_grade.json` | Composite → provisional CTCAE grade (1:1 crosswalk; never 4 or 5) |
| 3 Red flags | `red_flags.py`, `conditions.py` | `red_flags.json` | Severe dyspnea → floor 3; hospitalization/ER → floor 3 + seriousness; fever + severe item → floor 2; free text + severe item → floor 2 ("human read") |
| 4 Vitals | `vitals.py` | `vitals_corroboration.json` | Per sample & metric: confidence ≥ 0.6 (missing / NaN / outside 0..1 count as low), averaging window ≥ 12 s pulse / 30 s breathing / 60 s HRV, pulse 35–180, breathing 5–45, measured-or-toggle; a `mock` source is simulated whatever its `is_measured` flag says; status `unavailable > low_quality > implausible > simulated_ignored > ok`; medians/maxima |
| 5 Corroboration | `corroboration.py` | `vitals_corroboration.json` | Only when status is `ok`, using the session **maximum**: dyspnea ≥ 2 & breathing ≥ 24; dyspnea ≥ 2 & pulse ≥ 110; fever & pulse ≥ 110 → +1 tier |
| 6 Escalation | `escalation.py` | `escalation_ladder.json`, `vitals_corroboration.json` | `tier = min(3, max(base(max_grade), floor) + bump)`, `bump ≤ max_tier_bump` (table value, no literal in code); tier 3 ⇒ stop screen + page |
| 7 Seriousness | `seriousness.py` | `seriousness.json` | Hospitalization → `seriousness_suspected`, clock at `completed_at`, due +24 h |
| 8 Con-med | `conmed.py` | `medlist.json`, `conmed_matching.json` | Hand-written Levenshtein ≤ 2 with a confidence floor of 0.7 (a near-miss below it is `unmatched`, candidates still listed); brand → generic; verbatim text never altered; a "yes" with no name typed is still drafted (`CMTRT = ""`, flagged) |
| 8b Protocol | `protocol.py` | `protocol_rules.json`, `irae_mapping.json` | Possible AESI (grade ≥ 3 on a potentially immune-related item, or any grade after a PI 3-K inhibitor) → 24 h clock of kind `aesi`; con-med prohibited → tier floor 2, discouraged → coordinator flag with the protocol's exception text, permitted → note; CM fields the protocol requires that the kiosk could not fill. Never changes a grade |
| 9 Dedup | `dedup.py` | `dedup.json` | Same `AEDECOD` open within 7 days (inclusive) → follow-up, not a new AE; an open AE last reported by *this* session, or dated > 300 s in the future, is skipped with a logged reason |
| 10 Drafting | `drafting.py` | `ctcae_terms.json`, `protocol_rules.json` | AE / VS / CM records with per-field evidence; AE drafts of AESI items add `INTERIM_AESI_SUSPECTED`; CM drafts add `INTERIM_PROTOCOL_FLAG` and `INTERIM_CM_MISSING_FIELDS` |

`tables.py` loads and validates every table once per process; `serialize.py` converts to/from JSON;
`engine.py` validates the input up front (`validate_input`: ISO timestamps on every field,
`next_aeseq ≥ 1`, non-empty ids; `ValueError` names the field) and wires the stages in the order
above (which is also the order of `rules_fired`).

### Tier algorithm (CONTRACTS.md §1.5)

```
max_grade = max(item.provisional_grade)
base      = {0:0, 1:0, 2:1, 3:2}[max_grade]
floor     = max(tier_floor of fired red flags, default 0)
pfloor    = protocol_rules.json conmeds.prohibited_tier_floor (2) if a prohibited con-med, else 0
bump      = 1 if any corroboration rule fired and vitals.status == "ok" else 0
tier      = min(3, max(base, floor, pfloor) + bump)   # protocol floor joins before the bump
stop_screen = page_oncall = (tier == 3)
```

## Worked example (the demo persona)

Participant P-007 reports shortness of breath *Moderate* / *Somewhat* interfering, cough *Mild*,
everything else none, no hospitalization, "started loratadine", with one simulated vitals sample
(pulse 72, breathing 14).

```python
from interim_rules import evaluate_checkin
from interim_rules.serialize import input_from_dict, result_to_dict

result = evaluate_checkin(
    input_from_dict(
        {
            "session_id": "S1",
            "studyid": "R2810-ONC-1624",
            "usubjid": "R2810-ONC-1624-P-007",
            "completed_at": "2026-10-10T18:04:12.345Z",
            "nct_id": "NCT03088540",
            "responses": {
                "shortness_of_breath": {"severity": 2, "interference": 2},
                "cough": {"severity": 1, "interference": 0},
            },  # unanswered items count as 0
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
    )
)
```

`result.why` (one line per rule fired, in order):

```
Shortness of breath: severity = 2 (Moderate), interference = 2 (Somewhat) -> composite 2 (two_attribute_sev_int row (severity = 2, interference = 2) -> composite 2)
Cough: severity = 1 (Mild), interference = 0 (Not at all) -> composite 1 (...)
Shortness of breath (Dyspnea): composite 2 -> provisional CTCAE grade 2 (provisional, investigator to confirm)
Cough (Cough): composite 1 -> provisional CTCAE grade 1 (provisional, investigator to confirm)
Vitals: all usable samples are SIMULATED (mock) and 'treat simulated as measured' is OFF; summarized for the record but not eligible for corroboration
Vitals summary over 1 usable of 1 samples (SIMULATED, mock): pulse median 72 beats/min max 72 beats/min; breathing median 14 breaths/min max 14 breaths/min
Base tier 1 from highest provisional grade 2
Final escalation tier 1 (Coordinator review): Coordinator reviews within 1 business day.
Con-med 'loratadine' matched exactly to 'loratadine' (confidence 1.0)
Dyspnea: no open AE within 7 days -> new AE
Cough: no open AE within 7 days -> new AE
AE draft 1: Dyspnea (Shortness of breath), provisional grade 2
AE draft 2: Cough (Cough), provisional grade 1
VS draft PULSE: 72 beats/min (Simulated, n = 1)
VS draft RESP: 14 breaths/min (Simulated, n = 1)
CM draft: 'loratadine' -> loratadine (exact, confidence 1.0); started 2026-10-10, stopped -
```

Outputs: `escalation_tier = 1`, `max_grade = 2`, drafts `AE, AE, VS, VS, CM`. Each AE field points
at its evidence, e.g. `AETOXGR = 2` → `rule grade.provisional.shortness_of_breath` + the two
answer ids with their timestamps.

**Change the input and watch the output change.** Replay the same answers with a *measured*
sample at breathing 26 (or the simulated one with the admin toggle on): `corr.tachypnea_dyspnea`
fires ("tachypnea corroborates reported dyspnea"), `tier.corroboration_bump` reports `1 -> 2`, the
tier becomes 2 (Nurse call today) and **the grade stays 2**. Answer "yes" to hospitalization and
the tier becomes 3, the stop screen fires and the SAE clock starts.

## Rule catalog

Every rule id the engine can emit is listed in `data/rules_catalog.json` (the eval personas refer
to these ids). Summary:

| Rule id | Category | Fires when | Effect |
|---|---|---|---|
| `score.composite.<item>` | scoring | composite ≥ 1 | composite recorded |
| `grade.provisional.<item>` | grading | grade ≥ 1 | `AETOXGR` (provisional) |
| `redflag.severe_dyspnea` | red_flag | shortness_of_breath severity ≥ 3 | tier floor 3 |
| `redflag.fever_with_severe` | red_flag | fever/chills present AND any severe item | tier floor 2 |
| `redflag.hospitalization` | red_flag | hospital/ER = yes | tier floor 3; seriousness suspected |
| `redflag.other_text_with_severe` | red_flag | free text present AND any severe item | tier floor 2; human read (text never parsed) |
| `vitals.unavailable` / `.low_quality` / `.implausible` / `.simulated_ignored` / `.simulated_as_measured` / `.summary` | vitals_quality | see `vitals.py` docstring | status + summary; never a grade |
| `corr.tachypnea_dyspnea` | corroboration | dyspnea composite ≥ 2 AND max breathing ≥ 24 | +1 tier |
| `corr.tachycardia_dyspnea` | corroboration | dyspnea composite ≥ 2 AND max pulse ≥ 110 | +1 tier |
| `corr.tachycardia_fever` | corroboration | fever/chills present AND max pulse ≥ 110 | +1 tier |
| `tier.base` / `tier.redflag_floor` / `tier.protocol_floor` / `tier.corroboration_bump` / `tier.final` | escalation | always / floor > base / protocol floor > max(base, red-flag floor) / bump applied / always | the ladder, step by step |
| `sae.clock_started` | seriousness | hospitalization = yes | `site_awareness_at`, `due_at` (+24 h), `kind: "sae"` |
| `protocol.aesi_suspected` | protocol | grade ≥ 3 on a potentially immune-related item, or grade ≥ 1 on one with `prior_pi3k_inhibitor` | "possible AESI, investigator to confirm"; grade and tier unchanged |
| `aesi.clock_started` | protocol | `protocol.aesi_suspected` fired for an item without an existing AESI clock | `aesi_clock` (`kind: "aesi"`, due +24 h) |
| `aesi.clock_not_restarted` | protocol | a suspected item is a follow-up of an open AE with `aesi_clock_started` | no second clock for that item |
| `protocol.conmed_prohibited` / `_discouraged` / `_permitted` | protocol | the reported medication is on the protocol's list | tier floor 2 / coordinator flag (tier unchanged) / note |
| `protocol.cm_fields_missing` | protocol | a medication change was reported | `INTERIM_CM_MISSING_FIELDS` |
| `conmed.exact` / `.case_insensitive` / `.levenshtein` / `.unmatched` | conmed | one per con-med | `CMDECOD` proposal + confidence |
| `dedup.followup_linked` / `dedup.new_ae` | dedup | one per graded item | follow-up vs new AE |
| `draft.ae` / `draft.vs` / `draft.cm` | drafting | one per draft | draft created |

A "severe item" (used by two red flags) is defined once in `red_flags.json`: severity ≥ 3 for items
that ask severity; composite == 3 for items that do not.

## Data tables (`packages/rules/data/`)

| File | Content | Provenance |
|---|---|---|
| `proctcae_items.json` | The 10 items, attributes, response scales, kiosk prompts | Interim wording, *modeled on* NCI PRO-CTCAE (not the NCI text) |
| `gate_questions.json` | Hospital/ER, con-med, free text, optional temperature | Interim |
| `composite_scoring.json` | 179 published composite rows + zero rule + presence convention | Basch et al., Clin Trials 2021 (PMID 33258687) via ProAE v1.0.4 `comp_tab` |
| `composite_to_grade.json` | composite → provisional grade, max 3 | Interim convention (approximation, documented) |
| `ctcae_terms.json` | AEDECOD, grade 1–5 definitions, mock MedDRA codes | NCI CTCAE v5.0 (2017-11-27) spreadsheet |
| `red_flags.json` | 4 declarative rules + severe-item definition | CLAUDE.md §3.4(c) |
| `vitals_corroboration.json` | confidence, plausibility, `min_window_s` (12/30/60), `simulated_sources` (`mock`), `max_tier_bump`, 3 corroboration rules, method labels | CLAUDE.md §3.3, §3.4(d), §7.1 |
| `escalation_ladder.json` | tiers 0–3, actions, SLAs, stop-screen text | CLAUDE.md §3.4(e) |
| `seriousness.json` | ICH E2A criteria, 24 h site clock, 7/15-day sponsor clocks | ICH E2A; 21 CFR 312.32 |
| `medlist.json` | 300 lowercase brand/generic names (NOT RxNorm) | Generated by `scripts/fetch_public.py --build-medlist` from openFDA counts plus the hand-curated core entries in `data/public/medlist_build_config.json` |
| `conmed_matching.json` | Levenshtein ≤ 2, token length ≥ 4, confidence floor 0.7, top 3 candidates | CONTRACTS.md §1.7 (+ floor, see `rationale`) |
| `dedup.json` | 7-day inclusive window, 300 s clock-skew tolerance, same-session exclusion | CLAUDE.md §3.4(h) |
| `rules_catalog.json` | every rule id, category, description template | CONTRACTS.md §1.4, R2.4, R3.1 |
| `protocol_rules.json` | AESI criteria + 24 h, SAE 24 h, AE window 90 days, prohibited / discouraged / permitted con-meds with brand aliases and the protocol's own exception text, non-systemic qualifiers, CM required fields | EMPOWER-Lung 1 protocol R2810-ONC-1624 Amd 9, §7.7–7.7.2 p. 68–69, §9.4.1–9.4.3 p. 91–92; every quote verbatim from `data/public/empower_lung1_protocol_excerpt.json` |
| `irae_mapping.json` | per item: `potentially_immune_related`, `irae_category`, rationale | Protocol p. 91–92 ("eg, rash, colitis, elevated transaminases, or endocrine") + CLAUDE.md §00.1 |

The condition language used by `red_flags.json` and `vitals_corroboration.json` is documented in
`conditions.py`: `item_attribute`, `item_composite`, `any_severe_item`, `gate_bool`,
`gate_text_nonempty`, `vital`, combined with `{"all": [...]}`.

## How to add a rule

1. **Write it as data.** Add an entry to `red_flags.json` (fields `id`, `description`, `condition`,
   `tier_floor`, `seriousness`, `effect`) or `vitals_corroboration.json` (`id`, `description`,
   `condition`, `reason`, `tier_bump`). Give the table's `source`/`rationale` a sentence about it.
   If you need a comparison the condition language cannot express, add a `kind` to `conditions.py`
   (one small `_eval_*` function) rather than special-casing it in a rule module.
2. **Register the id** in `rules_catalog.json` with its category and a `description_template`.
   The property tests fail if an emitted rule id is missing from the catalog.
3. **Add a table-driven test** (`tests/test_red_flags.py` or `tests/test_vitals_corroboration.py`)
   with a case that fires and a case that does not, and check the invariants still hold
   (`tests/test_properties.py`: tier ≤ 3, at most one corroboration step, vitals never change a grade).
4. **Document the threshold** in `docs/WHAT_IT_GETS_WRONG.md` if it is a heuristic.

Adding an *item* means a row in `proctcae_items.json` (with a supported attribute set:
`presence`, any single attribute, `frequency+severity`, `severity+interference`,
`frequency+interference`, or all three), a row in `ctcae_terms.json`, and two catalog entries
(`score.composite.<id>`, `grade.provisional.<id>`).

## Using it from the API

```python
from interim_rules import INTERIM_VERSION, evaluate_checkin
from interim_rules.serialize import build_input, result_to_dict

inp = build_input(
    session_id=session.id, studyid=study.study_id, usubjid=session.usubjid,
    completed_at=session.completed_at, nct_id=study.nct_id,
    responses=[...ProResponse or dicts...], gates={...} or GateAnswers,
    vitals=[...VitalsSampleIn or snake/camelCase dicts...],
    open_aes=[...OpenAE...], settings={"simulated_as_measured": settings.simulated_as_measured},
    next_aeseq=next_seq,
)
result = evaluate_checkin(inp)
payload = result_to_dict(result)   # JSON-safe; store it, audit each rule in result.rules_fired
```

Evidence ids the engine did not receive (e.g. gate answer ids) are synthesized as
`<session_id>:gate_hospitalization`, `<session_id>:gate_conmed`, `<session_id>:gate_other`,
`<session_id>:gate_temp_c`; pass the real `Answer.id`s to get exact pointers.

Things the API must know:

* **Errors.** `input_from_dict` / `build_input` raise `ValueError` for a malformed payload
  (unknown attribute, non-finite number, bad timestamp); `evaluate_checkin` raises `ValueError`
  naming the field for a bad `completed_at`, response `ts`, vitals `ts_utc`, open-AE timestamp,
  empty id or `next_aeseq < 1`. Map these to a 400/422, never a 500.
* **Open AEs.** Load the participant's open AEs *before* persisting this session's drafts. The
  engine also skips any open AE whose `last_session_id` is the session being evaluated, so a
  re-evaluation (edit / recompute, eval re-run) can never link an AE to itself.
* **Vitals samples.** Pass `window_s` through from the bridge's `windowS` (the window of the
  longest-window metric present: 12 / 30 / 60 s). A sample with `window_s` below a metric's
  minimum is ignored for that metric with a logged reason; a sample without a window is
  treated as 0 s. A `source` of `mock` is simulated whatever `is_measured` says.
* **Con-med.** `conmed_changed = true` always yields a `ConMedMatch` and a CM draft, even when
  `conmed_text` is empty (`CMTRT = ""`, `conmed.unmatched`, "coordinator to ask"). The kiosk
  should require a name when the answer is yes; the engine never drops the reported change.
* **Result size.** Session-level rules and VS label fields cite the first and last sample of
  their span plus a count; only `VSORRES` (a median) points at every reading. A 3-minute 1 Hz
  capture serializes to well under 100 KB (`tests/test_vitals_corroboration.py`).
* **JSON.** `result_to_dict` output always passes `json.dumps(..., allow_nan=False)`.

## Development

```bash
# from packages/rules (Windows venv shown; use ../../.venv/bin/python elsewhere)
../../.venv/Scripts/python.exe -m pytest -q --cov=interim_rules
../../.venv/Scripts/python.exe -m ruff check .
../../.venv/Scripts/python.exe -m ruff format --check .
../../.venv/Scripts/python.exe -m mypy --strict interim_rules tests
```

Install: `uv pip install -e "packages/rules[dev]"` (no runtime dependencies; dev extras are pytest,
pytest-cov, hypothesis, ruff, mypy). The tables stay at `packages/rules/data/`; `pyproject.toml`
maps that directory into the distribution as `interim_rules.data`, so a wheel or a non-editable
install (`pip install ./packages/rules`, a Docker multi-stage image) ships them and
`tables.data_dir()` finds them under `<site-packages>/interim_rules/data`
(`tests/test_packaging.py` builds such an install with `uv` and imports from it).

## Known limitations (see `docs/WHAT_IT_GETS_WRONG.md`)

* The composite → CTCAE grade crosswalk is a 1:1 convention, not a validated mapping.
* Yes/no items (rash, fever/chills) are not composite-graded by the published algorithm; Interim's
  "present → grade 1" is its own convention.
* Corroboration thresholds are fixed population values, not personalized baselines.
* The con-med matcher misses misspellings beyond edit distance 2, compound names and doses. The
  0.7 confidence floor stops `from -> iron` (0.5) but not a one-letter slip on a four-letter
  name (`icon -> iron`, 0.75); the proposal is always shown with its confidence for the
  coordinator to reject.
* The averaging-window gate trusts the bridge's `windowS`; the engine cannot tell a genuine
  30 s window from a mislabeled one.
* The 7-day dedup window and the 300 s clock-skew tolerance are heuristics.
* Protocol rules (see the section below): "potentially immune-related" is a fixed per-item
  table, not a judgement; the kiosk cannot see infusion or allergic-reaction AESIs; rash is
  asked yes/no so a kiosk rash is never grade 3; protocol drug names match whole words only
  (a misspelled `bevacizumib` is missed); the topical-qualifier list can hide a systemic
  steroid typed as "prednisone spray"; the investigational-agent phrases catch only a few
  explicit wordings. The AE reporting window needs a last dose date, and the new anti-cancer
  therapy date only when the API knows it. One AESI clock per event relies on the API passing
  `OpenAE.aesi_clock_started`, and on the dedup window linking the follow-up.
* `validate_written` checks evidence ids, verbatim quotes (against the facts the sentence cites)
  and decision words (grade, AESI, seriousness, causality). It cannot check an unquoted factual
  claim against its evidence, so an LLM writer's text is still a draft for a person to confirm.
* The medlist lacks a few protocol drugs (prednisolone, bevacizumab, denosumab, pemetrexed ...).
  The protocol table's names and brands cover them for flags and `CMDECOD`, but a misspelling of
  one is not matched until `data/public/medlist_build_config.json` gains them and the medlist is
  rebuilt.
* Time saved is an estimate: only the VS rate is sourced; the other minutes are assumptions.

## Chart-note scanning (`chartscan.py`, Regeneron "Better" tier)

Ported from `backend/app/services/extract.py` of `omer-khawar/ae-checkin-agent` (Omer Khawar,
MIT), 2026-10-10 (CONTRACTS.md R2.4, decision D-014). A deterministic regex + NegEx-style
scanner for clinician chart notes and participant utterances: no LLM, no network, no clock.
Every finding keeps the exact quote and character offsets (`text[span_start:span_end] == quote`)
so the dashboard can highlight it, plus a plain-English reason.

```python
from datetime import date
from interim_rules import chartscan

result = chartscan.scan_text(note.text, date.fromisoformat(note.note_date))
payload = chartscan.scan_result_to_dict(result)  # JSON-safe
rules = chartscan.rules_fired(result)  # chartscan.* firings, with quote + spans
why = [r["description"] for r in rules]
serious = chartscan.seriousness_suspected(result)  # hospitalization / ER mention
level = chartscan.escalation_level(result, "note")  # none | urgent (a note is never an emergency)
```

| Output | What it is |
|---|---|
| `symptoms[]` | `SymptomFinding`: CTCAE v5 `term`, exact `quote` + `span_start/span_end`, `reason`, `grade_hint` (heuristic, 1–3; an explicit "grade 4/5" in the text is capped at `composite_to_grade.json` `max_assignable_grade` and the clinician's number is kept in `grade_basis`) + `grade_basis`, `onset_days` / `onset_date` (from `ref_date`), `worsening`, `resolved` (the text says it resolved; it still counts, and the API may propose `AEENDTC` from it) |
| `excluded_symptoms[]` | the mentions that do not count, with `excluded_reason` (`negated`, `historical`, `hypothetical`) and `grade_hint = None` |
| `meds[]` | `MedFinding`: lowercase generic `drug` (not RxNorm), `change` (`started` / `stopped` / `changed` / `taking`), quote, spans, `reason` (the verb used; the indication when written) |
| `excluded_meds[]` | allergy listings and declined prescriptions (`allergy`, `negated`) |
| `red_flags[]` | `RedFlag`: `level` (`emergency` / `urgent`), `category`, quote, spans, `reason` |
| `human_requested` | only with `detect_human_request=True` (participant utterances, never clinician notes) |

How it decides, per mention, in order: (0) map typographic punctuation to ASCII (U+2019 ->
`'`, en dash -> `-`, non-breaking space -> space; `text_normalization` in the lexicon, one code
point each, so every offset still indexes the caller's text and quotes are sliced from it);
(1) find the term or drug with a lexicon regex; (2) NegEx-style exclusion: a negation cue in the
clause before the term (cut at a terminator such as "but" or a comma followed by a severity /
quantity word, at most `scope.negation_max_words` = 8 words, pseudo-negations like "can't stop"
blanked first), a post-term "ruled out" / "Fever: no", a history cue ("hx of"), or an instruction /
hypothetical cue starting earlier in the sentence ("call if", "monitor for", "PRN for", "go to the
ER if"); (3) grade hint: an explicit "grade N" (capped at 3) > stools/day (diarrhea) or % BSA
(rash) > the nearest severity word > default 1, and a hospital/ER word in the same sentence that
passes the same exclusion check raises the hint to 3; (4) onset from "x5 days", "3 days of",
"since yesterday"; (5) one finding per term (highest grade wins; onset, cues and `worsening`
merge) and per drug (an action verb beats a bare mention; the first mention otherwise; "switched
from X to Y" is X stopped, Y started). Red flags: one per category, first match, with the same
exclusion check. Every regex, threshold, band, context window (`scope`) and reason text lives in
`data/chartscan_lexicon.json` and `data/chartscan_red_flags.json` with `source` / `rationale`;
the Python only validates, compiles (once per process) and applies them.

Rule ids (category `chartscan`, listed in `rules_catalog.json`): `chartscan.symptom`,
`chartscan.symptom_excluded`, `chartscan.med`, `chartscan.med_excluded`, `chartscan.red_flag`,
`chartscan.hospitalization` (seriousness suspected; the API starts the SAE clock at ingestion).

**Answer key.** `data/chartscan_answer_key.json` carries 39 synthetic cases: the 25 from the
source repository (8 chart notes, 17 utterances; subject ids remapped to `P-001` … `P-006`) plus
14 utterances (`T18`–`T31`, each with a `review_fix` note) added after the 2026-10-10 review, one
per fix below. `chartscan.evaluate_answer_key()` reproduces the source repository's
`scripts/evaluate.py` scoring (micro precision / recall for AE terms and con-med drugs, change
accuracy, escalation recall, over-escalations, possible-SAE recall) and `tests/test_chartscan.py`
pins the result: **AE terms P = R = 1.00 (38/38), con-meds P = R = 1.00 (17/17), 14/14
urgent-or-emergency cases escalated, 3/3 emergencies, 3/3 possible-SAE cues, 0 over-escalations**;
scored alone, the 25 original cases still give the source repository's exact numbers (31 terms,
13 drugs, 11/11, 2/2). `evaluation_to_dict()` is the payload for `docs/eval/results.md` and
`POST /eval/run`.

Things the API must know:

* Pass the note date as `ref_date`; the package never reads the clock. `AESTDTC` = `onset_date`
  when present, else the note date.
* A note escalates to Tier 2 at most (`escalation_level` returns `urgent`, never `emergency`);
  notes never page or stop a kiosk (D-017). `human_requested` is for participant utterances.
* `RuleFired.category` in `models.py` does not include `chartscan`; `rules_fired()` returns
  plain dicts in the same shape (`rule_id, category, description, inputs, effect` plus
  `quote, span_start, span_end`) for the API to wrap with `chart_note` evidence.
* `TableError` (a `ValueError`) is raised on first use if a chartscan table is malformed.

**Fixed after the 2026-10-10 review** (each with a table row, an answer-key case and a unit
test; decisions to log in `docs/DECISIONS.md`):

* Typographic apostrophes/quotes/dashes (U+2019 and friends, the default on Word, Outlook and
  iOS) defeated every contraction-based cue; `text_normalization` maps them 1:1 before matching.
* "No fever, mild diarrhea" lost the diarrhea: a comma followed by a severity / quantity /
  positivity word now ends the negation scope; a bare comma still continues a negated list.
* Review-of-systems negatives ("Nausea: no", "Fever - none") counted as findings and fired the
  fever flag; they are post-term negations now (short cues only when they end the clause).
* A negated hospital word ("Not admitted; has diarrhea") raised the grade hint to 3; the hospital
  cue now passes the same context check as the red flag.
* "grade 4" / "grade 5" in a note became `AETOXGR` 4/5; the hint is capped at
  `composite_to_grade.json` `max_assignable_grade` (3) with the clinician's number in
  `grade_basis` (**decision:** cap in the rules package rather than null in the API, so every
  consumer sees the same hint and its basis).
* "admitted to having", "the sob story about ED" started an SAE clock; `admitted` needs a
  hospital sense and bare `ED`/`ER` need hospital context ("in the ED", "ER visit", "ER course");
  "go to the ER if …" is an instruction (hypothetical cues may now run into the term).
* "was not started on X" / "not on X" exclude the drug; "switched from X to Y" is X stopped and
  Y started (a switch written with doses stays `changed`); "Tmax 101.3" is a fever; "Tylenol PRN
  for fever" does not report a fever (an affirmative mention elsewhere still counts).
* The NegEx scope (8 words) and the character windows live in the lexicon's `scope` section.
* `SymptomFinding.resolved` is a machine-readable flag (**decision:** `ExcludedReason` keeps the
  contract's `resolved` / `indication` values but the scanner never emits them; a resolved
  symptom is a kept finding with `resolved = True`, so the API can propose `AEENDTC` without
  parsing prose).

What it still gets wrong (to be added to `docs/WHAT_IT_GETS_WRONG.md`, with `docs/NOT_BUILT.md`
§1 and the PRD Good/Better/Best table, by the docs owner: `docs/ISSUES.md` #13): a hand-built
lexicon (29 terms, 43 drugs) misses phrasings and misspellings outside its patterns; the grade
hint is a heuristic for the investigator, not a validated grade; "No rash, itching on the legs"
(a comma followed by a bare symptom) is read as a negated list; "admission" in any sense
("Admission note: mild cough") is still a hospital cue; "Advised to go to the ER." without an
"if" counts as a visit; a switch written with doses ("switched from Zofran 4 mg to Compazine")
is a dose change for both drugs; the clause scope is 8 words, so a negation further back is
missed; abbreviations are case-sensitive (`SOB`, `ER`), so a lower-case `er` on its own is not a
hospital cue.

## Protocol-aware rules (`protocol.py`, EMPOWER-Lung 1)

CONTRACTS.md R3.1, CLAUDE.md §00.1, decision D-025. The rules come from the real protocol of the
demo study: EMPOWER-Lung 1, R2810-ONC-1624 Amendment 9 (NCT03088540), public on
ClinicalTrials.gov and cached as a verbatim excerpt with page numbers and the PDF's sha256 in
`data/public/empower_lung1_protocol_excerpt.json`. Every number, list and quoted sentence is in
`data/protocol_rules.json` / `data/irae_mapping.json` with a `protocol_ref` `{section,
printed_page}`; `tests/test_protocol_tables.py` checks every quote against the cited page.

```python
from interim_rules.protocol import ProtocolContext, assess_protocol

assessment = assess_protocol(
    items_or_result,
    conmed_match,
    gates,
    ProtocolContext(prior_pi3k_inhibitor=False, last_dose_date="2026-10-01"),
    completed_at=completed_at,
)
```

`evaluate_checkin` calls it for you (after con-med matching, before the ladder) with
`CheckInInput.protocol_context` (default: no PI3K history, last dose unknown, no new
anti-cancer therapy). `assess_protocol`
also accepts a finished `CheckInResult` instead of the item list.

**Contract deviation (documented):** R3.1 writes the first argument as `result: CheckInResult`;
the engine needs the protocol floor *before* the ladder runs, so the first argument is the graded
items (`Sequence[ItemResult]`) or a `CheckInResult`; `completed_at` (for the informational AE
window) and `gate_ids` (evidence ids) are keyword-only.

| Question | Protocol | What Interim does |
|---|---|---|
| Possible AESI? | §9.4.3, p. 92: "Grade 3 or greater irAEs"; "An irAE of any grade in a patient previously treated with a PI 3-K inhibitor" | Provisional grade ≥ 3 on an item `irae_mapping.json` marks potentially immune-related (shortness of breath → pneumonitis, fatigue → endocrine, diarrhea → colitis, rash / itching → dermatologic, joint pain → musculoskeletal), or grade ≥ 1 on one when `prior_pi3k_inhibitor`. Labeled "possible AESI, investigator to confirm"; `aesi_clock` (`kind: "aesi"`) starts at `completed_at`, due + `aesi.reporting_hours` (24). AE drafts of those items carry `INTERIM_AESI_SUSPECTED = true`. Grade and tier unchanged. The grade ≥ 2 infusion and allergic-reaction AESIs are listed but marked `detectable_from_kiosk: false`. |
| Prohibited con-med? | §7.7.1, p. 69: bevacizumab, necitumumab, other investigational anti-tumor agents | Tier floor `conmeds.prohibited_tier_floor` (2), joined with the red-flag floor before the vitals bump; "possible protocol deviation, coordinator to confirm"; applies whether the drug was started or stopped (it was taken during the study). |
| Discouraged con-med? | §7.7.2, p. 69: systemic corticosteroids "except in the case of a life-threatening emergency and/or to treat an irAE." | Coordinator flag quoting that exception text verbatim; tier unchanged. Not raised when the text carries a non-systemic word (`cream`, `drops`, `inhaler`, ...), with a `conmed_notes` line saying so. |
| Permitted con-med? | §7.7.2, p. 69: bisphosphonates, denosumab, pemetrexed maintenance (non-squamous), palliative radiation | Informational note (with the protocol's condition where there is one). |
| CM complete? | §7.7, p. 69: "generic name, dose, dose unit, frequency, indication, and start/stop date, as appropriate" | `INTERIM_CM_MISSING_FIELDS` lists what the kiosk could not fill (dose, unit, frequency and indication always; start date for a stopped drug; both dates when the direction is unknown; the name when none was typed). |
| AE reporting window | §9.4.1, p. 91: "until 90 days after the last dose of study drug, or until the patient commences another anti-cancer systemic therapy, whichever is earlier" | `ae_reporting_window_end` / `within_ae_reporting_window` from `last_dose_date`, cut short by `new_anticancer_therapy_date` when that is earlier (no window without a last dose date); informational only, never suppresses a draft. |
| One clock per event | §9.4.3, p. 92 (AESI within 24 h) and §3.4(h) de-duplication | A suspected AESI item that is a dedup follow-up of an open AE with `aesi_clock_started: true` does not start a second clock; `aesi.clock_not_restarted` says so, and `aesi_clock` is null when every suspected item is covered. |

**Matching a medication to the protocol lists.** Whole words of the verbatim text are compared
with each protocol drug's generic name, the table's brand aliases (`Avastin`, `Portrazza`,
`Deltasone`, `Xgeva`, ...) and a few category phrases (`another trial`, `radiation`); the medlist
match (`ConMedMatch.matched_name`) is also accepted. A typed name wins over a fuzzy medlist
neighbour (`prednisolone` is not double-flagged as `prednisone`). When the medlist has no match,
or only an edit-distance neighbour of a different drug, but the participant named a protocol drug
or brand outright, `CMDECOD` takes the protocol table's generic name with that table as evidence
(`Avastin` → `bevacizumab`; `prednisolone` stays `prednisolone`, not the medlist's `prednisone`);
`INTERIM_MATCH_KIND` still shows the medlist result. A category entry (`is_category: true`) never
fills `CMDECOD`.

**Outputs.** `ProtocolAssessment {protocol_id, context, aesi_suspected, aesi_items, aesi_reasons,
conmed_flags[{level, drug, matched_text, matched_by, protocol_ref, quote, exception_text,
condition, is_category}], conmed_flag, conmed_notes, cm_missing_fields, tier_floor,
ae_reporting_window_end, within_ae_reporting_window, rules_fired}`. `CheckInResult` gains
`protocol`, `aesi_clock` (an `SAEClock` with `kind: "aesi"`) and `protocol_tier_floor`;
`sae_clock` gains `kind: "sae"`. `serialize.input_from_dict` reads `protocol_context` /
`protocolContext` (`{prior_pi3k_inhibitor, last_dose_date, new_anticancer_therapy_date}`) and
an optional `aesi_clock_started` on each open AE; every pre-existing key of the input and the
result is unchanged. The API sets `OpenAE.aesi_clock_started` when an `aesi` clock row already
exists for that AE. `seriousness.build_clock(at)` keeps its signature and gains
keyword-only `kind`, `hours`, `informational`.

**Personas.** Seven `P3-` personas (category `protocol`) in `personas.json` cover a grade 3 skin
AE (itching: the kiosk cannot grade a rash above 1) → AESI clock; grade 3 diarrhea without PI3K
history → AESI; grade 1–2 skin AEs with PI3K history → AESI at tier 1; `bevacizumab` and the
brand `Avastin` → prohibited, tier floor 2 on an otherwise grade 1 check-in; `prednisone` →
discouraged flag, tier unchanged; `hydrocortisone cream` → no flag. They may carry
`protocol_context` and pin `protocol_tier_floor`, `aesi_suspected`, `aesi_clock_started`,
`aesi_items` and `cm[].protocol_flag` / `cm[].missing_fields`.

## Generated text and time-saved estimate

CONTRACTS.md R3.1, CLAUDE.md §00.2–§00.5. Three small modules turn the engine's facts into words
and minutes. All three are pure (no clock, no network, no LLM) and read only their own table.
Each one owns its table, which is why `tables.TABLE_NAMES` does not list them:

| Module | Table | Owner constant |
|---|---|---|
| `narrative.py` | `narrative_templates.json` | `NARRATIVE_TABLE_NAMES` |
| `time_saved.py` | `time_model.json` | `TIME_MODEL_TABLE_NAMES` |
| `plain_language.py` | `plain_language.json` | `PLAIN_LANGUAGE_TABLE_NAMES` |

`write`, `validate_written`, `WrittenText` and `estimate` are also exported from the package
root.

### Template writer: `narrative.py`

Rules decide, text tools write, people confirm. `write(kind, facts)` turns a structured fact
bundle into short, plain, past-tense sentences. Every sentence cites the evidence ids of the
facts it was built from. The same facts always give the same text.

```python
from interim_rules.narrative import validate_written, write

written = write("sae_narrative", facts)  # or "aesi_narrative" / "visit_brief"
written.to_dict()
# {"kind": "sae_narrative", "writer": "template",
#  "sentences": [{"text": ..., "evidence_ids": [...], "section": "event",
#                 "template_id": "sae_narrative.grade"}, ...],
#  "text": "<sentences joined>"}
assert validate_written(written, facts) == []
```

**Facts.** Facts are plain dicts that the API builds from database rows; their TypedDict schemas
are in `narrative.py`. Every fact carries `evidence_ids`. A fact with no evidence id, or with an
empty value, counts as absent, because a sentence may only say what it can cite. A date is either
`YYYY-MM-DD`, shown unchanged, or an ISO-8601 UTC timestamp, shown as `2026-10-10 06:15 UTC`.

| Schema | Fields (each object also has `evidence_ids: [str]`) |
|---|---|
| `TextFact` | `value` |
| `SaeFacts` | `kind` (`sae` or `aesi`; must match the narrative kind), `participant`, `study_id`, `study_drug`, `last_dose`, `onset`, `site_awareness_at`, `awareness_source`, `action_taken`, `outcome`, `causality`, `reporter_role` (all `TextFact`); `event {term, plain_label}`; `provisional_grade {grade 0-5}`; `quotes [{text, source_label?}]`; `seriousness_criteria [TextFact]`; `aesi_reasons [TextFact]`; `deadline {due_at, hours, protocol_section?, printed_page?}`; `conmeds [ConMedFact]`; `escalation {tier, tier_name, date?, reason?, acknowledged?, acknowledged_at?}`; `missing_information [TextFact]` |
| `ConMedFact` | `name` (verbatim), `direction` (`started` / `stopped` / `taking` / `changed`), `date?`, `protocol_flag?` (`prohibited` / `discouraged` / `permitted`), `protocol_section?`, `printed_page?`, `exception_text?` (verbatim protocol text), `missing_fields?` (SDTM names such as `CMDOSE` are shown in plain words) |
| `BriefFacts` | `participant`, `since`, `next_visit` (`TextFact`); `new_side_effects [{term, plain_label, grades: [{grade, date?}]}]`; `open_aes [{term, plain_label, onset?, last_reported?, ongoing?}]`; `med_changes [ConMedFact]`; `escalations [EscalationFact]`; `clocks [{kind sae/aesi, event_label, due_at, hours?, status? running / "reported (mock)" / stopped}]`; `notes [{note_type, note_date?, author?, n_symptoms?, n_meds?}]`; `vitals {is_measured, source, pulse_median?, breathing_median?, date?}`; `questions?`; `missing_information` |

**Wording is data.** Every sentence, label, joiner and date format is in
`data/narrative_templates.json`. Each sentence lists its variants in priority order. The writer
uses the first variant whose `when` conditions hold and whose slots (its placeholders plus any
`cite` names) are all present. If no variant fits, the sentence is left out; nothing is filled
with "unknown". The only sentence about absent data is "Information still needed: ...", which is
built from `missing_information`. When a verbatim quote already ends in a full stop
(`"... to treat an irAE."`), the template's own closing full stop is dropped, so a sentence never
ends in `.".`; the quoted text itself is never changed.

**Narrative order.**

* SAE and AESI narratives follow the ICH E2A order: who; what and when; seriousness and the
  protocol reporting deadline; medications; actions; outcome; causality; reporter; information
  still needed. Until a causality fact exists, causality reads "not yet assessed by the
  investigator".
* Every grade is followed by "(provisional, investigator to confirm)".
* Every AESI mention carries "possible AESI, investigator to confirm".
* Simulated vitals always say "simulated".

**Brief rules.**

* In a visit brief, an empty list (`[]`) for `new_side_effects` or `med_changes` produces "No ...
  were recorded since <date>". An absent list produces nothing.
* `questions` defaults to `derive_questions(facts)`, which asks about three things: CM fields the
  protocol requires that are still missing (§7.7, p. 69), open AEs not yet resolved, and running
  clocks whose report is not yet signed.

**`validate_written(written, facts) -> list[str]`** is the acceptance gate for any writer,
including the API's optional Claude adapter. An empty list means the text is acceptable. It
reports:

* an unknown kind or writer, no sentences, or an empty sentence;
* a sentence that cites no evidence id, or cites an id that is not in the facts;
* a quoted passage that is not verbatim in a fact **that the same sentence cites**. Straight and
  curly, double and single quotes are all checked; an apostrophe as in "participant's" is not a
  quote. `strings_by_evidence_id(facts)` gives the strings each id may quote, so a quote from the
  ER note cannot be attributed to the kiosk answer;
* filler or advice wording (`validation.forbidden_patterns`), checked outside quotes;
* a missing qualifier (`validation.qualifiers`):
  * a grade without "investigator to confirm", including when it is written as `grade 3`, `G3`
    or `CTCAE 3`;
  * an AESI mention without "possible AESI, investigator to confirm";
  * seriousness or causality wording (`related to`, `caused by`, `is serious`,
    `life-threatening`) without "investigator", because those are the investigator's decisions
    (§9.3.2, p. 90; §9.3.4, pp. 90–91);
* a `text` value that is not the sentences joined in order.

Unquoted factual claims are only checked through their evidence ids. A writer that states a fact
the cited evidence does not contain ("the participant died") is not caught, which is why the
template writer is the default (see Known limitations).

**Errors.** Malformed facts raise `ValueError` naming the field: a wrong type, an unrecognized
coded value, a bad date, or a grade outside 0–5.

### Time saved: `time_saved.py`

`estimate(prefilled_fields, edited_fields)` turns counts of work Interim pre-filled from evidence
into an **estimate** of coordinator minutes saved. It is pure arithmetic: no clock, no database.

```python
from interim_rules.time_saved import edited_count, estimate, prefilled_count, weekly_context

out = estimate({"AE": 6, "CM": 7, "VS": 8}, {"AE": 1, "VS": 2})
out["minutes_saved"]  # 10.85 = 5 x 1.0 + 7 x 0.75 + 6 x 0.1
out["minutes_manual_baseline"]  # 12.05 = 6 x 1.0 + 7 x 0.75 + 8 x 0.1
out["is_estimate"], out["disclaimer"]  # True, "estimate"
```

* **Categories and minutes per unit** (`time_model.json`):

  | Category | Minutes | Basis |
  |---|---|---|
  | `AE` | 1.0 | assumption |
  | `CM` | 0.75 | assumption |
  | `VS` | 0.1 | source |
  | `SAE_FORM` | 1.5 | assumption |
  | `NARRATIVE_PARAGRAPH` | 10 | assumption |
  | `BRIEF_SECTION` | 5 | assumption |

  The one sourced number is the VS rate: MSK + IgniteData measured 3023 lab and vital data points
  entered by hand in 5 data-manager hours, which is 0.099 min per field. The AE, CM and
  serious-report rates are stated multiples of that rate. The narrative and brief rates are plain
  assumptions. Each category's `derivation` says which.
* **Category names** are case-insensitive. The aliases `AESI`, `SAE`, `AESI_FORM`, `PACKET`,
  `NARRATIVE` and `BRIEF` are accepted.
* **The saving rule:**
  * A pre-filled unit that nobody edited saves its manual minutes.
  * An edited unit saves nothing.
  * The manual baseline is the time to type every pre-filled unit by hand.
  * If there are more edits than pre-filled units, the edits are capped, and the basis says so.
  * Unknown category names earn nothing and are listed in the basis.
  * A negative or non-whole count raises `ValueError`.
* **Result:** a plain JSON-safe dict with `minutes_saved`, `minutes_manual_baseline`, `basis[]`
  (the arithmetic in words), `breakdown[]` per category, `is_estimate` and `disclaimer`. It can go
  straight into `GET /metrics/time-saved`.
* **Counting helpers** make every caller count the same way:
  * `prefilled_count(domain, fields)` counts the fields a draft pre-filled.
  * `edited_count(domain, drafted, confirmed)` counts the pre-filled fields a person changed. A
    field the person filled in from empty is their own work and does not count.
  * Both look only at `countable_fields(domain)`: the AE, VS and CM variables a coordinator would
    type into the EDC. Ids the EDC fills itself, `--SEQ`, `INTERIM_*` fields and the
    investigator-only `AESER` and `AEREL` are excluded. The CM list follows protocol §7.7, p. 69.
* **Weekly context:** `weekly_baseline_minutes()` returns `(720, 900)`, the published 12–15 hours
  per study per week that coordinators spend copying EHR data into the EDC.
  `weekly_context(minutes)` returns one plain sentence comparing a saving with the lower figure,
  for example "About 10.85 min saved (estimate); ... about 2% of the lower figure." The weekly
  figure is context only and is never multiplied into the estimate.

### Plain language: `plain_language.py`

The dashboard shows plain words first and keeps SDTM names and rule ids one click deeper.
`plain_language.json` holds:

* `fields`: a plain label per SDTM or `INTERIM_*` variable, for example `INTERIM_PROTOCOL_FLAG`
  and `INTERIM_CM_MISSING_FIELDS`;
* `rules`: one short sentence template plus an input-free `fallback` for every rule id in
  `rules_catalog.json`, including the R3.1 `protocol.*` and `aesi.*` ids;
* `tiers`, `grades`, `clock_kinds` (`sae` / `aesi`, each with its protocol section and page),
  `evidence_kinds` and `domains`;
* `input_aliases` and `render_as`, which control how rule inputs fill a placeholder.

The functions are `label(field)`, `field_labels(fields)`, `has_label`, `rule_sentence(rule_id,
inputs)`, `tier_name`, `grade_label`, `clock_name`, `clock_kind`, `evidence_kind_name` and
`domain_name`. Filling a placeholder never uses `str.format`. A missing input selects the
fallback sentence, and an unknown rule id never raises. Tests check that every catalog id has a
sentence, that no sentence gives advice, and that every grade and AESI sentence carries its
qualifier.
