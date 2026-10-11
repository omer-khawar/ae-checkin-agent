# CLAUDE.md — INTERIM: the trial coordinator's safety-data desk

> This file is the complete build brief. Read it fully before writing any code. **Read §00 first: it is a direction update made on 2026-10-10 after mentor feedback, and it overrides anything below that conflicts with it.** Where a decision is left open, make the simplest choice that keeps the demo path bulletproof and write it down in `docs/DECISIONS.md`.

---

## 00. Direction update (2026-10-10, evening) — READ FIRST, OVERRIDES CONFLICTS BELOW

**Why it changed.** A Regeneron mentor reviewed the build. His points: the starter sheet is a guide to a problem area, not the whole scope; "AI wrappers" are fine if they lighten site staff's work; consent is covered by the informed consent form signed at enrollment; most judges are not doctors and will not value clinical depth; Presage is cool but will not work cleanly. Research backs him: about 70% of EDC data is retyped from the EHR, coordinators spend 12–15 h per study per week copying, and SAE reporting carries a 24-hour deadline that eats a coordinator's day. Presage's documented valid pulse range ends at 110 bpm, so the two pulse ≥ 110 corroboration rules can never fire on its real readings.

**New scope.** Interim is the **coordinator's safety-data desk**: it follows each side effect from its first mention to an EDC-ready record and, when required, a sponsor report, and it briefs the investigator before the next visit. Success is measured as **coordinator time removed**, not Good/Better/Best boxes. The life of one side effect at a site:
1. The participant feels something between visits.
2. It is mentioned somewhere: a kiosk check-in, a call, an urgent-care or ER note. *(built: kiosk, chart-note scanner)*
3. The coordinator has to find it. *(built: queue, scanner, dedup)*
4. The coordinator types it into the record and the EDC. *(built: SDTM drafts with evidence)*
5. If it is serious or of special interest, a report and a written narrative are due to the sponsor within 24 hours. *(NEW: §00.2, §00.3)*
6. The investigator decides seriousness and causality. *(built: attribution screen)*
7. Sponsor queries come back and must be answered. *(not in scope this round)*
8. Before the next visit, someone briefs the investigator on everything since the last one. *(NEW: §00.4)*

**What changes in the non-negotiables (§0):**
- **Rules decide, text tools write, people confirm.** Every decision (grade, tier, who is alerted, whether a 24-hour clock starts, whether a medication breaks the protocol) stays in the deterministic rules engine and its JSON tables. Generated *text* (SAE narratives, visit briefs) is allowed, but every sentence must cite evidence ids that resolve, and a person reviews it before it leaves the system.
- **Generated text works with no API key.** The default writer is a deterministic template writer that assembles sentences only from evidence fields. An LLM writer (Anthropic Claude via the official SDK, model ids from the environment, never called unless `ANTHROPIC_API_KEY` is set) can replace it behind the same interface; its output is accepted only if every cited evidence id exists and every quoted string appears verbatim in the cited source, otherwise the system falls back to the template writer and says so. A clean clone with no key must show every feature. There is no key yet (2026-10-10), so the template writer is what ships and what the eval measures.
- **The LLM chart-note reader is deferred** (not this round; superseded 2026-10-11 by CONTRACTS R5.3, an optional Gemini second reader). The deterministic scanner stays the reader; its Synthea numbers stay in `docs/WHAT_IT_GETS_WRONG.md`.
- **Vitals are optional context, not the headline.** Keep the bridge, mock source and Presage source; stop leading with "vitals as eSource" in the UI, README and slides. Vitals still never change a grade.
- **Consent is covered at enrollment.** Remove the per-session camera consent screen from the kiosk; the session records `consent_basis: "enrollment_icf"`. Keep the "no video is stored" sentence on the welcome screen.
- **Speak to non-clinicians first.** Plain-language labels lead ("Side effect: diarrhea, severe (grade 3, provisional)"); SDTM variable names and rule ids stay available one click deeper. Show time saved on screen.

### 00.1 Protocol-aware rules (deterministic, from the real protocol)
Source: EMPOWER-Lung 1 protocol R2810-ONC-1624 Amendment 9 (public on ClinicalTrials.gov, `https://cdn.clinicaltrials.gov/large-docs/40/NCT03088540/Prot_000.pdf`), cached as an excerpt with page numbers and sha256 under `data/public/`. Encode as JSON tables in `packages/rules/data/` with page citations:
- **Adverse events of special interest (§9.4.3, p. 92)** must be reported within 24 hours like SAEs: grade ≥ 2 infusion-related reactions, grade ≥ 2 allergic/hypersensitivity reactions, grade ≥ 3 immune-related AEs, any irAE in a patient previously treated with a PI3K inhibitor. Interim maps its 10 symptoms to "potentially immune-related" (rash, itching, diarrhea/colitis, shortness of breath/pneumonitis, joint pain, fatigue as endocrine signal — keep the mapping as a table with rationale) and starts a **24-hour AESI clock** when a provisional grade ≥ 3 lands on one of them. The clock is labeled "possible AESI, investigator to confirm"; it uses the same SAE-clock machinery with a `kind` field (`sae` | `aesi`).
- **SAE reporting (§9.4.2, p. 91):** all SAEs within 24 hours regardless of causality; follow-up reports for missing information.
- **Prohibited and discouraged concomitant medications (§7.7.1–7.7.2, p. 69):** prohibited = other investigational anti-tumor agents, bevacizumab, necitumumab; discouraged = systemic corticosteroids (hydrocortisone, prednisone, prednisolone, dexamethasone) except life-threatening emergencies or irAE treatment; permitted = bisphosphonates, denosumab, pemetrexed maintenance (non-squamous), palliative radiation. A new con-med matching a prohibited entry raises the tier floor to 2 with reason "possible protocol deviation"; a discouraged one adds a coordinator flag (no tier change) with the protocol's exception text.
- **CM CRF completeness (§7.7, p. 69):** generic name, dose, dose unit, frequency, indication, start/stop date. CM drafts list which of these are still missing so the coordinator knows what to ask.
- **AE reporting window (§9.4.1, p. 91):** all AEs from consent until 90 days after last dose. Informational on the participant header.

