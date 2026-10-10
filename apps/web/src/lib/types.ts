/**
 * TypeScript mirrors of the shapes in docs/CONTRACTS.md.
 *
 * Section references in comments point at CONTRACTS.md. Two naming conventions
 * coexist on purpose (DECISIONS.md D-002):
 *   - the API emits snake_case  → `VitalsSampleRow` and everything in §2;
 *   - the bridge emits camelCase → `VitalsSample` (CLAUDE.md §7.1) and §3.3 messages.
 *
 * Nothing in this file is runtime code; it is types only.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** ULID, 26-char Crockford base32. */
export type Ulid = string;

/** UTC ISO-8601 with a Z suffix and millisecond precision. */
export type IsoUtc = string;

export type Role = "coordinator" | "investigator" | "admin";

export type Attribute = "frequency" | "severity" | "interference" | "presence";

export type Domain = "AE" | "VS" | "CM";

export type VitalsSourceName = "mock" | "presage" | "arduino";

export type ConmedDirection = "started" | "stopped" | "both";

/** RFC 7807 problem document. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** FastAPI validation errors and other extensions ride along untyped. */
  [extra: string]: unknown;
}

/** Every list endpoint paginates with `?limit=&offset=`. */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// §2 Auth
// ---------------------------------------------------------------------------

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  role: Role;
  display_name: string;
  expires_at: IsoUtc;
}

// ---------------------------------------------------------------------------
// §2.1 Kiosk
// ---------------------------------------------------------------------------

export interface Health {
  status: "ok";
  version: string;
  time_utc: IsoUtc;
  vitals_source: VitalsSourceName | string;
  db: string;
}

/** CLAUDE.md §6 Study + the public note. */
export interface Study {
  study_id: string;
  nct_id: string;
  title: string;
  sponsor: string;
  phase: string;
  conditions: string[];
  interventions: string[];
  fetched_at: IsoUtc;
  source_url: string;
  status?: string;
  participants_note: string;
}

/**
 * One response option. The rules table stores `label → int`; the API may pass
 * that through as an object or expand it to an array. `optionsFor()` in
 * `format.ts` normalises both into this shape.
 */
export interface ResponseOption {
  label: string;
  value: number;
}

export type ResponseOptionsRaw = ResponseOption[] | Record<string, number>;

/**
 * An optional typed field attached to an item, as the rules table ships it
 * (`proctcae_items.json` → `fever_or_chills.optional_fields[0]`). The kiosk reads
 * `label`, `unit`, `min` and `max` from here; it never hardcodes them.
 */
export interface OptionalField {
  id: string;
  label: string;
  type?: "number" | string;
  unit?: string;
  min?: number;
  max?: number;
  /** Where the value is stored, e.g. "gates.temp_c". */
  stored_as?: string;
  note?: string;
}

/**
 * CONTRACTS §1.1 proctcae_items.json row, as returned by GET /items.
 *
 * The shipped table uses `prompts.<attribute>` and `optional_fields[]`. The
 * older `attribute_prompts` / `optional_numeric` names are kept as optional
 * aliases so an API that reshapes the table still renders; `promptFor()` and
 * `temperatureField()` in `format.tsx` read both.
 */
export interface Item {
  id: string;
  /** Symptom in plain words (e.g. "Shortness of breath"); the heading on the kiosk. */
  label: string;
  short_label: string;
  /** CTCAE v5.0 term (= AEDECOD). Never shown on the kiosk. */
  ctcae_term: string;
  attributes: Attribute[];
  response_options: Partial<Record<Attribute, ResponseOptionsRaw>>;
  recall_window: string;
  order: number;
  /** Per-attribute question stems, verbatim from the rules table. */
  prompts?: Partial<Record<Attribute, string>>;
  /** Typed optional extras (the fever item's temperature). */
  optional_fields?: OptionalField[];
  /** Legacy alias of `prompts`. */
  attribute_prompts?: Partial<Record<Attribute, string>>;
  /** Legacy alias of `optional_fields[0]`. */
  optional_numeric?: { id: string; label: string; unit: string } | null;
}

/**
 * CONTRACTS §1.1 gate_questions.json row. The shipped table uses `type`,
 * `text_prompt`, `text_note`, `direction_prompt` and `note`; the older `kind` /
 * `prompts` names are kept as optional aliases (see `gatePrompts()` in gates.ts).
 */
