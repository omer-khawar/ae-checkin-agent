# Decisions (ADR-style log)

Format: date, decision, why, consequences. Newest at the bottom.

## 2026-10-10 — D-001: Shared interface contract before parallel build
**Decision:** Write `docs/CONTRACTS.md` pinning rules-package types, API JSON shapes, bridge WS/HTTP messages, persona schema and seed rules before any app code.
**Why:** Five components are built in parallel by independent workers; the brief leaves JSON shapes implicit.
**Consequences:** The contract is the tie-breaker. Changes get logged here.

## 2026-10-10 — D-002: API JSON is snake_case; the vitals POST also accepts camelCase
**Decision:** The API emits snake_case everywhere. `POST /sessions/{id}/vitals` accepts the bridge's camelCase `VitalsSample` (CLAUDE.md §7.1) via Pydantic aliases and stores snake_case.
**Why:** Keeps the bridge contract verbatim from the brief while keeping the API consistent.
**Consequences:** The web app handles camelCase on the WS stream and snake_case from REST; types for both live in `apps/web/src/lib/types.ts`.

## 2026-10-10 — D-003: Bridge enforces timing gates by nulling, not by withholding samples
**Decision:** Before a metric's timing gate elapses, the bridge still emits/persists the sample but sets that metric to `undefined` and adds `gate_pending_<metric>`. Sub-threshold confidence values are kept and flagged `low_conf_<metric>`.
**Why:** "Samples are never averaged away" and the raw series must stay auditable; the rules engine applies the confidence threshold itself.
**Consequences:** The UI hides flagged values; the rules ignore them with a logged reason.

## 2026-10-10 — D-004: Backdating only via admin-authenticated override fields
**Decision:** `POST /sessions` and `POST /sessions/{id}/complete` accept `started_at_override` / `completed_at_override` / `settings_override` only when the caller holds an admin token. Seed and eval use them.
**Why:** Seeded timelines need prior check-ins in the past; eval personas need per-persona `simulated_as_measured` without flipping the global setting under a live kiosk.
**Consequences:** Documented in README as demo-only; every override is an audit event.

## 2026-10-10 — D-005: Eval replays explicit vitals samples, not the bridge
**Decision:** Personas carry an explicit `vitals_samples[]` list (deterministic) plus an informational `vitals_scenario` name for live demos.
**Why:** Determinism; `make eval` must be 100% reproducible without a running bridge.
**Consequences:** The mock bridge scenarios and the persona samples describe the same physiology but are separate data.

## 2026-10-10 — D-006: Light theme only; same-origin API via proxy
**Decision:** Kiosk and dashboard are light, high-contrast. The web app calls `/api/v1` relative; Vite proxies in dev, nginx in Docker.
**Why:** CLAUDE.md §14 recommendation; one fewer env var to get wrong on a cold-start laptop.

## 2026-10-10 — D-007: SQLite in a Docker volume; Postgres via `DATABASE_URL`
**Decision:** Compose uses SQLite in a named volume. Postgres is a one-line env change, documented but not run in compose.
**Why:** Zero extra services on the demo laptop.

## 2026-10-10 — D-008: VS exports are per-summary by default, per-sample on request
**Decision:** `GET /export/VS.csv` emits one row per metric summary per session; `?per_sample=true` and the bundle's `VS_samples.csv` give the raw series.
**Why:** Matches what a data manager expects to see in VS while keeping the raw eSource series exportable.

## 2026-10-10 — D-009: Root `package.json` mirrors the Makefile
**Decision:** `npm run dev|test|eval|seed` work on Windows without `make`.
**Why:** The build machine is Windows; judges' laptops may be too.