### 00.2 Serious-event packet (SAE / AESI)
One click on an SAE or AESI clock opens a **packet**: the report fields pre-filled from evidence (event term, onset, seriousness criteria suspected, provisional grade, relevant con-meds, study drug, last dose if known, outcome unknown, reporter, site awareness time, deadline), each field with its evidence pointers, a list of **missing information** to chase, and a **draft narrative** (template writer by default). The investigator edits, then signs; signing is an audit event, stops the clock as "reported (mock)", and exports a packet bundle (JSON + a printable HTML page). Nothing is sent anywhere real; the sponsor endpoint is the existing mock EDC.

### 00.3 Generated-text contract
`interim_rules.narrative` (template writer, pure, tested) and an optional `apps/api` LLM adapter implement `write(kind, facts) -> {text, sentences: [{text, evidence_ids}], writer: "template"|"llm", fallback_reason?}`. Facts are a structured bundle built by the API from DB rows. The UI shows each sentence with its evidence chips and a "written by template / written by Claude" label.

### 00.4 Visit-prep brief
One page per participant: everything since the last completed visit (configurable cut-off, default the previous visit date in the seed), grouped as new side effects (with grade trend), open AEs and their status, medication changes (with protocol flags), escalations and clocks, chart notes ingested, vitals context if any, and "questions to ask at the visit" (deterministic: missing CM fields, unresolved AEs, unsigned packets). Every line links to its evidence. Printable. Reachable from the queue and the participant timeline.

### 00.5 Time saved, on screen
A small, honest metric: for each confirmed record, the number of fields pre-filled from evidence and the number edited by a person; a **time-saved estimate** using per-field minutes from a cited table (`packages/rules/data/time_model.json`, sources: the 12–15 h/week EHR-to-EDC figure and per-field abstraction times; label it an estimate). Shown as a dashboard header strip and on the Monday-morning queue.

### 00.6 The new demo story (replaces §11's emphasis)
"Monday 8 am. Overnight: three kiosk check-ins and two hospital notes (an ER visit and an urgent-care visit). Interim has already found the side effects with exact quotes, merged duplicates, flagged the ER visit as a possible serious event, started the 24-hour clock, pre-filled the report and drafted its narrative, caught a discouraged steroid against the protocol, and built tomorrow's visit brief. The coordinator reviews and confirms: twenty minutes instead of most of a day." The seed must produce exactly this overnight state.

---

## 0. TL;DR for the agent

Build a deployable, MIT-licensed, open-source web product for clinical trial sites called **Interim**. A trial participant sits at a kiosk (laptop) between study visits, answers a short structured symptom check-in modeled on NCI PRO-CTCAE, and while they answer, a **vitals adapter** captures pulse rate and breathing rate contactlessly from the webcam. Every answer and every vitals sample is timestamped and written to a tamper-evident audit log. A **deterministic rules engine** (no LLM anywhere) assigns a provisional CTCAE grade, decides an escalation tier, starts the serious-adverse-event (SAE) clock when warranted, and drafts CDISC SDTM-shaped EDC entries (AE, VS, CM) where **every field points at its evidence**. A **coordinator dashboard** reviews, edits, confirms or rejects every draft; nothing leaves the system without a human click.

**The vitals adapter is the one piece we are NOT fully implementing right now.** Build it as a clean plugin interface with a fully working **mock source** (scenario-driven synthetic signals) and an **empty, documented stub** for the real Presage SmartSpectra SDK. When the user later says "implement Presage," the only file that should need real work is `apps/vitals-bridge/src/sources/presage.ts`. See §7.

Non-negotiables:
- **[Superseded by §00 and CONTRACTS R5: "Gemini reads, rules decide, people confirm. Nothing is accepted without a word-for-word quote."] ~~No LLM / generative AI calls anywhere in the runtime.~~** All logic is rules, lookup tables, and arithmetic. This is a deliberate differentiator; the judges have seen a hundred LLM wrappers.
- **Not a medical device.** Vitals are context attached to the record. They never produce medical advice and never change a grade on their own. The UI says this in a persistent footer.
- **Human confirms everything.** Drafts are drafts until a coordinator confirms them.
- **Runs from a clean clone** with `docker compose up` and also with `make dev`. CI must pass.
- **Measured vs. simulated is always labeled** on screen and in exports.

---

## 1. Context: who is judging and what wins

This is for the **Regeneron "Best Clinical Trials Solution"** superlative at HackRU Fall 2026 (Rutgers, Oct 2026). Judges are from Regeneron's Global Development Innovation (GDI) group. They run an internal CI/CD environment with Claude Code. Their published criteria, verbatim where it matters:

1. **Utility & Relevance:** "Does it solve a real bottleneck in medicines development (e.g., cancer therapeutics)?" Demos should reference Regeneron's pipeline (oncology via Libtayo/cemiplimab, immunology via Dupixent).
2. **Readiness:** "Is it actually functional, replicable, and ready to deploy? We generally only consider projects with a GitHub repo, and ideally MIT license." Their rubric also asks "how ready is it to support basic data privacy, security and cloud deployment, e.g. from a Git Repo via Jenkins on an Argo CI/CD environment?" So: Dockerfile, CI, env-based config, no secrets in repo, role separation.
3. **Design & Packaging:** a 3-minute demo video, a 10 to 12 slide deck, intuitive UX, clear documentation, and "well-documented, publicly-shared design documents in the repository such as PRDs, user stories, issue trackers, and well-commented code, even and especially if the hackathon time limited the time to implement the entire wish-list."

Their per-sheet rubric, which we must satisfy line by line:
- **Solves the problem:** would a research nurse capture more AEs, sooner, with less retyping?
- **It works:** end-to-end demo, runs from a clean clone following the README.
- **Smart use of data:** real public data where it exists; simulated data that is believable and documented.
- **Explains itself:** every output shows its evidence and reasoning.
- **Craft and demo:** clean code, clear story, good UI for the time available.