export interface GateQuestion {
  id: "hospitalization" | "conmed" | "other" | string;
  label: string;
  short_label?: string;
  type?: "yes_no" | "yes_no_with_text" | "free_text" | string;
  field?: string;
  /** conmed: label for the verbatim medication text box. */
  text_prompt?: string;
  /** conmed: documentation note about how the text is handled (not participant copy). */
  text_note?: string;
  /** conmed: label for the started / stopped / both choice. */
  direction_prompt?: string;
  /** other: participant-facing note shown under the text box. */
  note?: string;
  order?: number;
  /** Legacy alias of `type`. */
  kind?: "yes_no" | "yes_no_text" | "free_text" | string;
  /** Legacy sub-prompt map (`conmed_text`, `conmed_direction`, `other_hint`). */
  prompts?: Record<string, string>;
}

export interface ItemsResponse {
  items: Item[];
  gates: GateQuestion[];
  recall_window: string;
}

export interface TimingGates {
  pulse_s: number;
  breathing_s: number;
  hrv_s: number;
}

export interface PublicSettings {
  vitals_source: VitalsSourceName | string;
  mock_scenario: string;
  simulated_as_measured: boolean;
  min_confidence: number;
  timing_gates: TimingGates;
}

export type VitalsStatus =
  | "pending"
  | "ok"
  | "unavailable"
  | "low_quality"
  | "implausible"
  | "simulated_ignored"
  | "declined";

export interface Session {
  id: Ulid;
  usubjid: string;
  study_id: string;
  started_at: IsoUtc;
  completed_at: IsoUtc | null;
  consent_camera: boolean;
  vitals_status: VitalsStatus;
  tier: number | null;
  stop_screen_shown: boolean;
  is_eval: boolean;
}

export interface CreateSessionRequest {
  usubjid: string;
  consent_camera: boolean;
  /** Admin-only backdating (DECISIONS.md D-004). */
  started_at_override?: IsoUtc;
}

export interface Answer {
  id: Ulid;
  session_id: Ulid;
  item_id: string;
  attribute: Attribute | "gate";
  value_int: number | null;
  value_text: string | null;
  ts_client: IsoUtc;
  ts_server: IsoUtc;
}

export interface AnswerRequest {
  item_id: string;
  attribute: Attribute;
  value: number;
  value_text?: string;
  ts_client: IsoUtc;
}

export interface GatesRequest {
  hospitalization: boolean;
  conmed_changed: boolean;
  conmed_text?: string;
  conmed_direction?: ConmedDirection;
  other_text?: string;
  temp_c?: number;
  ts_client: IsoUtc;
}

export interface GatesResponse {
  answers: Answer[];
}

/**
 * Bridge-side sample, camelCase, verbatim from CLAUDE.md §7.1. This is what the
 * WebSocket carries and what the bridge POSTs to the API.
 */
export interface VitalsSample {
  tsUtc: IsoUtc;
  source: VitalsSourceName;
  isMeasured: boolean;
  pulseBpm?: number;
  pulseConf?: number;
  breathingBpm?: number;
  breathingConf?: number;
  hrvRmssdMs?: number;
  hrvConf?: number;
  windowS: number;
  /** e.g. face_not_found, low_light, motion, talking, gate_pending_pulse, low_conf_pulse */
  qualityFlags: string[];
}

/** API-side stored sample, snake_case (CLAUDE.md §6 VitalsSample). */
export interface VitalsSampleRow {
  id: Ulid;
  session_id: Ulid;
  ts_utc: IsoUtc;
  source: VitalsSourceName | string;
  is_measured: boolean;
  pulse_bpm: number | null;
  pulse_conf: number | null;
  breathing_bpm: number | null;
  breathing_conf: number | null;
  hrv_rmssd_ms: number | null;
  hrv_conf: number | null;
  window_s: number;
  quality_flags: string[];
}

export interface VitalsPostRequest {
  samples: VitalsSample[];
}

export interface VitalsPostResponse {
  accepted: number;
  session_id: Ulid;
  vitals_status: VitalsStatus;
}

export interface CompleteRequest {
  ts_client: IsoUtc;
  completed_at_override?: IsoUtc;
  settings_override?: Partial<RuleSettings>;
}

export interface CompleteResponse {
  session_id: Ulid;
  tier: number;
  stop_screen: boolean;
  /** Fixed, pre-approved Tier 3 text. The kiosk shows it verbatim and nothing else. */
  stop_screen_text?: string;
  checkin_url: string;
}

// ---------------------------------------------------------------------------
// §1.2 / §1.3 Rules result (as serialised by the API)
// ---------------------------------------------------------------------------

export interface RuleSettings {
  simulated_as_measured: boolean;
  min_confidence: number | null;
  dedup_window_days: number | null;
}