## 2026-10-10 — D-010: Composite scoring reproduced verbatim from the reference implementation
**Decision:** `composite_scoring.json` reproduces the Basch et al. 2021 PRO-CTCAE composite tables (179 rows) from the ProAE v1.0.4 `comp_tab` reference implementation (CRAN; senior author Dueck), with the published zero rule encoded as `zero_gate`. The PMC full text was bot-blocked during the build.
**Why:** The brief asks for the published table as data, not an approximation. `reproduced_verbatim: true` and the retrieval path are recorded in the table.
**Consequences:** Single-attribute mapping is attribute-specific (frequency 0,1,1,2,3; severity 0,1,2,3,3; interference 0,1,1,2,2), superseding CONTRACTS §1.1. Presence items map present → composite 1 → G1 as an Interim convention, labeled in the table and in WHAT_IT_GETS_WRONG.

## 2026-10-10 — D-011: Red-flag and corroboration conditions are declarative JSON
**Decision:** Conditions are expressed in a tiny condition language (`conditions.py`: item_attribute, item_composite, any_severe_item, gate_bool, gate_text_nonempty, vital, all) and evaluated from the tables.
**Why:** Every threshold is visible as data; a new rule needs no rule-module code.

## 2026-10-10 — D-012: Extra SDTM-adjacent fields and inputs
**Decision:** `CheckInInput.nct_id` (optional) and `INTERIM_NCT_ID` on AE/VS/CM; `INTERIM_DIRECTION` on CM. Dedup boundary is inclusive at exactly 7 days; future-dated last reports count as inside; most recent open AE wins on ties.
**Why:** The contract wanted the NCT id in a separate field but gave no input; direction is otherwise lost; deterministic boundary is robust to backdated seeds.

## 2026-10-10 — D-013: Con-med matcher parameters live apart from the medlist
**Decision:** `conmed_matching.json` holds min token length (4) and max distance (2); `medlist.json` holds names only and is regenerated from openFDA.
**Why:** The data refresh script must not be able to change matching behavior.

## 2026-10-10 — D-014: Merge with the teammate's repository (`omer-khawar/ae-checkin-agent`)
**Decision:** Interim's architecture is primary. Omer Khawar's deterministic chart-note scanner and his Presage SmartSpectra bridge are ported into the Interim structure as first-class modules with credit (CONTRACTS R2.4, R2.5). After parity is verified, the original `backend/` and `presage-bridge/` move to `legacy/` with a README explaining the lineage. Agreed with the user on 2026-10-10; the user clears it with Omer.
**Why:** Both backends are LLM-free and overlap heavily. Interim already has a contract-built web client, a validated rules engine, an audit chain and an eval harness; the teammate's repo contributes the Better tier (chart scan) and a working Presage integration, which the brief had left as a hole.
**Consequences:** `docs/NOT_BUILT.md` and the PRD's Good/Better/Best mapping change: chart-note scanning is now shipped, deterministically. The kiosk's free-text field is still never parsed.

## 2026-10-10 — D-015: Push model is branch `interim` + pull request
**Decision:** Every wave commits locally and pushes to the `interim` branch of the teammate's repo; a PR to `main` is kept open and updated. Nothing lands on `main` without a teammate's click.
**Why:** Large restructures should be reviewable by the person whose lane they touch.

## 2026-10-10 — D-016: Presage SDK is an optional runtime dependency loaded dynamically
**Decision:** `presage.ts` is implemented (not stubbed) but imports `@smartspectra/node-sdk` dynamically at `start()`. The package is not in `dependencies`; `npm run install:presage` installs it `--no-save`. A missing module fails fast with the install command.
**Why:** CLAUDE.md §7.3 forbids adding the multi-hundred-MB native dependency to package.json; the teammate's bridge.js verified the SDK API surface and decoded field names, so the implementation is low-risk.
**Consequences:** The source is marked "implemented, untested against a live camera" until someone runs it with a key.

