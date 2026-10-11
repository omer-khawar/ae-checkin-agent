# Synthetic data: participants, prior check-ins, and the persona answer key

> **No real people.** Every participant in Interim is synthetic. Names are `P-001` … `P-012`; there are no real names, dates of birth, addresses or identifiers anywhere in this repository or its runtime database. **All seeded and persona vitals are simulated.** A live session shows **MEASURED** only when the bridge runs the Presage camera source, which is implemented but has not yet been run against a live camera (`docs/VITALS_SOURCES.md` §5); the default and the Docker image run the mock. Every simulated value is labeled `simulated` in the UI (`SIMULATED` badge), in the rules (`is_measured = false`), and in exports (`VSMETHOD = "Simulated"`, `INTERIM_SOURCE = "mock"`, `INTERIM_IS_MEASURED = false`). The Synthea cohort in `synthea/` is labeled "Synthea synthetic EHR (simulated)" wherever it appears.

This directory is documentation. The generator is code:

| What | Source of truth | Regenerate with |
|---|---|---|
| The demo study (real public record) | `scripts/fetch_public.py` → `data/public/study.json` (committed cache; bundled fallback) | `make fetch-public` (`--offline` uses the cache) |
| 12 participants and their prior check-ins | `scripts/seed.py` (this README is its spec) | `make seed`, `make demo-reset`, `npm run seed`, `npm run demo-reset`, `python scripts/seed.py [--reset]`, Admin → "Reset demo data", or `POST /api/v1/admin/reset {"reseed": true}` |
| 8 synthetic chart notes (§4.6, lineage §9.1) | `data/synthetic/chart_notes.json` = `packages/rules/data/chartscan_answer_key.json` (notes), ingested by `scripts/seed.py` | same commands as the participants (the seed ingests them last) |
| Synthea NSCLC cohort: 12 participants, 72 notes, independent evaluation (§9.2) | `data/synthetic/synthea/` (see [`synthea/README.md`](synthea/README.md)), written by `scripts/synthea/import_synthea.py`; report `docs/eval/synthea_results.md` by `scripts/synthea/eval_synthea.py` | `scripts/synthea/run_synthea.py` (pinned jar, ~10–15 min); `import_synthea.py --check` / `eval_synthea.py --check` verify byte-identity. Not read by the seed yet (`docs/ISSUES.md` #23) |
| Persona answer key (eval) | `packages/rules/data/personas.json` | hand-edited; replayed by `scripts/run_eval.py` (`make eval`) and by the Eval page |
| Mock vitals scenarios (live kiosk) | `apps/vitals-bridge/src/sources/mock.ts` | n/a (deterministic per scenario) |

Nothing in `data/synthetic/` needs to be hand-edited (the `synthea/` files are generated; edit `scripts/synthea/` and the tables instead, and do not hand-edit the generated JSON). Seeded data lives only in the runtime database (`data/runtime/interim.db`, gitignored, or the Docker volume). If `scripts/seed.py` and this README disagree, the README is the spec and the discrepancy is a bug to log in `docs/ISSUES.md`; if a deliberate change is made, log it in `docs/DECISIONS.md` and update both.

---

## 1. Design goals

1. **Believable, documented, and labeled.** The judges' rubric asks for "simulated data that is believable and documented". Timelines should look lived-in (2–4 prior check-ins per participant over 60 days, mostly quiet, a few problems), with symptom patterns that fit a PD-1 inhibitor population (fatigue, rash, diarrhea, cough, joint pain, mouth sores; the LIBTAYO label's most common reactions are fatigue, musculoskeletal pain, rash, diarrhea and anemia).
2. **Deterministic.** `random.Random(20261010)` seeds everything. Two runs produce identical answers, vitals and tiers; only ULIDs and absolute timestamps differ (timestamps are anchored to "now" at seed time so the queue always shows the last 60 days).
3. **Seeded through the service layer, never by direct inserts.** Every prior check-in goes through the same code path as a live kiosk session (`POST /sessions` → answers → gates → vitals → `/complete`), so every seeded fact is audited, graded, drafted and escalated exactly as a live one would be (`docs/CONTRACTS.md` §5). The seed uses the admin-only backdating overrides (`started_at_override`, `completed_at_override`; `docs/DECISIONS.md` D-004), each of which is itself an audit event.
4. **Demo-ready.** `P-007` is the demo participant (`docs/DEMO.md`): it must have an **open Cough AE from 5 days ago** so the live check-in's cough report links as a follow-up.
5. **Grades come from the engine, not the seed.** The seed writes *answers* (attribute integers) and *vitals samples*. Grades, tiers, drafts and escalations are whatever `interim_rules` computes. The "intended tier" column below is the design intent; the engine is the arbiter.

## 2. The study

