# `interim_api` — the system of record

FastAPI + SQLModel service behind the Interim kiosk and dashboard. It is the **only writer**
to the database. It runs every completed check-in through the pure rules engine
(`packages/rules`, import name `interim_rules`), persists what came out (SDTM-shaped drafts,
open AEs, escalations, SAE clocks, mock pages), keeps a hash-chained append-only audit log,
and serves the coordinator dashboard, exports and the evaluation harness.

No LLM, no generative component, no network call at runtime. Every clinical number the API
relies on comes from the rules tables (`packages/rules/data/*.json`); the API never hardcodes
a threshold. Every simulated value is labeled `Simulated` on the way out.

## Run

```bash
# from the repo root, once
uv pip install --python .venv/Scripts/python.exe -e "packages/rules[dev]" -e "apps/api[dev]"
cp .env.example .env            # nothing needs editing for the demo

# dev server (http://localhost:8000, OpenAPI at /docs)
cd apps/api && ../../.venv/Scripts/python.exe -m uvicorn interim_api.main:app --reload --port 8000

# seed / reset the demo data (the API also seeds an empty DB on start when SEED_ON_START=true)
python scripts/seed.py            # no-op when already seeded
python scripts/seed.py --reset    # wipe every table and reseed

# lint + tests
cd apps/api
../../.venv/Scripts/python.exe -m ruff check . && ../../.venv/Scripts/python.exe -m ruff format --check .
../../.venv/Scripts/python.exe -m pytest -q
```

Health check: `GET /api/v1/health` → `{"status":"ok","version":"0.1.0","vitals_source":"mock","db":"ok", ...}`.

## Environment

All values live in `.env.example`; none is secret for the demo.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./data/runtime/interim.db` | SQLAlchemy URL. A relative SQLite path is resolved against the **repository root** and the directory is created. Postgres: `postgresql+psycopg://user:pw@host/db` (install `psycopg`; everything else is portable: TEXT timestamps, TEXT JSON, no SQLite-only SQL). |
| `DEMO_PASSWORD` | `interim-demo` | Shared password of the three seeded users. |
| `AUTH_SECRET` | `change-me-in-production` | HMAC key for bearer tokens. Change it anywhere real. |
| `BRIDGE_TOKEN` | empty | When set, `POST /sessions/{id}/vitals` requires `X-Bridge-Token`. **Empty also means no HTTP caller may post `isMeasured: true`** (see "Measured vs simulated" below); the mock bridge never does, so the demo needs nothing here. A real sensor (Presage) needs the same value on the API and the bridge. |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origins for the web app in dev (nginx proxies in Docker, so CORS is moot there). |
| `SEED_ON_START` | `true` | Seed the demo data when the database is empty. |
| `DEMO_NCT_ID` | `NCT03088540` | The public registry record expected in `data/public/study.json` (a mismatch only logs a warning; the API never fetches at runtime). |
| `VITALS_SOURCE`, `VITALS_SCENARIO` | `mock`, `resting` | Defaults for the admin settings `vitals_source` / `mock_scenario`. Validated at startup against `interim_api/constants.py` (`mock|presage|arduino`; `resting|post_exercise|tachypnea|low_quality|dropout`). |
| `TOKEN_TTL_HOURS` | `12` | Bearer token lifetime. |
| `PUBLIC_DATA_DIR` | `<repo>/data/public` | Where `study.json` and the LIBTAYO label excerpt are read from. |

## Auth model (demo) and what production needs

* `POST /api/v1/auth/login {username, password}` with `coordinator`, `investigator` or `admin`
  and `DEMO_PASSWORD` returns `{token, role, display_name, expires_at}`.
* Token = `username.role.exp.sig`, `sig = HMAC-SHA256(AUTH_SECRET, "username.role.exp")`, stdlib
  only. Sent as `Authorization: Bearer <token>`. Roles are checked **server-side** on every
  dashboard endpoint (`require_role(...)`), the web app's route gating is cosmetic.
* Kiosk endpoints are unauthenticated. An **admin** token may accompany `POST /sessions` and
  `POST /sessions/{id}/complete` to use the override fields (`started_at_override`,
  `completed_at_override`, `settings_override`, `create_participant`, `is_eval`); anyone else
  sending them gets a 403 (DECISIONS.md D-004). The seed and the eval harness use these.
