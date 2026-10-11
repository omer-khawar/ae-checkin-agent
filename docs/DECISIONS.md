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
