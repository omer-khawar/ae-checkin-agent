# Interim — Interface Contracts

> This document pins the shapes that cross package boundaries so the rules engine, API, vitals bridge, web app, seed script and eval harness can be built in parallel. **Where this file and running code disagree, fix the code, not the contract, unless the change is logged in `docs/DECISIONS.md`.** Everything here is derived from `CLAUDE.md`; read that first.

Conventions used everywhere:
- IDs are ULIDs (26-char Crockford base32). Python: `python-ulid`; TypeScript: `ulid`.
- Timestamps are UTC ISO-8601 strings with a `Z` suffix and millisecond precision, e.g. `2026-10-10T18:04:12.345Z`. UI displays local time with UTC on hover.
- JSON produced by the **API** is `snake_case`. JSON produced by the **bridge** (the `VitalsSample` contract in `CLAUDE.md` §7.1) is `camelCase`. The API accepts `camelCase` on the vitals POST (Pydantic aliases) and stores/returns `snake_case`.
- Every API response that includes a derived value also includes `evidence` and `rules_fired`.
- Errors are RFC 7807 `application/problem+json`: `{type, title, status, detail, instance}`.
- Lists paginate with `?limit=&offset=` and return `{items: [], total, limit, offset}`.
- The word **simulated** appears beside every simulated value, in UI and in exports.

---

## 1. Rules package (`packages/rules`, import name `interim_rules`)

Pure Python 3.12, no I/O except reading its own JSON tables from `packages/rules/data/` (resolved relative to the package file; installed editable). No FastAPI, no network, no datetime.now() inside rules (the caller passes `now`). Frozen dataclasses. `mypy --strict` clean. 100% branch coverage target on rule modules.

### 1.1 Data tables (`packages/rules/data/*.json`)
Every table has top-level `"source"` and `"rationale"` strings. Code reads tables; code never hardcodes a clinical number.

| File | Content |
|---|---|
| `proctcae_items.json` | The 10 items. Each: `id`, `label` (participant-facing question stem), `short_label`, `ctcae_term` (= `AEDECOD`), `attributes` (ordered subset of `frequency`,`severity`,`interference`,`presence`), `response_options` per attribute (label → int), `recall_window: "in the last 7 days"`, `order`. Items: `shortness_of_breath` (severity, interference), `cough` (severity, interference), `fatigue` (severity, interference), `nausea` (frequency, severity), `diarrhea` (frequency), `rash` (presence), `itching` (severity), `joint_pain` (severity, interference), `fever_or_chills` (presence; optional `temp_c` free numeric), `mouth_sores` (severity, interference). |
| `gate_questions.json` | The 3 gate questions: `hospitalization` (yes/no), `conmed` (yes/no + verbatim text + direction started/stopped/both), `other` (free text). Participant-facing wording lives here. |
| `composite_scoring.json` | Basch et al. 2020 composite grading tables. Keys: `three_attribute` (frequency, severity, interference → 0..3), `two_attribute_freq_sev`, `two_attribute_sev_int`, `single_attribute` (0→0, 1→1, 2→2, 3→3, 4→3), `presence` (0→0, 1→1). If the published lookup cannot be reproduced verbatim, the table must say so in `rationale` and `docs/WHAT_IT_GETS_WRONG.md` must mention it. |
| `composite_to_grade.json` | `{"0": 0, "1": 1, "2": 2, "3": 3}`; `max_assignable_grade: 3`. |
| `red_flags.json` | Four rules with `id`, `description`, `condition` (declarative, see 1.4), `tier_floor`. |
| `vitals_corroboration.json` | `min_confidence: 0.6`, `plausibility` bounds (pulse 35–180, breathing 5–45), `max_tier_bump: 1`, and the three corroboration rules with `id`, `description`, `condition`, `reason` text verbatim from CLAUDE.md. |
| `escalation_ladder.json` | Tiers 0..3 with `name`, `action`, `sla`, `triggers`. Tier 3 `stop_screen_text` verbatim from CLAUDE.md §3.4(e). |
| `seriousness.json` | ICH E2A criteria list; `site_to_sponsor_hours: 24`; informational sponsor clocks `{fatal_or_life_threatening_days: 7, other_serious_days: 15, source: "21 CFR 312.32"}`. |
| `ctcae_terms.json` | For each of the 10 items: `aedecod` (CTCAE v5.0 term name), `meddra_code_mock` (string, clearly labeled mock), `grade_definitions` {1..5} text extracted from CTCAE v5.0. |
| `medlist.json` | See §1.6 schema. Seeded by hand first; `scripts/fetch_public.py --build-medlist` regenerates it from openFDA in the same schema. |
| `dedup.json` | `window_days: 7`. |
| `rules_catalog.json` | Every rule id the engine can emit, with `category` and `description_template`. The eval personas reference these ids. |
| `personas.json` | See §6. |

