# What we deliberately did not build

> **Status (2026-10-10, evening): this list describes the wave-2 build (`docs/CONTRACTS.md` R2.6).** The R3 rewrite (`docs/DECISIONS.md` D-023 to D-026: the Monday-morning story, protocol-aware rules, no per-session camera consent, the optional text writer that relaxes "no LLM anywhere" for written text only) is pending; until it lands, statements here about consent, the no-LLM rule and persona counts describe the running wave-2 app.

> Judges ask for "a deliberate decision about what NOT to build." This is that list. Each item says **why not** and **what it would take**, so a future contributor can pick it up without re-deriving the trade-off. Two items that were on this list in wave 1 have since shipped; they are recorded under [Shipped later than planned](#shipped-later-than-planned) with credit, because changing our mind is part of the record. Open items are tracked in `docs/ISSUES.md`; the product spec is `CLAUDE.md`; the interface contract is `docs/CONTRACTS.md` (its Revision 2 wins where it differs).

Two rules shaped every cut:

1. **No LLM or generative AI anywhere in the runtime.** Every output in Interim is reproducible from a JSON table and arithmetic. Anything that needed a model was cut or replaced with a deterministic alternative. (Chart-note scanning turned out not to need one; see S1.) R3 (D-024) relaxes this rule for written text only: narratives and briefs come from a deterministic template writer, and an optional Claude writer may replace that text when an API key is set. No decision ever depends on generated text.
2. **The demo path must run from a clean clone on a laptop that is not the one it was built on.** Anything that pulls hundreds of megabytes of native binaries, needs an account, or needs a phone is either an optional install kept out of `package.json` (the Presage SDK, S2) or a documented slot.

## Summary

| # | Not built | Category | Slot exists? | Reason in one line |
|---|---|---|---|---|
| 1 | Voice check-in and telephony | Deliberate product choice | No | TCPA / disclosure obligations and a speech stack that pushes toward an LLM |
| 2 | Multilingual items | Deliberate product choice | Schema-ready | Our items are hand-written; translations would not be validated |
| 3 | Real EDC integration (Medidata Rave, Veeva Vault CDMS) | Time / access | Mock EDC endpoint | Needs sponsor credentials and eCRF mapping; SDTM-shaped exports + `POST /mock-edc/{domain}` show the seam |
| 4 | SSO and per-user identity | Time | Auth layer isolated | Demo auth with three seeded users; audit schema already has `actor_id` |
| 5 | Real MedDRA and RxNorm coding | Licensing | Mock codes, bundled lists | MedDRA is subscription-licensed; RxNorm needs a UMLS license; we ship a 300-name openFDA-derived list and a 43-drug scanner lexicon, both labeled "not RxNorm" |
| 6 | Mobile app | Deliberate product choice | No | The kiosk is the point: a site-controlled webcam and a consistent capture environment |
| 7 | **Arduino / serial sensor source** | Deliberate deferral | **Yes: `apps/vitals-bridge/src/sources/arduino.ts`** | Needs hardware on the demo machine; line format documented |
| 8 | EHR / FHIR connectivity | Time / scope | `POST /notes` is the seam | Site-specific; notes arrive by paste or API; Synthea FHIR is imported offline at build time, never at runtime |
| 9 | Real notifications (SMS, e-mail, pager) | Deliberate | Mock pager (`GET /pages`) | Sending messages to real phones is out of bounds for a hackathon demo |
| 10 | Baseline-personalized corroboration thresholds | Time | `Participant.baseline_vitals_json`; Synthea baselines exist | Fixed population thresholds first; personalization needs a baseline capture protocol |
| 11 | Postgres in `docker-compose.yml` | Deliberate | `DATABASE_URL` switch | Zero extra services on the demo laptop (`docs/DECISIONS.md` D-007) |
| 12 | Grades 4 and 5 | Deliberate safety boundary | No | A kiosk questionnaire or a regex must never assign life-threatening or fatal grades |
| 13 | Part 11 electronic signatures | Time / regulatory | Audit events exist | Needs identity (item 4), signature manifestation and validation |
| 14 | Caregiver / proxy answering mode | Time | No | Would need a "who is answering" field and different wording |
| 15 | Scheduling and reminders | Time | No | Site workflow; sites already have scheduling systems |
| 16 | Offline kiosk mode | Time | No | The kiosk needs the API; a store-and-forward queue is straightforward but untested |
| 17 | **PD-1 inhibitor patients in the Synthea cohort** | Not available upstream | Synthea pipeline is pinned and reproducible | Synthea has no immunotherapy; our cohort is stage-1 NSCLC on cisplatin + paclitaxel |
| 18 | Section-aware medication-list parsing | Measured, not shipped | Candidate scored in `docs/eval/synthea_results.md` | Raises recall but drops precision from 1.000 to 0.645 on Synthea; decision pending (`docs/ISSUES.md` #24) |

**Shipped later than planned** (rows 1 and 8 of the wave-1 list): S1 chart-note scanning, S2 the Presage SmartSpectra source.

---

## 1. Voice check-in and telephony

**Why not:** The sheet is explicit that voice agents must disclose automation, offer a human, never give medical advice, send emergencies to 911, and call only consenting people, and that the FCC treats AI voices as "artificial" under the TCPA. A speech stack (STT, dialog management, TTS) is also where an LLM creeps in. The kiosk gives the same structured answers with a large-type, one-question-per-screen UI and no telephony risk.

**What it would take:** a framework such as Pipecat or LiveKit Agents, STT with a constrained grammar per item (five fixed response options per attribute), the mandated disclosure/escape/911 scripts as fixed audio, consent records per phone number, and a test set of spoken answers with an answer key. The API already accepts one answer per `(session, item, attribute)`, so a voice front end would call the same `POST /api/v1/sessions/{id}/answers`. The scanner's answer key already holds 31 participant-style utterances (`kind: "utterance"` in `packages/rules/data/chartscan_answer_key.json`) and `scan_text` has a `detect_human_request` mode for them, so a transcript could be screened deterministically; the kiosk itself never parses free text.

## 2. Multilingual items

**Why not:** NCI provides PRO-CTCAE in more than 60 validated languages, but only under its Terms of Use with the official wording. Our 10 items are hand-written and modeled on the structure, not licensed items (see `docs/PRD.md` §9); translating them ourselves would produce unvalidated instruments. The data schema (`packages/rules/data/proctcae_items.json`: `label`, `response_options`) is language-neutral. The chart-note lexicon (`packages/rules/data/chartscan_lexicon.json`) is English-only.

**What it would take:** register the study with NCI, load the official items in the required languages into `proctcae_items.json` keyed by locale, add a language picker to the kiosk welcome screen, and keep the rules untouched (they operate on attribute integers, not wording). Notes in other languages would need a lexicon and an answer key per language.

## 3. Real EDC integration (Medidata Rave, Veeva Vault CDMS)

**Why not:** Needs sponsor-issued credentials, a study-specific eCRF mapping, and an integration environment we cannot have at a hackathon. We built the seam instead: SDTM-shaped exports with CDISC variable names, a `bundle.zip` with a SHA-256 manifest, and `POST /api/v1/mock-edc/{domain}` that validates the column set and returns an `ack_id`, so the "post to EDC" step is visibly real in the demo.

**What it would take:** a connector per vendor (Rave Web Services / CDISC ODM import, or Vault CDMS REST), a mapping from our `AE/VS/CM` fields and `INTERIM_*` supplemental variables to the study's forms (the `INTERIM_*` fields belong in SUPPAE/SUPPVS/SUPPCM in a real SDTM submission), credential management via environment variables (already the pattern), idempotent retries keyed on the draft id, and an audit event per acknowledgment (the `mock_edc.posted` event is the template).

## 4. SSO and per-user identity

**Why not:** Time. The demo needs role separation (it has it, enforced server-side) more than it needs enterprise login.

**What it would take:** OIDC or SAML against the site IdP; per-user `actor_id` in every audit event (the schema already carries `actor_id` and `actor_role`; today they hold the seeded user); revocable sessions and MFA; password/account lifecycle; and, for confirm/attribution actions, the signature meaning and manifestation 21 CFR Part 11 expects (item 13). This is an auth-layer change in `apps/api`, not a data-model change.

## 5. Real MedDRA and RxNorm coding

**Why not:** MedDRA is licensed through the MSSO by subscription; RxNorm is free from NLM but requires a UMLS license agreement. Neither can be bundled in an MIT repo. We ship `meddra_code_mock` values clearly labeled mock in `packages/rules/data/ctcae_terms.json`; a drug list of 300 brand and generic names (59 hand-curated core entries, the rest built from openFDA label data) in `packages/rules/data/medlist.json` whose top-level `rationale` says "NOT RxNorm. Not a formulary."; and, for chart notes, a 43-drug pattern lexicon (`med_patterns` in `packages/rules/data/chartscan_lexicon.json`) whose CM drafts carry `INTERIM_MATCH_KIND = "lexicon"`. The Synthea charts in `data/synthetic/synthea/` carry RxNorm codes exactly as Synthea emits them; Interim ships no terminology files.

**What it would take:** a licensed MedDRA lookup for `AEDECOD` (LLT → PT) and an RxNorm lookup (RxNav API or a local RxNorm release) for `CMDECOD`, both behind the existing `conmed.py` / `drafting.py` / `services/notes.py` interfaces; the match-kind and confidence fields already exist to carry the result. The Synthea evaluation already measures what the bundled lists miss (`docs/eval/synthea_results.md` §(b): the matcher proposes the right ingredient for 20 of 42 distinct Synthea medication displays; clopidogrel, insulin and every chemotherapy agent are unmatched).

## 6. Mobile app

**Why not:** The product is a site kiosk on purpose: a controlled camera, lighting and distance make contactless vitals plausible, and the site owns the device. A phone app would also need the Presage iOS/Android SDK path rather than the Node SDK.

**What it would take:** a React Native or native app reusing the kiosk API calls, the Presage mobile SDK as a `VitalsSource`, device attestation, and a participant identity model that the kiosk's "type your label" approach deliberately avoids.

## 7. Arduino / serial sensor source

**Status: deliberately deferred; the slot exists.** `apps/vitals-bridge/src/sources/arduino.ts` is a stub that throws `NotImplementedError`; selecting it exits with code 2 before any port opens. The expected newline-delimited JSON line format (`{"pulse":74,"spo2":98,"temp_c":36.8}` from a MAX30102 / DS18B20 sketch) and the `SERIALPORT` env variable are documented in `docs/VITALS_SOURCES.md`. The `serialport` dependency is intentionally not in `package.json`.

**What it would take:** add `serialport`, parse lines, emit `VitalsSample` with `isMeasured: true`, `source: "arduino"`, and a fixed `windowS` from the sketch; add a `temp_c` field to the sample if the team wants contact temperature to feed the `fever_or_chills` item (today temperature is an optional typed value).

## 8. EHR / FHIR connectivity

**Why not:** Site integrations are site-specific and would have been mocked anyway. Interim's record is complete without the EHR. Chart notes reach Interim by paste on the dashboard's Notes page or by `POST /api/v1/notes`; the Synthea charts in `data/synthetic/synthea/` were imported **offline, at build time** from Synthea's FHIR R4 output by `scripts/synthea/import_synthea.py`, and nothing in the runtime reads FHIR.

**What it would take:** SMART on FHIR launch for the dashboard, `Patient` / `MedicationStatement` reads to pre-fill con-meds, and a `DocumentReference` subscription that calls the existing `POST /notes` with the note text (the scanner, the dedup and the SAE clock need nothing else).

## 9. Real notifications

**Why not:** The sheet forbids calling anyone but teammates, and a hackathon demo should not send SMS. The on-call page is a `Page` row (`GET /api/v1/pages`), an `escalation.paged` audit event, and a dashboard toast. Chart notes never page anyone (`docs/DECISIONS.md` D-017).

**What it would take:** a notification adapter (Twilio, PagerDuty, e-mail) behind the same `page_oncall` hook, with delivery receipts written as audit events.

## 10. Baseline-personalized corroboration thresholds

**Why not:** Fixed thresholds (breathing ≥ 24, pulse ≥ 110) are documented population values in `packages/rules/data/vitals_corroboration.json` and are easy to explain in a demo. Personalization needs a baseline capture protocol and more data than one check-in. The `Participant.baseline_vitals_json` field is reserved for it, and the Synthea cohort now supplies plausible baselines to test against: its 12 NSCLC participants have median resting breathing 13–16/min and pulse 68–90/min, i.e. 8–11 breaths and 20–42 beats below the thresholds (`docs/eval/synthea_results.md` §(d)). Wiring those baselines into the seeded participants is `docs/ISSUES.md` #23. `docs/WHAT_IT_GETS_WRONG.md` §3 explains the cost of not personalizing.

**What it would take:** capture a resting baseline at enrollment, add a second rule family "delta from baseline ≥ X" to the same JSON table, and compare false-positive rates in the eval harness.

## 11. Postgres in compose

Logged as `docs/DECISIONS.md` D-007. SQLite in a named volume keeps the demo to three containers; `DATABASE_URL=postgresql+psycopg://…` switches the API with no code change.

## 12. Grades 4 and 5

`packages/rules/data/composite_to_grade.json` has `max_assignable_grade: 3`. A questionnaire at a kiosk cannot establish life-threatening consequences or death; red flags route those situations to Tier 3 (fixed stop screen, page the on-call) and the investigator grades them. The chart-note scanner obeys the same ceiling: an explicit "grade 4" in a note becomes a grade hint of 3, with the clinician's number kept in `INTERIM_GRADE_BASIS`. This is a boundary, not an omission.

## 13. Part 11 electronic signatures

Confirm, reject and attribution actions are audited with actor and timestamp, but they are not electronic signatures in the Part 11 sense (no signature manifestation, no re-authentication, no per-user identity). Requires item 4 first.

## 14–16. Caregiver mode, scheduling, offline kiosk

Each is a straightforward addition the current API supports (an extra answer row; a cron or site calendar; a store-and-forward queue in the kiosk), none of which changes a rule or a draft. They were cut for time.

## 17. PD-1 inhibitor patients in the Synthea cohort

**What we have:** 12 synthetic NSCLC patients generated with Synthea (version `d9d07a6`, seeds 20261010 (11 patients kept) and 20261011 (1 patient kept), per the provenance table in `docs/eval/synthea_results.md`, a keep module for active non-small cell lung cancer), de-identified and relabelled `P-001` … `P-012` in `data/synthetic/synthea/` (see its `README.md`). The Regeneron judges recommended Synthea, and the starter sheet names it as a source of synthetic notes and medication lists.

**Why not PD-1:** Synthea's lung-cancer module treats NSCLC with **cisplatin + paclitaxel** and has no cemiplimab (LIBTAYO) or any other immune checkpoint inhibitor; combined with "alive at the reference date" it kept only **stage 1** patients, while the demo study (NCT03088540) enrolled advanced or metastatic PD-L1+ disease. So the Synthea charts show chemotherapy-era context, not the pneumonitis, colitis or rash that matter for an anti-PD-1 study. Writing our own Synthea module for cemiplimab and irAEs would mean inventing incidence and timing parameters, which is exactly the kind of unsourced clinical number this project refuses to hard-code.

**What it would take:** a Synthea module (Generic Module Framework JSON) for anti-PD-1 therapy with irAE states whose transition probabilities cite published trial data (the LIBTAYO label's adverse-reaction table is the obvious source), a stage III/IV keep module, regenerated notes, and a re-run of `scripts/synthea/eval_synthea.py`. Until then, the irAE-shaped data is the hand-written chart notes (`data/synthetic/chart_notes.json`) and the personas.

## 18. Section-aware medication-list parsing

**What it is:** split a note's `# Medications` section on `;` and run the con-med matcher on each item, in addition to the scanner's verb-anchored medication patterns.

**Why not (yet):** the Synthea evaluation measured it before anyone built it: recall of the medications visible in the note text rises from 0.178 to 0.255, but precision falls from 1.000 to 0.645, almost entirely because the matcher's per-word Levenshtein step turns "sodium fluoride" and "sodium chloride" into loperamide (via the brand "imodium", distance 2) in 44 notes (`docs/eval/synthea_results.md` §(b)). A false con-med a coordinator might accept is worse than a missing one she will add. Tracked as `docs/ISSUES.md` #24.

**What it would take:** a section parser driven by a table of section headings, the matcher run with whole-string matching only (no per-token step) for structured lists, and a re-run of the Synthea evaluation showing precision back above 0.95.

---

## Shipped later than planned

Both items below were on this list in wave 1 as "deliberately deferred". A teammate's repository showed they could be done within our rules, so we ported them (`docs/DECISIONS.md` D-014). Credit: **Omer Khawar**, *AE Capture Desk* (`omer-khawar/ae-checkin-agent`, MIT). His original `backend/` and `presage-bridge/` are kept for lineage (D-014; CONTRACTS R2.5).

### S1. Chart-note scanning (the sheet's "Better" tier): shipped, deterministically

**Why it was on this list:** we assumed reading free-text notes for AEs needed an LLM or a trained clinical NLP model, and that a regex version would fall over the moment a judge changed the input.

**What changed our mind:** Omer's scanner is a regular-expression lexicon with NegEx-style exclusion (negation, pseudo-negation, scope terminators, history, hypotheticals, allergy listings; after Chapman et al., *J Biomed Inform* 2001), it explains every finding with the exact quote, and it reproduces its own answer key exactly. That is the same contract as the rest of Interim: tables in, explainable output out, no model. It does still fall over on inputs its lexicon does not name, and `docs/WHAT_IT_GETS_WRONG.md` §15 shows exactly where.

**What shipped** (`docs/CONTRACTS.md` R2.4):
- `packages/rules/interim_rules/chartscan.py` (the port, with credit in its module header), with every regex, cue, window and red flag moved into `packages/rules/data/chartscan_lexicon.json` and `chartscan_red_flags.json` (`source` / `rationale` on each): 29 symptom terms (CTCAE v5 names) and 43 drugs.
- `POST /api/v1/notes` (stored verbatim; AE and CM drafts whose evidence pointers carry the note id and character offsets; Tier 1 or 2; SAE clock at ingestion when a hospitalization or ER visit is mentioned), `POST /api/v1/scan` (dry run, nothing stored), `GET /notes`, `GET /notes/{id}`, and the dashboard's **Notes** page with the matched words highlighted.
- **Cross-source de-duplication:** a note symptom with the same `AEDECOD` as an open AE from a kiosk check-in (or an earlier note) within 7 days becomes a follow-up, not a new AE, and vice versa.
- **Evaluation:** `packages/rules/data/chartscan_answer_key.json`, 39 cases (Omer's 8 notes and 17 utterances, plus 14 utterances we added after review): AE terms P = R = 1.00 (38/38), medications P = R = 1.00 (17/17), 14/14 urgent-or-emergency cases escalated, 0 over-escalations; part of `make eval` / `POST /eval/run`. Then an independent test on 72 Synthea notes it was never tuned on (`docs/eval/synthea_results.md`), which is where its real weaknesses show.

**What did not change:** the kiosk's "anything else" free-text field is still stored verbatim and **never parsed** (`docs/WHAT_IT_GETS_WRONG.md` §8). A note never produces Tier 3, a page or a stop screen (D-017): it is retrospective, and the participant is not at the kiosk.

### S2. Presage SmartSpectra source: implemented, not yet run live

**Why it was on this list:** a several-hundred-megabyte native SDK, an API key, no Intel-Mac support, and a fragile `npm install` on a judge's laptop.

**What changed our mind:** Omer's `presage-bridge/bridge.js` had already verified the SDK's API surface and decoded field names (SDK 3.4.0), which made the integration the low-risk one-file job `CLAUDE.md` §7.3 intended.

**What shipped** (`docs/CONTRACTS.md` R2.5, `docs/DECISIONS.md` D-016): `apps/vitals-bridge/src/sources/presage.ts` (with `presageMap.ts`) is a real `VitalsSource`. The SDK is loaded **dynamically** and is still **not** a `package.json` dependency: `npm run install:presage` installs `@smartspectra/node-sdk@3.4.0` with `--no-save`, so CI and the Docker image stay SDK-free and mock-only. Samples carry `source: "presage"`, `isMeasured: true`, windows 12/30/60 s and quality flags from the SDK's validation codes; the kiosk badge reads **MEASURED**. Without the SDK or `PRESAGE_API_KEY`, `--source presage` exits with code 2 and tells the operator to install it or switch to `mock`. The mapping is unit-tested against fixtures in the SDK's decoded shape.

**What is still missing:** a live run. The source has **not yet been tested against a real camera**. The vendor account is metered, so the first live test is budgeted at about three minutes of capture, following the five-step checklist in `docs/VITALS_SOURCES.md` §5. Until it passes, every demo vitals value is the mock's and is labeled **SIMULATED**, and `docs/WHAT_IT_GETS_WRONG.md` §17 says what a live camera will get wrong.
