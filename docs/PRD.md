# Interim — Product Requirements Document (PRD)

| | |
|---|---|
| **Product** | Interim: between-visit adverse-event (AE) check-in for clinical trial sites, with contactless vitals captured as electronic source data (eSource) |
| **Version** | 0.1.0 — HackRU Fall 2026 (Rutgers), Regeneron "Best Clinical Trials Solution" track |
| **Status** | Living document, written before and during the build. Revised 2026-10-10 for wave 2: chart-note scanning shipped (Better tier), Presage source implemented, Synthea cohort and evaluation added |
| **Build brief** | `CLAUDE.md` (product specification; this PRD restates it as requirements) |
| **Interface contract** | `docs/CONTRACTS.md` (pins every cross-component shape; its Revision 2, R2.1–R2.6, wins on conflict) |
| **Companion docs** | `docs/DECISIONS.md` (ADR log) · `docs/ISSUES.md` (tracker) · `docs/NOT_BUILT.md` (deliberate scope cuts, and what shipped later) · `docs/WHAT_IT_GETS_WRONG.md` (limitations) · `docs/DEMO.md` (3-minute script) · `docs/SLIDES.md` (deck outline) · `docs/VITALS_SOURCES.md` (adapter contract) · `data/synthetic/README.md` (synthetic data rules) · `data/synthetic/synthea/README.md` (Synthea cohort) · `docs/eval/synthea_results.md` (independent evaluation) |
| **Credits** | Chart-note scanner and Presage SmartSpectra groundwork: **Omer Khawar**, *AE Capture Desk* (`omer-khawar/ae-checkin-agent`, MIT), ported with credit (D-014). Synthetic EHR: **Synthea**, © The MITRE Corporation, Apache-2.0 |
| **License** | MIT (`LICENSE`) |

> **Status (2026-10-10, evening): this PRD describes the wave-2 build (`docs/CONTRACTS.md` R2.6).** The R3 rewrite (`docs/DECISIONS.md` D-023 to D-026: the Monday-morning story, protocol-aware rules, no per-session camera consent, the optional text writer that relaxes "no LLM anywhere" for written text only) is pending; until it lands, statements here about consent, the no-LLM rule and persona counts describe the running wave-2 app.

---

## 1. Summary

Between study visits, trial participants experience symptoms and start or stop other medications. Most of this surfaces at the next visit, from memory, and is then typed into the electronic data capture system (EDC) by hand. Interim is a deployable, open-source web product for a trial site that closes that gap:

