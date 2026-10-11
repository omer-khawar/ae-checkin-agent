# Slide deck outline (12 slides)

> **Status (2026-10-10, evening): this outline describes the wave-2 build (`docs/CONTRACTS.md` R2.6).** The R3 rewrite (`docs/DECISIONS.md` D-023 to D-026: the Monday-morning story, protocol-aware rules, no per-session camera consent, the optional text writer that relaxes "no LLM anywhere" for written text only) is pending; until it lands, statements here about consent, the no-LLM rule and persona counts describe the running wave-2 app.

> Target: 10–12 slides per the Regeneron "Design & Packaging" criterion. This is the 12-slide outline from `CLAUDE.md` §12 with content, the screenshot each slide needs, and speaker notes of 60 words or fewer. Spoken time: about 7 minutes without the live demo; the live demo itself is `docs/DEMO.md` (3 minutes). Build the deck light-on-white to match the product; one idea per slide; no stock photos.

Screenshot checklist (capture at 1920×1080, light theme, browser zoom 110%, after `make demo-reset` and one full rehearsal of `docs/DEMO.md`):

| Tag | What to capture | From |
|---|---|---|
| S-kiosk | Kiosk mid-check-in: shortness-of-breath item, vitals card showing pulse 72 / breathing 14 with the **SIMULATED** badge | `/kiosk`, `resting` scenario |
| S-detail | Check-in detail page with AE/VS/CM drafts, one field highlighted and its evidence panel open, Why panel visible | `/dashboard/checkins/:sessionId` after DEMO step 4 |
| S-notes | Notes page after ingesting the DEMO step 4b note: the note text with "cough" highlighted, the Cough follow-up AE and dextromethorphan CM drafts, the two skipped mentions with "'Denies' precedes …" | `/dashboard/notes` after DEMO step 4b |
| S-synthea | The headline table of `docs/eval/synthea_results.md` (symptoms, medications, escalation by encounter class) | editor / rendered Markdown |
| S-why-tier2 | The Why panel after DEMO step 5 showing `corr.tachypnea_dyspnea` / `corr.tachycardia_dyspnea` and `tier.corroboration_bump` with the actual values | after DEMO step 5 |
| S-queue | Queue with Tier 1 and Tier 2 rows, tier chips, SAE countdown chip on a persona with hospitalization | `/dashboard` after running the eval with `include_eval` shown |
| S-audit | Audit page with the green "verified" badge and the head hash | `/dashboard/audit` |
| S-eval | Eval page results table (per-tier precision/recall, grade confusion matrix) | `/dashboard/eval` |
| S-arch | Rendered Mermaid architecture diagram | `README.md` |
| S-rules | `packages/rules/data/vitals_corroboration.json` open in an editor (showing `source`, `rationale`, thresholds) | editor |
| S-stop | Tier 3 stop screen | `/kiosk` with a severe-dyspnea answer |

---

## Slide 1 — Title

**Content**
- **Interim** — between-visit AE check-in with contactless vitals as eSource
- HackRU Fall 2026 · Regeneron "Best Clinical Trials Solution" track
- Repo URL · MIT · "No LLM anywhere. Not a medical device."
- Team names

**Screenshot:** S-kiosk, small, bottom-right.

**Speaker notes (≤60 words):** Interim. Between study visits, a participant answers a short symptom check-in at a kiosk while the webcam captures pulse and breathing. A rules engine grades, escalates and drafts EDC entries; a coordinator confirms every one. No LLM anywhere. Everything you will see runs from a clean clone.

## Slide 2 — The bottleneck

**Content**
- Clinicians under-report symptomatic toxicity: **40.7%–74.4%** of patient-reported toxicities missed by physicians in three randomized trials (Di Maio, *JCO* 2015)
- NCI's answer: PRO-CTCAE, 124 items, 78 symptomatic toxicities, 7-day recall (Basch, *JNCI* 2014)
- Cemiplimab is dosed **every 3 weeks**; a symptom can be 21 days old before anyone asks
- Then it is typed into the EDC by hand; the SAE clock starts at *site awareness*, which nobody timestamps

**Screenshot:** none; one large number (74%) and a q3w calendar strip.

**Speaker notes (≤60 words):** Clinicians under-report symptomatic toxicity: Di Maio found physicians missed forty-one to seventy-four percent of patient-reported toxicities in three randomized trials. NCI built PRO-CTCAE in response. On a three-weekly cemiplimab schedule a symptom can be three weeks old before anyone asks. Then it is typed into the EDC by hand.

> Presenter note: `CLAUDE.md` mentions an "8-day data lag" talking point. Use it only with a citation; otherwise the q3w dosing interval from the LIBTAYO label is the defensible number.

## Slide 3 — What we built

**Content**
- Two inputs, one engine: kiosk check-in (10 PRO-CTCAE-style items + 3 gates, with contactless vitals) **and** clinician chart notes (deterministic scanner) → rules → SDTM drafts → coordinator confirm
- Cross-source dedup: a cough in a phone note links to the cough reported at the kiosk
- One screenshot of the coordinator detail page: answers | drafts | Why