`STUDYID = R2810-ONC-1624` (Regeneron's own study id in the registry record), `INTERIM_NCT_ID = NCT03088540`: "A Global, Randomised, Phase 3, Open-label Study of REGN2810 (ANTI-PD 1 Antibody) Versus Platinum Based Chemotherapy in First Line Treatment of Patients With Advanced or Metastatic PD L1+ Non-small Cell Lung Cancer", sponsor Regeneron Pharmaceuticals, Phase 3, Completed ([clinicaltrials.gov/study/NCT03088540](https://clinicaltrials.gov/study/NCT03088540)). It is fetched by `scripts/fetch_public.py` via the ClinicalTrials.gov API v2 and cached in `data/public/study.json`; fallback `NCT02760498`; the dashboard labels it "Demo study (public registry record)". The study record is the only *real* thing in the demo data, and the participants are explicitly **not** from it.

## 3. Participants

| Field | Rule |
|---|---|
| `usubjid` | `"{study_id}-{label}"`, e.g. `R2810-ONC-1624-P-007` |
| `display_label` | `P-001` … `P-012` (what the kiosk asks for and what the dashboard shows) |
| `enrolled_at` | 75–120 days before seed time, drawn from the seeded RNG, always earlier than the participant's first check-in |
| `baseline_vitals_json` | `{ "pulse_bpm": b_p, "breathing_bpm": b_b, "source": "mock", "is_measured": false, "note": "simulated baseline" }` with `b_p` drawn uniformly from 58–84 and `b_b` from 12–17 per participant. Reserved for future baseline-personalized thresholds (`docs/NOT_BUILT.md` §10); unused by the rules today. The Synthea cohort (§9.2) has Synthea-derived (simulated) baselines per label; replacing these uniform draws with them is `docs/ISSUES.md` #23. |

No other demographic fields exist. There is no sex, age, race, site or address.

## 4. Prior check-ins (the "lived-in" timelines)

### 4.1 Contract constraints (`docs/CONTRACTS.md` §5)

- 12 participants; each has **2–4** prior check-ins; total 34 in the profile table below.
- Spread over the **last 60 days**; mostly Tier 0/1; **a couple of Tier 2**; **no Tier 3** in the seed (the first Tier 3 of the demo, if any, is created live or by the eval).
- One **open AE for P-007: Cough, G1, 5 days ago**, with its AE draft confirmed by the coordinator (so `AEOpen` exists regardless of whether a build opens AEs at draft or confirm time).
- Con-med changes on **4** participants.
- Deterministic: `random.Random(20261010)`.
- All seeded sessions carry `is_eval = false`; eval sessions carry `is_eval = true` and are hidden from the queue by default (`?include_eval=false`).

### 4.2 Timing rules

- `T0` = seed wall-clock time (UTC).
- `started_at = T0 − days_ago·24h`, snapped to a weekday-agnostic time of day drawn from 09:00–15:30 UTC plus a per-participant offset of 0–40 minutes from the RNG (so timestamps do not all share a minute).
- `completed_at = started_at + 4–7 minutes` (RNG).
- Answer `ts_client` values advance by 6–15 s per screen from `started_at`; `ts_server` is set by the API on receipt (the override only backdates `started_at`/`completed_at`; see D-004).

### 4.3 Profile table

Attribute values are the integers the kiosk would send (`frequency`/`severity`/`interference` 0–4, `presence` 0/1). Items not listed are 0 (None / Never / Not at all / No). Gates not listed are `hospitalization = false`, `conmed_changed = false`, `other_text = ""`.

| Participant | n | `days_ago` | Answers that are non-zero | Con-med gate | Camera consent | Intended tier(s) | Why this profile |
|---|---|---|---|---|---|---|---|
| **P-001** | 3 | 55, 34, 13 | `fatigue` severity 1, interference 0 on all three | — | Yes | 0, 0, 0 | A quiet, persistent G1 fatigue: the most common thing on a PD-1 inhibitor. Sparkline shows a flat line. |
| **P-002** | 2 | 40, **6** | d40: `rash` presence 1. d6: `rash` presence 1, `itching` severity 2 | — | Yes | 0, 1 | Presence-only rash is always G1 (a documented limitation, `docs/WHAT_IT_GETS_WRONG.md` §1); itching Moderate makes the second check-in Tier 1. The second check-in sits 6 days back (it was 12) so that chart note **N2** (2 days back, §4.6) finds Rash maculo-papular and Pruritus still open within the 7-day window and links as a **cross-source follow-up**. |
| **P-003** | 4 | 52, 38, 24, 10 | `diarrhea` frequency 2 → 3 → 4 → 3 (Occasionally → Frequently → Almost constantly → Frequently) | d24: `conmed_changed = true`, `conmed_text = "loperamide"`, `conmed_direction = "started"` | Yes | 0, 1, **2**, 1 | A colitis-like trajectory: composites 1, 2, 3, 2 → G1 → G2 → G3 (Tier 2, nurse call, escalation acknowledged in the seed) → improving after loperamide (exact con-med match, 1.0). The frequency-only map is 0,1,1,2,3 (`composite_scoring.json` `single_attribute_by_attribute.frequency`), so "Rarely" and "Occasionally" are both G1 and only "Almost constantly" reaches G3. |
| **P-004** | 2 | 45, 20 | none | — | Yes | 0, 0 | Entirely quiet. Shows the queue is not all alarms. |
| **P-005** | 3 | 50, 29, 8 | d50: `nausea` frequency 1, severity 1. d29: `nausea` frequency 2, severity 2. d8: `nausea` frequency 1, severity 1 | d29: `conmed_changed = true`, `conmed_text = "Zofran"`, `conmed_direction = "started"` | Yes | 0, 1, 0 | Brand → generic normalization: `CMTRT = "Zofran"`, `CMDECOD = "ondansetron"`, match kind `case_insensitive`, confidence 1.0. |
| **P-006** | 3 | 48, 27, 6 | `joint_pain` severity 2, interference 2 on all three | d48: `conmed_changed = true`, `conmed_text = "ibuprofen"`, `conmed_direction = "started"` | Yes | 1, 1, 1 | Persistent G2 arthralgia with an OTC analgesic; three Tier 1 rows. The check-ins are 21 days apart, beyond the 7-day dedup window, so the engine drafts **three separate Arthralgia AEs** rather than one with follow-ups: the seed deliberately shows the false-split limitation (`docs/WHAT_IT_GETS_WRONG.md` §6). |
| **P-007** | 3 | 47, 26, **5** | d47: `fatigue` severity 1, interference 0. d26: none. **d5: `cough` severity 1, interference 0** | — | Yes | 0, 0, 0 | **The demo participant.** The d5 Cough G1 AE draft is confirmed by the seed acting as `coordinator`, leaving an open Cough AE. The live demo's cough report (severity Mild) links to it as a follow-up; the live dyspnea report is a new AE. |
| **P-008** | 2 | 33, 9 | none | d33: `conmed_changed = true`, `conmed_text = "vitamin d"`, `conmed_direction = "started"` | Yes | 0, 0 | A con-med change with no symptoms; `vitamin d` is an exact match. |
| **P-009** | 4 | 58, 41, 30, 15 | `fatigue` severity 1/interference 0 → 2/2 → **3/3** → 2/2 | — | Yes | 0, 1, **2**, 1 | Severe fatigue episode (composites 1, 2, 3, 2 → G1, G2, G3, G2; Tier 2 acknowledged in the seed) that improves but is still under review. The timeline sparkline rises and falls. (Severity 2 with interference 1 would be composite 1 → G1 → Tier 0 in the `two_attribute_sev_int` table, so the last check-in keeps interference at 2.) |
| **P-010** | 3 | 44, 23, 7 | d44: none. d23: `mouth_sores` severity 2, interference 2. d7: `mouth_sores` severity 1, interference 1 | — | Yes | 0, 1, 0 | Stomatitis that resolves; the d7 report is 16 days after d23, so it is a new AE, not a follow-up. |
| **P-011** | 2 | 36, 11 | d36: `itching` severity 1. d11: `cough` severity 1, interference 0 | — | Yes | 0, 0 | Two different G1 symptoms; nothing escalates. |
| **P-012** | 3 | 49, **28**, 4 | none | — | Yes, **No on d28**, Yes | 0, 0, 0 | The d28 session declines the camera: `consent_camera = false`, no vitals samples, `vitals_status = "declined"` on the session, `vitals.unavailable` in the Why panel ("no samples were captured for this session"), and **no VS rows at all** (`build_vs_drafts` returns nothing for a session with zero samples; `VSSTAT = "NOT DONE"` rows appear only when samples exist but a metric has no usable reading, e.g. the low-quality persona). Proves the product is fully functional with vitals off. |

Totals: 34 check-ins; Tier 2 on exactly two of them (P-003 d24, P-009 d30); con-med changes on four participants (P-003, P-005, P-006, P-008); one open AE prepared for the demo (P-007 Cough); plus the eight chart notes of §4.6 (42 queue rows in all). Every "intended tier" in the table was replayed through `interim_rules.engine.evaluate_checkin` on 2026-10-10 and matched; if a table under `packages/rules/data/` changes, replay again before trusting this column.

### 4.4 What the seed does after each prior check-in

- Confirms every AE draft it created, acting as `coordinator` (audit `draft.confirmed`), so `AEOpen` rows exist and timelines show "open AEs". VS and CM drafts are left as `draft` so the queue still has work in it.
- Acknowledges the two Tier 2 escalations as `coordinator` 20–50 minutes after `completed_at` (RNG), so the Escalations page shows realistic `seconds_to_ack` values.
- Never sets `AEREL`/`AESER` (those are live investigator actions in the demo).

### 4.5 Seeded vitals (simulated)

For every seeded session with `consent_camera = true`, the seed posts a deterministic replay of the bridge's **`resting`** scenario through `POST /sessions/{id}/vitals` (as actor `vitals-bridge`, role `system`), so the audit trail and the `VitalsSample` table look exactly like a live session:

- One sample per second for the session's duration (`completed_at − started_at`, 240–420 samples), `source = "mock"`, `is_measured = false`. **`window_s` follows the metrics a sample carries**, as the bridge contract does (`docs/DECISIONS.md` D-003; Presage windows): `0` for the first 12 s (no metric published yet), then `12` while only pulse is published, `30` once breathing is (from 30 s), `60` once HRV is (from 60 s); a sample carries the largest window among its metrics (`resting_samples` in `apps/api/interim_api/seed.py`). An earlier version of this README said a flat `window_s = 30`; that was wrong: with `min_window_s.hrv = 60` in `vitals_corroboration.json`, a flat 30 would mark every HRV reading "window too short" and draft `HRV_RMSSD` as NOT DONE (`apps/api/tests/test_admin_seed.py` asserts it is not).
- Pulse: participant baseline `b_p` plus AR(1) noise (`x_t = 0.8·x_{t−1} + ε`, `ε ~ N(0, 1.2)`), rounded to one decimal; `pulse_conf` ramps 0.3 → 0.95 over the first 15 s then holds with ±0.03 jitter.
- Breathing: baseline `b_b` plus AR(1) noise (`0.85·x_{t−1} + ε`, `ε ~ N(0, 0.5)`); `breathing_conf` ramps the same way.
- HRV (`hrv_rmssd_ms`): 25–55 ms with AR(1) noise, `hrv_conf` 0.7–0.9.
- Timing gates mirrored from `apps/vitals-bridge/src/gate.ts`: pulse is `null` with flag `gate_pending_pulse` for the first 12 s, breathing for 30 s, HRV for 60 s. Nothing is below `min_confidence` after the ramp, so every seeded session gets `vitals_status = "simulated_ignored"` (simulated samples, toggle OFF): the summary exists and the VS rows say Simulated, but corroboration is not eligible.
- The seed contains its own small pure-Python generator for this; it does not depend on the Node bridge (`docs/DECISIONS.md` D-005: the bridge's mock and the seed/persona samples describe the same physiology but are separate code).

Nothing in the seed ever produces a vitals value outside the plausibility bounds (pulse 35–180, breathing 5–45); implausible and low-quality vitals are exercised by the personas (§5), not the seed.

### 4.6 Chart notes (`chart_notes.json`; CONTRACTS.md R2.4)

The eight synthetic clinician notes in `data/synthetic/chart_notes.json` (lineage and traps in that file's `_about`; the same eight cases live, text included, in `packages/rules/data/chartscan_answer_key.json`, kept identical by `packages/rules/tests/test_chartscan.py`) are ingested by the seed **after** the 34 check-ins, through the `/notes` service (`apps/api/interim_api/services/notes.py`) as actor `coordinator` with the admin-only `ingested_at_override`, so every note is audited (`note.ingested`, `note.scanned`, one `rule.fired` per rule, `draft.created`, …) exactly as a live ingestion. The seed reads the notes from the rules package's copy (`interim_rules.chartscan.answer_key()`), so a Docker image needs nothing from this directory.

**Dates are re-anchored to the seed clock.** Each note keeps its distance from the answer key's reference date (`utterance_ref_date` = 2026-10-10): `days_ago = 2026-10-10 − note_date`, the stored `note_date` becomes `T0 − days_ago` (date), and `ingested_at` is that day at 09:00–17:00 UTC from the seeded RNG. N1 is therefore always 5 days back and N3/N7 always yesterday, whatever day the seed runs, and the cross-source follow-up links below hold on any seed date. Consequences: the stored `note_date` differs from the file's absolute date, and the literal "10/08" inside N6's text no longer matches its stored date on a seed day other than 2026-10-10 (cosmetic; the scanner does not read it).

| Note (ingestion order) | Participant | Days back | What the scan yields | Tier | What the seed does |
|---|---|---|---|---|---|
| N8 | P-004 | 9 | four negated symptoms excluded; CM `amlodipine` (taking) | 1 | — |
| N1 | P-001 | 5 | AE Diarrhea (grade hint 2 from "4-5 loose stools", onset 3 days before), AE Nausea (1); CM `loperamide` (started), `ondansetron` (taking) | 1 | opens the two AEs N7 links to |
| N4 | P-004 | 4 | AE Sinusitis, Headache; CM `amoxicillin-clavulanate` (started) | 1 | — |
| N2 | P-002 | 2 | AE Rash maculo-papular (hint 2, 15% BSA), Pruritus; CM `triamcinolone`, `cetirizine` (started) | 1 | **cross-source follow-ups**: both AEs link to the open AEs of P-002's d6 check-in |
| N5 | P-005 | 2 | AE Headache, Mucositis oral; "hx of migraines" and "no nausea" excluded | 1 | — |
| N6 | P-006 | 2 (note date); **read ~3 h before the seed clock** (§8) | AE Confusion, Anorexia (hints raised to 3 by "admitted"); CM `dexamethasone` (stopped); red flags `confusion`, `hospitalization` | **2** | **SAE clock** started at ingestion (`site_awareness_at = ingested_at`, due +24 h: a live ~21 h countdown on a fresh seed, running until an investigator records `AESER`); escalation acknowledged by the coordinator 30–90 min later. Ingested last (§8) |
| N3 | P-003 | 1 | AE Dyspnea (onset 7 days before), Cough (5 days); CM `lisinopril` (stopped); red flag `dyspnea` | **2** | escalation **left unacknowledged** so the Escalations page has live work |
| N7 | P-001 | 1 | AE Diarrhea, Nausea ("resolved" flagged as `INTERIM_RESOLVED_CUE`); CM `loperamide` (taking) | 1 | **cross-note follow-ups**: both AEs link to N1's open AEs |

Totals: 8 notes, 23 drafts (14 AE + 9 CM, no VS: a note has no vitals), 4 follow-up links, 2 Tier 2 note escalations (1 acknowledged), 1 SAE clock. Note drafts are left as `draft` so the queue shows note-sourced work next to the check-ins (`source: "chart_note"`, `session_id: null`). A note never produces Tier 3, a page or a stop screen (`docs/DECISIONS.md` D-017). The order above is chronological so the audit chain reads naturally; the check-ins are all seeded first, which is correct for this data set because no check-in dated after a note reports the same term as that note.

Labeling: every note-sourced record carries `INTERIM_RECORD_SOURCE = "chart_note"` (and `INTERIM_SOURCE = "chart_note"` on its AE/CM fields), `INTERIM_NOTE_ID`, and `INTERIM_MATCH_KIND = "lexicon"` on CM rows (the scanner's lexicon is a pattern list, NOT RxNorm).

## 5. The persona answer key (`packages/rules/data/personas.json`)

The eval harness (`CLAUDE.md` §8, `docs/CONTRACTS.md` §6) replays scripted check-ins through the **real API** and compares the results with hand-written expectations.

### 5.1 Composition

| Category | Count | `hidden` | What they cover |
|---|---|---|---|
| `tier0` | 6 | no | All items G0/G1; no red flags; con-med variety (none, exact, brand, unmatched) |
| `tier1` | 6 | no | Exactly one or two G2 items; includes the demo persona `T1-dyspnea-moderate` |
| `tier2` | 5 | no | A G3 item, or a red flag with floor 2 (fever + severe item; free text + severe item) |
| `tier3` | 4 | no | Hospitalization (SAE clock), severe dyspnea (stop screen), Tier 2 + corroboration with `simulated_as_measured: true` |
| `edge` | 3 | no | Implausible vitals ignored (pulse 190 → `vitals.implausible`, no bump); low-quality vitals ignored (conf 0.4 → `vitals.low_quality`); same symptom twice within 7 days via `setup.prior_checkins` → `dedup.followup_linked`, `ae_drafts` counts the follow-up, `dedup_followups: 1` |
| `protocol` | 7 | no | Added with the R3 protocol rules (`protocol_rules.json`, `irae_mapping.json`; `docs/CONTRACTS.md` R3.1): grade-3 itching and diarrhea start a 24-hour AESI clock; mild rash + moderate itching after a prior PI3K inhibitor is a possible AESI; started bevacizumab (and the brand `Avastin`) is prohibited and floors the tier at 2; started prednisone raises the discouraged-steroid flag without moving the tier; hydrocortisone cream is topical and raises no flag. Ids start with `P3-` |
| `judge` | 5 | **yes** | Combinations the shipped set does not show, for the judges to run live from the Eval page (the **Run hidden judge personas (5)** button, or each row's **Run** button; the catalogue's "show hidden judge personas" checkbox only filters the list) |

24 core + 7 protocol + 5 hidden = 36. All are deterministic. `make eval` must pass every persona it runs. Until the R3 API work adds a `protocol_context` input, it reports one protocol persona, `P3-rash-itching-prior-pi3k-aesi`, as not replayable over HTTP instead of running it. That persona is still replayed in-process by `packages/rules/tests/test_personas.py`. The Eval page's **Run the shipped personas (31)** button does run it and shows it failing (30 / 31) for the same reason; see `docs/DEMO.md` step 6.

### 5.2 Schema (one persona)

```json
{
  "id": "T1-dyspnea-moderate",
  "name": "Moderate shortness of breath, started loratadine",
  "category": "tier1",
  "hidden": false,
  "description": "The demo persona. One G2 item, one G1 item, con-med exact match.",
  "consent_camera": true,
  "vitals_scenario": "resting",
  "settings": { "simulated_as_measured": false },
  "setup": { "prior_checkins": [] },
  "responses": { "shortness_of_breath": { "severity": 2, "interference": 2 }, "cough": { "severity": 1, "interference": 0 }, "...": {} },
  "gates": { "hospitalization": false, "conmed_changed": true, "conmed_text": "loratadine", "conmed_direction": "started", "other_text": "" },
  "vitals_samples": [ { "tsOffsetS": 0, "source": "mock", "isMeasured": false, "pulseBpm": 72, "pulseConf": 0.9, "breathingBpm": 14, "breathingConf": 0.85, "windowS": 30, "qualityFlags": [] } ],
  "expected": {
    "grades": { "shortness_of_breath": 2, "cough": 1, "fatigue": 0, "nausea": 0, "diarrhea": 0, "rash": 0, "itching": 0, "joint_pain": 0, "fever_or_chills": 0, "mouth_sores": 0 },
    "tier": 1,
    "stop_screen": false,
    "rules_fired_includes": ["grade.provisional.shortness_of_breath", "tier.base", "conmed.exact", "vitals.simulated_ignored"],
    "rules_fired_excludes": ["corr.tachypnea_dyspnea", "sae.clock_started"],
    "sae_clock_started": false,
    "seriousness_suspected": false,
    "ae_drafts": 2,
    "vs_drafts": 2,
    "cm": [ { "verbatim": "loratadine", "cmdecod": "loratadine", "min_confidence": 1.0 } ],
    "dedup_followups": 0
  }
}
```

Field notes:

- `vitals_scenario` is **informational** (which live mock scenario this persona corresponds to); the samples actually replayed are `vitals_samples[]`, with `tsOffsetS` relative to session start, materialized to `tsUtc` by the runner (`docs/DECISIONS.md` D-005). Every sample is `isMeasured: false`; personas that need corroboration set `settings.simulated_as_measured: true`, which the runner passes as the per-session `settings_override` (admin token), never by flipping the global setting.
- `setup.prior_checkins[]` entries are `{days_ago, responses, gates}`; the runner replays them first (backdated with `completed_at_override`) and confirms their AE drafts, so the main check-in can exercise dedup.
- `expected.grades` lists **all ten items** so a stray non-zero grade is caught.
- `rules_fired_includes` / `rules_fired_excludes` reference ids from `packages/rules/data/rules_catalog.json` only.
- `cm[].min_confidence` is a lower bound; `cmdecod: null` asserts unmatched.
- Hidden personas have `hidden: true`. `make eval` runs them (`scripts/run_eval.py --include-hidden` is the default; `--no-include-hidden` leaves them out). On the Eval page, **Run the shipped personas** excludes them and **Run hidden judge personas** runs only them.

### 5.3 How personas are run

- **From the command line:** `make eval` (or `npm run eval`) → `python scripts/run_eval.py --start-server --include-hidden --strict --out docs/eval/results.md`. It starts its own throwaway API on a free port with a temporary SQLite database, so nothing needs to be running and the demo database is never touched; the run is not stored for the Eval page. `make eval-live` (or `npm run eval:live`) → `python scripts/run_eval.py --api http://localhost:8000` replays against the API already running and writes `data/runtime/eval/results.live.md` (gitignored), so a rehearsal never overwrites the committed record. The runner creates eval participants on the fly (`is_eval: true`, hidden from the queue), replays each persona through `/sessions`, `/answers`, `/gates`, `/vitals`, `/complete`, fetches `/checkins/{id}`, compares, and writes `docs/eval/results.md`: per-tier precision/recall/F1, the 4×4 grade confusion matrix (rows expected, columns actual), dedup / SAE-clock / con-med correctness, and a list of mismatches.
- **From the dashboard:** Eval page → **Run the shipped personas (N)** or **Run hidden judge personas (5)**, or a single row's **Run** in the Personas catalogue (all `POST /api/v1/eval/run`). The last run is stored and shown on the page (`GET /api/v1/eval/results`) until `make demo-reset` wipes it.
- **Build your own persona:** the Eval page form opens pre-filled with the demo persona `T1-dyspnea-moderate` (**Reset to demo persona** restores it) and **Run this persona** sends it through `POST /api/v1/eval/run-custom`; the response carries the full `CheckInResult` with `rules_fired` and `why`, so the judge can change one answer or one vitals value and watch the tier, grade and rule list change.

### 5.4 Provenance

`personas.json` carries top-level `source` ("Hand-written by the Interim team; expected outputs verified against the rules engine and reviewed by hand") and `rationale`. "Verified against the engine" means the shipped expectations are a **regression guarantee** for the rules, not a clinical validation; see `docs/WHAT_IT_GETS_WRONG.md` §13.

## 6. Regenerating everything

```bash
# Full reset: wipe runtime DB, reseed study + 12 participants + 34 prior check-ins (audited)
make demo-reset            # or: npm run demo-reset  /  python scripts/seed.py --reset
# Seed into an empty DB without wiping (no-op if already seeded)
make seed                  # or: npm run seed  /  python scripts/seed.py
# Also available: Admin page -> "Reset demo data", or
#   curl -X POST -H "Authorization: Bearer <admin token>" http://localhost:8000/api/v1/admin/reset -d '{"reseed": true}'
# Refresh the public caches (network), or rebuild them from the bundled fallback without network
make fetch-public          # python scripts/fetch_public.py [--offline] [--build-medlist]
# Re-run the answer keys on a throwaway API (temp SQLite) and rewrite docs/eval/results.md
make eval                  # python scripts/run_eval.py --start-server --include-hidden --strict --out docs/eval/results.md
# Same replay against the API already running on :8000 (writes data/runtime/eval/results.live.md)
make eval-live             # python scripts/run_eval.py --api http://localhost:8000
```

With Docker, `docker compose down -v` deletes the SQLite volume; the next `docker compose up` reseeds because `SEED_ON_START=true`.

The Synthea cohort is regenerated separately and offline (it needs Docker or Java and downloads a pinned ~197 MB jar); the commands, the determinism check and the de-identification tests are in [`synthea/README.md`](synthea/README.md) ("Regenerate"). `scripts/synthea/eval_synthea.py --check` recomputes `docs/eval/synthea_results.md` and requires it to be byte-identical.

## 7. Labeling guarantees (so nobody mistakes synthetic for real)

- Dashboard header: "Demo study (public registry record)" next to the NCT id, and "All participants are synthetic." (`GET /api/v1/study` returns `participants_note`).
- Every vitals value: `SIMULATED` badge in the kiosk and dashboard; `VSMETHOD = "Simulated"`, `INTERIM_SOURCE = "mock"`, `INTERIM_IS_MEASURED = false` in VS rows and in every export and the bundle manifest's files.
- `AEDECOD` codes: `meddra_code_mock` in `packages/rules/data/ctcae_terms.json` is labeled mock; the term names are real CTCAE v5.0 terms.
- Con-med list: `packages/rules/data/medlist.json` says `"is_rxnorm": false` and "NOT RxNorm. Not a formulary." in its `rationale`.
- Eval participants: `is_eval = true`, hidden from the queue unless `include_eval=true`.
- Chart-note records: `INTERIM_RECORD_SOURCE = "chart_note"`, `INTERIM_NOTE_ID`, and `INTERIM_MATCH_KIND = "lexicon"` on CM rows (the scanner's drug list is NOT RxNorm); the note text itself is stored verbatim and is synthetic.
- Synthea data: every file and the evaluation report are labeled "Synthea synthetic EHR (simulated)"; vitals there are `is_measured: false`.
- The word "simulated" appears next to every simulated value, in UI and in exports. No exceptions (`CLAUDE.md` §13).

## 8. Notes (review fixes, 2026-10-10)

Deviations from §4.6 and behaviors the seed and the notes service added after the API review. The
seed table in §4.6 is otherwise still the spec; where this section and §4.6 differ, this section
wins (the discrepancy is deliberate and logged here rather than in `docs/ISSUES.md`).

- **N6 is read ~3 h before the seed clock, not 2 days back.** Its `note_date` stays re-anchored
  two days back (an ED note written on the visit day), but `ingested_at` is `T0 − 3 h ± 30 min`
  (`NoteSeed.ingested_hours_before_seed = 3.0` in `apps/api/interim_api/seed.py`): an outside ED
  record reaching the site a couple of days late, which is exactly what ICH E2A's "site
  awareness" moment is about. Consequences: the SAE clock (`site_awareness_at = ingested_at`,
  due +24 h) is a **live ~21 h countdown** on the first dashboard load (CLAUDE.md §3.4(f)) instead
  of ~35 h overdue; N6 is now the **last** note ingested (notes go in `ingested_at` order: N8, N1,
  N4, N2, N5, N3, N7, N6), and its escalation is acknowledged 30–90 min after ingestion, i.e. still
  before `T0`. The clock keeps running until an investigator records `AESER` on N6's Confusion or
  Anorexia draft (`PATCH /drafts/{id}/attribution`); the seed never does that (§4.4).
- **Hospitalization-only notes.** A note whose only finding is a hospitalization/ER cue ("admitted
  overnight after a fall") is Tier 2, starts an SAE clock and drafts **no AE**, so there is no
  draft to attribute. The investigator stops such a clock directly with
  `PATCH /sae-clocks/{id}/stop {decision}` (audited `sae_clock.stopped`; see `apps/api/README.md`, which labels it D-023, a number `docs/DECISIONS.md` has since given to a different decision). None of
  the eight seeded notes is of this kind; N6 has two symptom findings.
- **Duplicate guard.** `POST /notes` refuses (409 `Duplicate note`, with `existing_note_id`) a note
  whose participant, `note_date` and verbatim text were already ingested, whatever the `author`
  field says. The eight seeded notes are distinct, so a reseed is unaffected; re-posting a seeded
  note from the Notes page is refused rather than drafted twice.
- **Ingestion order no longer matters for de-duplication.** §4.6 says the chronological order is
  what keeps the cross-source follow-up links valid. The notes service now applies the dedup window
  in **both directions** for a note (an admin-backdated note read before a later kiosk report of
  the same term, within 7 days, links as a follow-up instead of opening a second AE; the open AE's
  `last_reported_at` never moves backwards). The seed still ingests chronologically because the
  audit chain reads better that way, not because dedup needs it.
- **`AESTDTC` on note AEs.** A new note AE carries a calendar date (`2026-10-02`; the note supports
  no time of day); a follow-up carries the linked AE's `first_reported_at` (a full timestamp when a
  check-in opened it). One export column mixes both precisions on purpose (SDTM allows partial ISO
  8601 dates). When a follow-up note states an onset earlier than the AE's first report, the draft
  keeps the first report and flags it (`INTERIM_STATED_ONSET_DATE`,
  `INTERIM_ONSET_BEFORE_FIRST_REPORT = true`, a why line) for the coordinator to decide.
  Documented in `docs/WHAT_IT_GETS_WRONG.md` §19.
- **Eval rows stay off the dashboard.** `GET /escalations`, `GET /sae-clocks`, `GET /pages` and
  every export (including chart-note drafts, which have no session and are hidden through the
  participant's `is_eval` flag) default to `include_eval=false`, so running the Eval page during
  the demo never leaves `EVAL-…` rows, unstoppable clocks or extra export rows behind.

## 9. Lineage and participant mapping (wave 2)

Three synthetic sources share the label space `P-001` … `P-012`. They are **not** the same simulated people unless a row below says so.

| Source | What it holds | Who wrote it | Label rule | Used at runtime? |
|---|---|---|---|---|
| Seeded kiosk participants (§3–§4) | 12 participants, 34 prior check-ins, simulated resting vitals; **no demographics** | Interim team, `apps/api/interim_api/seed.py` (spec: this README) | `P-001` … `P-012` by design | Yes: the runtime database |
| Chart notes (§4.6, §9.1) | 8 clinician notes for P-001 … P-006 with an answer key | Omer Khawar (AE Capture Desk), remapped | source subject `101-00x` → `P-00x` | Yes: ingested by the seed through `/notes`; also a sample list on the Notes page |
| Synthea cohort (§9.2) | 12 NSCLC patients with demographics, comorbidities, medications, baselines; 72 notes | Synthea (MITRE), imported by `scripts/synthea/import_synthea.py` | sorted by birth date, then Synthea id | No (offline evaluation only, until `docs/ISSUES.md` #23) |

### 9.1 Chart-note lineage

- **Origin.** `backend/app/data/chart_notes.json` of `omer-khawar/ae-checkin-agent` (Omer Khawar, MIT), ported 2026-10-10 (`docs/CONTRACTS.md` R2.4, `docs/DECISIONS.md` D-014). The note **texts are unchanged**; only subject ids were remapped (the file's `subject_mapping`).
- **Mapping** (deterministic: last three digits → `P-<digits>`):

  | Source subject | Interim participant | Notes |
  |---|---|---|
  | `101-001` | P-001 | N1 (progress note), N7 (phone note: the cross-note follow-up of N1) |
  | `101-002` | P-002 | N2 (dermatology telehealth consult: cross-source follow-up of P-002's d6 check-in) |
  | `101-003` | P-003 | N3 (triage phone note: Tier 2, left unacknowledged) |
  | `101-004` | P-004 | N4 (outside urgent-care record), N8 (progress note: four negated symptoms) |
  | `101-005` | P-005 | N5 (infusion RN note: "hx of migraines" and "no nausea" skipped) |
  | `101-006` | P-006 | N6 (ED note: hospitalization → SAE clock) |

  P-007 … P-012 have no seeded notes, so the optional note in `docs/DEMO.md` step 4b is P-007's first (it links to P-007's open Cough AE from the kiosk, a cross-source follow-up).
- **Answer key.** The same eight notes, text included, are the `kind: "note"` cases of `packages/rules/data/chartscan_answer_key.json`; `packages/rules/tests/test_chartscan.py` fails if the two files drift. The answer key has 39 cases in all: Omer's 8 notes and 17 participant utterances (`T1`–`T17`) plus 14 utterances (`T18`–`T31`) added after the 2026-10-10 review, one per scanner fix. Only the 8 notes are in `chart_notes.json`; utterances are never ingested as notes.
- **Style and traps.** Indirect clinical shorthand ("pt reports 3 days of diarrhea, started loperamide"), with deliberate negations, history, patient-education text ("call for fever > 100.4"), brand names and a repeated AE across two notes. Hand-written in the irAE spirit of the starter sheet; not Synthea output.

### 9.2 Synthea cohort (pointer)

Everything about generation, de-identification, ground truth and limitations is in [`synthea/README.md`](synthea/README.md); the evaluation is `docs/eval/synthea_results.md`. Labeled "Synthea synthetic EHR (simulated)"; every vital sign there is `is_measured: false`. Summary per label (values from `synthea/participants.json`; ages at 2026-10-10; baselines are medians of Synthea's yearly resting readings):

| Label | Sex | Age | NSCLC stage | Active meds | Baseline breathing / pulse (per min) | Smoking | Notes |
|---|---|---|---|---|---|---|---|
| P-001 | male | 76 | 1 | 5 | 14 / 82 | never | 6 |
| P-002 | male | 71 | 1 | 5 | 14 / 83 | never | 6 |
| P-003 | male | 67 | 1 | 5 | 13 / 83 | former | 6 |
| P-004 | female | 66 | 1 | 4 | 15 / 72 | never | 6 |
| P-005 | male | 64 | 1 | 1 | 14 / 80 | never | 6 |
| P-006 | male | 64 | 1 | 4 | 13 / 70 | former | 6 |
| P-007 | male | 61 | 1 | 1 | 16 / 90 | former | 6 |
| P-008 | female | 59 | 1 | 0 | 13 / 84 | former | 6 |
| P-009 | female | 57 | 1 | 1 | 15 / 68 | former | 6 |
| P-010 | male | 55 | 1 | 4 | 15 / 79 | former | 6 |
| P-011 | male | 53 | 1 | 4 | 15 / 71 | former | 6 |
| P-012 | male | 50 | 1 | 2 | 15 / 82.3 | former | 6 |

All 12 are on cisplatin + paclitaxel; none received a PD-1 inhibitor, because Synthea has none (`docs/NOT_BUILT.md` §17). How these baselines would attach to the seeded kiosk participants of the same label (age, sex, stage, comorbidities, active medications, baseline vitals, one recent note each, shown on the timeline as "Synthea synthetic EHR (simulated)") is `docs/ISSUES.md` #23; until it lands, a Synthea `P-007` and the seeded kiosk `P-007` are unrelated simulated people, and nothing in the runtime reads `synthea/`.