export type EvidenceKind = "pro_response" | "vitals_sample" | "gate_answer" | "rule" | "table";

export interface Evidence {
  kind: EvidenceKind;
  /** answer id / sample id / rule id / table file name */
  id: string;
  ts: IsoUtc | null;
  note: string;
}

export type RuleCategory =
  | "scoring"
  | "grading"
  | "red_flag"
  | "vitals_quality"
  | "corroboration"
  | "escalation"
  | "seriousness"
  | "conmed"
  | "dedup"
  | "drafting";

export interface RuleFired {
  rule_id: string;
  category: RuleCategory;
  /** Plain English with the actual values substituted. */
  description: string;
  inputs: Record<string, unknown>;
  /** e.g. "tier floor = 2", "tier +1 (2 → 3)", "AETOXGR = 2" */
  effect: string;
  evidence: Evidence[];
}

export interface ProResponse {
  answer_id: Ulid;
  item_id: string;
  attribute: Attribute;
  value: number;
  ts: IsoUtc;
}

export interface ItemResult {
  item_id: string;
  label: string;
  aedecod: string;
  composite: number;
  provisional_grade: number;
  responses: ProResponse[];
  evidence: Evidence[];
}

export interface VitalsSummary {
  n_samples: number;
  n_eligible: number;
  pulse_median: number | null;
  pulse_max: number | null;
  breathing_median: number | null;
  breathing_max: number | null;
  hrv_median: number | null;
  is_measured: boolean;
  source: string | null;
  first_ts: IsoUtc | null;
  last_ts: IsoUtc | null;
}

export type VitalsAssessmentStatus =
  | "ok"
  | "unavailable"
  | "low_quality"
  | "implausible"
  | "simulated_ignored";

export interface VitalsAssessment {
  status: VitalsAssessmentStatus;
  eligible_sample_ids: string[];
  /** (sample_id, reason) pairs */
  ignored: Array<[string, string]>;
  summary: VitalsSummary | null;
  rules_fired: RuleFired[];
}

export type ConMedMatchKind = "exact" | "case_insensitive" | "levenshtein" | "unmatched";

export interface ConMedMatch {
  verbatim: string;
  matched_name: string | null;
  match_kind: ConMedMatchKind;
  confidence: number;
  distance: number | null;
  /** top 3 (name, distance) */
  candidates: Array<[string, number]>;
}

export interface SAEClock {
  site_awareness_at: IsoUtc;
  due_at: IsoUtc;
  /** sponsor 7/15-day deadlines, informational only */
  informational: Record<string, string>;
}

export interface DraftField {
  name: string;
  value: unknown;
  evidence: Evidence[];
}

export interface DraftRecord {
  domain: Domain;
  fields: DraftField[];
  linked_ae_open_id: string | null;
  is_followup: boolean;
}

export interface CheckInResult {
  items: ItemResult[];
  max_grade: number;
  base_tier: number;
  red_flag_tier_floor: number;
  corroboration_bump: number;
  escalation_tier: number;
  stop_screen: boolean;
  page_oncall: boolean;
  seriousness_suspected: boolean;
  sae_clock: SAEClock | null;
  conmed: ConMedMatch | null;
  vitals: VitalsAssessment;
  drafts: DraftRecord[];
  rules_fired: RuleFired[];
  why: string[];
}

// ---------------------------------------------------------------------------
// §2.2 Dashboard
// ---------------------------------------------------------------------------

export interface Participant {
  usubjid: string;
  study_id: string;
  enrolled_at: IsoUtc;
  display_label: string;
  baseline_vitals_json?: Record<string, unknown> | null;
}

export type DraftStatus = "draft" | "confirmed" | "rejected" | "superseded";

export interface Draft {
  id: Ulid;
  session_id: Ulid;
  usubjid: string;
  domain: Domain;
  version: number;
  status: DraftStatus;
  /** SDTM variable name → value */
  fields: Record<string, unknown>;
  /** SDTM variable name → evidence pointers */
  evidence: Record<string, Evidence[]>;
  linked_ae_open_id: string | null;
  is_followup: boolean;
  created_by: string;
  created_at: IsoUtc;
  supersedes_id: Ulid | null;
  note: string | null;
}

export interface QueueItem {
  session_id: Ulid;
  usubjid: string;
  display_label: string;
  completed_at: IsoUtc;
  tier: number;
  tier_name: string;
  max_grade: number;
  vitals_status: VitalsStatus;
  is_measured: boolean;
  has_sae_clock: boolean;
  sae_due_at: IsoUtc | null;
  escalation_acked: boolean | null;
  draft_counts: Record<Domain, number>;
  draft_status_summary: string;
}