Things the judge has written that he will be impressed by: it runs live from a cold start on a laptop that isn't the one you built it on; you validated against something already known; you clearly labeled what is measured and what is simulated, every time; you can name one thing your tool gets wrong and why; you made a deliberate decision about what NOT to build. Things that fail: a beautiful UI with nothing computing behind it ("we will ask what happens if we change the input"), any claim of clinical utility or diagnosis, a polished deck with no running code.

---

## 2. The problem (from Regeneron's own starter sheet "How Are You Feeling?")

Between trial visits, patients experience symptoms and start or stop other medications. Some are **adverse events (AEs)** the trial must record. Some are dangerous. Today much of this surfaces only at the next visit, from memory. NCI notes that investigator-reported symptoms **under-detect symptomatic AEs**, which is why NCI built **PRO-CTCAE**, a library of patient-reported symptom questions (78 of 790 CTCAE terms can be meaningfully self-reported). Mass General Brigham deployed an "irAE-Agent" to detect immune-related AEs in notes and published deployment lessons (arXiv 2509.26153).

Regeneron's mission statement for this sheet: *"Build an AE and concomitant-medication capture agent that runs structured symptom check-ins between visits, scans new chart notes for possible AEs and medication changes, and delivers a reviewed, structured summary to the research team."* Their tiers:
- **GOOD "Check-In Agent":** voice or text check-in using a small PRO-CTCAE-style item set, structured answers, provisional grade, urgent escalation.
- **BETTER "Check-In + Chart Scan":** plus scanning new synthetic notes and med lists for AEs and con-med changes, merged with check-in data, evidence per flag, precision/recall against an answer key.
- **BEST "AE Capture Desk":** plus draft EDC AE and con-med entries for coordinator confirmation, de-duplication across sources, an SAE clock that starts when the site becomes aware, multilingual, investigator attribution screen.

**Our angle, which the sheet did not anticipate:** attach **objective, contactless vitals** (pulse rate, breathing rate) to the subjective symptom report at the moment it is given, and treat those vitals as **electronic source data (eSource)** with full traceability, per FDA's 2013 eSource guidance. A patient saying "shortness of breath, moderate" while the record shows breathing rate 26/min captured at that second is something investigators do not have today.

Oncology relevance: immune-related AEs (pneumonitis, colitis, rash, fatigue) on PD-1 inhibitors such as **cemiplimab (Libtayo)**. The demo trial is a real Regeneron study pulled live from ClinicalTrials.gov (see §9).

---

## 3. Product definition

### 3.1 Users and roles
| Role | What they do in Interim |
|---|---|
| **Participant** (kiosk mode) | Identifies with a study ID, consents to camera capture for this session, answers 8 to 12 check-in items, sees a thank-you with next steps. Never sees grades, tiers, or clinical language. |
| **Coordinator / research nurse** (dashboard) | Reviews the queue of check-ins, sees drafts with evidence, edits, confirms or rejects, acknowledges escalations, exports confirmed records. |
| **Investigator** (dashboard, elevated) | Only role that can set **AEREL** (causality/attribution) and **AESER** final seriousness. Everything else is read-only for them in v1. |
| **Admin/dev** (hidden panel) | Switches vitals source (mock/presage/arduino), picks mock scenario, resets demo data, runs the evaluation. |

### 3.2 The check-in instrument
Use a **fixed, hand-built item set modeled on PRO-CTCAE** (the official library is free from NCI but requires registration; do not fetch it at runtime). Store items in `packages/rules/data/proctcae_items.json`. Each item has the PRO-CTCAE attribute structure:
- `frequency` (Never / Rarely / Occasionally / Frequently / Almost constantly → 0..4)
- `severity` (None / Mild / Moderate / Severe / Very severe → 0..4)
- `interference` (Not at all / A little bit / Somewhat / Quite a bit / Very much → 0..4)
- Recall window: **"in the last 7 days."**
- Not every item has all three attributes (e.g., shortness of breath has severity + interference; nausea has frequency + severity; rash is present/absent).

Ship exactly these 10 items (chosen for PD-1 inhibitor irAE relevance): `shortness_of_breath`, `cough`, `fatigue`, `nausea`, `diarrhea` (frequency), `rash`, `itching`, `joint_pain`, `fever_or_chills` (present/absent + measured temp optional), `mouth_sores`. Plus three non-PRO-CTCAE gate questions at the end:
- "Since your last visit, were you admitted to a hospital or seen in an emergency room?" (yes/no; **seriousness trigger**)
- "Have you started or stopped any medication, including over-the-counter, since your last visit?" (yes/no + free-text med name captured verbatim; this is the **con-med capture**)
- "Is there anything else you want the study team to know?" (free text, stored verbatim, never parsed)

Document in `docs/PRD.md` that the item wording is "modeled on PRO-CTCAE" and that a production deployment would license the official item library from NCI.

### 3.3 Vitals capture (during the check-in)
While the participant answers, the kiosk shows a small, calm "vitals panel": a live pulse value, a live breathing rate value, a confidence/quality indicator, a **MEASURED / SIMULATED** badge, and the source name. Rules:
- Pulse is shown only after the source reports confidence above threshold and at least 12 s of capture; breathing only after 30 s; HRV (if provided) after 60 s. Before that, show "collecting…".
- Every vitals sample is persisted with its source, confidence, window length, and UTC timestamp. Samples are **never averaged away**; the record keeps the raw series plus derived summaries.
- The participant consents to camera use on the first screen of every session. Consent is itself an audited event.
- If the vitals source is unavailable or quality stays low, the check-in continues without vitals and the record is flagged `vitals_status: "unavailable"` or `"low_quality"`. The product must be fully functional with vitals off.

### 3.4 Rules engine (deterministic; `packages/rules`)
Pure functions with full unit tests. No I/O.

**(a) PRO composite score per item** (Basch et al. 2020 composite scoring approach): map the attribute responses to a 0 to 3 composite. Implement the published table for three-attribute, two-attribute, and single-attribute items; store it as data, not code.