### 1.2 Input types (`interim_rules.models`)
```python
Attribute = Literal["frequency", "severity", "interference", "presence"]

@dataclass(frozen=True)
class ProResponse:
    answer_id: str          # evidence pointer → Answer.id
    item_id: str
    attribute: Attribute
    value: int              # 0..4 (presence: 0/1)
    ts: str                 # ISO UTC (server receipt time)

@dataclass(frozen=True)
class GateAnswers:
    hospitalization: bool
    hospitalization_answer_id: str | None
    conmed_changed: bool
    conmed_text: str | None            # verbatim, never altered
    conmed_direction: Literal["started", "stopped", "both"] | None
    conmed_answer_id: str | None
    other_text: str | None             # verbatim, never parsed
    other_answer_id: str | None
    temp_c: float | None               # optional measured temperature typed by participant
    temp_answer_id: str | None

@dataclass(frozen=True)
class VitalsSampleIn:
    sample_id: str
    ts_utc: str
    source: str                        # "mock" | "presage" | "arduino"
    is_measured: bool
    pulse_bpm: float | None
    pulse_conf: float | None
    breathing_bpm: float | None
    breathing_conf: float | None
    hrv_rmssd_ms: float | None
    hrv_conf: float | None
    window_s: float
    quality_flags: tuple[str, ...]

@dataclass(frozen=True)
class OpenAE:                          # an existing open AE draft for this participant (dedup input)
    ae_open_id: str
    aedecod: str
    first_reported_at: str
    last_reported_at: str
    last_session_id: str

@dataclass(frozen=True)
class RuleSettings:
    simulated_as_measured: bool = False
    min_confidence: float | None = None   # None → table default
    dedup_window_days: int | None = None  # None → table default

@dataclass(frozen=True)
class CheckInInput:
    session_id: str
    studyid: str
    usubjid: str
    completed_at: str                  # "now" for this evaluation, passed by caller
    responses: tuple[ProResponse, ...]
    gates: GateAnswers
    vitals: tuple[VitalsSampleIn, ...]
    open_aes: tuple[OpenAE, ...]
    settings: RuleSettings
    next_aeseq: int = 1                # caller-provided sequence start for AESEQ
```

### 1.3 Output types
```python
EvidenceKind = Literal["pro_response", "vitals_sample", "gate_answer", "rule", "table"]

@dataclass(frozen=True)
class Evidence:
    kind: EvidenceKind
    id: str                 # answer_id / sample_id / rule_id / table file name
    ts: str | None
    note: str               # human-readable, e.g. "shortness_of_breath.severity = 2 (Moderate)"

@dataclass(frozen=True)
class RuleFired:
    rule_id: str            # from rules_catalog.json
    category: Literal["scoring","grading","red_flag","vitals_quality","corroboration","escalation","seriousness","conmed","dedup","drafting"]
    description: str        # plain English with the actual values substituted
    inputs: dict[str, object]
    effect: str             # e.g. "tier floor = 2", "tier +1 (2 → 3)", "AETOXGR = 2"
    evidence: tuple[Evidence, ...]

@dataclass(frozen=True)
class ItemResult:
    item_id: str
    label: str
    aedecod: str
    composite: int          # 0..3
    provisional_grade: int  # 0..3
    responses: tuple[ProResponse, ...]
    evidence: tuple[Evidence, ...]

@dataclass(frozen=True)
class VitalsSummary:
    n_samples: int
    n_eligible: int
    pulse_median: float | None
    pulse_max: float | None
    breathing_median: float | None
    breathing_max: float | None
    hrv_median: float | None
    is_measured: bool               # True only if every eligible sample is measured
    source: str | None
    first_ts: str | None
    last_ts: str | None

@dataclass(frozen=True)
class VitalsAssessment:
    status: Literal["ok","unavailable","low_quality","implausible","simulated_ignored"]
    eligible_sample_ids: tuple[str, ...]
    ignored: tuple[tuple[str, str], ...]   # (sample_id, reason)
    summary: VitalsSummary | None
    rules_fired: tuple[RuleFired, ...]

@dataclass(frozen=True)
class ConMedMatch:
    verbatim: str
    matched_name: str | None
    match_kind: Literal["exact","case_insensitive","levenshtein","unmatched"]
    confidence: float       # 1.0 exact/ci, 1 - d/len for levenshtein, 0.0 unmatched
    distance: int | None
    candidates: tuple[tuple[str, int], ...]  # top 3 (name, distance)

@dataclass(frozen=True)
class SAEClock:
    site_awareness_at: str
    due_at: str                       # +24h
    informational: dict[str, str]     # sponsor 7/15-day deadlines, computed, labeled informational

@dataclass(frozen=True)
class DraftField:
    name: str                         # SDTM variable name
    value: object
    evidence: tuple[Evidence, ...]

@dataclass(frozen=True)
class DraftRecord:
    domain: Literal["AE","VS","CM"]
    fields: tuple[DraftField, ...]
    linked_ae_open_id: str | None     # set when dedup linked this to an existing open AE
    is_followup: bool

@dataclass(frozen=True)
class CheckInResult:
    items: tuple[ItemResult, ...]
    max_grade: int
    base_tier: int
    red_flag_tier_floor: int
    corroboration_bump: int           # 0 or 1
    escalation_tier: int              # 0..3
    stop_screen: bool                 # tier == 3
    page_oncall: bool                 # tier == 3
    seriousness_suspected: bool
    sae_clock: SAEClock | None
    conmed: ConMedMatch | None
    vitals: VitalsAssessment
    drafts: tuple[DraftRecord, ...]
    rules_fired: tuple[RuleFired, ...]   # ordered: scoring → grading → red flags → vitals → corroboration → escalation → seriousness → conmed → dedup → drafting
    why: tuple[str, ...]                 # one plain-English line per rule fired, same order
```
Entry point: `interim_rules.engine.evaluate_checkin(inp: CheckInInput) -> CheckInResult`, plus `interim_rules.serialize.result_to_dict(result) -> dict` (JSON-safe) and `interim_rules.serialize.input_from_dict(d) -> CheckInInput`.

Sub-modules, each independently testable: `tables`, `scoring` (composite), `grading`, `red_flags`, `vitals` (plausibility, confidence, measured gate, summary), `corroboration`, `escalation`, `seriousness`, `conmed`, `dedup`, `drafting` (SDTM), `engine`, `serialize`.

