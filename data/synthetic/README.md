# Synthetic data: participants, prior check-ins, and the persona answer key

> **No real people.** Every participant in Interim is synthetic. Names are `P-001` … `P-012`; there are no real names, dates of birth, addresses or identifiers anywhere in this repository or its runtime database. **All vitals are simulated unless the badge says MEASURED**, which today it never does (the only implemented vitals source is the mock; see `docs/VITALS_SOURCES.md`). Every simulated value is labeled `simulated` in the UI (`SIMULATED` badge), in the rules (`is_measured = false`), and in exports (`VSMETHOD = "Simulated"`, `INTERIM_SOURCE = "mock"`, `INTERIM_IS_MEASURED = false`).

This directory is documentation. The generator is code:

| What | Source of truth | Regenerate with |
|---|---|---|
| The demo study (real public record) | `scripts/fetch_public.py` → `data/public/study.json` (committed cache; bundled fallback) | `make fetch-public` (`--offline` uses the cache) |
| 12 participants and their prior check-ins | `scripts/seed.py` (this README is its spec) | `make seed`, `make demo-reset`, `npm run seed`, `npm run demo-reset`, `python scripts/seed.py [--reset]`, Admin → "Reset demo data", or `POST /api/v1/admin/reset {"reseed": true}` |
| Persona answer key (eval) | `packages/rules/data/personas.json` | hand-edited; replayed by `scripts/run_eval.py` (`make eval`) and by the Eval page |
| Mock vitals scenarios (live kiosk) | `apps/vitals-bridge/src/sources/mock.ts` | n/a (deterministic per scenario) |

Nothing in `data/synthetic/` needs to be hand-edited. Seeded data lives only in the runtime database (`data/runtime/interim.db`, gitignored, or the Docker volume). If `scripts/seed.py` and this README disagree, the README is the spec and the discrepancy is a bug to log in `docs/ISSUES.md`; if a deliberate change is made, log it in `docs/DECISIONS.md` and update both.

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
| `baseline_vitals_json` | `{ "pulse_bpm": b_p, "breathing_bpm": b_b, "source": "mock", "is_measured": false, "note": "simulated baseline" }` with `b_p` drawn uniformly from 58–84 and `b_b` from 12–17 per participant. Reserved for future baseline-personalized thresholds (`docs/NOT_BUILT.md` §12); unused by the rules today. |

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
| **P-002** | 2 | 40, 12 | d40: `rash` presence 1. d12: `rash` presence 1, `itching` severity 2 | — | Yes | 0, 1 | Presence-only rash is always G1 (a documented limitation, `docs/WHAT_IT_GETS_WRONG.md` §1); itching Moderate makes the second check-in Tier 1. |
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

Totals: 34 check-ins; Tier 2 on exactly two of them (P-003 d24, P-009 d30); con-med changes on four participants (P-003, P-005, P-006, P-008); one open AE prepared for the demo (P-007 Cough). Every "intended tier" in the table was replayed through `interim_rules.engine.evaluate_checkin` on 2026-10-10 and matched; if a table under `packages/rules/data/` changes, replay again before trusting this column.

### 4.4 What the seed does after each prior check-in

- Confirms every AE draft it created, acting as `coordinator` (audit `draft.confirmed`), so `AEOpen` rows exist and timelines show "open AEs". VS and CM drafts are left as `draft` so the queue still has work in it.
- Acknowledges the two Tier 2 escalations as `coordinator` 20–50 minutes after `completed_at` (RNG), so the Escalations page shows realistic `seconds_to_ack` values.
- Never sets `AEREL`/`AESER` (those are live investigator actions in the demo).

### 4.5 Seeded vitals (simulated)

For every seeded session with `consent_camera = true`, the seed posts a deterministic replay of the bridge's **`resting`** scenario through `POST /sessions/{id}/vitals` (as actor `vitals-bridge`, role `system`), so the audit trail and the `VitalsSample` table look exactly like a live session:

- One sample per second for the session's duration (`completed_at − started_at`, 240–420 samples), `source = "mock"`, `is_measured = false`, `window_s = 30`.
- Pulse: participant baseline `b_p` plus AR(1) noise (`x_t = 0.8·x_{t−1} + ε`, `ε ~ N(0, 1.2)`), rounded to one decimal; `pulse_conf` ramps 0.3 → 0.95 over the first 15 s then holds with ±0.03 jitter.
- Breathing: baseline `b_b` plus AR(1) noise (`0.85·x_{t−1} + ε`, `ε ~ N(0, 0.5)`); `breathing_conf` ramps the same way.
- HRV (`hrv_rmssd_ms`): 25–55 ms with AR(1) noise, `hrv_conf` 0.7–0.9.
- Timing gates mirrored from `apps/vitals-bridge/src/gate.ts`: pulse is `null` with flag `gate_pending_pulse` for the first 12 s, breathing for 30 s, HRV for 60 s. Nothing is below `min_confidence` after the ramp, so every seeded session gets `vitals_status = "simulated_ignored"` (simulated samples, toggle OFF): the summary exists and the VS rows say Simulated, but corroboration is not eligible.
- The seed contains its own small pure-Python generator for this; it does not depend on the Node bridge (`docs/DECISIONS.md` D-005: the bridge's mock and the seed/persona samples describe the same physiology but are separate code).

Nothing in the seed ever produces a vitals value outside the plausibility bounds (pulse 35–180, breathing 5–45); implausible and low-quality vitals are exercised by the personas (§5), not the seed.

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
| `judge` | 5 | **yes** | Combinations the shipped set does not show, for the judges to run live from the Eval page ("Include hidden") |

24 visible + 5 hidden = 29. All are deterministic and `make eval` must report 100% on all of them.

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
- Hidden personas have `hidden: true` and are excluded from `make eval` unless `--include-hidden`; the Eval page's "Include hidden judge personas" checkbox includes them.

### 5.3 How personas are run

- **From the command line:** `make eval` → `python scripts/run_eval.py --api http://localhost:8000 --out docs/eval/results.md`. The API must be running. The runner creates eval participants on the fly (`is_eval: true`, hidden from the queue), replays each persona through `/sessions`, `/answers`, `/gates`, `/vitals`, `/complete`, fetches `/checkins/{id}`, compares, and writes `docs/eval/results.md`: per-tier precision/recall/F1, the 4×4 grade confusion matrix (rows expected, columns actual), dedup / SAE-clock / con-med correctness, and a list of mismatches.
- **From the dashboard:** Eval page → Run (`POST /api/v1/eval/run`), optional "Include hidden"; results persist (`GET /api/v1/eval/results`).
- **Build your own:** the Eval page form edits a persona in place and runs it through `POST /api/v1/eval/run-custom`; the response carries the full `CheckInResult` with `rules_fired` and `why`, so the judge can change one answer or one vitals value and watch the tier, grade and rule list change.

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
# Re-run the answer key through the live API and rewrite docs/eval/results.md
make eval                  # python scripts/run_eval.py --api http://localhost:8000 --out docs/eval/results.md
```

With Docker, `docker compose down -v` deletes the SQLite volume; the next `docker compose up` reseeds because `SEED_ON_START=true`.

## 7. Labeling guarantees (so nobody mistakes synthetic for real)

- Dashboard header: "Demo study (public registry record)" next to the NCT id, and "All participants are synthetic." (`GET /api/v1/study` returns `participants_note`).
- Every vitals value: `SIMULATED` badge in the kiosk and dashboard; `VSMETHOD = "Simulated"`, `INTERIM_SOURCE = "mock"`, `INTERIM_IS_MEASURED = false` in VS rows and in every export and the bundle manifest's files.
- `AEDECOD` codes: `meddra_code_mock` in `packages/rules/data/ctcae_terms.json` is labeled mock; the term names are real CTCAE v5.0 terms.
- Con-med list: `packages/rules/data/medlist.json` says `"is_rxnorm": false` and "NOT RxNorm. Not a formulary." in its `rationale`.
- Eval participants: `is_eval = true`, hidden from the queue unless `include_eval=true`.
- The word "simulated" appears next to every simulated value, in UI and in exports. No exceptions (`CLAUDE.md` §13).