* The vitals bridge is identified by `X-Bridge-Token` when `BRIDGE_TOKEN` is set.

| Role | Can |
|---|---|
| coordinator | read everything; confirm / reject / edit drafts; acknowledge escalations; export; run eval |
| investigator | everything a coordinator can **plus** `PATCH /drafts/{id}/attribution` (`AEREL`, `AESER`); only this role can |
| admin | everything **plus** `PUT /admin/settings`, `POST /admin/reset`, the kiosk override fields |

What a production deployment needs instead: SSO (OIDC/SAML) with per-user identities in the
audit log, per-user password hashing or no passwords at all, token revocation / short-lived
refresh, TLS termination, a Postgres `DATABASE_URL`, and a secrets manager for `AUTH_SECRET`
and `BRIDGE_TOKEN`. None of that changes the endpoint contract.

## Endpoints (`/api/v1`)

| Method & path | Auth | What |
|---|---|---|
| `GET /health`, `GET /study`, `GET /items`, `GET /settings/public` | none | liveness; the public registry record + "All participants are synthetic."; the instrument straight from the rules tables; `{vitals_source, mock_scenario, simulated_as_measured, min_confidence, timing_gates, plausibility}` |
| `POST /sessions` | none (admin for overrides) | `{usubjid \| display_label, consent_camera}` → `Session`. Audits `session.started` + `session.consent`. |
| `GET /sessions/{id}` | none | `Session` |
| `POST /sessions/{id}/answers` | none | idempotent on `(session, item, attribute)`; a repeat **updates** and audits `answer.updated` with before/after; values validated against the item's attributes and scale |
| `POST /sessions/{id}/gates` | none | stored as `gate_*` answer rows (`attribute = "gate"`); verbatim text, never parsed. A re-submission (kiosk Back button) **updates rows in place** (`answer.updated` with before/after), blanks a gate that no longer applies (`cleared: true`) and never deletes a row, so every answer id in an earlier `gates.recorded` event stays resolvable |
| `POST /sessions/{id}/vitals` | `X-Bridge-Token` if set | `{samples: [camelCase VitalsSample]}` → stored snake_case; `vitals_status` stays `pending` until completion. `source` must be `mock|presage|arduino` (422 otherwise); 409 when the session has no camera consent; 422 when a simulated source claims `isMeasured`; 403 when `isMeasured: true` comes without a configured `X-Bridge-Token` or an admin token. Refusals are `vitals.rejected` audit events |
| `POST /sessions/{id}/complete` | none (admin for overrides) | 422 `Check-in incomplete` (with `missing[]`) unless every item attribute and both yes/no gates are answered; then runs `interim_rules.evaluate_checkin`; returns `{session_id, tier, tier_name, stop_screen, stop_screen_text?, checkin_url}` |
| `GET /queue` | any role | `?usubjid=&min_tier=&status=open\|all&include_eval=false&limit&offset`; tier desc, newest first |
| `GET /checkins/{session_id}` | any role | session, participant, answers, vitals (samples + summary + status), the full rules result, current drafts, escalation, SAE clock, `ae_links`, `rules_fired`, `why`, and `evidence_index` (every evidence id → the answer row / sample / rule / table / audit event it points at) |
| `GET /participants`, `GET /participants/{usubjid}`, `GET /participants/{usubjid}/timeline` | any role | label or USUBJID accepted; timeline = sessions, `symptom_series` per item, `vitals_series`, `open_aes`, `conmed_changes` |
| `GET /drafts/{id}`, `GET /drafts/{id}/versions` | any role | a draft; its lineage in version order |
| `POST /drafts/{id}/confirm`, `POST /drafts/{id}/reject` | coordinator+ | status changes (409 if not actionable) |
| `PATCH /drafts/{id}` | coordinator+ | **new version row** (`version + 1`, `supersedes_id`), old row → `superseded`; audit `draft.edited` with a diff; edited fields gain an `Evidence{kind: "edit", id: <audit event id>}`. Typed fields are validated server-side (`services/sdtm_fields.py`: `AETOXGR` within `composite_to_grade.json`'s 0..3, `AESER`/`AEONGO` Y/N, `AESTDTC`/`AEENDTC`/`VSDTC` ISO, `VSORRES` finite number, `VSSTAT` null/NOT DONE, `CMSTDTC`/`CMENDTC` dates, `INTERIM_TIER` 0..3) |
| `PATCH /drafts/{id}/attribution` | investigator | `AEREL` / `AESER` as a new version; an `AESER` value **stops the SAE clock of the draft's source** (check-in session or chart note) |
| `GET /escalations?acked=&usubjid=&include_eval=false`, `POST /escalations/{id}/ack` | any role | `seconds_to_ack` computed; ack is once. Eval-harness rows (participant `is_eval`) are hidden unless `include_eval=true`, like the queue |
| `GET /sae-clocks?active=true&include_eval=false`, `GET /pages?include_eval=false` | any role | live `seconds_remaining` (+ informational sponsor deadlines from `seriousness.json`); the mock pager log; eval rows hidden by default |
| `PATCH /sae-clocks/{id}/stop {decision, note?}` | investigator | records a seriousness decision **directly on a clock** (D-023): for a hospitalization/ER cue that drafted no AE (a note saying "admitted after a fall", a kiosk Yes to the hospital question with every item at zero) there is nothing to attribute, so attribution could never stop it. Audited `sae_clock.stopped` (payload `path: "sae_clock.stop"`); 409 once stopped |
| `GET /export/{AE\|VS\|CM}.{csv\|json}?status=confirmed\|all&per_sample=false&include_eval=false` | any role | SDTM column order (`STUDYID, USUBJID`, domain variables, then `INTERIM_*`); `VS` long-format per-sample rows with `per_sample=true`; each export is an `export.generated` event with a SHA-256. Eval data (session `is_eval` **or** participant `is_eval`, which is what hides the eval harness's chart-note drafts) stays out unless `include_eval=true` |
| `GET /export/bundle.zip?status=&include_eval=false` | any role | `AE/VS/CM .csv + .json`, `VS_samples.csv`, `audit_excerpt.json` (events for the exported entities + a verify result), `manifest.json` (sha256 + bytes per file, audit head hash, version) |
| `POST /mock-edc/{domain}` | any role | validates the column set (domain SDTM variables + any `INTERIM_*`) and the typed fields with the **same validator as `PATCH /drafts`** (lenient about CSV strings), returns `{ack_id, received, accepted_at}`; nothing leaves the system |
| `GET /audit`, `GET /audit/verify` | any role | newest first with `entity_type/entity_id/action/actor_id` filters; verify recomputes every hash |
| `GET /eval/personas`, `POST /eval/run`, `POST /eval/run-custom`, `GET /eval/results` | any role | see "Eval" |
| `GET /reference/label`, `GET /reference/ctcae` | any role | LIBTAYO adverse-reactions text (public openFDA label excerpt, reference only); the 10 CTCAE v5.0 rows with mock MedDRA codes |
| `GET /admin/settings` / `PUT /admin/settings` | any role / admin | `vitals_source`, `mock_scenario`, `simulated_as_measured` (default OFF, with a warning); PUT validates both names against `known_sources` / `known_scenarios` (returned by GET; `interim_api/constants.py`, the twin of the bridge's `SCENARIO_NAMES`) and audits before/after |
| `POST /admin/reset {reseed}` | admin | drop + recreate every table, fresh genesis event (`demo.reset`), reseed |

Errors are RFC 7807 `application/problem+json`: `{type, title, status, detail, instance}` plus
`errors[]` on 422s. Lists paginate with `?limit=&offset=` → `{items, total, limit, offset}`.

### Chart notes (`/notes`, `/scan`; CONTRACTS R2.4, decisions D-014 / D-017)

The second source of AE evidence: a clinician note pasted or posted by the coordinator. The
scanner is `interim_rules.chartscan` (ported from `omer-khawar/ae-checkin-agent`, Omer Khawar,
MIT): regular expressions and lookup tables in `packages/rules/data/chartscan_*.json`, NegEx-style
negation / history / hypothetical exclusion, **no LLM**. `services/notes.py` turns its findings
into the same rows a check-in produces, through the same `apply_result`.

| Method & path | Auth | What |
|---|---|---|
| `POST /scan {text, ref_date?}` | any role | dry run: the `ScanResult` (`symptoms`, `excluded_symptoms`, `meds`, `excluded_meds`, `red_flags`, each with `span_start`/`span_end` into `text`) plus `rules_fired`, `why`, `escalation_level`, `seriousness_suspected` and the `tier` the note would get. Nothing stored, nothing audited; its `chart_note` evidence pointers carry `id: "scan"` and `ts: null` because there is no note to point at. |
| `POST /notes {usubjid \| display_label, note_date, author, note_type, text, ingested_at_override?}` | coordinator / investigator / admin (`ingested_at_override` admin-only) | stores the note verbatim (`ChartNote`), audits `note.ingested`, scans, audits `note.scanned` + one `rule.fired` per rule, then drafts: one **AE** per kept symptom (`AETERM` = the quoted words, `AEDECOD` = CTCAE v5 term, `AETOXGR` = grade hint, `AESTDTC` = onset date if the note states one else `note_date`, `INTERIM_SOURCE = "chart_note"`, `INTERIM_GRADE_BASIS`, `INTERIM_STATED_ONSET_DATE`, `INTERIM_RESOLVED_CUE`), one **CM** per kept medication (`CMTRT` = quoted words, `CMDECOD` = lexicon generic, `CMSTDTC` on started/changed, `CMENDTC` on stopped, `INTERIM_MATCH_KIND = "lexicon"`). Returns `{note, scan, drafts, escalation, sae_clock, rules_fired, why, ae_links, evidence_index, tier, tier_name}` (201). **Duplicate guard**: the same participant + `note_date` + verbatim `text` already ingested (whatever the `author` field says) is a 409 `Duplicate note` problem carrying `existing_note_id`, so a double-click or a retried request never stores and drafts a note twice. |
| `GET /notes?usubjid=&include_eval=false&limit&offset` | any role | newest ingestion first; `ChartNoteListItem` = note + `n_symptoms`, `n_meds`, `n_red_flags`, `draft_counts`, `escalation_acked`, `has_sae_clock` |
| `GET /notes/{id}` | any role | the same shape as `POST /notes` |

Rules of the note desk:

* **Evidence**: every draft field points at a `{kind: "chart_note", id: note_id, ts: ingested_at,
  note: quote, span_start, span_end}` pointer (`text[span_start:span_end] == quote`), plus the
  `chartscan.*` rule and the lexicon table it came from; `evidence_index` resolves them all.
* **Tier**: 2 when the scan found an urgent/emergency red flag or a hospitalization/ER mention,
  1 when it produced anything to review, 0 when nothing was found. A note **never** reaches
  Tier 3, never pages and never shows a stop screen (D-017): it is retrospective.
* **Seriousness**: a hospitalization/ER cue sets `seriousness_suspected` and starts the SAE clock
  with `site_awareness_at = ingested_at`, the moment the site read the note. An investigator's
  `AESER` on any of the note's AE drafts stops it (`PATCH /drafts/{id}/attribution`); when the
  cue came with no symptom finding (no AE draft to attribute), the investigator stops the clock
  directly with `PATCH /sae-clocks/{id}/stop` (D-023).
* **Cross-source de-duplication**: the same `AEDECOD` already open for the participant, from a
  check-in or an earlier note, within `dedup.json`'s window is a follow-up (`is_followup`,
  `linked_ae_open_id`, `INTERIM_FOLLOWUP_OF`, `AESTDTC` of the original) and extends the
  `AEOpen` row (`last_note_id`); the reverse direction (note first, kiosk later) works the same
  because `build_engine_input` loads every open AE regardless of source. A note is the one
  source that can legitimately be *read before* a later report of the same term (an admin
  backdates `ingested_at` for the seed or a late-filed outside record), so `services/notes.py`
  applies the window **in either direction** (`find_open_ae_for_note`; the dedup rule's inputs
  say `read_before_last_report: true` and `days_since_last_report` is negative) and the open
  AE's `last_reported_at` never moves backwards. Without this a backdated note would open a
  second concurrent AE for the same term.
* **`AESTDTC` precision**: a new note AE carries the calendar date the note supports
  (`2026-10-02`, a partial ISO 8601 date, which SDTM allows); a follow-up carries the linked
  AE's `first_reported_at`, a full timestamp when a kiosk check-in opened it. One export column
  therefore mixes the two precisions on purpose: the API never fabricates a time of day it does
  not have. When a follow-up note states an onset **earlier** than the AE's first report, the
  draft keeps the first report as `AESTDTC` (CONTRACTS §1.8) and says so:
  `INTERIM_STATED_ONSET_DATE`, `INTERIM_ONSET_BEFORE_FIRST_REPORT = true`, the quote on the
  `AESTDTC` evidence, and a why line ("the note dates onset to …, coordinator to decide"). Moving
  the start date of a confirmed AE is a human edit (`PATCH /drafts/{id}`), not an inference.
* **"Resolved / improved"** in the text is flagged (`INTERIM_RESOLVED_CUE = true`, a why line)
  for the coordinator to set `AEENDTC`; the API never proposes an end date itself.
* **Queue and timeline**: `GET /queue` lists notes next to check-ins (`source: "chart_note"`,
  `session_id: null`, `note_id`, `completed_at = ingested_at`, `vitals_status: "unavailable"`),
  sorted tier desc then newest first across both; `GET /participants/{usubjid}/timeline`
  carries `notes[]` (scan summary, drafts, escalation, clock) and note-sourced
  `conmed_changes[]` (`source: "chart_note"`, `note_id`).
* **Exports** label note records `INTERIM_RECORD_SOURCE = "chart_note"` with `INTERIM_NOTE_ID`
  set and `INTERIM_SESSION_ID` null.

## How a check-in is evaluated

```
POST /sessions ─ answers ─ gates ─ vitals ─ POST /complete
                                              │
              build_engine_input()  ──▶  interim_rules.evaluate_checkin()
              (real Answer / VitalsSample ids,        │
               open AEs for dedup, settings,          ▼
               next AESEQ, NCT id)           CheckInResult (grades, tier, drafts, rules_fired, why)
                                                      │
                            session.completed + one rule.fired event per rule
                                                      │
                            apply_result(): Draft rows (+ AEOpen new/extended),
                                            Escalation (tier ≥ 2) + Page (tier 3),
                                            SAEClock (seriousness suspected)
```

Details worth knowing:

* **Open AEs** are created when an AE is drafted (not when it is confirmed), so the live demo's
  repeat report links as a follow-up even before a coordinator clicks. Rejecting the draft that
  opened an AE closes it; editing an AE to `AEONGO = "N"` or a non-null `AEENDTC` closes it too.
* **`AESEQ`** continues per participant across sessions (`max(AESEQ) + 1` over all AE draft rows).
* **Response timestamps** passed to the engine are the server receipt times, except for an
  admin-backdated session (seed / eval) where the admin-supplied `ts_client` is used so that
  `AESTDTC` lands inside the backdated window. `ts_server` is always the truthful receipt time.
* **`vitals_status`** on the session is `pending` while open, `declined` whenever the camera was
  refused (no sample is accepted for such a session and none is passed to the engine), else the
  engine's `VitalsAssessment.status`.
* **A check-in must be complete** to finish: `missing_instrument_parts()` lists every item
  attribute and yes/no gate without an answer and `/complete` refuses with 422 + `missing[]`
  until the list is empty, so a crashed kiosk or a curl user can never produce a record that
  looks like a clean Tier 0 "Log". The eval harness records an explicit 0 for anything a
  persona omits (answer-key convention: omitted = none / never).

## Measured vs simulated: who may say "measured"

The rules engine labels a sample from a `simulated_sources` source (`mock`) as simulated
whatever its flag says (D-022), but every *other* source would count as measured by default.
The API closes that gap at the door (`POST /sessions/{id}/vitals`):

| Sample | Result |
|---|---|
| `source` not in `mock | presage | arduino` | 422 (schema) |
| `source: mock`, `isMeasured: true` | 422 `Simulated source claims measured` |
| `isMeasured: true` without a configured `BRIDGE_TOKEN` presented as `X-Bridge-Token`, and without an admin bearer token | 403 `Measured claim not verifiable` |
| session created with `consent_camera: false` | 409 `No camera consent` |

Each refusal is a `vitals.rejected` audit event (committed before the 4xx so the chain keeps
it). In-process callers (the seed and the eval harness, both admin-driven and eval-only) may
claim measured: that is how a "build your own persona" run can say *suppose the sensor measured
breathing 27* and show the corroboration rule firing. To run a real sensor, set the same
`BRIDGE_TOKEN` on the API and the bridge; with it empty the dashboard can never show MEASURED.
* **The global `simulated_as_measured` toggle** and a per-session admin `settings_override`
  both feed `RuleSettings`; the effective settings are stored on the session (`settings_json`)
  and shown in the detail page.
* **One writer at a time.** Every mutating request runs under a process-wide lock
  (`Database.write_scope`) so `read audit head → hash → insert` can never interleave. SQLite
  serializes writers anyway; a Postgres deployment would replace the lock with an advisory lock
  on the audit head.

## Audit chain

Table `audit_events`: `{id, seq, ts_utc, actor_id, actor_role, action, entity_type, entity_id,
payload, prev_hash, hash}` with

```
hash = sha256(prev_hash + canonical_json({id, seq, ts_utc, actor_id, actor_role, action,
                                          entity_type, entity_id, payload}))
canonical_json = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
genesis prev_hash = "0" * 64 ; seq strictly increasing
```

Append-only is enforced in code, not by convention: SQLAlchemy `before_update` /
`before_delete` listeners on the model and a Core `before_execute` guard on the engine raise
`AuditImmutableError` for any UPDATE or DELETE aimed at `audit_events`. `GET /audit/verify`
walks the chain in `seq` order, recomputes every hash and reports `first_broken = {index, seq,
id, expected_hash, actual_hash, reason}` for the first sequence gap, broken link or changed
row (the test suite edits a payload with raw `sqlite3` and checks the index).

Actions emitted: `session.started, session.consent, answer.recorded, answer.updated,
gates.recorded, vitals.batch, vitals.rejected, session.completed, rule.fired (one per
RuleFired, payload = the RuleFired), draft.created, drafts.applied, draft.edited,
draft.confirmed, draft.rejected, draft.attribution, ae_open.closed, escalation.created,
escalation.paged, escalation.acked, sae_clock.started, sae_clock.stopped, export.generated,
mock_edc.posted, settings.changed, demo.seed, demo.seeded, demo.reset, eval.run, auth.login,
note.ingested, note.scanned` (a note's rules are `rule.fired` events on entity type `note`; its
drafts, escalation and SAE clock carry `note_id` and `source: chart_note`). The vocabulary is closed:
`audit.AUDIT_ACTIONS` lists it and `append_event` refuses anything else. Beyond the CONTRACTS
§2.3 list the API adds `vitals.rejected` (a refused batch), `drafts.applied` (one summary line
per `apply_result()` on the originating entity), `ae_open.closed`, `demo.seed` and
`demo.seeded`; drafts edited or attributed carry an `Evidence{kind: "edit"}` pointer, which is
also an addition to the contract's evidence-kind union. Kiosk events carry the participant
(`actor_role = participant`); the bridge is `vitals-bridge` / `system`; an admin override is
recorded in the payload as `override_by`.

## Eval

`packages/rules/data/personas.json` is the answer key (29 personas: 24 shipped + 5 hidden
"judge" personas). `POST /eval/run` replays each one **through the same service functions the
kiosk endpoints use** (`create_session → record_answer → record_gates → record_vitals →
complete_session`) as a fresh eval participant (`is_eval = true`, hidden from the queue unless
`include_eval=true`). `setup.prior_checkins` are replayed first, backdated with the admin
override, and their AE drafts confirmed, so de-duplication is exercised for real. Vitals
samples are materialized from `tsOffsetS` relative to a session start 180 s before completion.

Every key in `expected` the harness knows is compared (`grades`, `max_grade`, `tier`,
`stop_screen`, `red_flag_tier_floor`, `corroboration_bump`, `rules_fired_includes/excludes`,
`sae_clock_started` (+ `site_awareness_at` / `due_at` arithmetic), `seriousness_suspected`,
`ae_drafts`, `vs_drafts`, `vs_not_done`, `cm[]` (verbatim, cmdecod, min_confidence,
match_kind, distance, direction → CMSTDTC/CMENDTC), `dedup_followups` (with the linked open
AE's dates), `vitals_status`), plus invariants (stop screen ⇔ tier 3, AE drafts carry the
session tier and are provisional, simulated VS rows say Simulated). Unknown keys are listed
as notices, never failures. `counterfactuals[]` are run as separate participants and must
change the tier without touching a grade.

The result (`EvalResults`: per-tier precision / recall / F1, a 4×4 grade confusion matrix,
dedup / SAE-clock / con-med correctness, per-persona mismatches, a Markdown rendering) is
persisted (`GET /eval/results`) and audited. A second section, `chartscan` (R2.4), scores the
chart-note scanner: `answer_key` = `interim_rules.chartscan.evaluate_answer_key()` over all
answer-key cases (AE-term and medication precision / recall / F1, change accuracy, escalation
recall, over-escalations, possible-SAE recall; pass = every case exact) and `via_api` = the eight
synthetic notes ingested through the `/notes` service for fresh eval participants, checking the
drafted terms and meds, the tier (2 at most), the escalation row, the SAE clock at ingestion and
the cross-note follow-up link (N7 onto N1). `all_passed` is true only when personas and scanner
both pass; the Markdown carries a "Chart-note scanner" section. `POST /eval/run-custom {persona}` runs one ad-hoc
persona (the dashboard's "build your own" form) and returns the full `CheckInResult` with
`rules_fired` and `why`, plus `mismatches` when the persona carries `expected`. The shipped
personas pass 100% (`tests/test_eval.py`).

## Seed

`interim_api/seed.py` (CLI wrapper `scripts/seed.py`) creates the study from
`data/public/study.json`, the three users, and twelve synthetic participants `P-001..P-012`
with 2-4 prior check-ins over the last 60 days per the profile table in
`data/synthetic/README.md` §4.3 (34 check-ins; Tier 2 on exactly two; P-007 has an open Cough
AE from 5 days ago confirmed by the coordinator; con-med changes on four participants; P-012's
middle session declines the camera). Deterministic with `random.Random(20261010)`; only ULIDs
and the absolute clock differ between runs. Simulated `resting` vitals are generated in pure
Python (AR(1) noise, confidence ramp, bridge timing gates) and posted in batches as the bridge
would. One documented deviation from README §4.5: samples carry `window_s` 12 / 30 / 60 by
which metrics are published (the bridge contract), not a flat 30, so the seeded HRV rows are
usable rather than NOT DONE.

After the check-ins the seed ingests the eight synthetic chart notes (README §4.6) through the
`/notes` service as the coordinator with the admin backdating override. The notes are read from
the rules package's answer key (`chartscan.answer_key()`, identical to
`data/synthetic/chart_notes.json` by test) and **re-anchored to the seed clock**: each keeps its
distance from the answer key's reference date (`utterance_ref_date`, 2026-10-10), so N1 is always
5 days ago and N3/N7 yesterday, and the cross-source follow-up links hold on any seed date. P-002's
second check-in is 6 days ago so note N2 (2 days ago) links its Rash and Pruritus as follow-ups;
N7 links onto N1. N6 (the ED visit) keeps its note date two days back but is **read by the site
about 3 hours before the seed clock** (`NoteSeed.ingested_hours_before_seed`; notes are ingested
in `ingested_at` order, so N6 goes last): its SAE clock starts at that ingestion and the dashboard
shows a live ~21 h countdown on first load instead of an already-overdue one; it runs until an
investigator records `AESER` on one of N6's AE drafts. N6's Tier 2 escalation is acknowledged;
N3's Tier 2 escalation is left open for the demo. Note drafts stay `draft`.

## Layout

```
interim_api/
  main.py          app factory, lifespan (create_all + seed-if-empty), CORS, routers
  settings.py      pydantic-settings; DATABASE_URL resolution
  models.py        SQLModel tables (CLAUDE.md §6 + User, Page, EvalRun, ChartNote)
  db.py            engine, write lock, append-only guard for audit_events
  audit.py         canonical JSON, hash chain, verify
  auth.py          HMAC tokens, role dependencies
  problems.py      RFC 7807 handlers
  schemas.py       request bodies (camelCase vitals alias)
  seed.py          the demo seed (through the service layer)
  services/        sessions (kiosk flow), checkins (engine input + apply_result),
                   notes (chart-note ingest/scan/drafts, R2.4), drafts (review),
                   dashboard (queue/detail/timeline), exports, evaluation,
                   settings_svc, participants, reference, common (serializers)
  routers/         thin HTTP adapters, one per area
tests/             pytest + httpx TestClient, a fresh SQLite file per test
```
