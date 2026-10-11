# Interim — Product Requirements Document (PRD)

| | |
|---|---|
| **Product** | Interim: the trial coordinator's safety-data desk. It follows each side effect from its first mention (kiosk check-in, chart note, phone call) to a confirmed EDC record, a 24-hour sponsor report when one is required, answered sponsor queries, and an investigator visit brief. |
| **Version** | 0.1.0 — HackRU Fall 2026 (Rutgers), Regeneron "Best Clinical Trials Solution" track |
| **Status** | Living document. Rewritten 2026-10-10 (evening/night) for the expanded scope: `CLAUDE.md` §00, `docs/DECISIONS.md` D-023 to D-026, `docs/CONTRACTS.md` Revisions 3 and 4. |
| **Build brief** | `CLAUDE.md` (read §00 first; it overrides older sections) |
| **Interface contract** | `docs/CONTRACTS.md` (Revisions 2–4 win on conflict) |
| **Companion docs** | `docs/DECISIONS.md` · `docs/ISSUES.md` · `docs/NOT_BUILT.md` · `docs/WHAT_IT_GETS_WRONG.md` · `docs/DEMO.md` · `docs/SLIDES.md` · `docs/VITALS_SOURCES.md` · `data/synthetic/README.md` · `docs/eval/results.md` · `docs/eval/synthea_results.md` |
| **Credits** | Chart-note scanner and Presage groundwork: **Omer Khawar**, *AE Capture Desk* (MIT), ported with credit (D-014). Synthetic EHR: **Synthea**, © The MITRE Corporation, Apache-2.0. |
| **License** | MIT (`LICENSE`) |

---

## 1. Summary

Between study visits, trial participants have symptoms and start or stop other medicines. Some of these are adverse events (side effects) the trial must record; a few are serious and must reach the sponsor within 24 hours. Today they surface late, from memory or from an outside hospital note, and a research coordinator then retypes them into the electronic data capture system (EDC), writes the serious-event report by hand under a deadline, answers the sponsor's follow-up questions, and pulls everything together again before the next visit.

Interim takes that clerical work off the coordinator without taking any decision away from a person:

- **It catches side effects from three places:** a short kiosk check-in modeled on NCI PRO-CTCAE, clinician notes pasted in (clinic, urgent care, ER), and phone calls the coordinator logs. Notes and calls are read by a deterministic scanner that quotes the exact words.
- **It hands over ready-to-confirm work:** SDTM-shaped AE, VS and CM records in which every field links to its evidence; a pre-filled 24-hour report packet with a drafted narrative and a list of what is still missing; a suggested answer for each sponsor query; and a one-page visit brief per participant.
- **Rules decide, templates write, people confirm.** Grades, urgency tiers, 24-hour clocks and protocol flags come from rules in JSON tables with sources. Narratives, briefs and suggested answers come from a template writer whose every sentence cites evidence. A coordinator confirms every record; only the investigator decides seriousness and causality and signs a report.
- **It shows the time it saves** as an estimate with its basis, and it keeps a hash-chained audit trail of every step.

Interim is a research data-capture tool. **It is not a medical device and does not provide medical advice.** That sentence is a persistent footer on every screen.

---

## 2. Problem

### 2.1 The coordinator's day is spent copying