### 1.4 Rule ids (must exist in `rules_catalog.json`)
```
score.composite.<item_id>          grading   composite computed for an item (emitted only when composite ≥ 1)
grade.provisional.<item_id>        grading   provisional grade assigned (emitted only when grade ≥ 1)
redflag.severe_dyspnea             red_flag  shortness_of_breath severity ≥ 3 → tier floor 3
redflag.fever_with_severe          red_flag  fever_or_chills present AND any item severity ≥ 3 → tier floor 2
redflag.hospitalization            red_flag  hospitalization/ER = yes → tier floor 3, seriousness
redflag.other_text_with_severe     red_flag  other_text non-empty AND any item severity ≥ 3 → tier floor 2, "human read"
vitals.unavailable                 vitals_quality  no samples
vitals.low_quality                 vitals_quality  no sample reaches min confidence
vitals.implausible                 vitals_quality  one or more samples outside plausibility bounds (ignored), one per sample
vitals.simulated_ignored           vitals_quality  samples are simulated and simulated_as_measured is OFF → not eligible for corroboration
vitals.simulated_as_measured       vitals_quality  demo toggle ON → simulated samples treated as measured (warning)
vitals.summary                     vitals_quality  summary computed over eligible samples
corr.tachypnea_dyspnea             corroboration   shortness_of_breath composite ≥ 2 AND breathing ≥ 24 → +1 tier
corr.tachycardia_dyspnea           corroboration   shortness_of_breath composite ≥ 2 AND pulse ≥ 110 → +1 tier
corr.tachycardia_fever             corroboration   fever_or_chills present AND pulse ≥ 110 → +1 tier
tier.base                          escalation      base tier from max grade
tier.redflag_floor                 escalation      floor applied from red flags
tier.corroboration_bump            escalation      +1 applied (max one step, cap 3)
tier.final                         escalation      final tier with action text; stop_screen/page when 3
sae.clock_started                  seriousness     hospitalization → seriousness_suspected, site_awareness_at, due_at
conmed.exact | conmed.case_insensitive | conmed.levenshtein | conmed.unmatched   conmed
dedup.followup_linked              dedup           same AEDECOD open within window → follow-up, no new AE
dedup.new_ae                       dedup           no open AE within window → new AE
draft.ae | draft.vs | draft.cm     drafting        one per draft record
```
Corroboration uses the **maximum** eligible breathing/pulse value in the session (documented in the table `rationale`). Corroboration rules fire only when `VitalsAssessment.status == "ok"`.

### 1.5 Tier algorithm (deterministic)
```
max_grade = max(item.provisional_grade)
base_tier = 0 if max_grade ≤ 1 else (1 if max_grade == 2 else 2)
floor     = max(red_flag.tier_floor for fired red flags, default 0)
tier      = max(base_tier, floor)
bump      = 1 if (any corroboration rule fired and vitals.status == "ok") else 0
tier      = min(3, tier + bump)        # note: Tier 2 + corroboration → Tier 3 per CLAUDE.md
stop_screen = page_oncall = (tier == 3)
```
Vitals never touch `provisional_grade`.

### 1.6 `medlist.json` schema
```json
{
  "source": "openFDA drug label API (api.fda.gov/drug/label.json) brand/generic names; hand-curated core list merged in",
  "rationale": "Small bundled list for deterministic string matching. NOT RxNorm. Not a formulary.",
  "built_at": "2026-10-10T00:00:00Z",
  "is_rxnorm": false,
  "entries": [
    {"name": "loratadine", "kind": "generic", "generic": "loratadine"},
    {"name": "claritin",   "kind": "brand",   "generic": "loratadine"}
  ]
}
```
Names are lowercase. Matching returns `matched_name` = the entry's `generic` (so brand "claritin" normalizes to "loratadine"). The hand-curated core list that MUST be present regardless of the openFDA pull: acetaminophen, tylenol, ibuprofen, advil, motrin, naproxen, aleve, aspirin, loratadine, claritin, cetirizine, zyrtec, diphenhydramine, benadryl, loperamide, imodium, omeprazole, prilosec, pantoprazole, famotidine, pepcid, ondansetron, zofran, prednisone, dexamethasone, amoxicillin, azithromycin, ciprofloxacin, doxycycline, metformin, lisinopril, amlodipine, atorvastatin, levothyroxine, metoprolol, hydrocortisone, triamcinolone, gabapentin, sertraline, albuterol, melatonin, vitamin d, multivitamin.

### 1.7 Con-med matcher
`match_conmed(text: str, medlist=None) -> ConMedMatch`. Normalize: strip, collapse whitespace, lowercase for comparison only. Order: exact → case-insensitive → Levenshtein ≤ 2 (ties → shortest name, then alphabetical). Multi-word input: try the whole string, then each whitespace token ≥ 4 chars; keep the best. Confidence: exact/ci = 1.0; Levenshtein = round(1 - d / max(len(input), len(candidate)), 2); unmatched = 0.0. No other NLP.