**Screenshot:** S-detail, full-bleed, with S-notes as a small inset (bottom-right).

**Speaker notes (≤60 words):** This is the coordinator's detail page. Left, the participant's answers. Middle, drafted AE, VS and CM records in SDTM variable names. Right, every rule that fired, in plain English. Chart notes feed the same drafts, with the exact words highlighted. Every field shows its evidence. Nothing leaves without a confirm click.

## Slide 4 — The angle: vitals as eSource

**Content**
- "Shortness of breath, moderate" + breathing rate 26/min captured at that second
- Every sample: source, confidence, window, UTC timestamp, **MEASURED / SIMULATED** label (FDA eSource guidance, 2013)
- Vitals never change the grade; they can raise the escalation tier by at most one step, by a documented rule
- Camera frames never leave the kiosk machine

**Screenshot:** S-kiosk vitals card, cropped, next to the VS draft row with `VSMETHOD`.

**Speaker notes (≤60 words):** The sheet asked for check-ins. We added objective context: contactless pulse and breathing captured while the participant says "moderate shortness of breath". Each sample keeps source, confidence, window and timestamp, and is labeled measured or simulated. Vitals never change the grade; they can raise the escalation tier by one step.

## Slide 5 — Architecture

**Content**
- Mermaid diagram for `README.md` (the README's architecture section is still to be written; draw these edges): kiosk (web) → API → rules → SQLite; bridge → WS → kiosk and → HTTP → API; dashboard Notes page → `POST /notes` → `interim_rules.chartscan` → same drafts, dedup, SAE clock
- Three apps, one shared package: `apps/web`, `apps/api`, `apps/vitals-bridge`, `packages/rules`
- `VitalsSource` plugin: `mock` (demo, SIMULATED) · `presage` (implemented, SDK loaded on demand, live test pending) · `arduino` (slot)
- Offline, build-time only: `scripts/synthea/` (pinned Synthea jar → de-identified NSCLC cohort → evaluation); nothing reads FHIR at runtime

**Screenshot:** S-arch.

**Speaker notes (≤60 words):** Three apps, one shared rules package. The bridge is the only thing that touches the camera; frames never leave it. The API is the single writer. Check-ins and chart notes flow into the same rules, drafts and audit chain. The vitals adapter is a plugin: mock today, Presage implemented and awaiting its live test.

## Slide 6 — Rules, not prompts

**Content** (table)

| Rule family | Table | Effect |
|---|---|---|
| Composite scoring (Basch 2021) | `composite_scoring.json` | 0–3 per item |
| Provisional grade | `composite_to_grade.json` | G0–G3, never G4/G5 |
| Red flags | `red_flags.json` | tier floor 2 or 3 |
| Vitals corroboration | `vitals_corroboration.json` | +1 tier max; breathing ≥24, pulse ≥110 |
| Escalation ladder | `escalation_ladder.json` | tier 0–3, stop screen, page |
| SAE clock | `seriousness.json` | +24 h site; 7/15 d informational |
| Con-med matcher | `medlist.json`, `conmed_matching.json` | exact → case-insensitive → Levenshtein ≤2, confidence floor 0.7 |
| Dedup | `dedup.json` | 7-day follow-up link, check-ins and notes alike |
| Chart-note scanner | `chartscan_lexicon.json` | 29 CTCAE terms, 43 drugs; NegEx-style negation / history / hypothetical skips with reasons |
| Note red flags | `chartscan_red_flags.json` | Tier 2 max (never pages); hospitalization → SAE clock at ingestion |

**Screenshot:** S-rules.

**Speaker notes (≤60 words):** Every clinical number, and every regex, lives in a JSON table with a source and a rationale, not in code. Composite scoring follows Basch 2021. Red flags, corroboration, the ladder, the SAE clock and the chart-note scanner are all deterministic. Change an input and the output changes the same way every time.

## Slide 7 — Evidence and audit

**Content**
- 100% of drafted fields carry `evidence[]` pointers (answer id, sample id, rule id, table)
- Append-only audit: `hash = sha256(prev_hash + canonical_json(event))`; `GET /audit/verify`
- Edits create versions; nothing is overwritten (ALCOA+)

**Screenshot:** S-audit (verified badge) with an inset of the evidence panel from S-detail.

**Speaker notes (≤60 words):** Every answer, sample, rule firing, edit, confirm, page and export is an append-only audit event, hash-chained with SHA-256 over the previous hash. One endpoint verifies the whole chain and names the first broken link. Edits create versions; nothing is overwritten. This is ALCOA-plus by construction.

## Slide 8 — Evaluation results

**Content**
- **Regression (our answer keys, 100% by construction):** 24 scripted personas + 5 hidden judge personas replayed through the **real API** (the 7 `protocol` personas added with the R3 rules join this line when the R3 API work lands; the Eval page already lists them) (per-tier P/R/F1, grade confusion matrix, dedup, SAE clock); chart-note scanner on 39 cases: AE terms 38/38, meds 17/17, 14/14 escalations, 0 over-escalations. Numbers from `docs/eval/results.md`
- **Independent (Synthea, never tuned on it):** 72 notes, 12 NSCLC patients. Symptoms P 0.919 / R 0.792; medications P 1.000 / R 0.178 of those visible in text; routine visits over-flagged 55.8% (templated "Chest Pain"). From `docs/eval/synthea_results.md`
- "Build your own persona" form on the Eval page

**Screenshot:** S-eval left, S-synthea right.

**Speaker notes (≤60 words):** Left: our answer keys, one hundred percent because they are deterministic regression tests. Right: the honest number. Synthea notes the scanner never saw: good precision, weaker recall, and a templated chest-pain complaint over-flags routine visits. We publish both. Five hidden judge personas and a build-your-own form are waiting for you.

## Slide 9 — Live demo

**Content**
- `docs/DEMO.md`, 3 minutes: P-007 → Tier 1 → (optional: paste a phone note, cough links to the kiosk AE) → scenario `post_exercise` → Tier 2, grade unchanged → judge edits an input → audit verify → export bundle
- URLs: kiosk `http://localhost:5173/kiosk` · dashboard `http://localhost:5173/dashboard` · API docs `http://localhost:8000/docs`

**Screenshot:** S-why-tier2 as the fallback if the live demo fails.

**Speaker notes (≤60 words):** Three minutes: P-007 reports moderate shortness of breath, tier one. Switch the vitals scenario to post-exercise, same answers, pulse one-nineteen and breathing twenty-five, tier two, grade unchanged. Then you change an input on the eval page. Then audit verify and export.

## Slide 10 — What it gets wrong, and what we did not build

**Content**
- Composite → grade crosswalk is an approximation, not validated (presence-only rash is always G1)
- Camera vitals confounded by talking, motion, light; thresholds fixed, not baseline-adjusted; **Presage source not yet run live**
- Scanner is lexicon-bound: misses "tingling", skips a cough after "Phone call with pt:", starts no SAE clock for "seen in ED" (needs "the")
- Con-med matcher: string distance over 300 names ("Vitamin B12 5 MG/ML …" → methylphenidate via "ritalin"; no clopidogrel)
- Synthea: stage 1, chemotherapy, no PD-1 patients, templated notes
- Not built: voice, multilingual, real EDC/MedDRA/RxNorm, Arduino (slot). **Shipped later than planned:** chart-note scanning and Presage (credit Omer Khawar)
- `docs/WHAT_IT_GETS_WRONG.md` · `docs/NOT_BUILT.md`

**Screenshot:** none; text slide.

**Speaker notes (≤60 words):** We will tell you first. The grade crosswalk is not validated. Camera vitals are confounded by talking and motion, and our Presage source has not seen a live camera yet. The note scanner only knows its lexicon, and one missing "the" decides an SAE clock. Synthea has no immunotherapy patients. We once cut chart scanning; a teammate proved it deterministic.

## Slide 11 — Readiness

**Content**
- `git clone` → `docker compose up` (or `make dev`) → kiosk, dashboard, API docs
- Multi-stage images · GitHub Actions CI (ruff, mypy strict, pytest, eslint, tsc, docker build) · MIT
- Env-based config, no secrets in repo · SQLite now, Postgres by one variable · server-side roles · `/health`
- Synthetic participants only · frames never stored · measured/simulated labeled everywhere
- Production adds: SSO + per-user audit identity, real EDC connector, NCI items under Terms of Use

**Screenshot:** terminal capture of `docker compose up` reaching healthy, small.

**Speaker notes (≤60 words):** Clean clone, docker compose up, done. Multi-stage images, CI on every push, MIT license, environment-based config, no secrets, SQLite now and Postgres by one variable, server-side role checks, health endpoint. Synthetic participants only; no frames stored. Production adds SSO, per-user audit identity and a real EDC integration.

## Slide 12 — Team and links

**Content**
- Team names and roles
- **Credits:** chart-note scanner and Presage SmartSpectra groundwork: Omer Khawar, *AE Capture Desk* (`omer-khawar/ae-checkin-agent`, MIT). Synthetic EHR: Synthea, © The MITRE Corporation (Apache-2.0), recommended by the Regeneron judges. Public data: ClinicalTrials.gov, openFDA, NCI CTCAE v5.0
- Repository URL · 3-minute demo video URL · submission/judging link requested by the track (`CLAUDE.md` calls it the JEDI link; fill in before presenting)
- "Run the hidden judge personas: Dashboard → Eval → Run hidden judge personas (5)" · "Change an input: Dashboard → Eval → Build your own persona → Run this persona" · "Paste a note: Dashboard → Notes"

**Screenshot:** QR code to the repo.

**Speaker notes (≤60 words):** Thank you. The chart-note scanner and the Presage groundwork are Omer Khawar's work, ported with credit; the synthetic EHR is Synthea from MITRE. The repository, the demo video and the submission link are on this slide. Everything shown is public and runnable, and the eval page is waiting for your input.