Research coordinators spend **12 to 15 hours per study per week** copying data that already exists in the electronic health record into the EDC (Mednet, reported by Clinical Trial Vanguard, 16 Sep 2026: https://www.clinicaltrialvanguard.com/?p=32325). Manual abstraction is also error-prone: a meta-analysis puts the pooled medical-record-abstraction error rate at **6.57%** (Garza MY et al. 2023, https://pmc.ncbi.nlm.nih.gov/articles/PMC10775420/). Safety data is the most time-pressured part of that work: the demo study's protocol requires **every serious adverse event to be reported to the sponsor within 24 hours** of the site learning about it, regardless of causality, and the same 24 hours applies to its adverse events of special interest (EMPOWER-Lung 1 protocol R2810-ONC-1624 Amendment 9, §9.4.2 p. 91 and §9.4.3 p. 92: https://cdn.clinicaltrials.gov/large-docs/40/NCT03088540/Prot_000.pdf).

### 2.2 Side effects are under-reported and arrive late

NCI built PRO-CTCAE because clinician reporting under-detects symptomatic adverse events ([NCI PRO-CTCAE](https://healthcaredelivery.cancer.gov/pro-ctcae/)). The size of the gap has been measured: across three randomized trials (1,090 patients), when patients reported a toxicity, **physicians under-reported it 40.7% to 74.4% of the time** (Di Maio M, et al. *J Clin Oncol* 2015;33(8):910–915, https://doi.org/10.1200/JCO.2014.57.9334).

The demo study is a real, completed Regeneron Phase 3 trial: **NCT03088540**, EMPOWER-Lung 1, cemiplimab (LIBTAYO, anti-PD-1) in first-line advanced non-small cell lung cancer (https://clinicaltrials.gov/study/NCT03088540). Cemiplimab is given every 3 weeks; a symptom that starts the day after an infusion can be three weeks old before anyone asks. Immune-related side effects on PD-1 inhibitors (pneumonitis, colitis, rash, endocrine problems) are exactly the events where early awareness matters, and the outside urgent-care or ER note that first mentions them often reaches the site a day or two late.

### 2.3 What the Regeneron sheet asks for, and how we read it

The starter sheet (`site-sheet-08-how-are-you-feeling.md`) asks for "an AE and concomitant-medication capture agent that runs structured symptom check-ins between visits, scans new chart notes for possible AEs and medication changes, and delivers a reviewed, structured summary to the research team." A Regeneron mentor reviewed our first build and told us the sheet is a guide to a problem area, not the whole scope; that tools are welcome if they lighten site staff's work; that consent is covered by the form signed at enrollment; and that most judges are not clinicians. So we widened the scope from "capture" to the coordinator's whole safety-data workload for one side effect (§4) and measured success as coordinator time removed (§7). The sheet's Good / Better / Best tiers are mapped in §13.

---

## 3. Users and roles

| Role | What they do in Interim | Enforced where |
|---|---|---|
| **Participant** (kiosk) | Types the study label from their card, answers 10 symptom items and 3 gate questions, sees a thank-you (or the fixed "a member of the study team will contact you today" screen). Never sees a grade, tier or clinical term. Camera use is covered by the consent form signed at enrollment; the welcome screen says no video is stored and offers "I'd rather not use the camera". | Kiosk endpoints only, no token |
| **Coordinator / research nurse** | Works the queue; reviews, edits, confirms or rejects records; pastes notes and logs calls; acknowledges escalations; prepares report packets and follow-ups; answers sponsor queries; prints visit briefs; exports. | Server-side role checks |
| **Investigator** | Everything a coordinator can, plus the decisions only an investigator may make: seriousness (`AESER`), causality (`AEREL`), immune-related (`INTERIM_IRAE`), "Record seriousness decision" on a clock, and **signing** a report packet. | Server-side, investigator only |
| **Admin** | Settings (vitals source, mock scenario, the loud "treat simulated as measured" toggle), demo reset, and the sponsor side of queries (raise a manual query, close a query). | Server-side, admin only |
| **System** | The vitals bridge (posts samples), the sponsor-side edit checks (raise queries), the seed. | Bridge token; audit actor ids |

---

## 4. The life of a side effect: requirements by step

Each step lists what Interim must do and where it lives. "Shipped" means implemented and tested in the API and rules package; the web screens for steps 5, 7 and 8 and for call intake were built against the contract and are being connected to the live API in the current integration pass (`docs/ISSUES.md`).

### Step 1–2. It happens, and it is mentioned somewhere

| ID | Requirement | Where |
|---|---|---|
| S2-01 | Kiosk check-in: 10 items modeled on PRO-CTCAE (shortness of breath, cough, fatigue, nausea, diarrhea, rash, itching, joint pain, fever or chills, mouth sores; frequency / severity / interference / presence; "in the last 7 days") plus 3 gate questions (hospital or ER since the last visit; medicine started or stopped, typed verbatim; anything else, stored verbatim and never parsed). One question per screen, plain words. | `/kiosk`, `packages/rules/data/proctcae_items.json`, `gate_questions.json` |
| S2-02 | No per-session consent screen; every session records `consent_basis: "enrollment_icf"` (D-026). The participant may turn the camera off; the check-in works fully without vitals. | `POST /sessions` |
| S2-03 | Optional vitals while the participant answers: pulse after 12 s, breathing after 30 s, HRV after 60 s of continuous capture, above a confidence threshold; every value labeled MEASURED or SIMULATED with its source. Frames never leave the kiosk machine. | `apps/vitals-bridge`, `docs/VITALS_SOURCES.md` |
| S2-04 | Chart-note intake: paste a clinic, urgent-care or ER note; the scanner finds symptoms and medications with exact quotes and character offsets, and skips negated, historical and hypothetical mentions with a stated reason. Dry run available. | `/dashboard/notes`, `POST /notes`, `POST /scan`, `interim_rules.chartscan` |
| S2-05 | **Phone-call intake:** "Log a call" (participant, caller: participant / caregiver / other, direction: inbound / outbound, summary). The summary is scanned exactly like a note and labeled "phone call" everywhere. | Notes page and participant timeline; `POST /notes` with `note_type: "phone_call"` |

### Step 3. The coordinator finds it

| ID | Requirement | Where |
|---|---|---|
| S3-01 | One queue for check-ins, notes and calls, sorted by urgency tier then time, with tier names spelled out (Log; Review within 1 business day; Nurse call today; Urgent), SAE / AESI clock chips with countdowns, MEASURED / SIMULATED badges, and a "Since you were last here" summary. | `/dashboard`, `GET /queue` |
| S3-02 | Urgency is decided by rules: provisional grade, red flags (hospital/ER, severe shortness of breath, fever with a severe item), protocol tier floor (prohibited medicine → at least tier 2), optional vitals corroboration (+1 at most). Tier 3 stops the kiosk with fixed text and writes a mock page. A note or call never reaches tier 3 (D-017). | `interim_rules.escalation`, `red_flags.json`, `escalation_ladder.json` |
| S3-03 | **Merging repeats:** the same standard term for the same participant within 7 days of an open side effect becomes a follow-up of it, across sources and in either order (kiosk then note, note then kiosk, note then note). The link is shown. | `interim_rules.dedup`, `services/notes.py` |
| S3-04 | Escalations page: every tier ≥ 2 event, acknowledged by whom and when, time to acknowledge; every running and stopped 24-hour clock. | `/dashboard/escalations` |

### Step 4. It goes into the record and the EDC

| ID | Requirement | Where |
|---|---|---|
| S4-01 | Pre-filled CDISC SDTM-shaped records: **AE** per side effect (standard CTCAE term, provisional grade, start date, ongoing), **VS** per vitals summary, **CM** per medication change (verbatim text, matched name with confidence, start/stop). | `interim_rules.drafting`, `services/notes.py` |
| S4-02 | **Every field carries evidence** (the answer row, the vitals samples, the quoted words of a note or call, the rule, the table). Click a field to see it. Target and test: 100% of drafted fields. | Check-in and note detail pages |
| S4-03 | Plain words first ("Side effect: diarrhea, severe (grade 3, provisional)"), SDTM variable names and rule ids one click deeper. | `plain_language.json`, `labels` in API responses |
| S4-04 | Confirm, edit (creates a new version; never overwrites), reject. Investigator-only fields stay empty until the investigator acts. | `/drafts/*` |
| S4-05 | Protocol-aware medication checks (§7.7, p. 69): a **prohibited** drug (bevacizumab, necitumumab, other investigational anti-cancer agents) raises the tier floor to 2 ("possible protocol deviation"); a **discouraged** systemic steroid adds a coordinator flag with the protocol's exception text, no tier change; CM records list which protocol-required fields (dose, unit, frequency, indication, dates) are still missing. | `protocol_rules.json`, `interim_rules.protocol` |
| S4-06 | Export confirmed records as CSV and JSON per domain, a submission bundle with a SHA-256 manifest and the audit excerpt, and post to the mock EDC, which returns an acknowledgment id. | `/export/*`, `POST /mock-edc/{domain}` |

### Step 5. Serious and special-interest events: the 24-hour report

| ID | Requirement | Where |
|---|---|---|
| S5-01 | **SAE clock:** a hospitalization or ER cue (kiosk gate "yes", or a note or call mentioning one) sets seriousness suspected and starts a 24-hour clock at **site awareness** (kiosk completion; note or call ingestion). Live countdown. Sponsor 7/15-day deadlines (21 CFR 312.32) shown as information only. | `seriousness.json`, `protocol_rules.json` |
| S5-02 | **AESI clock:** a provisional grade ≥ 3 on a potentially immune-related symptom (shortness of breath as possible pneumonitis, diarrhea as possible colitis, rash, itching, joint pain, fatigue as a possible endocrine signal; table with rationale in `irae_mapping.json`), or any grade on one of them after a prior PI3K inhibitor, starts a 24-hour clock labeled "possible AESI, investigator to confirm" (protocol §9.4.3, p. 92). | `interim_rules.protocol` |
| S5-03 | **Report packet:** one click on a clock opens a packet pre-filled from evidence (event term, onset, provisional grade, seriousness or AESI criteria, study drug, medications with protocol flags, site awareness time, deadline, reporter), each field with its evidence; a **missing-information list** (last dose, action taken, outcome, causality, hospital dates, missing medication fields); and a **draft narrative** in ICH E2A order whose every sentence cites evidence. | `/dashboard/packets/:id`, `POST /packets`, `GET /packets/{id}` |
| S5-04 | Edit fields and narrative (versioned, audited). **Only the investigator signs.** Signing stops the clock as "reported (mock)", posts the packet to the mock EDC, and records which narrative was signed (generated or edited). Print (self-contained HTML) and export JSON. | `PATCH /packets/{id}`, `POST /packets/{id}/sign`, `/print`, `/export.json` |
| S5-05 | **Follow-up reports:** from a signed packet, "Start follow-up report" creates report n+1, re-filled from current evidence, with a "changes since the previous report" list and the missing information recomputed. | `POST /packets/{id}/follow-up` |

### Step 6. The investigator decides

| ID | Requirement | Where |
|---|---|---|
| S6-01 | Investigator-only: causality (`AEREL`), seriousness (`AESER`), immune-related (`INTERIM_IRAE`, protocol p. 91) on the AE record. `AESER` stops the source's SAE clock; immune-related "No" stops its AESI clock. | `PATCH /drafts/{id}/attribution` |
| S6-02 | "Record seriousness decision" directly on a clock that has no side-effect record to attribute (e.g. a note saying "admitted after a fall"). | `PATCH /sae-clocks/{id}/stop`; check-in, note and Escalations pages |
| S6-03 | Reference only: the public LIBTAYO label's adverse-reactions excerpt beside the attribution controls. | `GET /reference/label` |

### Step 7. Sponsor queries

| ID | Requirement | Where |
|---|---|---|
| S7-01 | Sponsor-side **edit checks** run when records are posted to the mock EDC (and on demand): serious AE with no signed report; grade ≥ 3 potentially immune-related AE marked not immune-related; end date before start date; CM missing a protocol-required field; CM with a protocol flag and no investigator note; implausible vital sign; resolved outcome without an end date. A failing record raises one query (not again while one is open). | `edit_checks.json`, `interim_rules.queries` |
| S7-02 | Queries page: open / answered / closed, age in hours, the record field, and a **suggested answer** written by the template writer with evidence chips. Answer from the suggestion or in your own words, optionally correcting the field (a new record version). | `/dashboard/queries`, `/queries/*` |
| S7-03 | Admin acts as the sponsor's monitor: raise a manual query on any field, close answered queries. | `POST /queries`, `POST /queries/{id}/close` |

### Step 8. The visit brief

| ID | Requirement | Where |
|---|---|---|
| S8-01 | One printable page per participant covering everything since the last completed visit (or a chosen date; 14 days back when no visit is recorded): new side effects with their grade over time, open side effects and their status, medication changes with protocol flags and missing fields, escalations and clocks, notes and calls, vitals context (MEASURED / SIMULATED on every line), the participant's background (labeled "Synthea synthetic EHR (simulated)"), and **questions to ask at the visit** (missing medication fields, unresolved side effects, unsigned reports, open sponsor queries). Every line links to its evidence. | `/dashboard/participants/:usubjid/brief`, `GET /participants/{usubjid}/brief`, `/brief/print` |
| S8-02 | Reachable from the queue (per row) and the participant timeline. Visits can be recorded (completed / scheduled). | `/participants/{usubjid}/visits` |

### Across all steps

| ID | Requirement | Where |
|---|---|---|
| X-01 | **Audit trail:** append-only, hash-chained events for every answer, sample batch, rule firing, note, call, edit, confirm, packet edit and signature, query, brief, export and page; `GET /audit/verify` names the first broken link. Edits create versions. | `apps/api/interim_api/audit.py` |
| X-02 | **Time saved, on screen:** a header strip "Time saved this week (estimate)" from fields pre-filled and edited, signed packets, briefs and queries answered from suggestions, using per-field minutes from a cited table; basis on hover. | `GET /metrics/time-saved`, `time_model.json` |
| X-03 | **Evaluation:** check-in personas with an answer key, chart-note answer key, counterfactuals, a "build your own persona" form, and an independent Synthea evaluation (§7). | `/dashboard/eval`, `scripts/run_eval.py`, `scripts/synthea/eval_synthea.py` |
| X-04 | **Labels are never dropped:** MEASURED / SIMULATED beside every vital, "provisional, investigator to confirm" after every grade, "possible AESI, investigator to confirm", "estimate" beside time saved, "written by template" / "written by Claude" on generated text, the not-a-medical-device footer on every page. | Web, exports, printable pages |

---

## 5. User stories

1. As a **research coordinator**, I want every kiosk check-in, chart note and phone call that came in overnight in one queue, most urgent first, so my Monday starts with a list, not a search.
2. As a **research coordinator**, I want a repeat report of the same side effect within a week to be merged into the open one as a follow-up, so I do not create duplicate AEs.
3. As a **research coordinator**, I want each side-effect record pre-filled with the standard term, provisional grade and start date, and to click any field to see the exact answer or quoted note words behind it, so I check instead of retype.
4. As a **research coordinator**, I want to paste an outside urgent-care or ER note and get draft records with the exact words highlighted, so I do not reread the whole note to find the one sentence that matters.
5. As a **research coordinator taking a call**, I want to log the caller, direction and a short summary and have it scanned like a note, so what a caregiver tells me on the phone becomes a record the same day.
6. As a **research coordinator**, I want the 24-hour clock to start when the site becomes aware of a hospital stay, with a countdown, so I never discover a deadline after it passed.
7. As a **research coordinator**, I want the serious-event report pre-filled from the evidence with a list of what is still missing, so my phone calls go to the gaps, not to retyping.
8. As an **investigator**, I want a draft narrative where every sentence shows what it is based on, which I can edit before I sign, so I can trust and correct it quickly.
9. As an **investigator**, I want to be the only person who can record seriousness, causality and whether an event is immune-related, and the only one who can sign a report, so those decisions stay mine.
10. As a **research coordinator**, I want to start a follow-up report from a signed one, already re-filled with what changed since, so follow-ups take minutes, not a rewrite.
11. As a **research coordinator**, I want a medication that the protocol prohibits or discourages to be flagged with the protocol's own words and page, so I catch a possible deviation before the monitor does.
12. As a **research coordinator**, I want each sponsor query to come with a suggested answer that cites the record, and to correct the field in the same step, so I close queries in one pass.
13. As a **sponsor monitor** (admin in the demo), I want edit checks to raise queries automatically on records posted to the EDC, so obvious gaps come back to the site without a manual review.
14. As an **investigator**, I want a one-page brief before each visit with everything since the last one and the questions to ask, each line linked to its source, so the visit starts informed.
15. As a **participant**, I want to answer a few plain questions without clinical words, and to be told clearly when someone will contact me, so I am not left guessing.
16. As a **site manager**, I want an honest estimate of the coordinator time Interim saved, with the basis shown, so I can judge whether it is worth adopting.
17. As a **quality reviewer**, I want every change to be an audited, hash-chained event and edits to create versions, so I can reconstruct who did what and when.
18. As a **judge or new user**, I want to change one answer and watch the grade, tier and clocks change, so I can see that something real is computing behind the screen.

---

## 6. Rules decide, templates write, people confirm

- **Decisions** (grade, tier, red flags, who is alerted, whether a clock starts, protocol flags, query raising, de-duplication) are pure functions over JSON tables in `packages/rules/data/`. Every number and list has a `source` and a `rationale`; protocol rules carry the protocol section and printed page. Same input, same output, every time.
- **Text** (report narratives, follow-up narratives, visit briefs, suggested query answers) is written by `interim_rules.narrative`, a template writer: each sentence is assembled only from fact fields and cites the evidence ids of those facts; a sentence whose facts are missing is left out rather than filled with "unknown"; every grade is followed by "(provisional, investigator to confirm)". Wording lives in `narrative_templates.json`.
- **Optional Claude writer.** With `ANTHROPIC_API_KEY` set (and the optional SDK installed), a Claude writer may rephrase the template draft from the same facts. Its text is accepted only when `validate_written` passes: every cited evidence id exists, every quote appears verbatim in the fact the sentence cites, decision words (grade, AESI, seriousness, causality) carry their "investigator to confirm" qualifiers, and no advice wording appears. Otherwise the template text is used and the fallback reason is shown. No decision ever depends on generated text. A clean clone without a key shows every feature; there is no key today, so the template writer is what ships and what is measured.
- **People confirm.** Nothing leaves the system without a coordinator's confirm or an investigator's signature.

---

## 7. Success metrics

Success is coordinator time removed and side effects reaching the site sooner, without losing traceability.

| Metric | Definition | How Interim measures it today | Target for a pilot |
|---|---|---|---|
| **Time from first mention to site awareness** | From the moment a side effect is first mentioned (kiosk completion, note or call ingestion) to the first coordinator action on it (escalation acknowledged or record confirmed) | Audit timestamps (`session.completed` / `note.ingested` → `escalation.acked` / `draft.confirmed`); time-to-acknowledge is shown on the Escalations page | Tier ≥ 2 acknowledged the same business day |
| **Fields pre-filled vs edited** | For each confirmed record: fields Interim filled from evidence, and fields a person changed before confirming | `fields_prefilled`, `fields_edited` in `GET /metrics/time-saved` (per record in `draft_metrics`) | Edit rate tracked per field; a rising edit rate on a field means its rule needs work |
| **Queries answered from suggestions** | Share of sponsor queries answered with the suggested answer (as given or as the start of the answer) | `queries_answered_from_suggestion` in `GET /metrics/time-saved` | Majority of data-type queries |
| **24-hour reports on time** | Clocks stopped (packet signed or decision recorded) before `due_at` | SAE/AESI clock rows (`GET /sae-clocks?active=all`) | 100% |
| **Time-saved estimate** | Minutes a coordinator would have spent typing what Interim pre-filled, minus anything a person had to edit | `minutes_saved` with `basis[]` from `time_model.json`: one sourced rate (0.1 min per structured vitals field, MSK + IgniteData time-and-motion study) and labeled assumptions anchored to it (AE field 1.0 min, CM field 0.75, report field 1.5, narrative paragraph 10, brief section 5). The 12–15 h/week figure is shown as context, never multiplied in. | Report the estimate with its basis; replace assumptions with a time-and-motion study at the pilot site |
| **Evidence coverage** | Share of drafted fields with at least one resolvable evidence pointer | Enforced by tests | 100% |
| **Rule correctness on known cases** | Answer-key pass rate | `docs/eval/results.md` | 100% (regression gate in CI) |

---

## 8. Non-goals

- **Making clinical decisions.** Interim never assigns grade 4 or 5, never decides seriousness or causality, never gives advice beyond one fixed "contact you today / call 911" screen.
- **Reading the kiosk's free text.** The "anything else" answer is stored verbatim and never parsed (`docs/WHAT_IT_GETS_WRONG.md` §8).
- **A model that decides anything.** Gemini is only an optional second reader of notes and call summaries (CONTRACTS R5.3): it can add findings with a verified quote; rules decide, people confirm.
- **Real EDC or safety-database integration, a sponsor-side portal, voice check-in, multilingual items, mobile app, SSO** (`docs/NOT_BUILT.md`).
- **Leading with vitals.** Contactless vitals stay as optional context; they never change a grade (D-026).

---

## 9. Instrument note: "modeled on PRO-CTCAE"

The 10 items in `packages/rules/data/proctcae_items.json` are **hand-written items modeled on the PRO-CTCAE attribute structure** (frequency / severity / interference / presence, 7-day recall, 0–4 response scales). They are **not** the official NCI items, and the wording is ours. NCI's Terms of Use make PRO-CTCAE freely available but tie permission to registering the study, and prohibit altering item wording without NCI's written consent ([PRO-CTCAE Terms of Use](https://healthcaredelivery.cancer.gov/pro-ctcae/terms_of_use.html)). A **production deployment would register the study with NCI and load the official items verbatim** into the same schema; the rules use attributes and values, not wording. Composite scoring follows the published algorithm (Basch E, et al. *Clin Trials* 2021;18(1):104–114, https://doi.org/10.1177/1740774520975120), reproduced verbatim; the composite → CTCAE grade crosswalk is our documented approximation (`docs/WHAT_IT_GETS_WRONG.md` §1). CTCAE v5.0 term names come from NCI EVS (https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/).

---

## 10. Privacy and security posture

| Concern | What Interim does | Where |
|---|---|---|
| **No PHI** | All participants are synthetic (`P-001` … `P-012`); the notes, calls and urgent-care record are hand-written synthetic text. "All participants are synthetic" is in the dashboard header. | `apps/api/interim_api/seed.py`, `data/synthetic/README.md` |
| **Synthea de-identification** | Synthea's fictional names, addresses and identifiers are never copied; UUIDs are hashed; raw FHIR is not committed; a test asserts no source identifier appears in any output. | `scripts/synthea/import_synthea.py`, `data/synthetic/synthea/README.md` |
| **Consent** | Camera use is covered by the informed consent form signed at enrollment (D-026); each session records `consent_basis: "enrollment_icf"`; the participant can turn the camera off on the welcome screen, and the API then refuses vitals for that session. | Kiosk welcome, `POST /sessions` |
| **Camera data** | Frames are processed on the kiosk machine and never stored or transmitted; only derived numbers, confidences and quality flags leave the bridge. The welcome screen says "no video is stored". | `apps/vitals-bridge` |
| **Who may say "measured"** | A mock sample claiming to be measured is refused; a measured claim needs the shared bridge token. | `apps/api/README.md` "Measured vs simulated" |
| **Role separation** | Roles enforced server-side on every endpoint; only the investigator signs reports and records seriousness, causality and immune-related decisions; only the admin acts as the sponsor. | `apps/api/interim_api/auth.py` |
| **Tamper evidence** | Append-only hash chain, enforced in code; verify endpoint; bundle and packet exports carry SHA-256 hashes. | `audit.py`, `db.py` |
| **Generated text** | Template writer by default; an optional Claude writer runs only with a key in the environment, sends only the structured facts already shown on screen, and its output is validated against the evidence before use. | `apps/api/interim_api/writers/` |
| **Configuration** | Everything by environment; `.env.example` lists every variable; no secrets in the repo; Docker binds to `127.0.0.1` by default because the demo password is public. | `.env.example`, `docker-compose.yml` |
| **Runtime network** | No outbound calls at runtime. Exceptions, both opt-in: the Presage SDK validates its key with the vendor when that source is selected; the Claude writer calls the Anthropic API when a key is set. | `docs/VITALS_SOURCES.md` §5 |
| **No telemetry** | The web app loads nothing from outside the repository. | `apps/web` |

Interim does **not** claim 21 CFR Part 11 compliance; §11 lists what that would require. The audit design follows ALCOA+ expectations ([MHRA GxP data integrity guidance](https://www.gov.uk/government/publications/guidance-on-gxp-data-integrity)) and FDA's eSource guidance ([FDA, 2013](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/electronic-source-data-clinical-investigations)).

---

## 11. Deployment readiness

Regeneron's rubric asks how ready the project is for basic privacy, security and cloud deployment "from a Git repo via Jenkins on an Argo CI/CD environment."

| Item | Status | Where |
|---|---|---|
| Runs from a clean clone | `docker compose up --build`; also `make dev` / `npm run dev` | `README.md` |
| Container images | Multi-stage Dockerfiles for API (Python 3.12, uvicorn) and web (Vite build behind nginx); mock-only bridge image | `apps/*/Dockerfile` |
| CI | GitHub Actions on every push and PR: lint, strict type checks, unit and integration tests, offline public-data check, Synthea reproducibility check, deterministic eval, Docker build. The same `make` targets run in a Jenkins stage. | `.github/workflows/ci.yml` |
| Health | `GET /api/v1/health` (status, version, vitals source, DB) | `apps/api` |
| Database | SQLite in a volume; Postgres by changing `DATABASE_URL` | `apps/api/README.md` |
| Auth today | Three seeded users, shared `DEMO_PASSWORD`, HMAC-signed tokens, server-side role checks | `apps/api/README.md` |
| **What production would add** | OIDC/SAML single sign-on with per-user identity in every audit event; revocable sessions and MFA; 21 CFR Part 11 electronic signatures (meaning, manifestation, re-authentication) for signing and attribution ([21 CFR Part 11](https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11)); a secrets manager; TLS; Postgres with an advisory lock on the audit head; a validation package (IQ/OQ/PQ) for the rule tables, scanner lexicon and templates; real EDC and safety-database connectors; licensed PRO-CTCAE items, MedDRA and RxNorm; a vendor and data-flow review for any external SDK or model API. | `docs/NOT_BUILT.md` |

---

## 12. Risks and open questions

Tracked in `docs/ISSUES.md`; explained with reproducible examples in `docs/WHAT_IT_GETS_WRONG.md`.

- **The composite → grade crosswalk is not validated** (§1 there). Grades are labeled provisional everywhere.
- **The scanner is lexicon-bound and over-flags templated text** (§15). Discharge advice such as "if symptoms worsen, go to the ER" is read as a hospital visit and starts an SAE clock (issue #25).
- **The template writer reads stiffly and cannot infer missing facts** (§20). That is deliberate: missing facts become the missing-information list.
- **The time-saved number is an estimate** built on one sourced rate and labeled assumptions (§21).
- **The AESI mapping is our reading of the protocol** for some symptoms (pneumonitis via shortness of breath, joint pain, fatigue) (§22).
- **The Presage source has not been run against a live camera**, and its documented pulse range ends at 110 bpm, where our pulse corroboration rules start (§17, §24).

---

## 13. Secondary: mapping to Regeneron's Good / Better / Best

The sheet's tiers are a checklist, not our success measure (§7). What shipped against each line:

| Sheet requirement | Tier | Shipped? | Where |
|---|---|---|---|
| Voice **or text** check-in with a small PRO-CTCAE-style item set | GOOD | **Yes, text at a kiosk** (voice deliberately not built, `docs/NOT_BUILT.md`) | S2-01 |
| Structured answers | GOOD | **Yes**, one audited row per attribute | S2-01, X-01 |
| Provisional grade | GOOD | **Yes**, Basch 2021 composite, labeled provisional | S3-02 |
| Urgent escalation | GOOD | **Yes**, four named tiers, red flags, fixed stop screen, mock pager | S3-02 |
| Scan new synthetic notes and med lists for AEs and con-med changes | BETTER | **Yes, deterministically**, notes and phone calls | S2-04, S2-05 |
| Merge chart findings with check-in data | BETTER | **Yes**, in either order | S3-03 |
| Evidence for each flag | BETTER | **Yes, for every field**, with quoted words and offsets | S4-02 |
| Precision / recall against an answer key | BETTER | **Yes**, personas, scanner answer key, and an independent Synthea test | X-03 |
| Draft EDC AE and con-med entries for coordinator confirmation | BEST | **Yes**, AE / VS / CM, versioned edits, mock EDC | S4-01–S4-06 |
| De-duplication across sources | BEST | **Yes** | S3-03 |
| SAE clock that starts when the site becomes aware | BEST | **Yes**, plus AESI clocks from the protocol, report packets, follow-ups | S5-01–S5-05 |
| Multilingual | BEST | **No** (`docs/NOT_BUILT.md`) | — |
| Investigator attribution screen | BEST | **Yes**, plus immune-related assessment and signing | S6-01–S6-03 |
| *(beyond the sheet)* Protocol-aware rules, sponsor queries, visit brief, phone-call intake, time saved | — | **Yes** | S4-05, S7, S8, S2-05, X-02 |
| *(beyond the sheet)* Contactless vitals as optional context | — | Mock source in the demo (SIMULATED); Presage source implemented, untested live | S2-03 |

---

## 14. References

- EMPOWER-Lung 1 protocol R2810-ONC-1624, Amendment 9 (public on ClinicalTrials.gov) — https://cdn.clinicaltrials.gov/large-docs/40/NCT03088540/Prot_000.pdf; excerpt with page numbers and sha256: `data/public/empower_lung1_protocol_excerpt.json`
- ClinicalTrials.gov record NCT03088540 — https://clinicaltrials.gov/study/NCT03088540; API v2 — https://clinicaltrials.gov/data-api/api
- Clinical Trial Vanguard (16 Sep 2026), citing Mednet: coordinators spend 12–15 h per study per week copying EHR data into the EDC — https://www.clinicaltrialvanguard.com/?p=32325
- Memorial Sloan Kettering + IgniteData EHR-to-EDC time-and-motion study — https://www.mskcc.org/announcements/msk-presents-significant-data-study-findings-to-fda
- Garza MY, et al. Error rates of data processing methods in clinical research: a systematic review and meta-analysis (2023) — https://pmc.ncbi.nlm.nih.gov/articles/PMC10775420/
- Di Maio M, et al. *J Clin Oncol* 2015;33(8):910–915 — https://doi.org/10.1200/JCO.2014.57.9334
- NCI PRO-CTCAE — https://healthcaredelivery.cancer.gov/pro-ctcae/ ; Basch E, et al. *J Natl Cancer Inst* 2014;106(9):dju244 — https://doi.org/10.1093/jnci/dju244
- Basch E, et al. Composite grading algorithm for PRO-CTCAE. *Clin Trials* 2021;18(1):104–114 — https://doi.org/10.1177/1740774520975120
- NCI CTCAE v5.0 — https://evs.nci.nih.gov/ftp1/CTCAE/CTCAE_5.0/
- ICH E2A (October 1994) — https://database.ich.org/sites/default/files/E2A_Guideline.pdf
- 21 CFR 312.32 — https://www.ecfr.gov/current/title-21/chapter-I/subchapter-D/part-312/subpart-B/section-312.32 ; 21 CFR Part 11 — https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11
- FDA. Electronic Source Data in Clinical Investigations (2013) — https://www.fda.gov/regulatory-information/search-fda-guidance-documents/electronic-source-data-clinical-investigations
- MHRA GxP Data Integrity Guidance (2018) — https://www.gov.uk/government/publications/guidance-on-gxp-data-integrity
- openFDA drug label API — https://open.fda.gov/apis/drug/label/
- CDISC SDTM Implementation Guide — https://www.cdisc.org/standards/foundational/sdtmig
- Chapman WW, et al. NegEx. *J Biomed Inform* 2001;34(5):301–310 — https://doi.org/10.1006/jbin.2001.1029
- Walonoski J, et al. Synthea. *JAMIA* 2018;25(3):230–238 — https://doi.org/10.1093/jamia/ocx079 ; https://github.com/synthetichealth/synthea
- Gallifant J, et al. A Field Guide to Deploying AI Agents in Clinical Practice (irAE-Agent). arXiv:2509.26153 — https://arxiv.org/abs/2509.26153
- Presage SmartSpectra SDK — https://physiology.presagetech.com ; https://smartspectra.presagetech.com/docs/nodejs/
- Khawar O. *AE Capture Desk* (MIT): source of the chart-note scanner and the Presage groundwork (`legacy/`, D-014)
- Regeneron starter sheet — `site-sheet-08-how-are-you-feeling.md`
