# What we deliberately did not build

> Judges ask for "a deliberate decision about what NOT to build." This is that list. Each item says **why not** and **what it would take**, so a future contributor can pick it up without re-deriving the trade-off. Open items are tracked in `docs/ISSUES.md`; the product spec is `CLAUDE.md`; the interface contract is `docs/CONTRACTS.md`.

Two rules shaped every cut:

1. **No LLM or generative AI anywhere in the runtime.** Every output in Interim is reproducible from a JSON table and arithmetic. Anything that needed a model was cut or replaced with a deterministic alternative.
2. **The demo path must run from a clean clone on a laptop that is not the one it was built on.** Anything that pulls hundreds of megabytes of native binaries, needs an account, or needs a phone was given a documented slot instead of an implementation.

## Summary

| # | Not built | Category | Slot exists? | Reason in one line |
|---|---|---|---|---|
| 1 | Chart-note scanning (the sheet's "Better" tier) | Deliberate product choice | No | Needs an LLM/NLP pipeline; we chose a fully deterministic product |
| 2 | Voice check-in and telephony | Deliberate product choice | No | TCPA / disclosure obligations and a speech stack that pushes toward an LLM |
| 3 | Multilingual items | Deliberate product choice | Schema-ready | Our items are hand-written; translations would not be validated |
| 4 | Real EDC integration (Medidata Rave, Veeva Vault CDMS) | Time / access | Mock EDC endpoint | Needs sponsor credentials and eCRF mapping; SDTM-shaped exports + `POST /mock-edc/{domain}` show the seam |
| 5 | SSO and per-user identity | Time | Auth layer isolated | Demo auth with three seeded users; audit schema already has `actor_id` |
| 6 | Real MedDRA and RxNorm coding | Licensing | Mock codes, bundled list | MedDRA is subscription-licensed; RxNorm needs a UMLS license; we ship a ~370-name openFDA-derived list labeled "not RxNorm" |
| 7 | Mobile app | Deliberate product choice | No | The kiosk is the point: a site-controlled webcam and a consistent capture environment |
| 8 | **Presage SmartSpectra integration** (real contactless vitals) | Deliberate deferral | **Yes: `apps/vitals-bridge/src/sources/presage.ts`** | Large native install and an API key; the plugin contract and notes make it a one-file job |
| 9 | **Arduino / serial sensor source** | Deliberate deferral | **Yes: `apps/vitals-bridge/src/sources/arduino.ts`** | Needs hardware on the demo machine; line format documented |
| 10 | EHR / FHIR connectivity | Time / scope | No | Site-side integration is site-specific; nothing in Interim's record requires it |
| 11 | Real notifications (SMS, e-mail, pager) | Deliberate | Mock pager (`GET /pages`) | Sending messages to real phones is out of bounds for a hackathon demo |
| 12 | Baseline-personalized corroboration thresholds | Time | `Participant.baseline_vitals_json` exists | Fixed population thresholds first; personalization needs a baseline capture protocol |
| 13 | Postgres in `docker-compose.yml` | Deliberate | `DATABASE_URL` switch | Zero extra services on the demo laptop (`docs/DECISIONS.md` D-007) |
| 14 | Grades 4 and 5 | Deliberate safety boundary | No | A kiosk questionnaire must never assign life-threatening or fatal grades |
| 15 | Part 11 electronic signatures | Time / regulatory | Audit events exist | Needs identity (item 5), signature manifestation and validation |
| 16 | Caregiver / proxy answering mode | Time | No | Would need a "who is answering" field and different wording |
| 17 | Scheduling and reminders | Time | No | Site workflow; sites already have scheduling systems |
| 18 | Offline kiosk mode | Time | No | The kiosk needs the API; a store-and-forward queue is straightforward but untested |

---

## 1. Chart-note scanning (the sheet's "Better" tier)

**What the sheet asked for:** scan new synthetic clinic notes and medication lists for possible AEs and con-med changes ("pt reports 3 days of diarrhea, started loperamide"), merge with check-in data, show evidence per flag, report precision/recall.

**Why not:** Reading free-text notes for AEs is a language-understanding task. Doing it well means an LLM or a trained clinical NLP model; doing it with regexes would be a demo that falls over the moment a judge changes the input. We made the opposite bet: **every output in Interim is reproducible from a table**, and the con-med problem is solved at the source by asking a structured question ("Have you started or stopped any medication…?") and keeping the verbatim text, with a string-distance matcher (`packages/rules/data/medlist.json`, `packages/rules/interim_rules/conmed.py`) that proposes a normalized name and flags what it cannot match. The MGB irAE-Agent field guide (Gallifant J, et al., [arXiv:2509.26153](https://arxiv.org/abs/2509.26153)) makes the governance cost of a note-reading agent in production very clear; that cost is real and we did not want to hand-wave it in three minutes.

**What it would take:** a note ingestion path (FHIR `DocumentReference` from a sandbox such as [HAPI FHIR](https://hapi.fhir.org/) or Synthea output), a labeled synthetic corpus with an answer key, a detection model behind a strict interface that emits the same `Evidence` shape (a new `kind: "note_span"` with char offsets and note id) the rest of the system already uses, a precision/recall report alongside `docs/eval/results.md`, and the governance work the field guide describes (monitoring, drift, escalation of model errors). The dedup module already accepts any source that produces an `AEDECOD` and a timestamp, so merging would reuse `packages/rules/interim_rules/dedup.py`.

## 2. Voice check-in and telephony

**Why not:** The sheet is explicit that voice agents must disclose automation, offer a human, never give medical advice, send emergencies to 911, and call only consenting people, and that the FCC treats AI voices as "artificial" under the TCPA. A speech stack (STT, dialog management, TTS) is also where an LLM creeps in. The kiosk gives the same structured answers with a large-type, one-question-per-screen UI and no telephony risk.

**What it would take:** a framework such as Pipecat or LiveKit Agents, STT with a constrained grammar per item (five fixed response options per attribute), the mandated disclosure/escape/911 scripts as fixed audio, consent records per phone number, and a test set of spoken answers with an answer key. The API already accepts one answer per `(session, item, attribute)`, so a voice front end would call the same `POST /api/v1/sessions/{id}/answers`.

## 3. Multilingual items

**Why not:** NCI provides PRO-CTCAE in more than 60 validated languages, but only under its Terms of Use with the official wording. Our 10 items are hand-written and modeled on the structure, not licensed items (see `docs/PRD.md` §9); translating them ourselves would produce unvalidated instruments. The data schema (`packages/rules/data/proctcae_items.json`: `label`, `response_options`) is language-neutral.

**What it would take:** register the study with NCI, load the official items in the required languages into `proctcae_items.json` keyed by locale, add a language picker to the kiosk welcome screen, and keep the rules untouched (they operate on attribute integers, not wording).

## 4. Real EDC integration (Medidata Rave, Veeva Vault CDMS)

**Why not:** Needs sponsor-issued credentials, a study-specific eCRF mapping, and an integration environment we cannot have at a hackathon. We built the seam instead: SDTM-shaped exports with CDISC variable names, a `bundle.zip` with a SHA-256 manifest, and `POST /api/v1/mock-edc/{domain}` that validates the column set and returns an `ack_id`, so the "post to EDC" step is visibly real in the demo.

**What it would take:** a connector per vendor (Rave Web Services / CDISC ODM import, or Vault CDMS REST), a mapping from our `AE/VS/CM` fields and `INTERIM_*` supplemental variables to the study's forms (the `INTERIM_*` fields belong in SUPPAE/SUPPVS/SUPPCM in a real SDTM submission), credential management via environment variables (already the pattern), idempotent retries keyed on the draft id, and an audit event per acknowledgment (the `mock_edc.posted` event is the template).

## 5. SSO and per-user identity

**Why not:** Time. The demo needs role separation (it has it, enforced server-side) more than it needs enterprise login.

**What it would take:** OIDC or SAML against the site IdP; per-user `actor_id` in every audit event (the schema already carries `actor_id` and `actor_role`; today they hold the seeded user); revocable sessions and MFA; password/account lifecycle; and, for confirm/attribution actions, the signature meaning and manifestation 21 CFR Part 11 expects (item 15). This is an auth-layer change in `apps/api`, not a data-model change.

## 6. Real MedDRA and RxNorm coding

**Why not:** MedDRA is licensed through the MSSO by subscription; RxNorm is free from NLM but requires a UMLS license agreement. Neither can be bundled in an MIT repo. We ship `meddra_code_mock` values clearly labeled mock in `packages/rules/data/ctcae_terms.json`, and a drug list of about 370 brand and generic names (372 entries as shipped) built from openFDA label data in `packages/rules/data/medlist.json` whose top-level `rationale` says "NOT RxNorm. Not a formulary."

**What it would take:** a licensed MedDRA lookup for `AEDECOD` (LLT → PT) and an RxNorm lookup (RxNav API or a local RxNorm release) for `CMDECOD`, both behind the existing `conmed.py` / `drafting.py` interfaces; the match-kind and confidence fields already exist to carry the result.

## 7. Mobile app

**Why not:** The product is a site kiosk on purpose: a controlled camera, lighting and distance make contactless vitals plausible, and the site owns the device. A phone app would also need the Presage iOS/Android SDK path rather than the Node SDK.

**What it would take:** a React Native or native app reusing the kiosk API calls, the Presage mobile SDK as a `VitalsSource`, device attestation, and a participant identity model that the kiosk's "type your label" approach deliberately avoids.

## 8. Presage SmartSpectra integration (the real contactless vitals source)

**Status: deliberately deferred; the slot exists and is documented.** `apps/vitals-bridge/src/sources/presage.ts` exports `PresageVitalsSource implements VitalsSource` whose methods throw `NotImplementedError("Presage SDK not yet integrated; see docs/VITALS_SOURCES.md")`; selecting `VITALS_SOURCE=presage` exits with code 2 before opening any port. The implementation notes (package `@smartspectra/node-sdk`, supported OSes, API key from physiology.presagetech.com, the quickstart event pattern, metric windows 12/30/60 s, validation-status to `qualityFlags` mapping, vendor disclaimer) are in `docs/VITALS_SOURCES.md` and in the block comment at the top of `presage.ts`.

**Why not now:** the SDK pulls several hundred megabytes of per-platform native runtimes, needs an API key, does not support Intel Macs, and would make `npm install` on a judge's laptop slow and fragile. The product is fully functional with the mock source and labels every mock value **SIMULATED**.

**What it would take:** `npm install @smartspectra/node-sdk` in `apps/vitals-bridge`, `PRESAGE_API_KEY` in `.env`, and filling in one file: map `decodeMetrics(buf)` to `VitalsSample` with `isMeasured: true`, `source: "presage"`, `windowS` 12/30/60 by metric, confidences passed through unchanged, `validationStatus` hints to `qualityFlags`, `error` events to `status: "error"`. The timing gates and confidence threshold in `apps/vitals-bridge/src/gate.ts` apply unchanged. Then run the rehearsal in `docs/DEMO.md` with real jumping jacks instead of the `post_exercise` scenario.

## 9. Arduino / serial sensor source

**Status: deliberately deferred; the slot exists.** `apps/vitals-bridge/src/sources/arduino.ts` is a stub that throws `NotImplementedError`; the expected newline-delimited JSON line format (`{"pulse":74,"spo2":98,"temp_c":36.8}` from a MAX30102 / DS18B20 sketch) and the `SERIALPORT` env variable are documented in `docs/VITALS_SOURCES.md`. The `serialport` dependency is intentionally not in `package.json`.

**What it would take:** add `serialport`, parse lines, emit `VitalsSample` with `isMeasured: true`, `source: "arduino"`, and a fixed `windowS` from the sketch; add a `temp_c` field to the sample if the team wants contact temperature to feed the `fever_or_chills` item (today temperature is an optional typed value).

## 10. EHR / FHIR connectivity

**Why not:** Site integrations are site-specific and would have been mocked anyway. Interim's record is complete without the EHR.

**What it would take:** SMART on FHIR launch for the dashboard, `Patient` / `MedicationStatement` reads to pre-fill con-meds, and a `DocumentReference` feed if item 1 is ever built.

## 11. Real notifications

**Why not:** The sheet forbids calling anyone but teammates, and a hackathon demo should not send SMS. The on-call page is a `Page` row (`GET /api/v1/pages`), an `escalation.paged` audit event, and a dashboard toast.

**What it would take:** a notification adapter (Twilio, PagerDuty, e-mail) behind the same `page_oncall` hook, with delivery receipts written as audit events.

## 12. Baseline-personalized corroboration thresholds

**Why not:** Fixed thresholds (breathing ≥ 24, pulse ≥ 110) are documented population values in `packages/rules/data/vitals_corroboration.json` and are easy to explain in a demo. Personalization needs a baseline capture protocol and more data than one check-in. The `Participant.baseline_vitals_json` field is reserved for it. `docs/WHAT_IT_GETS_WRONG.md` §3 explains the cost of not doing it.

**What it would take:** capture a resting baseline at enrollment, add a second rule family "delta from baseline ≥ X" to the same JSON table, and compare false-positive rates in the eval harness.

## 13. Postgres in compose

Logged as `docs/DECISIONS.md` D-007. SQLite in a named volume keeps the demo to three containers; `DATABASE_URL=postgresql+psycopg://…` switches the API with no code change.

## 14. Grades 4 and 5

`packages/rules/data/composite_to_grade.json` has `max_assignable_grade: 3`. A questionnaire at a kiosk cannot establish life-threatening consequences or death; red flags route those situations to Tier 3 (fixed stop screen, page the on-call) and the investigator grades them. This is a boundary, not an omission.

## 15. Part 11 electronic signatures

Confirm, reject and attribution actions are audited with actor and timestamp, but they are not electronic signatures in the Part 11 sense (no signature manifestation, no re-authentication, no per-user identity). Requires item 5 first.

## 16–18. Caregiver mode, scheduling, offline kiosk

Each is a straightforward addition the current API supports (an extra answer row; a cron or site calendar; a store-and-forward queue in the kiosk), none of which changes a rule or a draft. They were cut for time.