**(b) Provisional CTCAE grade per symptom.** Map composite to a provisional grade using a documented table in `packages/rules/data/composite_to_grade.json` (composite 0→no AE, 1→G1, 2→G2, 3→G3; G4/G5 are never assigned by this system). Grade comes **only** from the participant's answers. Label it "provisional, investigator to confirm."

**(c) Red-flag items.** A table of conditions that bypass grading: severe or very severe shortness of breath; fever/chills present with any severe item; hospitalization/ER = yes; free-text "other" field non-empty AND any item severe (flag for human read, do not parse). Red flags set `escalation_tier` floor.

**(d) Vitals corroboration.** Vitals **never change the grade**. They can **raise the escalation tier by at most one step** and only when all of these hold: the vitals sample is marked measured (not simulated) OR the admin has enabled "treat simulated as measured for demo", confidence ≥ threshold, the sample window is valid, and a documented corroboration rule matches. Ship exactly these rules in `packages/rules/data/vitals_corroboration.json`:
- `shortness_of_breath` composite ≥ 2 AND breathing rate ≥ 24 bpm → +1 tier, reason "tachypnea corroborates reported dyspnea".
- `shortness_of_breath` composite ≥ 2 AND pulse ≥ 110 bpm → +1 tier, reason "tachycardia with reported dyspnea".
- `fever_or_chills` present AND pulse ≥ 110 → +1 tier.
- A vitals value outside physiological plausibility (pulse < 35 or > 180, breathing < 5 or > 45) is flagged `implausible` and ignored for rules, with a reason logged. (These bounds also catch the mock "post-exercise" scenario; that is the point of the demo: show the tier change, then explain the rule.)

**(e) Escalation ladder** (`escalation_tier` 0..3):
- **Tier 0, Log:** no symptom above G1. Record goes to the queue, no notification.
- **Tier 1, Coordinator review within 1 business day:** any G2.
- **Tier 2, Nurse call today:** any G3, or any red flag except hospitalization.
- **Tier 3, Urgent:** hospitalization/ER yes, or severe/very severe shortness of breath, or Tier 2 plus a corroboration rule. Action: the kiosk **stops the check-in**, shows a fixed, pre-approved screen: "Thank you. A member of the study team will contact you today. If you feel you need urgent help right now, call 911 or go to the nearest emergency room." The system pages the on-call role (mock pager: writes a `page` event and shows a toast on the dashboard). No medical advice beyond that fixed text, ever.