## 2026-10-10 — D-017: Chart-note findings never auto-escalate to Tier 3
**Decision:** Note ingestion can create Tier 1 (default) or Tier 2 (urgent/emergency red flag, or hospitalization mention) escalations and may start the SAE clock at ingestion time; it never creates Tier 3, never pages, never shows a stop screen.
**Why:** A note is retrospective; the participant is not in front of the kiosk. The site-awareness moment for a note is when the site reads it, which is what the SAE clock must record.

## 2026-10-10 — D-018: Kiosk session creation and participant id (web)
**Decision:** The kiosk creates the session on the consent decision (Yes or No), so consent is one audited event. The participant types the printed label (`P-007`); the kiosk sends `usubjid = "{study_id}-{LABEL}"` first and retries once with the bare label on 404. The API accepts either (CONTRACTS R2.3).
**Why:** `POST /sessions` needs `consent_camera` in the same body; participants know their label, not the composed USUBJID.

## 2026-10-10 — D-019: Vitals display gating is decided by the bridge, not the web
**Decision:** A value is shown only when the bridge's `published.<metric>` is true AND confidence ≥ the threshold from `hello.minConf` AND no `low_conf_<metric>` flag. The web never computes timing gates. The bridge adopts `min_confidence` and the timing gates from `GET /settings/public` on every start.
**Why:** One place owns the gate; the rules table is the source of the threshold.

## 2026-10-10 — D-020: Bridge behaviors beyond the contract
**Decision:** The timing-gate clock resets on any non-`collecting` state (not only `error`). The vitals source is fixed for the bridge process's lifetime (the admin setting only warns on mismatch). The WebSocket binds `127.0.0.1` by default; Docker sets `--ws-host 0.0.0.0`. Terminal 4xx responses (400/404/413/415/422) are not retried. `post_exercise` decays with pulse τ = 45 s and breathing τ = 150 s so the corroboration threshold is still exceeded after the 30 s breathing gate. Mock scenario parameters live in a typed TS table with a rationale each (they are simulation parameters, not clinical thresholds).
**Why:** Demo robustness and safety defaults; recorded by the bridge builder and reviewer.

## 2026-10-10 — D-021: Public-data cache and medlist build policy
**Decision:** A cached file counts as a hit only if `fetched: true`; bundled fallbacks are refetched online and reported offline; `--strict` fails on any degraded step. The medlist is assembled core list → ranked generics (top 180) → brands by rank, capped at 300; every non-core entry has ≥ 5 letters and every word ≥ 3 letters; brand→generic comes from openFDA label counts, not a dictionary. `data/public/ctcae_v5_excerpt.json` is provenance only; `packages/rules/data/ctcae_terms.json` (mock MedDRA codes) is the runtime source.
**Why:** Determinism offline, honest provenance, and fewer short-token collisions for the Levenshtein matcher.

## 2026-10-10 — D-022: Rules-engine guards added after review
**Decision:** `vitals_corroboration.json` gained `min_window_s` (pulse 12, breathing 30, HRV 60) and `simulated_sources: ["mock"]`; a reading from a simulated source is never measured regardless of its flag, and a reading with too short a window is ignored. `conmed_matching.json` gained `min_levenshtein_confidence: 0.7` (so "from" no longer matches "iron"). `dedup.json` gained `max_future_skew_s: 300` and dedup skips an open AE from the session being evaluated. `evaluate_checkin` validates its input up front (ISO timestamps, `next_aeseq ≥ 1`, finite numbers). A "yes" con-med change with no name still yields an empty CM draft flagged for the coordinator. VS evidence is bounded (first/last/count) so a 3-minute capture stays under 100 KB.
**Why:** Each closes a reviewer-demonstrated path where the engine would have corroborated, linked or serialized something it should not have.

