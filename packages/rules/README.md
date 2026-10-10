# `interim_rules` — the deterministic rules engine

The core of Interim. One pure function, `evaluate_checkin(CheckInInput) -> CheckInResult`,
turns a completed between-visit check-in into:

| Output | What it is |
|---|---|
| `items[]` | PRO-CTCAE composite (0–3) and **provisional** CTCAE grade (0–3) per symptom |
| `escalation_tier` | 0 Log · 1 Coordinator review · 2 Nurse call today · 3 Urgent (stop screen + page) |
| `seriousness_suspected`, `sae_clock` | ICH E2A hospitalization trigger; site 24 h clock + informational sponsor 7/15-day deadlines |
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
                                                  ├─▶ escalation ──▶ seriousness ──▶ con-med ──▶ dedup ──▶ drafting
vitals ─────▶ vitals quality ──▶ corroboration ───┘
```

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
| 9 Dedup | `dedup.py` | `dedup.json` | Same `AEDECOD` open within 7 days (inclusive) → follow-up, not a new AE; an open AE last reported by *this* session, or dated > 300 s in the future, is skipped with a logged reason |
| 10 Drafting | `drafting.py` | `ctcae_terms.json` | AE / VS / CM records with per-field evidence |

`tables.py` loads and validates every table once per process; `serialize.py` converts to/from JSON;
`engine.py` validates the input up front (`validate_input`: ISO timestamps on every field,
`next_aeseq ≥ 1`, non-empty ids; `ValueError` names the field) and wires the stages in the order
above (which is also the order of `rules_fired`).

### Tier algorithm (CONTRACTS.md §1.5)

```
max_grade = max(item.provisional_grade)
base      = {0:0, 1:0, 2:1, 3:2}[max_grade]
floor     = max(tier_floor of fired red flags, default 0)
bump      = 1 if any corroboration rule fired and vitals.status == "ok" else 0
tier      = min(3, max(base, floor) + bump)
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
| `tier.base` / `tier.redflag_floor` / `tier.corroboration_bump` / `tier.final` | escalation | always / floor > base / bump applied / always | the ladder, step by step |
| `sae.clock_started` | seriousness | hospitalization = yes | `site_awareness_at`, `due_at` (+24 h) |
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
| `rules_catalog.json` | every rule id, category, description template | CONTRACTS.md §1.4 |

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