**(f) Seriousness and the SAE clock.** If hospitalization/ER = yes, set `seriousness_suspected = true` (ICH E2A criteria: death, life-threatening, hospitalization or prolongation, persistent disability, congenital anomaly, other medically important). Start `site_awareness_at = now()` and compute `investigator_to_sponsor_due = site_awareness_at + 24h` (the site's SAE reporting obligation). Show a live countdown on the dashboard. The clock stops only when an investigator records a seriousness decision. The sponsor-side 7/15-day clocks (21 CFR 312.32) are shown as informational downstream deadlines but are not owned by this system.

**(g) Con-med capture.** The verbatim medication text is stored as-is. A **deterministic matcher** (exact + case-insensitive + simple Levenshtein ≤ 2 against a small bundled list of ~200 common drug names in `packages/rules/data/medlist.json`, built from openFDA drug label data, clearly labeled "not RxNorm") proposes a normalized name with a confidence. Unmatched stays verbatim and is flagged for the coordinator. No NLP beyond string distance.

**(h) De-duplication.** If the same participant reports the same symptom term within 7 days of an existing open AE draft, link the new check-in to the existing AE as a follow-up (update `AEENDTC`/ongoing status) rather than creating a new AE. Show the link in the UI.

### 3.5 EDC drafts (CDISC SDTM-shaped)
Generate drafts the coordinator can confirm. Use SDTM variable names so a pharma judge recognizes them immediately. Every field carries an `evidence[]` array of pointers `{kind: "pro_response"|"vitals_sample"|"gate_answer"|"rule", id, ts, note}`.

- **AE domain** (one per symptom with provisional grade ≥ 1): `STUDYID, USUBJID, AESEQ, AETERM (verbatim symptom label), AEDECOD (our mapped CTCAE term, mock MedDRA), AESTDTC (first report), AEENDTC (null if ongoing), AEONGO, AETOXGR (provisional), AESER (null until investigator), AEREL (null until investigator), AEACN (null), AEOUT (null), INTERIM_TIER, INTERIM_RULES_FIRED[]`.
- **VS domain** (one row per vitals summary and optionally per sample): `VSTESTCD (PULSE|RESP|HRV_RMSSD), VSTEST, VSORRES, VSORRESU (beats/min, breaths/min, ms), VSDTC, VSMETHOD ("Contactless optical, camera-based" or "Simulated"), VSSTAT, INTERIM_CONFIDENCE, INTERIM_SOURCE`.
- **CM domain** (one per medication change): `CMTRT (verbatim), CMDECOD (matched name or null), CMSTDTC/CMENDTC (from "started/stopped"), CMSTAT, INTERIM_MATCH_CONFIDENCE`.

Confirmed records export as **JSON** and **CSV** per domain, plus a **submission bundle** zip with a manifest (sha256 per file) and the audit log excerpt. Also provide a `POST /mock-edc/{domain}` endpoint that accepts the confirmed records and returns an acknowledgment id, so the "post to EDC" step is visibly real in the demo.

### 3.6 Audit trail (ALCOA+)
Append-only `audit_events` table. Each event: `id, ts_utc, actor_id, actor_role, action, entity_type, entity_id, payload_json, prev_hash, hash` where `hash = sha256(prev_hash + canonical_json(event_without_hash))`. Provide `GET /audit/verify` that walks the chain and reports the first broken link, if any, and a dashboard page that shows the chain with a green "verified" badge. Every participant answer, every vitals sample batch, every rule firing, every coordinator edit/confirm/reject, every page, and every export is an event. Edits never overwrite: they create a new version row and an event.

### 3.7 Coordinator dashboard
Pages:
1. **Queue:** check-ins sorted by tier desc then time; tier chips; SAE countdown chips; "measured/simulated" badges; filter by participant.
2. **Check-in detail:** left column = the participant's answers in order with timestamps; middle = the drafted AE/VS/CM records with every field clickable to reveal its evidence; right = the "Why" panel listing every rule that fired, in plain English, with the inputs it used (this is the "explains itself" criterion). Buttons: Confirm, Edit, Reject, Acknowledge escalation. Investigator-only controls for AESER/AEREL.
3. **Participant timeline:** symptoms over time (sparkline per item), vitals over time, open AEs, con-med changes.
4. **Escalations:** every tier ≥ 2 event with "acknowledged by / at" and time-to-acknowledge.
5. **Audit:** chain view + verify.
6. **Eval:** runs the persona test set and shows precision/recall per tier and per grade (§8).
7. **Admin (hidden route `/admin`):** vitals source selector, mock scenario selector, demo reset, "treat simulated as measured" toggle (default OFF, shown with a warning).

### 3.8 Kiosk UI
Large type, one question per screen, big tap targets, progress bar, calm palette, no clinical jargon. Screens: Welcome + study ID → Camera consent (explicit Yes/No, "No" continues without vitals) → 10 items → 3 gate questions → Thank-you (or Tier 3 stop screen). The vitals panel is a small card, not the hero. Persistent footer: *"Interim is a research data-capture tool. It is not a medical device and does not provide medical advice."*

---

## 4. Architecture

Monorepo. Three runnable apps and one shared package.

```
interim/
├── CLAUDE.md                     # this file
├── README.md                     # quickstart, architecture diagram, demo script link
├── LICENSE                       # MIT
├── Makefile                      # dev, test, eval, seed, demo-reset
├── docker-compose.yml            # api + web (+ bridge in mock mode)
├── .github/workflows/ci.yml      # lint, typecheck, unit tests, docker build
├── .env.example
├── apps/
│   ├── api/                      # Python 3.12, FastAPI, SQLModel, SQLite (Postgres-ready via env)
│   ├── web/                      # React 18 + Vite + TypeScript + Tailwind; kiosk + dashboard routes
│   └── vitals-bridge/            # Node 20+ TypeScript service; vitals source plugins; WebSocket out
├── packages/
│   └── rules/                    # Python package: PRO scoring, grading, escalation, corroboration, SDTM drafting
│       ├── interim_rules/
│       ├── data/                 # JSON tables: items, composite map, grade map, corroboration, medlist, personas
│       └── tests/
├── data/
│   ├── public/                   # pulled from public APIs at seed time, cached as JSON (ClinicalTrials.gov study, openFDA label excerpt)
│   └── synthetic/                # generated participants, personas, answer keys (documented)
├── scripts/
│   ├── seed.py                   # creates demo study, participants, baseline check-ins
│   ├── fetch_public.py           # ClinicalTrials.gov + openFDA pulls, with caching and a --offline flag
│   └── run_eval.py               # persona test harness → docs/eval/results.md
└── docs/
    ├── PRD.md                    # product requirements, user stories, Good/Better/Best mapping
    ├── DECISIONS.md              # ADR-style log of choices
    ├── NOT_BUILT.md              # deliberately out of scope, with reasons
    ├── WHAT_IT_GETS_WRONG.md     # honest limitations (judges ask for this)
    ├── DEMO.md                   # 3-minute demo script, step by step
    ├── SLIDES.md                 # 10-12 slide outline
    ├── VITALS_SOURCES.md         # adapter contract + Presage implementation notes (see §7)
    └── eval/results.md           # generated
```

### 4.1 Data flow
```
Kiosk (web) ──answers──▶ api ──▶ rules ──▶ drafts + events ──▶ SQLite
   ▲                      ▲
   │ live vitals (WS)     │ vitals samples (HTTP POST, batched)
   └────── vitals-bridge ─┘
             │
       VitalsSource plugin: mock | presage (stub) | arduino (stub)
```
- The **bridge** runs on the kiosk machine (where the webcam is). It opens a WebSocket to the web app for the live panel and POSTs batched samples to the API every 2 s. It is stateless beyond the current session.
- The **API** is the system of record and the only writer to the DB.
- The **web** app is a static build served by nginx in Docker; it talks to the API over REST and to the bridge over WS. Kiosk and dashboard are routes in one SPA (`/kiosk`, `/dashboard`, `/admin`).

### 4.2 Tech choices (don't relitigate)
- API: Python 3.12, FastAPI, SQLModel, SQLite file in a volume; `DATABASE_URL` env allows Postgres. Pydantic models for every payload. `uvicorn`.
- Rules: pure Python package, no FastAPI imports, 100% unit-tested, tables in JSON.
- Web: React + Vite + TypeScript + Tailwind + React Router. Charts: Recharts. No component library bloat; small hand-built components. Light and dark both fine; pick one and make it clean.
- Bridge: Node 20+, TypeScript, `ws`, `undici`/fetch. Plugin interface in §7.
- Auth: role is chosen on a simple login screen with three seeded users (coordinator, investigator, admin) and a shared demo password from env. Roles are enforced server-side on every mutating endpoint. Say in README this is a demo auth model and list what production would need (SSO, per-user audit identity).
- Privacy: no real PHI, synthetic participants only; camera frames are never stored; only derived metrics leave the bridge. State this in README and in the kiosk consent screen.
- IDs: ULIDs. Times: UTC ISO-8601 everywhere, displayed in local time in UI with the UTC on hover.

---

## 5. API surface (FastAPI, `/api/v1`)

Participants/sessions:
- `POST /sessions` → start a check-in `{usubjid, consent_camera: bool}` → `{session_id}`
- `POST /sessions/{id}/answers` → `{item_id, attribute, value, ts_client}` (one per answer, idempotent on `(session_id,item_id,attribute)`)
- `POST /sessions/{id}/gates` → hospitalization, con-med text, free text
- `POST /sessions/{id}/complete` → runs rules, creates drafts, computes tier, may page; returns `{tier, stop_screen: bool}`
- `POST /sessions/{id}/vitals` → batch of `VitalsSample[]` (from bridge)

Dashboard:
- `GET /queue`, `GET /checkins/{id}` (answers, vitals, drafts, rules_fired, evidence), `GET /participants/{usubjid}/timeline`
- `POST /drafts/{id}/confirm|reject`, `PATCH /drafts/{id}` (creates a version), investigator-only `PATCH /drafts/{id}/attribution`
- `POST /escalations/{id}/ack`
- `GET /export/{domain}.csv|json`, `GET /export/bundle.zip`, `POST /mock-edc/{domain}`
- `GET /audit`, `GET /audit/verify`
- `POST /eval/run`, `GET /eval/results`
- Admin: `GET/PUT /admin/settings` (vitals_source, mock_scenario, simulated_as_measured), `POST /admin/reset`

All list endpoints paginate. All errors are RFC 7807 problem+json.

---

## 6. Data model (SQLModel)

`Study(study_id, nct_id, title, sponsor, phase, conditions[], interventions[], fetched_at, source_url)`
`Participant(usubjid, study_id, enrolled_at, display_label, baseline_vitals_json?)`
`Session(id, usubjid, started_at, completed_at, consent_camera, vitals_status, tier, stop_screen_shown)`
`Answer(id, session_id, item_id, attribute, value_int, value_text, ts_client, ts_server)`
`VitalsSample(id, session_id, ts_utc, source, is_measured, pulse_bpm, pulse_conf, breathing_bpm, breathing_conf, hrv_rmssd_ms, hrv_conf, window_s, quality_flags[])`
`Draft(id, session_id, domain [AE|VS|CM], version, status [draft|confirmed|rejected], fields_json, evidence_json, created_by, created_at, supersedes_id)`
`AEOpen(id, usubjid, aedecod, first_session_id, last_session_id, ongoing)` (for dedup/follow-up)
`Escalation(id, session_id, tier, reasons[], paged_at, acked_by, acked_at)`
`SAEClock(id, session_id, site_awareness_at, due_at, stopped_at, stopped_by, decision)`
`AuditEvent(...)` per §3.6
`Setting(key, value_json)`

---

## 7. The vitals adapter: contract, mock, and the Presage hole

### 7.1 Contract (`apps/vitals-bridge/src/sources/types.ts`)
```ts
export interface VitalsSample {
  tsUtc: string;                 // ISO-8601
  source: "mock" | "presage" | "arduino";
  isMeasured: boolean;           // false for mock, true for real sensors
  pulseBpm?: number;  pulseConf?: number;        // 0..1
  breathingBpm?: number; breathingConf?: number; // 0..1
  hrvRmssdMs?: number; hrvConf?: number;
  windowS: number;               // averaging window the source used
  qualityFlags: string[];        // e.g. "face_not_found", "low_light", "motion", "talking"
}
export interface VitalsSource {
  readonly name: "mock" | "presage" | "arduino";
  readonly isMeasured: boolean;
  start(opts: { cameraId?: string; scenario?: string }): Promise<void>;
  stop(): Promise<void>;
  onSample(cb: (s: VitalsSample) => void): void;
  onStatus(cb: (status: { state: "idle"|"warming"|"collecting"|"error"; message?: string }) => void): void;
  listCameras?(): Promise<{ id: string; label: string }[]>;
}
```
Selection via env `VITALS_SOURCE=mock|presage|arduino` (default `mock`) and runtime override from the admin panel. The bridge enforces the **timing gates** regardless of source: pulse published only after ≥12 s, breathing after ≥30 s, HRV after ≥60 s of continuous collection; confidence threshold env `VITALS_MIN_CONF=0.6`.

### 7.2 Mock source (fully implemented now)
`sources/mock.ts`. Emits one sample per second. Scenarios (selectable from admin and from a query param `?scenario=`):
- `resting`: pulse ~72±3, breathing ~14±1, conf ramps from 0.3 to 0.95 over the first 15 s.
- `post_exercise`: pulse starts ~128 decaying toward 90 over 90 s, breathing ~27 decaying toward 18. (This is the "jumping jacks" demo today; later it is replaced by actually doing jumping jacks in front of Presage.)
- `tachypnea`: pulse ~98, breathing ~26 steady, conf 0.9.
- `low_quality`: conf stays < 0.5, flags `face_not_found`/`low_light` intermittently.
- `dropout`: good for 20 s then status `error` for 10 s then recovers.
Signals must look physiological (add small autocorrelated noise, not white noise). Every sample is `isMeasured: false`. The mock also exposes a tiny synthetic pleth waveform so the UI's waveform sparkline has something to draw.

### 7.3 Presage source (STUB NOW; the hole to fill later)
Create `sources/presage.ts` exporting `PresageVitalsSource implements VitalsSource` where every method throws `NotImplementedError("Presage SDK not yet integrated; see docs/VITALS_SOURCES.md")` except `name`/`isMeasured` (which return `"presage"`/`true`). Selecting `VITALS_SOURCE=presage` must fail fast at startup with that message and tell the operator to switch to `mock`. **Do not add the SDK dependency to `package.json` now** (it pulls several hundred MB of native binaries). Put the implementation notes below verbatim into `docs/VITALS_SOURCES.md` and as a block comment at the top of `presage.ts` so the later implementation is a one-file job:

> **Presage SmartSpectra SDK, Node.js path (verified from vendor docs, Oct 2026):**
> - Package: `@smartspectra/node-sdk` (`npm install @smartspectra/node-sdk`). Node ≥ 20 (24 LTS recommended). Pulls native runtimes per platform; large install.
> - OS: Linux x64/arm64 (glibc 2.35+, i.e. Ubuntu 22.04+), Windows x64, macOS Apple Silicon. Intel Mac not supported.
> - API key: constructor option `apiKey`, obtained from the Presage developer portal (physiology.presagetech.com). There is also a vendor MCP server (`https://mcp.presagetech.com/mcp`) that can fetch/rotate the key, and a Claude Code skill: `npx skills add Presage-Security/SmartSpectra --skill using-smartspectra` (or `/plugin marketplace add Presage-Security/SmartSpectra` then `/plugin install smartspectra-sdk@smartspectra`). Use the skill when implementing.
> - Minimal usage pattern from vendor quickstart:
>   ```ts
>   import { SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, decodeMetrics } from '@smartspectra/node-sdk';
>   const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics: [...breathingMetrics, ...cardioMetrics] });
>   sdk.on('metrics', (buf, tsMicros) => { const m = decodeMetrics(buf); /* map → VitalsSample */ });
>   sdk.on('validationStatus', (code, ts, hint) => { /* map → qualityFlags */ });
>   sdk.on('error', (code, message, retryable) => { /* → status error */ });
>   sdk.useCamera(CameraSelection.default);   // or CameraSelection.byId(id) from SmartSpectraSDK.availableCameras()
>   sdk.start();  /* later: await sdk.stopAsync(); await sdk.destroy(); */
>   ```
> - Metrics semantics per vendor docs: pulse rate is a 12-second average (valid 40–110 BPM) with confidence; breathing rate a 30-second average (valid 5–40) with confidence; HRV (Mean NN, RMSSD, SDNN, Baevsky) needs 60 s; waveforms available (pleth, upper/lower breathing); face analysis (blink, talking, expressions). **Exact decoded field names were not verified; read `smartspectra.presagetech.com/docs/nodejs/metrics/` when implementing.**
> - Capture conditions: face and upper chest visible and well lit; stable camera for breathing; subject still and not talking (talking degrades breathing); avoid dark clothing / fine stripes.
> - Windows: `CameraSelection.front/back` fail; select by discovered id.
> - Vendor disclaimer: the SDK metrics are "for general wellness and informational use only" except the FDA-cleared iOS/Android pulse+breathing monitor (510(k) K254169). Our product never claims clearance; the UI footer covers this.
> - Mapping: `isMeasured = true`, `source = "presage"`, `windowS` from the metric (12/30/60), `qualityFlags` from validationStatus hints, confidences passed through unchanged.

### 7.4 Arduino source (STUB NOW, same pattern)
`sources/arduino.ts`: reads newline-delimited JSON from a serial port (`SERIALPORT` env), e.g. `{"pulse":74,"spo2":98,"temp_c":36.8}` from a MAX30102/DS18B20 sketch. Stub throws NotImplemented. Document the expected line format in `docs/VITALS_SOURCES.md`. Do not add `serialport` to dependencies now.

### 7.5 Bridge CLI
`npm run bridge -- --source mock --scenario resting --api http://localhost:8000 --ws-port 8787`. Prints a one-line status every 5 s. `--list-cameras` works only for sources that implement `listCameras`.

---

## 8. Evaluation harness (this is how we prove it works)

`packages/rules/data/personas.json`: 24 scripted check-ins with **expected outputs** (answer key). Mix:
- 6 Tier 0 (all G0/G1), 6 Tier 1 (a G2), 5 Tier 2 (a G3 or red flag), 4 Tier 3 (hospitalization, severe dyspnea, or Tier 2 + corroboration), 3 edge cases (implausible vitals ignored; low-quality vitals ignored; same symptom twice within 7 days → follow-up not new AE).
- Each persona includes the vitals scenario to replay and the expected: provisional grade per item, tier, rules fired, SAE clock started yes/no, AE drafts count, CM matches.

`scripts/run_eval.py` replays every persona through the real API (not by calling rules directly), compares, and writes `docs/eval/results.md` with: per-tier precision/recall/F1, per-grade confusion matrix, dedup correctness, SAE clock correctness, and a list of mismatches. `make eval` must pass with 100% on the shipped personas (they are deterministic). Also add 5 **"judge personas"** flagged `hidden: true` that the README invites the judge to run live from the Eval page with one click, plus a free-form "build your own persona" form so the judge can change the input and watch the output change.

Unit tests (pytest) for every rule table with property-style checks (monotonicity: raising severity never lowers grade; vitals never change grade; tier never exceeds 3; implausible vitals never fire corroboration).

---

## 9. Public data to use (and how)

Fetch at seed time with `scripts/fetch_public.py`, cache under `data/public/`, and commit the cache so the demo works offline.
- **ClinicalTrials.gov API v2** (no key): pull the demo study. Default `NCT03088540` (cemiplimab, EMPOWER-Lung 1, Regeneron, NSCLC). Fallback `NCT02760498` (cemiplimab, cutaneous squamous cell carcinoma). Verify the NCT resolves and the sponsor is Regeneron; if not, search `query.spons=Regeneron&query.intr=cemiplimab` and pick a completed phase 3. Store title, conditions, interventions, phase, status, and the official URL. Show it in the dashboard header as "Demo study (public registry record)".
- **openFDA drug label API** (no key): pull the LIBTAYO label's adverse reactions section text and show it read-only in the investigator attribution panel as "reference safety information (public label excerpt)". Also use labels to build `medlist.json` (brand + generic names of ~200 common drugs).
- **NCI CTCAE v5.0** files (public, NCI EVS): use the term names for the 10 symptoms as `AEDECOD`, and the grade definitions as hover text. Do not bundle the entire file; extract the 10 rows.
- **CDISC SDTM** variable names: follow the SDTM IG naming for AE/VS/CM as listed in §3.5. The CDISC pilot project on GitHub is a reference for shapes; do not depend on it at runtime.
- **Synthetic participants:** generate 12 participants with Synthea-style realism by hand in `scripts/seed.py` (names like "P-001"; no real names), each with 2 to 4 prior check-ins so timelines look lived-in. Document generation rules in `data/synthetic/README.md`.

Everything simulated is labeled simulated in the UI and in exports (`INTERIM_SOURCE`, `VSMETHOD`).

---

## 10. Build order (do it in this sequence; commit after each)

1. Repo skeleton, LICENSE (MIT), README stub, Makefile, `.env.example`, CI workflow that runs lint/tests on push.
2. `packages/rules`: data tables → scoring → grading → red flags → corroboration → ladder → SAE clock → con-med matcher → dedup → SDTM drafting. Tests green. This is the core; finish it before any UI.
3. `apps/api`: models, migrations (SQLModel create_all is fine), endpoints, audit chain, seed script, mock-edc, exports. Integration tests with httpx.
4. `apps/vitals-bridge`: types, mock source with all scenarios, WS server, batch POST, CLI, presage/arduino stubs, `docs/VITALS_SOURCES.md`.
5. `apps/web`: kiosk flow first (it is the demo), then dashboard Queue + Detail + Why panel, then Escalations/SAE countdown, Audit verify, Eval page, Admin, Timeline.
6. `scripts/run_eval.py` + personas; `make eval` green; `docs/eval/results.md` generated.
7. Docker: multi-stage images for api and web; compose brings up api + web + bridge(mock). `docker compose up` → kiosk at `http://localhost:5173/kiosk`, dashboard at `/dashboard`, API docs at `http://localhost:8000/docs`.
8. Docs: PRD, DECISIONS, NOT_BUILT, WHAT_IT_GETS_WRONG, DEMO, SLIDES. README with architecture diagram (Mermaid), quickstart, screenshots.
9. Polish pass on kiosk and detail page. Rehearse `docs/DEMO.md` end to end from a clean clone.

Keep a running `docs/ISSUES.md` (acts as the issue tracker the judges ask for) with open items and owners.

---

## 11. Demo script (what `docs/DEMO.md` must enable, ~3 minutes)

1. Dashboard header shows the real Regeneron study record and "all participants are synthetic." (10 s)
2. Kiosk: P-007 starts a check-in, consents to camera. Vitals panel says "collecting…", then shows pulse 72 / breathing 14, badge **SIMULATED** (today) or **MEASURED** (after Presage). (20 s)
3. Answers: shortness of breath = Moderate severity, Somewhat interference; cough Mild; everything else none; no hospitalization; "started loratadine." Thank-you screen. (40 s)
4. Dashboard: new Tier 1 item. Open it. AE draft `AEDECOD = Dyspnea, AETOXGR = 2 (provisional)`, VS rows with `VSMETHOD`, CM row `CMTRT = "loratadine"` matched 1.0. Click a field → evidence panel highlights the exact answer and timestamp. "Why" panel lists the rules. (40 s)
5. Admin: switch scenario to `post_exercise` (today) / do jumping jacks (later). Repeat the check-in with the same answers. Now breathing 26 → corroboration rule fires → **Tier 2**, reason shown verbatim. Point out: grade did not change, tier did, and here is the rule and its threshold. (40 s)
6. Judge changes the input: on the Eval page, pick a hidden persona or edit one answer, run, watch outputs change. Show `docs/eval/results.md` numbers. (20 s)
7. Audit → Verify → green. Export bundle. Footer: not a medical device. One slide: "what it gets wrong." (10 s)

---

## 12. Docs content requirements

- **PRD.md:** problem, users, user stories (≥ 12, "As a research nurse I want…"), Good/Better/Best mapping to Regeneron's sheet with what we shipped per tier, non-goals, success metrics (time from symptom to site awareness; AEs captured per participant-month; % fields with evidence = 100%).
- **NOT_BUILT.md:** voice mode, chart-note NLP scanning (originally excluded as needing an LLM; superseded: a deterministic scanner shipped and an optional Gemini second reader was added per R5), multilingual, real EDC integration (Rave/Veeva), SSO, real MedDRA/RxNorm licensing, mobile app, the Presage integration (slot exists), Arduino source (slot exists).
- **WHAT_IT_GETS_WRONG.md:** PRO-CTCAE composite → CTCAE grade is an approximation and not a validated crosswalk; camera vitals are confounded by motion/talking/lighting; corroboration thresholds are fixed, not personalized to baseline; con-med matcher misses misspellings beyond distance 2 and all compound names; 7-day dedup window is a heuristic; demo auth is not production auth.
- **SLIDES.md:** 1 title, 2 the bottleneck (NCI under-detection stat, 8-day data lag), 3 what we built (one screenshot), 4 the angle: vitals as eSource, 5 architecture, 6 rules not prompts (table of rules), 7 evidence + audit (screenshot), 8 eval results, 9 live demo pointer, 10 what it gets wrong + not built, 11 readiness (Docker, CI, MIT, URL), 12 team + JEDI link.

---

## 13. Conventions

- Python: ruff + mypy strict on `packages/rules`; black formatting; pytest. TypeScript: eslint + prettier + `tsc --noEmit`. Conventional commits.
- Every rule and threshold lives in a JSON table under `packages/rules/data/` with a `source`/`rationale` field. Code reads tables; code does not hardcode clinical numbers.
- Every API response that includes a derived value also includes `evidence` and `rules_fired`.
- No network calls at runtime except ClinicalTrials.gov/openFDA at seed time (cached) and the optional mock-EDC endpoint we host ourselves.
- No analytics, no telemetry, no third-party scripts in the web app.
- When something is simulated, the word "simulated" appears next to it. No exceptions.
- Write docs as you go, not at the end.

---

## 14. Open questions to decide yourself (log in DECISIONS.md)

- Exact Tailwind palette and whether kiosk is light-only (recommended: light, high contrast).
- Whether VS rows are per-sample or per-summary by default in exports (recommended: per-summary with a per-sample CSV available).
- Whether to keep SQLite in the Docker volume or use Postgres in compose (recommended: SQLite for the demo; document the env switch).

If you hit something this file does not cover, pick the option that keeps the demo path working from a clean clone, and move on.

---

## 15. Repository lineage (added at merge, 2026-10-10)

This repository started as `omer-khawar/ae-checkin-agent` ("AE Capture Desk": a FastAPI backend under `backend/`, a Presage SmartSpectra bridge under `presage-bridge/`, teammate context in `AGENTS.md`). The Interim build described above was merged in on the `interim` branch. Per `docs/DECISIONS.md` D-014: Interim's structure (`apps/`, `packages/`, `scripts/`, `docs/`) is primary; the deterministic chart-note scanner and the Presage bridge from the original backend are ported into it with credit (see `docs/CONTRACTS.md` R2.4 and R2.5); parity was verified and `backend/`, `presage-bridge/` and the original `AGENTS.md` moved to `legacy/` (see `legacy/README.md`); this file is the build brief for everything else.