## 2026-10-10 — D-023: Scope expands to the coordinator's safety-data workload
**Decision:** Interim follows each side effect from first mention to an EDC-ready record, a 24-hour sponsor report when required, and an investigator visit brief (CLAUDE.md §00). Success is measured as coordinator time removed. This round adds protocol-aware rules, a serious-event packet with a drafted narrative, a visit-prep brief, and an on-screen time-saved estimate.
**Why:** Regeneron mentor feedback (the starter sheet is a guide, not the scope; lighten staff work; most judges are not clinicians) and research on site burden (EHR-to-EDC retyping, 24-hour SAE reporting).
**Consequences:** The "no LLM anywhere" non-negotiable is replaced by "rules decide, text tools write, people confirm" (D-024). Chart-note LLM reading is deferred. `docs/PRD.md`, `SLIDES.md`, `DEMO.md` and the README are rewritten around the Monday-morning story.

## 2026-10-10 — D-024: Generated text ships as a deterministic template writer; Claude is optional
**Decision:** Narratives and briefs are produced by `interim_rules.narrative`, a template writer that builds each sentence from evidence fields and cites evidence ids. A Claude adapter (official `anthropic` SDK) can replace it when `ANTHROPIC_API_KEY` is set; its output is accepted only if every cited id resolves and every quote appears verbatim, otherwise the template text is used with a stated fallback reason.
**Why:** There is no API key yet, and a clean clone must show every feature. Decisions never depend on generated text.

## 2026-10-10 — D-025: Protocol rules come from the real EMPOWER-Lung 1 protocol
**Decision:** AESI criteria (§9.4.3), SAE reporting (§9.4.2), the AE reporting window (§9.4.1) and prohibited/discouraged/permitted concomitant medications (§7.7) are encoded as JSON tables citing printed page numbers in `data/public/empower_lung1_protocol_excerpt.json` (verbatim excerpt of the public ClinicalTrials.gov PDF, sha256 recorded). Grade ≥ 3 on a potentially immune-related item starts a 24-hour AESI clock ("possible AESI, investigator to confirm"); a prohibited con-med floors the tier at 2; a discouraged steroid adds a coordinator flag with the protocol's exception text.
**Why:** The previous build only started a 24-hour clock on hospitalization and would miss a grade 3 rash, which this protocol requires reporting within 24 hours. Protocol awareness is the most credible thing to show a sponsor's judges.

## 2026-10-10 — D-026: Per-session camera consent removed; vitals demoted
**Decision:** The kiosk no longer asks for camera consent each session (consent is covered by the informed consent form at enrollment; sessions record `consent_basis: "enrollment_icf"`). Vitals stay as optional context; the UI, README and slides stop leading with "vitals as eSource".
**Why:** Mentor guidance; Presage's documented valid pulse range ends at 110 bpm, so the pulse ≥ 110 corroboration rules cannot fire on its real readings (recorded in WHAT_IT_GETS_WRONG).

## 2026-10-11 — D-027: Investigator-only fields are enforced on every write path
**Decision:** AESER, AEREL and INTERIM_IRAE can be set only by the investigator, whether through attribution, a draft edit, a packet edit or a query's "also correct the field". Other roles get 403 before any other validation.
**Why:** The safety reviewer showed a coordinator could set seriousness and causality through a plain draft edit.

## 2026-10-11 — D-028: Signing a report requires an attestation
**Decision:** Signing a packet requires `narrative_reviewed: true` and each open "information still needed" item to be marked "not available" by the investigator. The attestation (who, when, generated vs edited narrative, items marked unavailable) is stored on the packet and in the `packet.signed` audit event.
**Why:** Generated text must never leave the system without a person reviewing it (CLAUDE.md §00), and missing facts must be an explicit decision, not an oversight.

## 2026-10-11 — D-029: Overdue 24-hour clocks raise an alert once
**Decision:** A lazy sweep on reads of the queue, clocks and escalations records `clock.due_soon` / `clock.breached` audit events once per clock, writes a mock page, and appends an overdue reason to the existing escalation (an acknowledged escalation is not reopened; the new reason and page make the breach visible).
**Why:** A missed deadline must produce a system response, not just a red chip.