export interface QueueQuery {
  usubjid?: string;
  min_tier?: number;
  status?: "open" | "all";
  include_eval?: boolean;
  limit?: number;
  offset?: number;
}

export interface Escalation {
  id: Ulid;
  session_id: Ulid;
  usubjid: string;
  tier: number;
  reasons: string[];
  paged_at: IsoUtc | null;
  acked_by: string | null;
  acked_at: IsoUtc | null;
  seconds_to_ack: number | null;
}

export interface SAEClockRow {
  id: Ulid;
  session_id: Ulid;
  usubjid: string;
  site_awareness_at: IsoUtc;
  due_at: IsoUtc;
  stopped_at: IsoUtc | null;
  stopped_by: string | null;
  decision: string | null;
  seconds_remaining: number | null;
  informational: Record<string, string>;
}

export interface AELink {
  draft_id: Ulid;
  ae_open_id: Ulid;
  first_session_id: Ulid;
}

export interface CheckInDetail {
  session: Session;
  participant: Participant;
  answers: Answer[];
  vitals: {
    samples: VitalsSampleRow[];
    summary: VitalsSummary | null;
    status: VitalsStatus;
  };
  result: CheckInResult;
  drafts: Draft[];
  escalation: Escalation | null;
  sae_clock: SAEClockRow | null;
  ae_links: AELink[];
  rules_fired: RuleFired[];
  why: string[];
  evidence_index: Record<string, Evidence>;
}

export interface AEOpen {
  id: Ulid;
  usubjid: string;
  aedecod: string;
  first_session_id: Ulid;
  last_session_id: Ulid;
  ongoing: boolean;
}

export interface SymptomPoint {
  session_id: Ulid;
  ts: IsoUtc;
  composite: number;
  grade: number;
}

export interface VitalsSeriesPoint {
  session_id: Ulid;
  ts: IsoUtc;
  pulse_median: number | null;
  breathing_median: number | null;
  is_measured: boolean;
  source: string | null;
}

export interface ConmedChange {
  session_id: Ulid;
  ts: IsoUtc;
  cmtrt: string;
  cmdecod: string | null;
  direction: ConmedDirection | null;
  confidence: number;
}

export interface Timeline {
  participant: Participant;
  sessions: Session[];
  symptom_series: Record<string, SymptomPoint[]>;
  vitals_series: VitalsSeriesPoint[];
  open_aes: AEOpen[];
  conmed_changes: ConmedChange[];
}

export interface AttributionRequest {
  AEREL?: string;
  AESER?: string;
  note?: string;
}

export interface PageEvent {
  id: Ulid;
  ts: IsoUtc;
  session_id: Ulid;
  tier: number;
  message: string;
  delivered: boolean;
}

export type ExportStatusFilter = "confirmed" | "all";

export interface ExportJson {
  domain: Domain;
  generated_at: IsoUtc;
  status_filter: ExportStatusFilter;
  records: Array<Record<string, unknown>>;
}

export interface MockEdcAck {
  ack_id: string;
  domain: Domain;
  received: number;
  accepted_at: IsoUtc;
}

// ---------------------------------------------------------------------------
// §2.3 Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | "session.started"
  | "session.consent"
  | "answer.recorded"
  | "answer.updated"
  | "gates.recorded"
  | "vitals.batch"
  | "session.completed"
  | "rule.fired"
  | "draft.created"
  | "draft.edited"
  | "draft.confirmed"
  | "draft.rejected"
  | "draft.attribution"
  | "escalation.created"
  | "escalation.paged"
  | "escalation.acked"
  | "sae_clock.started"
  | "sae_clock.stopped"
  | "export.generated"
  | "mock_edc.posted"
  | "settings.changed"
  | "demo.reset"
  | "eval.run"
  | "auth.login"
  | string;

export interface AuditEvent {
  id: Ulid;
  seq: number;
  ts_utc: IsoUtc;
  actor_id: string;
  actor_role: Role | "participant" | "system" | string;
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  head_hash: string;
  first_broken: {
    index: number;
    id: Ulid;
    expected_hash: string;
    actual_hash: string;
  } | null;
  verified_at: IsoUtc;
}

// ---------------------------------------------------------------------------
// §2.2 Eval and §6 Personas
// ---------------------------------------------------------------------------

export interface EvalPersonaSummary {
  id: string;
  name: string;
  category: string;
  hidden: boolean;
  description: string;
  expected_tier: number;
}

export interface PersonaVitalsSample extends Omit<VitalsSample, "tsUtc"> {
  tsOffsetS: number;
}