1. A **participant** sits at a kiosk (any laptop with a webcam) between visits and answers a short structured symptom check-in modeled on NCI PRO-CTCAE (10 items + 3 gate questions, "in the last 7 days").
2. While they answer, a **vitals adapter** captures pulse rate and breathing rate contactlessly from the webcam. Every sample is timestamped, labeled **MEASURED** or **SIMULATED**, and stored as eSource with its source, confidence and window. Today's demo runs the mock source (labeled SIMULATED); the Presage SmartSpectra source is implemented but has not yet been run against a live camera (§6, `docs/NOT_BUILT.md` S2).
3. A **deterministic rules engine** (no LLM anywhere) computes a PRO composite score per item, assigns a *provisional* CTCAE grade, checks red flags, decides an escalation tier (0–3), starts the serious-adverse-event (SAE) clock when a hospitalization is reported, matches the verbatim con-med text against a bundled drug list, de-duplicates against open AEs, and drafts CDISC SDTM-shaped **AE / VS / CM** records in which **every field points at its evidence**.
4. A **coordinator** reviews the queue, opens the check-in, sees the drafts and a plain-English "Why" panel, edits, confirms or rejects. An **investigator** is the only role that can set causality (`AEREL`) and seriousness (`AESER`). Nothing leaves the system without a human click.
5. Everything is written to an **append-only, hash-chained audit log** that can be verified with one call.
6. A coordinator can also **ingest a clinician chart note** (clinic note, phone note, outside ED record). A deterministic scanner (regular expressions with NegEx-style exclusion, ported from Omer Khawar's AE Capture Desk) drafts AE and CM entries whose evidence is the exact quoted words with character offsets, links them to the same participant's open AEs from kiosk check-ins, and starts the SAE clock at the moment of ingestion when the note mentions a hospitalization or ER visit. The kiosk's own free-text field is still never parsed.

Three things make Interim different from a check-in form:

- **Objective context attached to a subjective report.** "Shortness of breath, moderate" arrives with breathing rate 26/min captured at that second, with provenance. Vitals never change a grade; they can raise the escalation tier by at most one step, and only under documented conditions.
- **Rules, not prompts.** Every clinical number lives in a JSON table with a `source` and a `rationale` under `packages/rules/data/`. Change an input and the output changes the same way every time. An evaluation harness proves it.
- **Evidence and audit by construction.** 100% of drafted fields carry evidence pointers; every event is hash-chained; edits create versions and never overwrite.

Interim is a research data-capture tool. **It is not a medical device and does not provide medical advice.** That sentence is a persistent footer on every screen.

---

## 2. Problem

### 2.1 Symptomatic AEs are under-detected when clinicians report them

NCI's position is explicit: the standard approach, in which investigators report symptoms, under-detects symptomatic adverse events. That is why NCI built **PRO-CTCAE**, a library of **124 items representing 78 symptomatic toxicities** drawn from CTCAE that patients can report themselves, characterizing frequency, severity, interference and presence/absence ([NCI PRO-CTCAE measurement system](https://healthcaredelivery.cancer.gov/pro-ctcae/measurement.html); development paper: Basch E, et al. *J Natl Cancer Inst* 2014;106(9):dju244, [doi:10.1093/jnci/dju244](https://doi.org/10.1093/jnci/dju244), [PubMed 25265940](https://pubmed.ncbi.nlm.nih.gov/25265940/)).

The size of the gap has been measured. In three randomized trials (1,090 patients, 2,482 cycles), for patients who reported a toxicity of any severity, **under-reporting by physicians ranged from 40.7% to 74.4%**; even for patients reporting "very much" toxicity, physicians missed 13.0% to 50.0% (Di Maio M, et al. *J Clin Oncol* 2015;33(8):910–915, [doi:10.1200/JCO.2014.57.9334](https://doi.org/10.1200/JCO.2014.57.9334), [PubMed 25624439](https://pubmed.ncbi.nlm.nih.gov/25624439/)).

### 2.2 The between-visit gap

The demo study is a real, completed Regeneron Phase 3 record pulled live from ClinicalTrials.gov: **NCT03088540** (sponsor study id `R2810-ONC-1624`), cemiplimab (REGN2810, anti-PD-1) versus platinum-based chemotherapy in first-line advanced or metastatic PD-L1+ non-small cell lung cancer, known in the literature as EMPOWER-Lung 1 ([clinicaltrials.gov/study/NCT03088540](https://clinicaltrials.gov/study/NCT03088540)). Cemiplimab (LIBTAYO) is dosed **350 mg every 3 weeks** per its label, and the label's most common adverse reactions (≥15%) are fatigue, musculoskeletal pain, rash, diarrhea and anemia; its warnings concern severe and fatal immune-mediated adverse reactions such as pneumonitis and colitis ([openFDA drug label API, LIBTAYO](https://api.fda.gov/drug/label.json?search=openfda.brand_name:LIBTAYO&limit=1)). On a three-weekly schedule, a symptom that begins the day after an infusion can be **up to 21 days old** before anyone asks about it, and PRO-CTCAE's own recall window is 7 days. Immune-related AEs (irAEs) on PD-1 inhibitors are exactly the events for which early awareness changes management.

### 2.3 Retyping and the clocks

Today a research nurse asks at visits, reads charts for new problems, and enters AEs and con-meds into the EDC by hand (Regeneron starter sheet, `site-sheet-08-how-are-you-feeling.md`, §5). Serious AEs have strict clocks: ICH E2A defines seriousness (death, life-threatening, hospitalization or prolongation, persistent or significant disability, congenital anomaly, other medically important event; [ICH E2A, October 1994](https://database.ich.org/sites/default/files/E2A_Guideline.pdf)); the sponsor must file IND safety reports within **15 calendar days**, or **7 calendar days** for unexpected fatal or life-threatening suspected adverse reactions ([21 CFR 312.32](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-D/part-312/subpart-B/section-312.32)). Those sponsor clocks start from awareness, and the site's own obligation to the sponsor is typically 24 hours from site awareness. **The moment the site becomes aware is therefore a data point worth capturing precisely.**

### 2.4 What the Regeneron sheet asks for, and our angle

The sheet's mission: *"Build an AE and concomitant-medication capture agent that runs structured symptom check-ins (by voice or text) between visits, scans new chart notes for possible AEs and medication changes, and delivers a reviewed, structured summary to the research team."* It cites the Mass General Brigham irAE-Agent deployment field guide (Gallifant J, et al. *A Field Guide to Deploying AI Agents in Clinical Practice*, [arXiv:2509.26153](https://arxiv.org/abs/2509.26153)).

Our angle, which the sheet did not anticipate: treat **contactless vitals as eSource**, per FDA's *Electronic Source Data in Clinical Investigations* guidance (September 2013; CDER/CDRH/CBER; [fda.gov](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/electronic-source-data-clinical-investigations)), which asks for identified data originators, data element identifiers and examinable audit trails. Interim does all three for every vitals sample.

We first cut the chart-note scanner, on the assumption that it would require an LLM and we wanted every output to be reproducible from a table. A teammate's repository proved the assumption wrong: Omer Khawar's AE Capture Desk (`omer-khawar/ae-checkin-agent`, MIT) scans notes with a regex lexicon and NegEx-style context rules (after Chapman et al. 2001) and reproduces its own answer key exactly. We ported it into the rules package with its lexicons moved into JSON tables (`docs/DECISIONS.md` D-014), so the sheet's Better tier ships **without** giving up determinism (§6). The Regeneron judges also recommended **Synthea** for synthetic EHR data; a reproducible Synthea NSCLC cohort now supplies participant baselines (age, sex, stage, comorbidities, active medications, resting pulse and breathing) and an independent test of the scanner on notes it was never tuned on (FR-32).

---

## 3. Users and roles

| Role | Where | What they do in Interim | What they never do |
|---|---|---|---|
| **Participant** | Kiosk (`/kiosk`) | Identifies with a study label (e.g. `P-007`), consents (or declines) to camera capture for this session, answers 10 items + 3 gate questions one screen at a time, sees a thank-you or the fixed Tier 3 stop screen. | Never sees grades, tiers, rules or clinical language. Never receives medical advice beyond the fixed stop-screen text. |
| **Research nurse / coordinator** | Dashboard (`/dashboard`) | Works the queue, opens check-ins, inspects drafts and evidence, edits, confirms or rejects drafts, acknowledges escalations, exports confirmed records, posts to the mock EDC. Ingests chart notes on the Notes page (`/dashboard/notes`) or dry-runs a scan without storing anything. | Cannot set `AEREL` / `AESER`. |
| **Investigator** | Dashboard (elevated) | Everything the coordinator can read, plus the only role that can set causality (`AEREL`) and final seriousness (`AESER`), which stops the SAE clock; can also record a seriousness decision directly on a clock that has no AE draft (a note that mentions only an admission; `PATCH /sae-clocks/{id}/stop`, documented in `apps/api/README.md`). Sees the public LIBTAYO label excerpt as reference safety information. | Everything else read-only in v1 (the Notes page offers an investigator the dry-run scan only). **Known gap:** that ingestion restriction is enforced by the web UI only; `POST /api/v1/notes` currently accepts an investigator token too (`require_role("coordinator", "investigator", "admin")` in `apps/api/interim_api/routers/notes.py`). The API owner decides whether to narrow it to coordinator/admin, which `CLAUDE.md` §3.1 favors. |
| **Admin / developer** | Hidden route (`/admin`) | Picks the mock scenario, toggles "treat simulated as measured" (default OFF, with warning), resets demo data, runs the evaluation, may backdate seeded notes and sessions. The vitals source (`mock` / `presage` / `arduino`) is chosen when the bridge starts; the admin setting records the intended source and warns on a mismatch (D-020). | Does not confirm clinical drafts in the demo narrative (can, technically, for seeding). |
| **Data manager** (downstream consumer) | Exports | Loads `AE.csv/json`, `VS.csv/json`, `VS_samples.csv`, `CM.csv/json` and the `bundle.zip` manifest into the study's SDTM pipeline. | No system login in v1; consumes files. |
| **Sponsor safety** (downstream consumer) | Exports, SAE clock view | Reads `site_awareness_at`, `due_at` and the informational 7/15-day deadlines; relies on the audit chain. | No system login in v1. |
| **Vitals bridge** (system actor) | Kiosk machine | The only process that touches the camera. Posts derived metrics only; frames never leave it. Audit actor `vitals-bridge`, role `system`. With the Presage source selected, the vendor SDK also contacts Presage's servers for API-key validation and credit metering (telemetry switched off). | Never stores frames; never computes grades. |
| **Chart-note author** (outside the system) | Clinic, triage line, outside ED | Writes the notes a coordinator ingests. Interim stores the text verbatim with `author` and `note_type` as typed. | Never logs in; never sees drafts. |

Demo authentication: three seeded users (`coordinator`, `investigator`, `admin`) share `DEMO_PASSWORD` from `.env`. Roles are enforced server-side on every mutating dashboard endpoint (`docs/CONTRACTS.md` §2), with one known exception: chart-note ingestion is limited to coordinator/admin in the web UI, while the API also accepts an investigator (see the Investigator row above). This is a demo auth model; §11 lists what production adds.

---

## 4. User stories

Each story references the requirement(s) in §5 that satisfy it.

**Participant**

- **US-01** As a trial participant, I want to answer a short check-in on a kiosk between visits in plain language, one question per screen with large buttons, so that the study team hears about my symptoms while I still remember them. (FR-01, FR-20)
- **US-02** As a participant, I want to be asked explicitly before the camera is used, and to be able to say No and still finish the check-in, so that I stay in control of my data. (FR-03, FR-04)
- **US-03** As a participant, I want to know what happens next after I finish, and if something is urgent I want to be told plainly to call 911 or go to an emergency room, so that I am never left guessing. (FR-10, FR-20)

**Research nurse / coordinator**

- **US-04** As a research nurse, I want a queue sorted by urgency with tier chips and SAE countdowns, so that I call the right participant first. (FR-16)
- **US-05** As a research nurse, I want a provisional CTCAE grade computed only from the participant's answers, labeled "provisional, investigator to confirm", so that I do not re-derive it by hand and nobody mistakes it for a clinical judgment. (FR-06, FR-07)
- **US-06** As a research nurse, I want AE, VS and CM entries drafted with SDTM variable names, so that I confirm instead of retype. (FR-13)
- **US-07** As a research nurse, I want to click any drafted field and see exactly which answer, vitals sample, rule or table produced it, with timestamps, so that I can defend the entry during monitoring. (FR-13, FR-17)
- **US-08** As a research nurse, I want to edit a draft without destroying the original, so that the audit trail shows what changed, by whom and when. (FR-15, FR-17)
- **US-09** As a research nurse, I want urgent check-ins to page the on-call role and to record who acknowledged and when, so that no urgent symptom sits unnoticed. (FR-10, FR-18)
- **US-10** As a research nurse, I want the participant's pulse and breathing rate at the moment of the report, clearly labeled measured or simulated, so that "shortness of breath, moderate" arrives with objective context. (FR-04, FR-05, FR-09)
- **US-11** As a research nurse, I want a symptom reported again within a week to attach to the existing open AE as a follow-up, so that the AE log is not full of duplicates. (FR-12)
- **US-12** As a research nurse, I want the participant's verbatim medication text kept as typed, with a suggested normalized name and a confidence, so that I code faster but never lose what was said. (FR-11)

**Investigator**

- **US-13** As an investigator, I want to be the only role that can set causality (`AEREL`) and seriousness (`AESER`), so that the regulatory responsibility stays with me and is recorded under my role. (FR-14)
- **US-14** As an investigator, I want the public LIBTAYO label's adverse-reactions text beside the attribution controls, so that reference safety information is at hand without leaving the page. (FR-14, FR-23)
- **US-15** As an investigator, I want a 24-hour SAE clock to start the instant the site becomes aware of a hospitalization, with a live countdown that stops only when I record a seriousness decision, so that the site meets its reporting obligation. (FR-10a, FR-14)

**Site admin / developer**

- **US-16** As a site admin, I want to switch the vitals source and mock scenario, toggle the demo-only "simulated as measured" setting with a warning, and reset demo data without touching code, so that I can rehearse and demo reliably. (FR-21)
- **US-17** As a developer, I want the vitals adapter to be a single-file plugin with a working mock and documented stubs, so that integrating the real camera SDK later touches one file. (FR-02; delivered: the Presage source was a one-file implementation plus its mapping module, not yet run live.)

**Data manager**

- **US-18** As a data manager, I want confirmed records exported per domain as CSV and JSON with SDTM column names, plus a bundle with a manifest of SHA-256 checksums and an audit excerpt, so that I can load them into the study's SDTM pipeline and prove integrity. (FR-19)
- **US-19** As a data manager, I want every simulated value labeled as simulated in every export (`VSMETHOD`, `INTERIM_SOURCE`), so that no synthetic number is ever mistaken for source data. (FR-09, FR-19)

**Sponsor safety**

- **US-20** As a sponsor safety physician, I want the site-awareness timestamp and the informational 7/15-day downstream deadlines computed from it, so that expedited reporting timelines have a documented origin. (FR-10a)
- **US-21** As a sponsor quality lead, I want an append-only, hash-chained audit trail that I can verify with one call and that names the first broken link if any, so that the record meets ALCOA+ expectations. (FR-17)

**Monitor / QA**

- **US-22** As a clinical research associate, I want to re-run the evaluation set and see agreement with the answer key, then change one input and watch the output change, so that I can trust the logic is deterministic and explainable. (FR-22)

**Chart notes (wave 2, `/notes`)**

- **US-23** As a research nurse, I want to paste a new chart note (clinic note, phone note, outside ED record) for a participant and get draft AE and CM entries, with the exact words that produced each one highlighted in the note, so that I confirm instead of re-reading and retyping. (FR-28)
- **US-24** As a research nurse, I want to see which mentions the scanner skipped and why ("'Denies' precedes 'fever'", "history", "instruction, not a report"), so that I can check its reading before I trust it. (FR-28)
- **US-25** As a research nurse, I want a symptom found in a chart note to attach to the participant's open AE from a kiosk check-in (and a later kiosk report to attach to an AE a note opened), within the same 7-day window, so that one episode is one AE regardless of where we heard about it. (FR-29)
- **US-26** As an investigator, I want the 24-hour SAE clock to start at the moment the site ingests a note that mentions a hospitalization or ER visit, because that is when the site became aware, and I want to be able to record a seriousness decision even if the note produced no AE draft. (FR-30)
- **US-27** As a research nurse, I want to dry-run a scan of any text without storing it or creating drafts, and I want a second paste of the same note refused rather than drafted twice, so that trying the tool never pollutes the record. (FR-28)
- **US-28** As a monitor, I want the chart-note scanner scored against its own answer key on every eval run **and** against an independent synthetic EHR it was not tuned on, with its misses listed by example, so that I know where to trust it and where to read the note myself. (FR-31, FR-32)

---

## 5. Functional requirements

Each row maps to the section of `CLAUDE.md` that specifies it, the location in the repository that implements it, and how it is verified.

| ID | Requirement | `CLAUDE.md` | Implemented in | Verified by |
|---|---|---|---|---|
| FR-01 | Fixed 10-item instrument modeled on PRO-CTCAE (`shortness_of_breath`, `cough`, `fatigue`, `nausea`, `diarrhea`, `rash`, `itching`, `joint_pain`, `fever_or_chills`, `mouth_sores`), attributes frequency / severity / interference / presence on 0–4 (presence 0/1) scales, recall "in the last 7 days"; plus 3 gate questions (hospitalization/ER, medication started/stopped with verbatim text, free text never parsed). | §3.2 | `packages/rules/data/proctcae_items.json`, `packages/rules/data/gate_questions.json`; served by `GET /api/v1/items` | `packages/rules/tests`; `apps/api` integration tests |
| FR-02 | Vitals adapter contract (`VitalsSource`, `VitalsSample`) with a fully working `mock` source (scenarios `resting`, `post_exercise`, `tachypnea`, `low_quality`, `dropout`); a **Presage SmartSpectra** source implemented against the vendor Node SDK, loaded dynamically and kept out of `package.json` (`npm run install:presage`), **not yet tested against a live camera**; a documented fail-fast stub for `arduino`. | §7; CONTRACTS R2.5; D-016 | `apps/vitals-bridge/src/sources/{types,mock,presage,presageMap,arduino,index}.ts`; `docs/VITALS_SOURCES.md` | `apps/vitals-bridge` tests (Presage mapping against SDK-shaped fixtures and a fake SDK); `--source presage` without the SDK or key exits 2 with the install / switch-to-mock hint; live checklist in `docs/VITALS_SOURCES.md` §5 pending |
| FR-03 | Camera consent is an explicit Yes/No on the first screen of every session; No continues without vitals; consent is an audited event (`session.consent`). (D-026 removes the per-session screen in R3 in favor of enrollment consent; pending.) | §3.3 | `apps/web/src/` kiosk flow; `POST /api/v1/sessions {consent_camera}` | API integration tests |
| FR-04 | Timing gates regardless of source: pulse published only after ≥12 s, breathing after ≥30 s, HRV after ≥60 s of continuous collection; confidence threshold `VITALS_MIN_CONF=0.6`; "collecting…" shown before. | §3.3, §7.1 | `apps/vitals-bridge/src/gate.ts`; kiosk vitals panel | bridge unit tests |
| FR-05 | Every vitals sample persisted with source, `is_measured`, confidences, window, UTC timestamp, quality flags; raw series never averaged away; summaries derived separately. | §3.3 | `POST /api/v1/sessions/{id}/vitals`; `VitalsSample` table | API tests; `VS_samples.csv` in bundle |
| FR-06 | PRO composite score per item (Basch 2021 composite grading algorithm) stored as data, not code. | §3.4(a) | `packages/rules/data/composite_scoring.json`; `packages/rules/interim_rules/scoring.py` | property tests (monotonicity) |
| FR-07 | Provisional CTCAE grade from composite via a documented table; grades 4–5 never assigned; grade comes only from answers. | §3.4(b) | `packages/rules/data/composite_to_grade.json`; `packages/rules/interim_rules/grading.py` | tests: vitals never change grade |
| FR-08 | Red flags bypass grading and set a tier floor: severe/very severe dyspnea (floor 3), hospitalization/ER (floor 3, seriousness), fever/chills with any severe item (floor 2), non-empty free text with any severe item (floor 2, "human read"). | §3.4(c) | `packages/rules/data/red_flags.json`; `packages/rules/interim_rules/red_flags.py` | tests |
| FR-09 | Vitals corroboration: never changes grade; raises tier by at most one step; only when measured (or demo toggle ON), confidence ≥ threshold, window valid, status `ok`; three rules (dyspnea + breathing ≥24; dyspnea + pulse ≥110; fever + pulse ≥110); implausible values (pulse <35 or >180, breathing <5 or >45) flagged and ignored with a logged reason. Session maximum of eligible values is used. | §3.4(d) | `packages/rules/data/vitals_corroboration.json`; `packages/rules/interim_rules/{vitals,corroboration}.py` | tests: implausible never fires; tier ≤ 3 |
| FR-10 | Escalation ladder 0–3 (Log / Review within 1 business day / Nurse call today / Urgent). Tier 3 stops the kiosk with the fixed, pre-approved text and pages the on-call role (mock pager event + dashboard toast). | §3.4(e) | `packages/rules/data/escalation_ladder.json`; `packages/rules/interim_rules/escalation.py`; `POST /sessions/{id}/complete`; `GET /pages` | tests; eval personas |
| FR-10a | Seriousness and SAE clock: hospitalization/ER = yes → `seriousness_suspected`, `site_awareness_at = now`, `due_at = +24h`; live countdown; stops only on an investigator seriousness decision; sponsor 7/15-day clocks shown as informational only. | §3.4(f) | `packages/rules/data/seriousness.json`; `packages/rules/interim_rules/seriousness.py`; `SAEClock` table; `GET /sae-clocks` | tests; eval `sae_clock_correct` |
| FR-11 | Con-med capture: verbatim text stored as-is; deterministic matcher (exact → case-insensitive → Levenshtein ≤ 2) against a bundled list of 300 brand and generic names (59 hand-curated core entries plus the most frequent openFDA label names; `CLAUDE.md` asked for ~200 and the openFDA build grew it) labeled "not RxNorm"; unmatched stays verbatim and is flagged. | §3.4(g) | `packages/rules/data/medlist.json`; `packages/rules/interim_rules/conmed.py`; `scripts/fetch_public.py --build-medlist` | tests; eval `conmed_correct` |
| FR-12 | De-duplication: same `AEDECOD` for the same participant within 7 days of an open AE → follow-up linked to the existing AE (no new AE); link shown in the UI. | §3.4(h) | `packages/rules/data/dedup.json`; `packages/rules/interim_rules/dedup.py`; `AEOpen` table | tests; eval `dedup_correct` |
| FR-13 | SDTM-shaped drafts: AE (one per symptom with grade ≥1), VS (one summary row per metric; per-sample on request), CM (one per medication change), with SDTM variable names and an `evidence[]` on **every** field. | §3.5 | `packages/rules/interim_rules/drafting.py`; `Draft` table | test: every `DraftField` has ≥1 `Evidence` |
| FR-14 | Investigator-only attribution: `PATCH /drafts/{id}/attribution {AEREL, AESER}`; setting `AESER` stops the SAE clock; public label excerpt shown beside the controls. | §3.1, §3.5 | `apps/api`; `GET /reference/label` | API role tests (403 for coordinator) |
| FR-15 | Edits never overwrite: `PATCH /drafts/{id}` creates a new version with `supersedes_id`; previous row becomes `superseded`; every edit/confirm/reject is an audit event. | §3.6, §5 | `apps/api` drafts service | API tests |
| FR-16 | Dashboard Queue sorted tier desc then time, with tier chips, SAE countdown chips, measured/simulated badges, participant filter; pagination on all lists. | §3.7(1), §5 | `GET /api/v1/queue`; `apps/web/src/` | web tests |
| FR-17 | Audit trail (ALCOA+): append-only `AuditEvent` with `hash = sha256(prev_hash + canonical_json(event))`; genesis `prev_hash = "0"*64`; `GET /audit/verify` walks the chain and reports the first broken link; dashboard Audit page with a green "verified" badge. | §3.6 | `apps/api` audit service; `apps/web` Audit page | API test tampers a row and expects `ok=false` |
| FR-18 | Escalations page: every tier ≥2 event with acknowledged-by/at and seconds-to-acknowledge; `POST /escalations/{id}/ack`. | §3.7(4) | `Escalation` table; `apps/web` | API tests |
| FR-19 | Exports: `GET /export/{AE,VS,CM}.csv\|.json`, `GET /export/bundle.zip` (manifest with SHA-256 per file, `audit_head_hash`, `interim_version`, audit excerpt), `POST /mock-edc/{domain}` returning an `ack_id`; every export is an audit event; every row carries `INTERIM_SOURCE` / `VSMETHOD` labeling. | §3.5 | `apps/api` export service | API tests verify manifest hashes |
| FR-20 | Kiosk UX: large type, one question per screen, big tap targets, progress bar, calm light palette, no jargon, small vitals card (not the hero), persistent not-a-medical-device footer. | §3.8 | `apps/web/src/` kiosk routes | manual + `docs/DEMO.md` rehearsal |
| FR-21 | Admin panel at `/admin`: vitals source, mock scenario, "treat simulated as measured" (default OFF, warning shown), demo reset; all settings changes audited. | §3.7(7) | `GET/PUT /admin/settings`, `POST /admin/reset` | API role tests |
| FR-22 | Evaluation harness: 24 scripted personas + 5 hidden judge personas with an answer key (`personas.json` also holds 7 `protocol` personas added with the R3 rules, 36 in all; one of them needs the R3 API's `protocol_context` input and is reported as not replayable over HTTP until then); `scripts/run_eval.py` replays them through the real API and writes `docs/eval/results.md` (per-tier precision/recall/F1, grade confusion matrix, dedup and SAE-clock correctness, mismatches, and the chart-note scanner section of FR-31); Eval page runs them with one click and offers a build-your-own persona form. | §8 | `packages/rules/data/personas.json`; `scripts/run_eval.py`; `POST /eval/run`, `POST /eval/run-custom` | `make eval` must report 100% (personas and scanner) |
| FR-23 | Public data at seed time only, cached and committed: ClinicalTrials.gov v2 record for `NCT03088540` (fallback `NCT02760498`, then a sponsor/intervention search), openFDA LIBTAYO label adverse-reactions excerpt, CTCAE v5.0 term names and grade definitions for the 10 items, SDTM IG variable names. Shown as "Demo study (public registry record)" and "all participants are synthetic". | §9 | `scripts/fetch_public.py` (with `--offline`); `data/public/`; `packages/rules/data/ctcae_terms.json` | `GET /study`, `GET /reference/*` |
| FR-24 | Synthetic cohort: 12 participants `P-001…P-012`, each with 2–4 prior check-ins over the last 60 days (34 in all), plus 8 synthetic chart notes for P-001…P-006, seeded through the service layer so every fact is audited and drafted like a live check-in or ingestion; deterministic RNG; 42 queue rows after seed. | §9, CONTRACTS §5, R2.4 | `scripts/seed.py` → `apps/api/interim_api/seed.py`; `data/synthetic/README.md`; `data/synthetic/chart_notes.json` | `make seed` idempotent; queue populated |
| FR-25 | Measured vs simulated labeling everywhere a vitals value appears: kiosk panel badge, dashboard badges, `VSMETHOD` ("Contactless optical, camera-based" vs "Simulated"), `INTERIM_SOURCE`, `INTERIM_IS_MEASURED`. | §0, §13 | bridge, web, rules drafting, exports | tests on drafting + exports |
| FR-26 | No LLM or generative AI call anywhere at runtime (the chart-note scanner included: regular expressions and tables only); no network calls at runtime except our own mock-EDC endpoint and, only when the Presage source is selected, the vendor SDK's own key validation and credit metering from the bridge; no analytics or third-party scripts. | §0, §13 | repository-wide | CI dependency review; `grep` |
| FR-27 | Errors are RFC 7807 `application/problem+json`; IDs are ULIDs; timestamps are UTC ISO-8601 with `Z`, displayed in local time with UTC on hover. | §4.2, CONTRACTS | `apps/api`, `apps/web` | API tests |
| FR-28 | Chart-note ingestion and dry-run scan. `POST /notes` stores the note verbatim and drafts one AE per kept symptom finding (`AETERM` = quoted words, `AEDECOD` = CTCAE v5 term, `AETOXGR` = grade hint ≤ 3 with `INTERIM_GRADE_BASIS`, `AESTDTC` from a stated onset else the note date) and one CM per kept medication finding (`CMDECOD` from a 43-drug lexicon, `INTERIM_MATCH_KIND = "lexicon"`); every pointer is `{kind: "chart_note", id, ts, note: quote, span_start, span_end}`; negated / historical / hypothetical mentions and allergy listings are returned as skipped with a reason; identical re-posts are refused (409). `POST /scan` stores nothing. Notes page highlights the spans. | Regeneron sheet BETTER; CONTRACTS R2.4; D-014 | `packages/rules/interim_rules/chartscan.py`; `packages/rules/data/chartscan_lexicon.json`, `chartscan_red_flags.json`; `apps/api/interim_api/services/notes.py`; `apps/web/src/pages/dashboard/Notes.tsx`, `NoteDetail.tsx` | `packages/rules/tests/test_chartscan.py`; `apps/api/tests/test_notes.py`; web tests |
| FR-29 | Cross-source de-duplication: a note symptom whose `AEDECOD` matches an open AE of the same participant (from a check-in or an earlier note) within the 7-day window is a follow-up, not a new AE; a later kiosk report links to an AE a note opened; the link is shown in the UI. | §3.4(h); R2.4 | `packages/rules/data/dedup.json`; `apps/api/interim_api/services/notes.py`, `services/checkins.py` | `test_notes.py`; seed notes N2 and N7 link as follow-ups; eval checks N7 → N1 |
| FR-30 | Note escalation and seriousness: an urgent or emergency red flag, or a hospitalization/ER mention, gives the note **Tier 2** (never Tier 3, never a page or stop screen: D-017); a hospitalization/ER mention also sets `seriousness_suspected` and starts the SAE clock with `site_awareness_at = ingested_at`. An investigator can stop a clock that has no AE draft directly (`PATCH /sae-clocks/{id}/stop`). | §3.4(e)(f); R2.4; D-017 | `chartscan_red_flags.json`; `services/notes.py`; `routers/dashboard.py` | `test_notes.py`; answer-key escalation and possible-SAE recall |
| FR-31 | Scanner answer key in every eval run: 39 cases (8 notes + 31 utterances: the 25 from the source repository plus 14 added after review). Pass = AE terms P = R = 1.00 (38/38), medications P = R = 1.00 (17/17), every urgent-or-emergency case escalated (14/14), every possible-SAE cue caught (3/3), 0 over-escalations. | §8; R2.4 | `packages/rules/data/chartscan_answer_key.json` (notes identical to `data/synthetic/chart_notes.json`); `chartscan.evaluate_answer_key()`; `POST /eval/run` | `test_chartscan.py`; `make eval` |
| FR-32 | Synthea cohort and independent evaluation: 12 de-identified Synthea NSCLC patients (`P-001…P-012`) with baselines and 72 notes whose ground truth comes from Synthea's structured FHIR record, regenerable from a pinned jar and seed; the scanner and the con-med matcher are scored on them, unchanged, and the report is byte-reproducible. Seeding kiosk participants from these baselines is open (`docs/ISSUES.md` #23). | §9; judges' recommendation | `scripts/synthea/{run_synthea,import_synthea,eval_synthea}.py`; `data/synthetic/synthea/`; `docs/eval/synthea_results.md` | `scripts/tests/test_synthea_import.py`, `test_synthea_eval.py`; `eval_synthea.py --check` |

---

## 6. Mapping to Regeneron's Good / Better / Best

The starter sheet (`site-sheet-08-how-are-you-feeling.md`, §8) defines three tiers. What we shipped, and what we deliberately did not. (In wave 1 the Better tier's note scanning was marked "No, deliberately"; it shipped in wave 2, deterministically, from a teammate's port: `docs/NOT_BUILT.md` S1.)

| Sheet requirement | Tier | Shipped? | Where | Notes |
|---|---|---|---|---|
| Voice **or text** check-in with a small PRO-CTCAE-style item set | GOOD | **Yes (text, kiosk)** | FR-01, FR-20 | Voice deliberately not built: TCPA / automation-disclosure rules and the speech stack would push us toward an LLM. See `docs/NOT_BUILT.md` §1. |
| Structured answers | GOOD | **Yes** | FR-01, `Answer` table | Each attribute answer is its own timestamped, audited row. |
| Provisional grade | GOOD | **Yes** | FR-06, FR-07 | Composite per Basch 2021, then a documented composite→grade table; labeled provisional. |
| Urgent escalation | GOOD | **Yes** | FR-08, FR-10 | Four-tier ladder, red flags, fixed stop screen, mock pager. |
| Scan new synthetic notes and med lists for AEs and con-med changes | BETTER | **Yes, deterministically** | FR-28, FR-30 | Regex lexicon + NegEx-style exclusion, no LLM, ported from Omer Khawar's AE Capture Desk with credit. Medications are found where the note text names them with an action ("started loperamide", "holding lisinopril"); a structured med-list feed and section-aware list parsing are not built (`docs/NOT_BUILT.md` §8, §18). The kiosk's free-text field is still never parsed. |
| Merge chart findings with check-in data | BETTER | **Yes** | FR-29 | Cross-source dedup on `AEDECOD` within 7 days, in both directions; the queue and timeline show notes next to check-ins. |
| Evidence for each flag | BETTER | **Yes, for every field** | FR-13, FR-17, FR-28 | Evidence pointers on 100% of drafted fields, not only on flags; note evidence carries character offsets into the stored note, so the UI highlights the exact words. |
| Precision / recall against an answer key | BETTER | **Yes, three ways** | FR-22, FR-31, FR-32 | Check-in personas (per-tier P/R/F1, grade confusion matrix); the scanner's 39-case answer key (AE terms 38/38, meds 17/17, 0 over-escalations); and an independent Synthea evaluation the scanner was not tuned on (symptoms P 0.919 / R 0.792; medications P 1.000 / R 0.178 of those visible in text; `docs/eval/synthea_results.md`). |
| Draft EDC AE and con-med entries for coordinator confirmation | BEST | **Yes** | FR-13, FR-15, FR-28 | SDTM-shaped AE/VS/CM drafts from check-ins and AE/CM drafts from notes; confirm / edit (versioned) / reject; mock EDC endpoint. |
| De-duplication across sources | BEST | **Yes, check-ins and chart notes** | FR-12, FR-29 | 7-day window on `AEDECOD`; link shown in the UI. |
| SAE clock that starts when the site becomes aware | BEST | **Yes, from the kiosk and from note ingestion** | FR-10a, FR-30 | 24 h site clock with countdown; for a note, `site_awareness_at` is the ingestion time; 7/15-day sponsor clocks informational. |
| Multilingual voice | BEST | **No** | `docs/NOT_BUILT.md` §1–2 | NCI offers PRO-CTCAE in 60+ validated languages; our hand-written items would not be validated translations. |
| Investigator review screen for attribution | BEST | **Yes** | FR-14 | `AEREL` / `AESER` investigator-only; public label excerpt as reference. |
| *(not on the sheet)* Contactless vitals as eSource | — | **Yes (mock source in the demo; Presage source implemented, live test pending)** | FR-02, FR-04, FR-05, FR-09, FR-25 | The differentiator. Mock emits labeled simulated signals; `apps/vitals-bridge/src/sources/presage.ts` drives the SmartSpectra SDK (groundwork verified by Omer Khawar) and will label its samples MEASURED once run; the first live test is budgeted at about three minutes of capture. |
| *(judges' recommendation)* Synthea synthetic EHR | — | **Yes** | FR-32 | 12 NSCLC patients and 72 notes, de-identified and reproducible; no immunotherapy in Synthea, so no PD-1 patients (`docs/NOT_BUILT.md` §17). |

---

## 7. Non-goals

- **Not a medical device and not clinical decision support.** No diagnosis, no treatment advice, no grade above 3, no automatic seriousness or causality. The investigator decides seriousness and attribution (sheet §10).
- **No LLM and no statistical NLP.** Chart notes are read only by a regular-expression lexicon with NegEx-style context rules whose every pattern is a table entry; con-med text only by string distance. The kiosk's "anything else" field is stored verbatim, never parsed, and flagged for a human read only.
- **No voice, no telephony, no SMS/e-mail.** The pager is a mock event and a dashboard toast; chart notes never page.
- **No real EDC, EHR/FHIR, MedDRA or RxNorm integration.** SDTM-shaped exports, mock EDC endpoint, mock MedDRA codes, a bundled drug-name list and a scanner drug lexicon labeled "not RxNorm". Synthea's FHIR output is imported offline at build time; nothing reads FHIR at runtime.
- **No real participants, no PHI.** Synthetic cohort only; camera frames are never stored or transmitted.
- **No production identity.** Demo auth with three seeded users and a shared password.
- **Not personalized medicine.** Corroboration thresholds are fixed population values from a table, not baseline-adjusted (see `docs/WHAT_IT_GETS_WRONG.md` §3).

---

## 8. Success metrics

| # | Metric | Definition (computable from Interim's own data) | Target | Where it is visible |
|---|---|---|---|---|
| M1 | **Time from symptom report to site awareness** | `Session.completed_at` (record enters the queue) minus the participant's report time; the counterfactual is "the next visit", up to 21 days on a q3w schedule. | Same-minute awareness for every completed check-in | Queue (`completed_at`), participant timeline |
| M2 | **AEs captured per participant-month** | Confirmed, non-follow-up AE drafts ÷ participant-months enrolled, from the `AE.json` export and `Participant.enrolled_at`. | Reported per cohort; the synthetic cohort is the demo baseline | Exports, timeline |
| M3 | **% of drafted fields with evidence** | `DraftField` rows with ≥1 `Evidence` ÷ all `DraftField` rows. | **100%**, enforced by unit and integration tests | Check-in detail (click any field) |
| M4 | **Time-to-acknowledge, tier ≥ 2** | `Escalation.seconds_to_ack` = `acked_at − paged_at`. | 100% acknowledged; demo target under 1 h | Escalations page |
| M5 | **Eval pass rate** | `n_pass ÷ n_personas` in `EvalResults`, replayed through the real API. | **100%** on the shipped 24 and on the 5 hidden judge personas (the R3 protocol personas join when the R3 API work lands) | Eval page; `docs/eval/results.md` |
| M6 | **Audit chain verified** | `GET /audit/verify` → `ok == true`; `audit_head_hash` recorded in every bundle manifest. | `ok` at every export | Audit page |
| M7 | **Retyping avoided** | Confirmed drafts with no preceding `draft.edited` event ÷ confirmed drafts. | Reported; higher is better | Audit log |
| M8 | **Simulated values labeled** | Exported VS rows with `VSMETHOD == "Simulated"` ⇔ `INTERIM_IS_MEASURED == false`. | 100% consistent, tested | Exports |
| M9 | **Time from note to site awareness** | `ChartNote.ingested_at` (drafts and any SAE clock exist from that instant) minus the note's own date; Interim cannot shorten the time before a note reaches the site, only the time after. | Drafts at ingestion, every time | Notes page, queue |
| M10 | **Scanner answer-key pass** | `chartscan.evaluate_answer_key().passed` (FR-31). | **100%** (regression guarantee) | Eval page; `docs/eval/results.md` |
| M11 | **Scanner on independent data** | Symptom and medication precision/recall on Synthea notes (FR-32). | Reported, not targeted; today symptoms P 0.919 / R 0.792, medications P 1.000 / R(text) 0.178, ambulatory over-escalation 55.8% | `docs/eval/synthea_results.md` |

---

## 9. Instrument note: "modeled on PRO-CTCAE"

The 10 items in `packages/rules/data/proctcae_items.json` are **hand-written items modeled on the PRO-CTCAE attribute structure** (frequency / severity / interference / presence, 7-day recall, 0–4 response scales). They are **not** the official NCI items, and the wording is ours. We did this because NCI's Terms of Use make PRO-CTCAE freely available but tie permission to **registering the study and agreeing to the Terms of Use**, and prohibit adapting, altering or modifying item wording without NCI's prior written consent ([PRO-CTCAE Terms of Use](https://healthcaredelivery.cancer.gov/pro-ctcae/terms_of_use.html)). Fetching the library at runtime or shipping modified items would violate that. A **production deployment would register the study with NCI, accept the Terms of Use, and load the official items verbatim** (in any of the 60+ validated languages) via NCI's form builder into the same `proctcae_items.json` schema; the rules engine does not care about wording, only about attributes and values. The composite scoring follows the published algorithm (Basch E, et al. *Clin Trials* 2021;18(1):104–114, [doi:10.1177/1740774520975120](https://doi.org/10.1177/1740774520975120), [PubMed 33258687](https://pubmed.ncbi.nlm.nih.gov/33258687/)); the composite→CTCAE grade crosswalk is our documented approximation and is called out in `docs/WHAT_IT_GETS_WRONG.md` §1. CTCAE v5.0 term names and grade definitions for the 10 items come from NCI EVS ([CTCAE v5.0 files](https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/)).

---

## 10. Privacy and security posture

| Concern | What Interim does | Where |
|---|---|---|
| **No PHI** | All participants are synthetic (`P-001…P-012`); no real names, dates of birth or identifiers. The dashboard header says "all participants are synthetic." The 8 seeded chart notes are hand-written synthetic text. | `scripts/seed.py`, `data/synthetic/README.md`, `GET /study` |
| **Synthea de-identification** | Synthea's fictional patients still carry realistic-looking names, addresses, phone numbers and identifiers. The importer replaces names with the participant label, never copies addresses, identifiers or birth dates, hashes Synthea UUIDs, and does not commit the raw FHIR; a test asserts no source identifier appears in any output or doc. | `scripts/synthea/import_synthea.py`, `scripts/tests/test_synthea_import.py`, `data/synthetic/synthea/README.md` |
| **Chart-note text** | Stored verbatim (it is the source record), never sent anywhere, scanned in-process by tables; derived findings point back into it by character offsets. | `apps/api/interim_api/services/notes.py` |
| **Camera data** | Frames are processed on the kiosk machine by the bridge and **never stored or transmitted**; only derived metrics (pulse, breathing, HRV, confidences, quality flags) leave the bridge. The consent screen says this. | `apps/vitals-bridge`, kiosk consent screen |
| **Explicit consent, every session** | Consent is a Yes/No screen at the start of every session and an audited event; No continues without vitals. (R3, D-026, replaces this with consent at enrollment; pending.) | FR-03 |
| **Role separation** | Participant (no token, kiosk endpoints only), coordinator, investigator, admin, system (bridge). Roles enforced server-side on every mutating endpoint; client-side route gating is a convenience only. Exception: `POST /notes` also accepts an investigator, while the UI offers that role only the dry-run scan (§3, known gap). | `docs/CONTRACTS.md` §2 |
| **Least privilege for the clinical decision** | Only the investigator can set `AEREL` / `AESER`. | FR-14 |
| **Tamper evidence** | Append-only hash-chained audit log; `GET /audit/verify`; bundle manifest carries the head hash and per-file SHA-256. | FR-17, FR-19 |
| **Versioned edits** | Drafts are never overwritten; edits create versions linked by `supersedes_id`. | FR-15 |
| **Configuration by environment** | `.env.example` documents every variable; no secrets in the repo; `AUTH_SECRET`, `DEMO_PASSWORD`, `BRIDGE_TOKEN`, `PRESAGE_API_KEY` come from the environment. | `.env.example` |
| **Bridge authentication** | Optional `X-Bridge-Token` shared secret (`BRIDGE_TOKEN`). | CONTRACTS §2, §3.2 |
| **No telemetry, no third-party scripts** | The web app loads nothing from outside the repo. | FR-26 |
| **Runtime network isolation** | No outbound calls at runtime; public data is fetched at seed time and cached in `data/public/`. One documented exception: when an operator selects the Presage source, the vendor SDK on the kiosk machine validates the API key and meters credits against Presage's servers (telemetry switched off; no frames, no answers, no identifiers). The default mock source and the Docker image make no such call. | FR-23, FR-26, `apps/vitals-bridge/README.md` |
| **Vendor key handling** | `PRESAGE_API_KEY` comes only from the environment, is never logged or committed, and is not needed for `--list-cameras`. | `.env.example`, `docs/VITALS_SOURCES.md` §5 |
| **Demo-only toggles are loud** | "Treat simulated as measured" defaults OFF, shows a warning, is audited (`settings.changed`), and never changes the simulated label in exports. | FR-21, FR-25 |

Regulatory framing (for the reader, not a claim of compliance): the audit design follows ALCOA+ expectations as described in the MHRA GxP data integrity guidance ([gov.uk](https://www.gov.uk/government/publications/guidance-on-gxp-data-integrity)) and the FDA eSource guidance cited in §2.4. Interim does **not** claim 21 CFR Part 11 compliance; §11 lists what that would require.

---

## 11. Deployment readiness

Regeneron's rubric asks how ready the project is to support basic data privacy, security and cloud deployment "from a Git repo via Jenkins on an Argo CI/CD environment."

| Readiness item | Status | Where |
|---|---|---|
| Runs from a clean clone | `docker compose up --build` (api + web + bridge in mock mode) **and** `make dev` / `npm run dev` on Windows | `docker-compose.yml`, `Makefile`, `package.json`, `README.md` |
| Container images | Multi-stage Dockerfiles for `apps/api` (Python 3.12 / uvicorn) and `apps/web` (Vite build served by nginx, proxying `/api/` to the API); bridge image for mock mode only (a container has no webcam and the Presage SDK is never a declared dependency; real sensors run the bridge on the kiosk host) | `apps/*/Dockerfile`, `docker-compose.yml` |
| CI | GitHub Actions on every push and PR: ruff, mypy `--strict` (rules), pytest (rules + api), eslint + `tsc --noEmit` + unit tests (bridge + web), docker build. The same commands run in a Jenkins stage. | `.github/workflows/ci.yml`, `make lint`, `make test` |
| Health and readiness | `GET /api/v1/health` returns status, version, time, vitals source and DB state for liveness/readiness probes | CONTRACTS §2.1 |
| Stateless services, one writer | API is the single DB writer; web is static; bridge is stateless beyond the current session. Horizontal scaling of the API requires Postgres (below). | `CLAUDE.md` §4.1 |
| Database | SQLite in a named volume by default; **Postgres by changing one variable**: `DATABASE_URL=postgresql+psycopg://…` (SQLModel `create_all` at startup; the schema is portable). | `.env.example`, `docs/DECISIONS.md` D-007 |
| Configuration | 12-factor: everything in environment variables; `.env.example` is the single list; no secrets committed. | `.env.example` |
| License | MIT | `LICENSE` |
| Versioning | `INTERIM_VERSION = "0.1.0"` surfaces in `/health`, exports and the bundle manifest. | CONTRACTS §7 |
| Auth today | Demo model: three seeded users, shared `DEMO_PASSWORD`, HMAC-signed bearer tokens, server-side role checks. | CONTRACTS §2 |
| **What SSO / per-user identity would add** | OIDC/SAML login against the site's IdP; per-user `actor_id` in every audit event (today the actor is the role-level seeded user); revocable sessions; MFA; the electronic-signature meaning, manifestation and controls that 21 CFR Part 11 expects ([21 CFR Part 11](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11)) for confirm/attribution actions; password policy and account lifecycle. The audit schema already has `actor_id` and `actor_role` fields, so this is an auth-layer change, not a data-model change. | `docs/NOT_BUILT.md` §4, §13 |
| What a regulated deployment would add beyond auth | Validation package (IQ/OQ/PQ) for the rules tables, the scanner lexicon included; external anchoring of the audit head hash; retention and archival policy; a real EDC connector (`docs/NOT_BUILT.md` §3); official PRO-CTCAE items under NCI terms (§9); a vendor agreement and data-flow review for the Presage SDK's network calls. | — |

---

## 12. Risks and open questions

Tracked in `docs/ISSUES.md`. The two largest product risks are documented head-on in `docs/WHAT_IT_GETS_WRONG.md`: the composite→grade crosswalk is not a validated instrument, and camera-derived vitals are confounded by talking, motion and lighting. Decisions that were left open by `CLAUDE.md` §14 are logged in `docs/DECISIONS.md` (light theme only, per-summary VS export with per-sample on request, SQLite in compose with Postgres by env).

Wave 2 added three risks, each with its own section in `docs/WHAT_IT_GETS_WRONG.md`:

- **The scanner is lexicon-bound** (§15). It finds only the 29 symptom terms and 43 drugs it names, its negation and history windows are word counts, and on Synthea's templated notes a repeated "Chest Pain" complaint flags 55.8% of routine visits. A missing "the" ("seen in ED" vs "seen in the ED") decides whether a note starts the SAE clock. Mitigation: every finding and every skip is shown with its quote and reason, and nothing leaves without a coordinator's click. Issue #24 tracks the over-flagging.
- **The Presage source has not been run live** (§17). It is implemented and unit-tested; the first live test is budgeted at about three minutes of capture on a metered account, following `docs/VITALS_SOURCES.md` §5. Until then the demo uses the mock, labeled SIMULATED. Issue #14.
- **Synthea is the wrong population for the study** (§18): stage 1, chemotherapy, no immunotherapy, templated notes. It is an independent test of the text tools, not a model of the trial. Issues #22 and #23.

---

## 13. References

- NCI PRO-CTCAE: overview and measurement system — https://healthcaredelivery.cancer.gov/pro-ctcae/ and https://healthcaredelivery.cancer.gov/pro-ctcae/measurement.html; Terms of Use — https://healthcaredelivery.cancer.gov/pro-ctcae/terms_of_use.html
- Basch E, Reeve BB, Mitchell SA, et al. Development of the NCI PRO-CTCAE. *J Natl Cancer Inst* 2014;106(9):dju244. https://doi.org/10.1093/jnci/dju244 · https://pubmed.ncbi.nlm.nih.gov/25265940/
- Basch E, Becker C, Rogak LJ, et al. Composite grading algorithm for the NCI PRO-CTCAE. *Clin Trials* 2021;18(1):104–114 (published online December 2020). https://doi.org/10.1177/1740774520975120 · https://pubmed.ncbi.nlm.nih.gov/33258687/
- Di Maio M, Gallo C, Leighl NB, et al. Symptomatic toxicities experienced during anticancer treatment: agreement between patient and physician reporting in three randomized trials. *J Clin Oncol* 2015;33(8):910–915. https://doi.org/10.1200/JCO.2014.57.9334 · https://pubmed.ncbi.nlm.nih.gov/25624439/
- NCI CTCAE v5.0 (November 27, 2017) files — https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/
- FDA. Electronic Source Data in Clinical Investigations: Guidance for Industry. September 2013. https://www.fda.gov/regulatory-information/search-fda-guidance-documents/electronic-source-data-clinical-investigations
- ICH E2A. Clinical Safety Data Management: Definitions and Standards for Expedited Reporting. October 1994. https://database.ich.org/sites/default/files/E2A_Guideline.pdf
- 21 CFR 312.32 IND safety reporting — https://www.ecfr.gov/current/title-21/chapter-I/subchapter-D/part-312/subpart-B/section-312.32
- 21 CFR Part 11 Electronic records; electronic signatures — https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11
- MHRA. GxP Data Integrity Guidance and Definitions (ALCOA+). March 2018. https://www.gov.uk/government/publications/guidance-on-gxp-data-integrity
- Gallifant J, et al. A Field Guide to Deploying AI Agents in Clinical Practice (irAE-Agent, Mass General Brigham). arXiv:2509.26153, 2025. https://arxiv.org/abs/2509.26153
- ClinicalTrials.gov record NCT03088540 (R2810-ONC-1624) — https://clinicaltrials.gov/study/NCT03088540; API v2 — https://clinicaltrials.gov/data-api/api
- openFDA drug label API — https://open.fda.gov/apis/drug/label/ (no key required for low volumes: https://open.fda.gov/apis/authentication/)
- CDISC SDTM Implementation Guide — https://www.cdisc.org/standards/foundational/sdtmig; SDTM/ADaM pilot project — https://github.com/cdisc-org/sdtm-adam-pilot-project
- Presage SmartSpectra SDK (the implemented, not-yet-live-tested source) — https://physiology.presagetech.com and https://smartspectra.presagetech.com/docs/nodejs/
- Chapman WW, Bridewell W, Hanbury P, Cooper GF, Buchanan BG. A simple algorithm for identifying negated findings and diseases in discharge summaries (NegEx). *J Biomed Inform* 2001;34(5):301–310. https://doi.org/10.1006/jbin.2001.1029
- Walonoski J, Kramer M, Nichols J, et al. Synthea: An approach, method, and software mechanism for generating synthetic patients and the synthetic electronic health care record. *J Am Med Inform Assoc* 2018;25(3):230–238. https://doi.org/10.1093/jamia/ocx079 · software: https://github.com/synthetichealth/synthea (© The MITRE Corporation, Apache-2.0)
- Khawar O. *AE Capture Desk* (`omer-khawar/ae-checkin-agent`, MIT): source of the chart-note scanner, its 25-case answer key and the Presage bridge groundwork ported into Interim (D-014)
- Regeneron starter sheet — `site-sheet-08-how-are-you-feeling.md` (in this repository)