## 2026-10-11 — D-030: The admin role is not a clinical role; demo reset is gated
**Decision:** Admin can change settings, run eval, reset the demo (only when `ALLOW_DEMO_RESET` is true, the demo default) and act as the sponsor monitor for queries. Acknowledging escalations, confirming or rejecting drafts, editing or signing packets and answering queries require coordinator or investigator. A reset writes a genesis audit event that cites the previous chain head.
**Why:** Role separation is a readiness criterion; an unaudited wipe of the audit chain is not acceptable even in a demo.

## 2026-10-11 — D-031: Exports carry their evidence
**Decision:** JSON exports include `INTERIM_EVIDENCE` per record; the bundle adds `evidence.json` and a long-format `evidence.csv`, both hashed in the manifest. Domain CSVs stay flat and SDTM-ordered.
**Why:** "Every output shows its evidence" must survive leaving the system.

## 2026-10-11 — D-032: Discharge advice is not a hospitalization
**Decision:** The chart scanner's hypothetical cues now cover return precautions ("call 911 if", "seek emergency care if", "if you feel worse, go to the ER"), so they never start an SAE clock; an actual ER visit is still flagged. The answer key grew to 42 cases, all passing.
**Why:** Judge and tester finding (ISSUES #25): false 24-hour clocks erode trust in real ones.

## 2026-10-11 — D-033: The kiosk asks the urgent question first and stops early
**Decision:** The first question after the study ID is "Right now, are you having trouble breathing, or chest pain or tightness?" (Yes before No). Yes, or a Severe/Very severe shortness-of-breath severity answer, ends the check-in at once through `POST /sessions/{id}/urgent`: tier 3, on-call paged, answers so far saved (unanswered items are "not reported", never zero-filled). The stop screen text is fixed and table-driven (call 911; team alerted) with the site phone from `SITE_PHONE` (fictional 555-01xx default) under it.
**Why:** The playtest showed an urgent participant had to answer a dozen questions first. No advice beyond the fixed text, as before (CONTRACTS R5.1).

## 2026-10-11 — D-034: Kiosk free text and medication text are now read, in utterance mode
**Decision:** The "anything else" box and the medication box run through the deterministic scanner in utterance mode. Red-flag hits raise the tier floor to 3 with the quote as evidence; a request to talk to a person raises it to 2; a hospital mention against a "No" answer adds a conflict reason and suspects seriousness. Free text never lowers anything. Participant phrasings the playtest missed ("can't breathe", "chest feels tight") were added to the red-flag table, checked against a 34-utterance answer key.
**Why:** Reverses the old "free text is never read" stance (WHAT_IT_GETS_WRONG §8). The earlier worry was an unvalidated lexicon on participant language; the answer key and the quote-as-evidence rule are the validation we could afford overnight.

## 2026-10-11 — D-035: Several medications are split into separate entries
**Decision:** The kiosk sends `conmeds` (up to 10, each with a direction). A single text is also split on commas, semicolons, "and", "&", "+". Each entry becomes its own CM draft, matched separately.
**Why:** The playtest lost cephalexin because "cefalexin antibiotic pill and hydrocortisone cream" was matched as one string.

## 2026-10-11 — D-036: Gemini is a second reader that can only add, and only with a verbatim quote
**Decision:** For chart notes and call summaries, a Gemini reader proposes symptoms and medication changes. Code keeps a finding only if its quote is found in the source (exact, else whitespace/case-normalized, mapped back to original offsets), the term is in the closed CTCAE vocabulary (extended with about 20 immune-related terms), any count appears as digits in the quote, and a drug name appears in the quote. Rules then grade the finding; the model never sets a grade, tier, seriousness or causality. The merge is additive: scanner findings are never removed or changed. The note tier cap of 2 (D-017) is unchanged, and a Gemini-only finding never pages or stops a clock. Product line: "Gemini reads, rules decide, people confirm. Nothing is accepted without a word-for-word quote."
**Why:** The deterministic scanner missed hypothetical-free but unlisted terms such as hypothyroidism (ISSUES #29). This supersedes the "LLM chart-note reader is deferred" line in CLAUDE.md §00.

## 2026-10-11 — D-037: Judges' clones read a committed cache; no key needed
**Decision:** Model responses are cached in `data/llm_cache/gemini_reader.json`, committed, keyed by sha256 of prompt version, kind and text. A cache hit is used with no network; a miss with no key means the reader is off and says so. `INTERIM_LLM_MODE` is `auto`, `replay` or `off`. The key comes only from the environment and is never logged or committed.
**Why:** A clean clone must show every feature offline (CLAUDE.md §00). The cost is that judges see recorded output, which we state plainly (WHAT_IT_GETS_WRONG §26).

## 2026-10-11 — D-038: Model gemini-3.5-flash; synthetic data only
**Decision:** Default model `gemini-3.5-flash`, overridable by `INTERIM_GEMINI_MODEL`. gemini-2.5-flash is closed to new API keys. Only synthetic text is ever sent. A production deployment handling real participant text would need Vertex AI under a business associate agreement (BAA), data-residency review and a site privacy sign-off.
**Why:** A new key cannot call 2.5-flash; and the hackathon API tier is not a HIPAA-eligible path.

## 2026-10-11 — D-039: Stool counts are read as ranges
**Decision:** "6 or 7", "6-7" and "6 to 7" are read with the larger number winning (the basis says so), "watery/loose/liquid stools" count, and "a day/per day/daily" are accepted. Bands are unchanged (4-6 per day grade 2, 7 or more grade 3).
**Why:** The playtest phrase "6 or 7 watery stools a day" was under-graded. Taking the larger number errs toward the investigator looking, not away.

## 2026-10-11 — D-040: Read-aloud is pre-rendered, with browser voice as the fallback
**Decision:** Fixed kiosk strings are rendered to MP3 at build time (`scripts/build_kiosk_audio.py`, ElevenLabs) and played from a manifest. If a file is absent the browser's speech synthesis is used, else silence. Nothing calls a speech service at runtime.
**Why:** No runtime network calls (CLAUDE.md §13). The MP3s are pending a key (ISSUES #35), so the browser voice is what ships today.

## 2026-10-11 — D-041: Worklist vitals column and eval checkbox removed
**Decision:** The worklist no longer shows a vitals column or the "Include eval runs" checkbox (the `include_eval` URL parameter still works). This does not break the simulated-label rule: no vitals values are shown on the worklist, and MEASURED/SIMULATED stays beside every vitals value where values appear.
**Why:** Vitals are optional context (D-026), and the column crowded the demo view.

## 2026-10-11 — D-042: Kiosk defaults: camera off, Yes before No, bad login goes to sign-in
**Decision:** The camera is off until the participant opts in. Yes is always listed before No. An invalid or expired login returns to the sign-in page rather than showing an error on a dead screen.
**Why:** Playtest findings; opt-in matches the consent being covered at enrollment (D-026).

## 2026-10-11 — D-043: Confirmation texts go through a notifier, with a mock outbox by default
**Decision:** A check-in completion sends a plain-language confirmation text, and a coordinator's acknowledgment sends "Your study nurse has reviewed your check-in." Twilio sends real SMS only when all three `TWILIO_*` variables are set; otherwise texts are stored in the `messages` table and shown on Admin > Outbox. Texting consent is covered by the informed consent form signed at enrollment, like camera use (D-026). Sending happens after the check-in is committed and outside the write lock; a failure is recorded, never raised. The seed and the eval harness send nothing.
**Why:** Participants should know their check-in arrived and how to reach the team, without the text ever carrying a grade or clinical word. A clean clone has no keys, so the mock outbox keeps the feature visible and safe, the same way the mock EDC does.