export interface PersonaPriorCheckin {
  days_ago: number;
  responses: Record<string, Partial<Record<Attribute, number>>>;
  gates: Partial<GatesRequest>;
}

export interface PersonaExpected {
  grades: Record<string, number>;
  tier: number;
  stop_screen: boolean;
  rules_fired_includes: string[];
  rules_fired_excludes: string[];
  sae_clock_started: boolean;
  seriousness_suspected: boolean;
  ae_drafts: number;
  vs_drafts: number;
  cm: Array<{ verbatim: string; cmdecod: string | null; min_confidence: number }>;
  dedup_followups: number;
}

export interface Persona {
  id: string;
  name: string;
  category: string;
  hidden: boolean;
  description: string;
  consent_camera: boolean;
  vitals_scenario: string;
  settings: Partial<RuleSettings>;
  setup: { prior_checkins: PersonaPriorCheckin[] };
  responses: Record<string, Partial<Record<Attribute, number>>>;
  gates: {
    hospitalization: boolean;
    conmed_changed: boolean;
    conmed_text?: string;
    conmed_direction?: ConmedDirection;
    other_text?: string;
    temp_c?: number;
  };
  vitals_samples: PersonaVitalsSample[];
  expected?: PersonaExpected;
}

export interface TierMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface EvalPerPersona {
  persona_id: string;
  name: string;
  hidden: boolean;
  pass: boolean;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  mismatches: string[];
  session_id: Ulid | null;
}

export interface EvalResults {
  run_id: Ulid;
  ran_at: IsoUtc;
  include_hidden: boolean;
  n_personas: number;
  n_pass: number;
  n_fail: number;
  tier_metrics: Record<"0" | "1" | "2" | "3", TierMetrics>;
  /** rows = expected grade, cols = actual grade */
  grade_confusion: number[][];
  dedup_correct: { n: number; correct: number };
  sae_clock_correct: { n: number; correct: number };
  conmed_correct: { n: number; correct: number };
  per_persona: EvalPerPersona[];
  markdown: string;
}

export interface EvalRunRequest {
  include_hidden?: boolean;
  persona_ids?: string[];
}

export interface EvalCustomResponse {
  persona: Persona;
  result: CheckInResult;
  session_id: Ulid;
}

// ---------------------------------------------------------------------------
// §2.2 Reference + Admin
// ---------------------------------------------------------------------------

export interface ReferenceLabel {
  drug: string;
  section: string;
  text: string;
  source_url: string;
  fetched_at: IsoUtc;
  note: string;
}

export interface CtcaeTerm {
  item_id: string;
  aedecod: string;
  meddra_code_mock: string;
  grade_definitions: Record<string, string>;
}

export interface Settings {
  vitals_source: VitalsSourceName | string;
  mock_scenario: string;
  simulated_as_measured: boolean;
  [extra: string]: unknown;
}

export type SettingsUpdate = Partial<
  Pick<Settings, "vitals_source" | "mock_scenario" | "simulated_as_measured">
>;

export interface AdminResetResponse {
  ok: boolean;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// §3.3 Bridge WebSocket messages
// ---------------------------------------------------------------------------

export type BridgeState = "idle" | "warming" | "collecting" | "error";

export interface BridgeHello {
  type: "hello";
  source: VitalsSourceName;
  isMeasured: boolean;
  scenario: string | null;
  minConf: number;
  gates: { pulseS: number; breathingS: number; hrvS: number };
  version: string;
}

export interface BridgeStatusMessage {
  type: "status";
  state: BridgeState;
  message?: string;
  elapsedS: number;
  sessionId: string | null;
}

export interface PublishedFlags {
  pulse: boolean;
  breathing: boolean;
  hrv: boolean;
}

export interface BridgeSampleMessage {
  type: "sample";
  sample: VitalsSample;
  published: PublishedFlags;
  elapsedS: number;
  sessionId: string | null;
}

export interface BridgeWaveformMessage {
  type: "waveform";
  /** ~25 points of synthetic pleth per 1 Hz batch (mock); real sources may omit. */
  values: number[];
  tsUtc: IsoUtc;
}

export interface BridgeErrorMessage {
  type: "error";
  message: string;
}

export type BridgeToWebMessage =
  | BridgeHello
  | BridgeStatusMessage
  | BridgeSampleMessage
  | BridgeWaveformMessage
  | BridgeErrorMessage;

export type WebToBridgeMessage =
  | { type: "start"; sessionId: string; scenario?: string }
  | { type: "stop" }
  | { type: "set_scenario"; scenario: string }
  | { type: "ping" };