### 1.8 SDTM drafts
Field lists exactly as in `CLAUDE.md` §3.5. Additional conventions:
- `STUDYID` = the demo study's `study_id` (e.g. `R2810-ONC-1624` style string from the seed; `NCT` id in a separate `INTERIM_NCT_ID` field).
- `AETERM` = the item `label` (verbatim participant-facing wording); `AEDECOD` = `ctcae_terms.json` term.
- `AESTDTC` = first report ts (for a follow-up, the linked open AE's `first_reported_at`). `AEENDTC` = null, `AEONGO` = "Y".
- `AETOXGR` = provisional grade (int). `AESER`, `AEREL`, `AEACN`, `AEOUT` = null.
- `INTERIM_TIER`, `INTERIM_RULES_FIRED` (list of rule ids), `INTERIM_PROVISIONAL = true`, `INTERIM_FOLLOWUP_OF` (ae_open_id or null).
- VS: one **summary** row per metric present (PULSE, RESP, HRV_RMSSD) with `VSORRES` = median of eligible samples, `VSDTC` = last sample ts, `VSMETHOD` = "Contactless optical, camera-based" if measured else "Simulated", `VSSTAT` = null if value present else "NOT DONE", `INTERIM_CONFIDENCE` = median conf, `INTERIM_SOURCE` = source, `INTERIM_N_SAMPLES`, `INTERIM_IS_MEASURED`. Per-sample rows are produced by the API export with `?per_sample=true`, not by the rules package.
- CM: `CMTRT` verbatim, `CMDECOD` matched generic or null, `CMSTDTC` = completed_at date if direction in (started, both) else null, `CMENDTC` = completed_at date if direction in (stopped, both) else null, `CMSTAT` = null, `INTERIM_MATCH_CONFIDENCE`, `INTERIM_MATCH_KIND`.
Each field's `evidence` points at the exact answer ids / sample ids / rule ids that produced it.

---

## 2. API (`apps/api`, FastAPI, prefix `/api/v1`)

Auth: `POST /auth/login {username, password} → {token, role, display_name, expires_at}`. Seeded users: `coordinator`, `investigator`, `admin`, all with `DEMO_PASSWORD`. Token = HMAC-signed (stdlib `hmac`) `username.role.exp.sig`; sent as `Authorization: Bearer <token>`. Roles enforced server-side on every mutating dashboard endpoint. Kiosk endpoints (`/sessions*`, `/items`, `/study`, `/settings/public`) need no token. Bridge sends `X-Bridge-Token` when `BRIDGE_TOKEN` is set.

Admin-only override fields exist so the seed script and eval harness can backdate: `started_at_override`, `completed_at_override`, `settings_override`, `usubjid` creation on the fly with `is_eval`. Non-admin callers sending them get 403.

### 2.1 Kiosk
| Method & path | Request | Response |
|---|---|---|
| `GET /health` | — | `{status:"ok", version, time_utc, vitals_source, db}` |
| `GET /study` | — | `Study` + `{"participants_note": "All participants are synthetic."}` |
| `GET /items` | — | `{items: [Item], gates: [GateQuestion], recall_window}` (from the rules tables) |
| `GET /settings/public` | — | `{vitals_source, mock_scenario, simulated_as_measured, min_confidence, timing_gates:{pulse_s:12, breathing_s:30, hrv_s:60}}` |
| `POST /sessions` | `{usubjid, consent_camera: bool, started_at_override?}` | `Session` |
| `GET /sessions/{id}` | — | `Session` |
| `POST /sessions/{id}/answers` | `{item_id, attribute, value: int, value_text?: str, ts_client}` (idempotent on session+item+attribute: a repeat **updates** and emits an audit event) | `Answer` |
| `POST /sessions/{id}/gates` | `{hospitalization: bool, conmed_changed: bool, conmed_text?, conmed_direction?: "started"\|"stopped"\|"both", other_text?, temp_c?, ts_client}` | `{answers: [Answer]}` |
| `POST /sessions/{id}/vitals` | `{samples: [VitalsSample camelCase]}` | `{accepted: int, session_id, vitals_status}` |
| `POST /sessions/{id}/complete` | `{ts_client, completed_at_override?, settings_override?}` | `{session_id, tier, stop_screen, stop_screen_text?, checkin_url}` |

`Session` = `{id, usubjid, study_id, started_at, completed_at, consent_camera, vitals_status: "pending"\|"ok"\|"unavailable"\|"low_quality"\|"implausible"\|"simulated_ignored"\|"declined", tier, stop_screen_shown, is_eval}`.
`Answer` = `{id, session_id, item_id, attribute, value_int, value_text, ts_client, ts_server}`.
Gate answers are stored as `Answer` rows with `item_id` ∈ {`gate_hospitalization`, `gate_conmed`, `gate_conmed_text`, `gate_conmed_direction`, `gate_other`, `gate_temp_c`} and `attribute = "gate"`.

### 2.2 Dashboard (token required)
| Method & path | Notes |
|---|---|
| `GET /queue?usubjid=&min_tier=&status=open\|all&include_eval=false&limit&offset` | `QueueItem = {session_id, usubjid, display_label, completed_at, tier, tier_name, max_grade, vitals_status, is_measured, has_sae_clock, sae_due_at, escalation_acked, draft_counts:{AE,VS,CM}, draft_status_summary}` sorted tier desc, completed_at desc |
| `GET /checkins/{session_id}` | `CheckInDetail = {session, participant, answers[], vitals:{samples[], summary, status}, result: CheckInResult-as-dict, drafts: [Draft], escalation: Escalation\|null, sae_clock: SAEClockRow\|null, ae_links: [{draft_id, ae_open_id, first_session_id}], rules_fired[], why[], evidence_index: {id: Evidence}}` |
| `GET /participants` / `GET /participants/{usubjid}` | paginated / `Participant` |
| `GET /participants/{usubjid}/timeline` | `{participant, sessions: [Session+tier], symptom_series: {item_id: [{session_id, ts, composite, grade}]}, vitals_series: [{session_id, ts, pulse_median, breathing_median, is_measured, source}], open_aes: [AEOpen], conmed_changes: [{session_id, ts, cmtrt, cmdecod, direction, confidence}]}` |
| `GET /drafts/{id}` / `GET /drafts/{id}/versions` | `Draft` / list |
| `POST /drafts/{id}/confirm {note?}` | coordinator/investigator/admin → `Draft` (status confirmed) |
| `POST /drafts/{id}/reject {reason}` | → `Draft` (status rejected) |
| `PATCH /drafts/{id} {fields: {...}, note?}` | creates a new version row with `supersedes_id`; returns the new `Draft`. Previous row status → `superseded`. |
| `PATCH /drafts/{id}/attribution {AEREL?, AESER?, note?}` | investigator only. Setting `AESER` stops the session's SAE clock (`stopped_at`, `stopped_by`, `decision`). |
| `GET /escalations?acked=&limit&offset` / `POST /escalations/{id}/ack` | `Escalation = {id, session_id, usubjid, tier, reasons[], paged_at, acked_by, acked_at, seconds_to_ack}` |
| `GET /sae-clocks?active=true` | `SAEClockRow = {id, session_id, usubjid, site_awareness_at, due_at, stopped_at, stopped_by, decision, seconds_remaining, informational}` |
| `GET /pages` | mock pager log `{id, ts, session_id, tier, message, delivered: true}` |
| `GET /export/{AE\|VS\|CM}.csv` / `.json` `?status=confirmed\|all&per_sample=false` | CSV with SDTM column names; JSON `{domain, generated_at, status_filter, records: [...]}`. Every row includes `INTERIM_SOURCE`/`VSMETHOD` labeling. Export is an audit event. |
| `GET /export/bundle.zip` | zip: `AE.csv AE.json VS.csv VS.json VS_samples.csv CM.csv CM.json audit_excerpt.json manifest.json` where manifest has `{generated_at, study_id, files: [{name, sha256, bytes}], audit_head_hash, interim_version}` |
| `POST /mock-edc/{domain} {records: [...]}` | `{ack_id, domain, received, accepted_at}`; logs an audit event; the request is validated against the SDTM column set |
| `GET /audit?entity_type=&entity_id=&limit&offset` | paginated `AuditEvent` newest first |
| `GET /audit/verify` | `{ok: bool, checked: int, head_hash, first_broken: {index, id, expected_hash, actual_hash}\|null, verified_at}` |
| `GET /eval/personas` | `[{id, name, category, hidden, description, expected_tier}]` |
| `POST /eval/run {include_hidden?: bool, persona_ids?: [..]}` | runs personas in-process through the same service layer the endpoints use; returns `EvalResults` and persists it |
| `POST /eval/run-custom {persona: Persona}` | runs one ad-hoc persona (the "build your own" form); returns `{persona, result: CheckInResult-as-dict, session_id}` |
| `GET /eval/results` | last `EvalResults` or 404 |
| `GET /reference/label` | `{drug: "LIBTAYO (cemiplimab-rwlc)", section: "adverse_reactions", text, source_url, fetched_at, note: "public label excerpt, reference only"}` |
| `GET /reference/ctcae` | the 10 CTCAE term rows |
| `GET /admin/settings` / `PUT /admin/settings {vitals_source?, mock_scenario?, simulated_as_measured?}` | admin only for PUT; `GET` admin/coordinator/investigator |
| `POST /admin/reset {reseed: true}` | admin only; wipes all tables, reseeds, writes a fresh genesis audit event |

`Draft` = `{id, session_id, usubjid, domain, version, status: "draft"\|"confirmed"\|"rejected"\|"superseded", fields: {NAME: value}, evidence: {NAME: [Evidence]}, linked_ae_open_id, is_followup, created_by, created_at, supersedes_id, note}`.

`EvalResults` = `{run_id, ran_at, include_hidden, n_personas, n_pass, n_fail, tier_metrics: {"0".."3": {precision, recall, f1, support}}, grade_confusion: [[int]*4]*4 (rows expected, cols actual), dedup_correct: {n, correct}, sae_clock_correct: {n, correct}, conmed_correct: {n, correct}, per_persona: [{persona_id, name, hidden, pass, expected, actual, mismatches: [str], session_id}], markdown}`.

### 2.3 Audit events
`AuditEvent = {id, seq, ts_utc, actor_id, actor_role, action, entity_type, entity_id, payload, prev_hash, hash}`.
`hash = sha256(prev_hash + canonical_json({id, seq, ts_utc, actor_id, actor_role, action, entity_type, entity_id, payload}))` where canonical JSON = `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. Genesis `prev_hash = "0" * 64`. Actions (strings): `session.started, session.consent, answer.recorded, answer.updated, gates.recorded, vitals.batch, session.completed, rule.fired, draft.created, draft.edited, draft.confirmed, draft.rejected, draft.attribution, escalation.created, escalation.paged, escalation.acked, sae_clock.started, sae_clock.stopped, export.generated, mock_edc.posted, settings.changed, demo.reset, eval.run, auth.login`. Actor for kiosk events is the participant `usubjid` with role `participant`; for the bridge, `vitals-bridge` with role `system`.

### 2.4 DB
SQLModel, `create_all` at startup, SQLite file path from `DATABASE_URL` (directory auto-created). Tables as in `CLAUDE.md` §6 plus `User`, `Page`, `EvalRun`, `DraftVersion` not needed (versions are Draft rows linked by `supersedes_id`). JSON columns stored as TEXT with (de)serialization helpers.

---

## 3. Vitals bridge (`apps/vitals-bridge`)

Node 20+, TypeScript, ESM. Entrypoint `src/cli.ts`. Sources in `src/sources/{types,mock,presage,arduino,index}.ts`. Timing gates and confidence threshold are enforced in `src/gate.ts` regardless of source.

### 3.1 Gating semantics
The bridge emits one `VitalsSample` per second from the source. Before a metric's timing gate has elapsed (pulse 12 s, breathing 30 s, HRV 60 s of **continuous** collecting state; an `error` status resets the clock), that metric is set to `undefined` in the emitted sample and a flag `gate_pending_pulse|breathing|hrv` is added. Values below `VITALS_MIN_CONF` are **kept** but flagged `low_conf_pulse|breathing|hrv` (the UI hides them; the rules ignore them). Raw series is never averaged by the bridge.

### 3.2 HTTP to API
Every 2 s: `POST {api}/api/v1/sessions/{sessionId}/vitals` with `{"samples": [VitalsSample...]}` (camelCase exactly as §7.1 of CLAUDE.md), header `X-Bridge-Token` if set. On non-2xx, retry once, then log and keep buffering (bounded 120 samples). Only when a session is active (see `start` below).

### 3.3 WebSocket to web (`ws://<host>:8787`)
Bridge → web messages:
```ts
{ type: "hello", source: "mock"|"presage"|"arduino", isMeasured: boolean, scenario: string|null, minConf: number, gates: { pulseS: 12, breathingS: 30, hrvS: 60 }, version: string }
{ type: "status", state: "idle"|"warming"|"collecting"|"error", message?: string, elapsedS: number, sessionId: string|null }
{ type: "sample", sample: VitalsSample, published: { pulse: boolean, breathing: boolean, hrv: boolean }, elapsedS: number, sessionId: string|null }
{ type: "waveform", values: number[], tsUtc: string }     // ~25 points of synthetic pleth at 1 Hz batches (mock); real sources may omit
{ type: "error", message: string }
```
Web → bridge:
```ts
{ type: "start", sessionId: string, scenario?: string }   // begin capture + batching for this session; scenario overrides env for mock
{ type: "stop" }                                           // stop capture; flush remaining buffer
{ type: "set_scenario", scenario: string }                 // mock only; applies on next start
{ type: "ping" }
```
On `start`, the bridge GETs `{api}/api/v1/settings/public` and uses `mock_scenario` from it unless the `start` message carries a `scenario`. Idle state when no session.

### 3.4 CLI
`npm run bridge -- --source mock --scenario resting --api http://localhost:8000 --ws-port 8787 [--list-cameras] [--min-conf 0.6]`. Env fallbacks: `VITALS_SOURCE, VITALS_SCENARIO, BRIDGE_API_URL, BRIDGE_WS_PORT, VITALS_MIN_CONF, BRIDGE_TOKEN`. Prints one status line every 5 s: `[bridge] source=mock scenario=resting state=collecting session=01J... elapsed=42s pulse=72(0.93) breathing=14(0.88) buffered=3 posted=40`. Selecting `presage` or `arduino` exits with code 2 and the NotImplemented message before opening any port.

---

## 4. Web (`apps/web`)

Vite + React 18 + TypeScript + Tailwind 3.4 + React Router 6 + Recharts. Light theme only, high contrast. Routes: `/` (login / role picker + link to kiosk), `/kiosk` (flow), `/dashboard` (queue), `/dashboard/checkins/:sessionId`, `/dashboard/participants/:usubjid`, `/dashboard/escalations`, `/dashboard/audit`, `/dashboard/eval`, `/admin`.

- API base: relative `/api/v1` (Vite dev proxy → `http://localhost:8000`; nginx in Docker proxies `/api/` → `http://api:8000/api/`). `src/lib/api.ts` is the single typed client; types in `src/lib/types.ts` mirror §2.
- Bridge WS URL: `import.meta.env.VITE_BRIDGE_WS_URL` else `ws://${location.hostname}:8787`. `src/lib/bridge.ts` wraps it with reconnect and a typed message union from §3.3.
- Token stored in `sessionStorage`; role gates routes client-side **and** the API enforces server-side.
- Persistent footer on every page: *"Interim is a research data-capture tool. It is not a medical device and does not provide medical advice."*
- Badges: `MEASURED` (green) / `SIMULATED` (violet) wherever a vitals value appears. Tier chips: 0 slate "Log", 1 amber "Review 1 business day", 2 orange "Nurse call today", 3 red "Urgent".
- Kiosk flow: Welcome + study ID → Camera consent (Yes / No) → 10 items (one per screen, big buttons, progress bar, vitals panel card) → 3 gates → Thank-you or Tier 3 stop screen (fixed text from the API response). On consent Yes the kiosk creates the session, then sends `{type:"start", sessionId}` to the bridge; on finish it sends `{type:"stop"}` before calling `/complete` (give the bridge ≤ 2.5 s to flush, then complete regardless).
- Dashboard detail page layout: left = answers in order with timestamps; middle = AE/VS/CM drafts, each field clickable → highlights its evidence (answer rows / vitals samples / rules) and shows the `Evidence[]`; right = "Why" panel listing every rule fired in plain English with inputs. Buttons: Confirm, Edit (inline field editor → PATCH), Reject, Acknowledge escalation. Investigator-only AESER/AEREL controls with the public label excerpt collapsed beside them.

---

## 5. Seed data (`scripts/seed.py`)
- Study from `data/public/study.json` (fetched; fallback bundled).
- 12 participants `P-001..P-012`, `USUBJID = "{study_id}-{P-xxx}"`, display label `P-001` etc. Each with 2–4 prior check-ins spread over the last 60 days with mostly Tier 0/1 content, a couple of Tier 2, one open AE for P-007 (cough G1, 5 days ago) so the demo's dedup can show a follow-up, con-med changes on ~4 participants. Deterministic (`random.Random(20261010)`). Documented in `data/synthetic/README.md`. Seed goes through the service layer so every seeded fact is audited and drafted exactly as a live check-in.

---

## 6. Personas (`packages/rules/data/personas.json`)
```json
{
  "source": "Hand-written by the Interim team; expected outputs verified against the rules engine and reviewed by hand.",
  "rationale": "Deterministic answer key for the eval harness (CLAUDE.md §8).",
  "personas": [
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
      "responses": { "shortness_of_breath": { "severity": 2, "interference": 2 }, "cough": { "severity": 1, "interference": 0 }, "fatigue": { "severity": 0, "interference": 0 }, "nausea": { "frequency": 0, "severity": 0 }, "diarrhea": { "frequency": 0 }, "rash": { "presence": 0 }, "itching": { "severity": 0 }, "joint_pain": { "severity": 0, "interference": 0 }, "fever_or_chills": { "presence": 0 }, "mouth_sores": { "severity": 0, "interference": 0 } },
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
  ]
}
```
`vitals_samples[].tsOffsetS` is relative to session start; the runner materializes `tsUtc`. `setup.prior_checkins[]` items have `{days_ago, responses, gates}` and are replayed (and their AE drafts confirmed) before the main check-in. Mix required: 6 tier0, 6 tier1, 5 tier2, 4 tier3, 3 edge (`implausible` vitals ignored, `low_quality` ignored, dedup follow-up), plus 5 `hidden: true` judge personas.

---

## 7. Versioning
`INTERIM_VERSION = "0.1.0"` read from `packages/rules/interim_rules/__init__.py` by the API and from `package.json` by the bridge/web. Exports and the bundle manifest carry it.

---

# Revision 2 (2026-10-10, after wave 1) — amendments and additions

The sections above are the original contract. The rules package, bridge, web kiosk and public-data fetch were built against them; the amendments below record what the shipped code actually does where it legitimately differs, plus two new scopes adopted from the teammate's repository (`omer-khawar/ae-checkin-agent`, MIT): deterministic chart-note scanning and a real Presage source. **The API, eval harness and dashboard are built against this revised contract.**

## R2.1 Rules package: what shipped (read these as the truth for §1)
- **Items table** (`proctcae_items.json`): `{source, rationale, recall_window, response_scales, items: [ItemDef]}` where `ItemDef = {id, order, label, short_label, ctcae_term, attributes[], prompts: {attribute: question stem}, response_options: {attribute: {label: int}}, recall_window}`. `label` is the plain symptom phrase (used as `AETERM`); the per-attribute question stems live in `prompts`. Python accessor: `interim_rules.tables.items()`.
- **Gate questions** (`gate_questions.json`): `{source, rationale, questions: [{id, order, type: "yes_no"|"yes_no_text"|"free_text", field, label, options?, seriousness_trigger?, red_flag_rule?, ...}], optional_fields: [...]}`. Accessor `tables.gate_questions()` (each has `.raw`). `GET /items` returns `{items, gates: questions, optional_fields, recall_window}` straight from these tables.
- **Composite scoring**: reproduced verbatim from Basch et al. 2021 via the ProAE v1.0.4 `comp_tab` reference implementation (`reproduced_verbatim: true`). Single-attribute mapping is attribute-specific: frequency 0,1,1,2,3; severity 0,1,2,3,3; interference 0,1,1,2,2 (`single_attribute_by_attribute`). Presence items (rash, fever/chills) map present → composite 1 → provisional G1 as an Interim convention, labeled in the table. **§1.1's "single_attribute 0,1,2,3,3" is superseded.**
- **`CheckInInput`** gained `nct_id: str | None = None` and `settings` has a default. The API must pass `nct_id`.
- **SDTM drafts** carry `INTERIM_NCT_ID` on AE/VS/CM and `INTERIM_DIRECTION` on CM, in addition to §1.8. The mock-EDC column validation must allow every `INTERIM_*` column.
- **`vitals.implausible`** is per offending sample; there is no session-level rule for the `implausible` status. The dashboard derives the status badge from `VitalsAssessment.status`.
- **`corroboration_bump`** is 1 whenever a corroboration rule fired with status ok, even if the tier was already 3; `tier.corroboration_bump` then says "capped at the maximum tier".
- **Con-med matcher parameters** live in `conmed_matching.json` (min token length 4, max distance 2); `medlist.json` has an extra `core_names[]` and 372 entries today. `scripts/fetch_public.py --build-medlist` regenerates it in the same schema; names must stay lowercase and unique.
- **Table resolution** is `<package>/../data` then `<package>/data`. Docker images must either `pip install -e packages/rules` or copy `data/` next to the package.
- **Serializer helpers** (`interim_rules.serialize`): `build_input(session_id=, studyid=, usubjid=, completed_at=, nct_id=, responses=[...], gates=..., vitals=[...], open_aes=[...], settings={...}, next_aeseq=)`, `result_to_dict(result)`, `input_from_dict(persona_dict)` (accepts `responses` as `{item: {attr: value}}`, `vitals_samples` with `tsOffsetS`, camelCase or snake_case samples).
- **Evidence ids** for gate answers are synthesized as `<session_id>:gate_<field>` when the caller passes none; the API passes real `Answer.id`s.

## R2.2 Personas: what shipped
`personas.json` top level: `{source, rationale, version, schema, counts, personas}`. `expected` may carry extra keys beyond §6 (`max_grade, red_flag_tier_floor, corroboration_bump, vitals_status, vs_not_done, cm[].match_kind/distance/direction`) and a persona may carry `counterfactuals[]`. The eval harness compares every key present in `expected` that it knows how to compute and ignores unknown keys with a logged notice. 29 personas (24 + 5 hidden), all matching the engine.

## R2.3 API amendments
- `POST /sessions {usubjid}` accepts **either** the full `USUBJID` or the participant's `display_label` (e.g. `P-007`, case-insensitive, trimmed) and resolves it. 404 problem+json when neither matches. The kiosk sends whatever the participant typed.
- `POST /sessions/{id}/complete` response adds `stop_screen_text` (the verbatim ladder text) whenever `stop_screen` is true, and `tier_name`.
- `GET /checkins/{id}` adds `vitals.status` taken from `VitalsAssessment.status`, and `source: "check_in" | "chart_note"` on every draft.
- Every endpoint that returns a `Draft` includes `fields.INTERIM_SOURCE` (`"check_in"` or `"chart_note"`).

## R2.4 Chart-note scanning (new scope, Regeneron "Better" tier)
Ported from `backend/app/services/extract.py` of `omer-khawar/ae-checkin-agent` (author Omer Khawar, MIT) into the Interim structure, with credit in the module header. Deterministic regex + NegEx-style exclusion; no LLM.
- **Rules module** `interim_rules.chartscan`: `scan_text(text: str, ref_date: date | None = None) -> ScanResult` with `ScanResult = {symptoms: [SymptomFinding], excluded_symptoms: [SymptomFinding], meds: [MedFinding], excluded_meds: [MedFinding], red_flags: [RedFlag]}`. Findings keep `term` (CTCAE v5 term), `quote`, `span_start`, `span_end`, `reason`, `grade_hint` (int | None, with `grade_basis` text), `onset_days` (int | None), `worsening` (bool), `excluded_reason` (`negated | historical | hypothetical | resolved | allergy | indication` or None). Med findings: `drug` (lowercase lexicon name), `change` (`started | stopped | changed | taking`), `quote`, spans, `reason`. Red flags: `level` (`emergency | urgent`), `category`, `quote`, `reason`.
- **Lexicons move to tables** per CLAUDE.md §13: `packages/rules/data/chartscan_lexicon.json` (`symptom_patterns: {ctcae_term: [regex]}`, `med_patterns: {drug: [regex]}`, `negation`, `pseudo_negation`, `terminators`, `historical`, `hypothetical`, `severity_words`, `worsening`, `hospital`, `med_started/stopped/changed/negated`, `allergy`, `indication`, each with `source`/`rationale`) and `chartscan_red_flags.json`. Regex strings are data; code compiles them once.
- **Answer key** `packages/rules/data/chartscan_answer_key.json`: the 25 cases (8 notes + 17 utterances) from the source repo, `kind: "note" | "utterance"`, with the notes' text in `data/synthetic/chart_notes.json` (subject ids remapped to Interim participants `P-001…P-012`, documented in `data/synthetic/README.md`). `tests/test_chartscan.py` must reproduce the source repo's result: AE terms P = R = 1.00, meds P = R = 1.00, all urgent/emergency cases flagged, 0 over-escalations.
- **API**:
  - `POST /notes {usubjid, note_date, author, note_type, text}` (coordinator+): stores `ChartNote{id, usubjid, note_date, author, note_type, text, ingested_at, ingested_by}`, runs `scan_text`, creates drafts: one AE draft per non-excluded symptom finding (`AETERM` = quote, `AEDECOD` = term, `AETOXGR` = `grade_hint` or null, `AESTDTC` = note_date − onset_days when known else note_date, `INTERIM_SOURCE = "chart_note"`, `INTERIM_TIER`, evidence `{kind: "chart_note", id: note_id, ts: ingested_at, note: quote, span_start, span_end}`), one CM draft per non-excluded med finding (`CMTRT` = quote, `CMDECOD` = drug, `CMSTDTC/CMENDTC` from `change`, `INTERIM_SOURCE = "chart_note"`). **Cross-source dedup:** the same `AEDECOD` already open for the participant within the dedup window → follow-up link (not a new AE), exactly as check-in dedup. Escalation: `urgent`/`emergency` red flags or a hospitalization finding → `Escalation(tier=2, reasons=[...], source="chart_note")`; a hospitalization finding also sets `seriousness_suspected` and starts the SAE clock with `site_awareness_at = ingested_at` (the moment the site saw the note). Notes never produce Tier 3 or a page (they are retrospective, not a live participant). Returns `{note, scan: ScanResult, drafts: [Draft], escalation, sae_clock, rules_fired, why}`.
  - `POST /scan {text, ref_date?}` dry-run (nothing stored) → `ScanResult`.
  - `GET /notes?usubjid=&limit&offset`, `GET /notes/{id}` (note + scan + drafts).
  - Queue items gain `source: "check_in" | "chart_note"`; `GET /queue` lists notes with drafts alongside check-ins (`session_id` is null for notes, `note_id` set). `GET /participants/{usubjid}/timeline` adds `notes[]`.
  - Audit actions add `note.ingested`, `note.scanned`.
  - Seed ingests the 8 synthetic notes for their mapped participants (backdated via `ingested_at_override`, admin only).
- **Eval**: `scripts/run_eval.py` and `POST /eval/run` add a second section: scanner precision/recall per category (AE terms, meds, escalation) against the answer key, written to `docs/eval/results.md`. Pass criterion stays 100%.
- **Evidence kind union** becomes `"pro_response" | "vitals_sample" | "gate_answer" | "rule" | "table" | "chart_note"`.
- **Docs**: PRD Good/Better/Best mapping and NOT_BUILT must be updated: the Better tier is now shipped by a deterministic scanner (credit Omer Khawar); "free text from the participant is never parsed" still holds for the kiosk's "anything else" field.

## R2.5 Presage source (new: implemented, not stubbed)
Ported from `presage-bridge/bridge.js` of the same repo, which verified the SDK usage (v3.4.0) and the decoded field names: `Metrics.toObject(decodeMetrics(buf), {longs: Number})` → `cardio.pulseRate[{value, confidence (0–100), stable, timestamp (µs)}]`, `cardio.hrv[...]`, `breathing.rate[{value, confidence, stable, timestamp}]`; `validationStatus(code, ts, hint)`; `error(code, message, retryable)`.
- `apps/vitals-bridge/src/sources/presage.ts` implements `VitalsSource` for real: `start()` dynamically imports `@smartspectra/node-sdk` and `@smartspectra/node-sdk/messages`; a missing module → `onStatus({state:"error", message})` with the exact install command and `start()` rejects with `NotImplementedError`-style text that tells the operator to run `npm run install:presage` or switch to `mock`. The SDK stays **out of `dependencies`** (CLAUDE.md §7.3); `package.json` gets `"install:presage": "npm install --no-save @smartspectra/node-sdk@3.4.0"` and `optionalDependencies` stays empty. `PRESAGE_API_KEY` env required; `listCameras()` via `SmartSpectraSDK.availableCameras()`; `CameraSelection.byId(id)` on Windows.
- Mapping: one `VitalsSample` per metrics packet (≈1 Hz): `pulseBpm` = last `pulseRate.value`, `pulseConf` = confidence/100, `breathingBpm`/`breathingConf` likewise, `hrvRmssdMs` from the hrv entry when present (field name verified at implementation; if absent, omit), `windowS` 12/30/60 per metric (sample carries the max present), `qualityFlags` from the latest non-zero `validationStatus` hint (snake_cased) plus `unstable_pulse|breathing` when `stable` is false, `isMeasured: true`, `source: "presage"`. The bridge's `gate.ts` timing/confidence gates still apply unchanged.
- Tests: the mapping function is unit-tested against fixtures in the exact `toObject` shape (reuse the `simulatedMetrics` shape from the source repo); the SDK is not installed in CI. `docs/VITALS_SOURCES.md` gains a "status: implemented, untested against a live camera; needs PRESAGE_API_KEY" line and the install steps.
- `legacy/` keeps the original `backend/` and `presage-bridge/` directories from the teammate's repository after parity is verified (decision D-016).
