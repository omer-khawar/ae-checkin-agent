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

/**
 * `chart_note` (R2.4: a quoted span of a chart note or call summary) and
 * `protocol` (R3.1: a section and printed page of the study protocol) joined
 * the R1 kinds in Revisions 2 and 3.
 */
export type EvidenceKind =
  | "pro_response"
  | "vitals_sample"
  | "gate_answer"
  | "rule"
  | "table"
  | "chart_note"
  | "protocol";

export interface Evidence {
  kind: EvidenceKind;
  /** answer id / sample id / rule id / table file name / note id / protocol ref */
  id: string;
  ts: IsoUtc | null;
  note: string;
  /** chart_note only: character offsets of the quoted words in the note text. */
  span_start?: number;
  span_end?: number;
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

/**
 * Where a queue item came from. `phone_call` is a chart note whose `note_type`
 * is "phone_call" (R4.1): the API files it under `source: "chart_note"`, but
 * the coordinator reads "Phone call", so the queue gives it its own value.
 */
export type QueueSource = "check_in" | "chart_note" | "phone_call";

/** One clock as the API may send it inside a queue row (`clocks[]`, R3.2). */
export interface QueueItemClock {
  id?: Ulid | null;
  kind?: ClockKind | string | null;
  due_at?: IsoUtc | null;
  stopped_at?: IsoUtc | null;
  /** When a packet exists for the clock, the chip links to it (R3.2 packets). */
  packet_id?: Ulid | null;
}

/**
 * A row of GET /queue: the R1 shape plus the R2.4 note fields and the R3.2
 * clock fields. Everything beyond R1 is optional so a minimal API still
 * renders; `queue/normalize.ts#normalizeQueueItem` turns it into a view row.
 */
export interface QueueItem {
  /** Null for chart-note and phone-call items (R2.4). */
  session_id?: Ulid | null;
  note_id?: Ulid | null;
  source?: QueueSource | string;
  usubjid: string;
  display_label: string;
  completed_at: IsoUtc;
  tier: number;
  tier_name: string;
  max_grade?: number | null;
  vitals_status: VitalsStatus;
  is_measured: boolean;
  has_sae_clock: boolean;
  sae_due_at: IsoUtc | null;
  escalation_acked: boolean | null;
  draft_counts?: Partial<Record<Domain, number>> | null;
  draft_status_summary: string;
  /** Optional: any of these marks the SAE clock as stopped by an investigator. */
  sae_stopped_at?: IsoUtc | null;
  sae_stopped?: boolean | null;
  sae_clock_stopped?: boolean | null;
  sae_clock?: {
    stopped_at?: IsoUtc | null;
    due_at?: IsoUtc | null;
    kind?: ClockKind | string | null;
  } | null;
  /** R3.2: the kind of the row's single legacy clock (no SAE/AESI claim when absent). */
  clock_kind?: ClockKind | string | null;
  sae_kind?: ClockKind | string | null;
  /** R3.2: every clock on the item, each with its kind (wins over the legacy fields). */
  clocks?: QueueItemClock[] | null;
  /** R2.4 / R4.1: chart-note type; "phone_call" marks a logged call. */
  note_type?: string | null;
  note_date?: string | null;
  /** R4.1: who was on a logged call and which way (phone-call rows only). */
  caller?: string | null;
  call_direction?: string | null;
  /** AE drafts on the item that follow up an already-open AE (dedup, §3.4h). */
  followup_count?: number | null;
  /** True while drafts await review or an escalation is unacknowledged (API-computed). */
  is_open?: boolean | null;
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
  /**
   * Optional timestamps the rules-side `OpenAE` carries. When absent the
   * timeline falls back to the linked sessions' timestamps.
   */
  first_reported_at?: IsoUtc | null;
  last_reported_at?: IsoUtc | null;
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
  /** R2.4: chart notes and logged calls for this participant (shape not pinned). */
  notes?: ChartNoteSummary[];
  /** Synthea background chart (simulated); read through timeline/BaselineCard#normalizeBaseline. */
  baseline?: unknown;
}

export type IraeValue = "Y" | "N";

export interface AttributionRequest {
  AEREL?: string;
  AESER?: string;
  /** R4.3: investigator's immune-related assessment; null = not decided (protocol p. 91). */
  INTERIM_IRAE?: IraeValue | null;
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

  // ---- R2.2 extras the live API sends (read through eval/evalExtras.ts) ----
  /**
   * Each persona that declares `counterfactuals` is replayed again with its
   * settings toggled; the harness records baseline tier vs new tier and checks
   * the invariant "settings never change a provisional grade".
   */
  counterfactuals?: EvalCounterfactual[];
  /** Expected keys the harness does not compare (informational). */
  notices?: string[];
  ran_by?: string;
  persona_ids?: string[] | null;
  interim_version?: string;
}

export interface EvalCounterfactual {
  persona_id: string;
  label: string;
  settings?: Record<string, unknown> | null;
  baseline_tier: number;
  tier: number;
  pass: boolean;
  mismatches: string[];
  session_id: Ulid | null;
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
// R3.2 Report clocks (SAE / AESI) and R4.3 stopping one
// ---------------------------------------------------------------------------

/** `sae` = suspected serious event; `aesi` = possible adverse event of special interest. */
export type ClockKind = "sae" | "aesi";

/**
 * A 24-hour report clock as any endpoint returns it (check-in detail, notes,
 * GET /sae-clocks). `session_id` is null for a clock a chart note or phone call
 * started (R2.4); `ae_draft_ids` / `has_ae_draft` are optional hints a newer API
 * may send so the page knows whether the seriousness decision can go through an
 * AE draft's attribution instead.
 */
export interface ClockRow extends Omit<SAEClockRow, "session_id"> {
  session_id: Ulid | null;
  note_id?: Ulid | null;
  kind?: ClockKind | string | null;
  /** Server-side snapshot; pages recompute from `due_at` live. */
  overdue?: boolean;
  created_at?: IsoUtc | null;
  /** The report packet already opened for this clock, when the API joins it. */
  packet_id?: Ulid | null;
  ae_draft_ids?: Ulid[] | null;
  has_ae_draft?: boolean | null;
}

/** `PATCH /sae-clocks/{id}/stop` body (R4.3; investigator only). */
export interface StopClockRequest {
  /** e.g. "AESER = Y" or "AESER = N" (apps/api schemas.StopSaeClockRequest). */
  decision: string;
  note?: string;
}

/** `GET /sae-clocks?active=&limit=&offset=` paging. */
export interface SaeClocksQuery {
  /** `true` = running clocks, `false` = stopped clocks. */
  active: boolean;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// R3.1 Protocol assessment (serialized by the rules package)
// ---------------------------------------------------------------------------

export interface ProtocolRef {
  section: string;
  printed_page: number;
}

export type ProtocolLevel = "prohibited" | "discouraged" | "permitted";

export interface ProtocolConMedFlag {
  level: ProtocolLevel | string;
  drug: string;
  matched_text?: string;
  matched_by?: string;
  protocol_ref?: ProtocolRef | null;
  /** The protocol sentence the classification rests on, verbatim. */
  quote?: string | null;
  /** For discouraged drugs: the protocol's exception wording, verbatim. */
  exception_text?: string | null;
  condition?: string | null;
  is_category?: boolean;
}

export interface ProtocolAssessment {
  protocol_id?: string;
  aesi_suspected?: boolean;
  aesi_items?: string[];
  aesi_reasons?: string[];
  conmed_flags?: ProtocolConMedFlag[];
  conmed_flag?: ProtocolLevel | string | null;
  conmed_notes?: string[];
  cm_missing_fields?: string[];
  tier_floor?: number;
  ae_reporting_window_end?: string | null;
  within_ae_reporting_window?: boolean | null;
  rules_fired?: RuleFired[];
}

/** A rule row that may carry the API's own plain sentence (R3.1 plain_language.json). */
export interface RuleFiredPlain extends RuleFired {
  plain?: string | null;
  plain_sentence?: string | null;
}

/** Evidence pointer as the R3/R4 endpoints may send it (open kind union). */
export interface EvidenceR3 extends Omit<Evidence, "kind"> {
  kind: EvidenceKind | string;
}

/**
 * `GET /checkins/{id}` as R3.2 widens it: every clock may carry a kind, and the
 * response may add the protocol assessment and SDTM → plain labels. Every new
 * field is optional so the page renders against the R2 API as well.
 */
export interface CheckInDetailR3 extends Omit<CheckInDetail, "sae_clock"> {
  sae_clock: ClockRow | null;
  /** R3.1: `CheckInResult.aesi_clock`, surfaced as a row when the API stores it. */
  aesi_clock?: ClockRow | null;
  /** Some builds return every clock of the session as one list. */
  clocks?: ClockRow[] | null;
  protocol?: ProtocolAssessment | null;
  /** SDTM variable → plain label (R3.2). */
  labels?: Record<string, string> | null;
  /** R3.2 kiosk: the camera setting is covered by the enrollment ICF. */
  session: CheckInDetail["session"] & { consent_basis?: string | null };
}

// ---------------------------------------------------------------------------
// R2.4 Chart notes and R4.1 phone calls
// ---------------------------------------------------------------------------

export type CallerKind = "participant" | "caregiver" | "other";
export type CallDirection = "inbound" | "outbound";

/** NegEx-style reasons a mention is excluded from drafting (R2.4). */
export type ExcludedReason =
  | "negated"
  | "historical"
  | "hypothetical"
  | "resolved"
  | "allergy"
  | "indication";

export interface SymptomFinding {
  /** CTCAE v5 term, e.g. "Dyspnea". */
  term: string;
  /** The matched words, verbatim from the note. */
  quote: string;
  span_start: number;
  span_end: number;
  /** Plain-English reason the scanner kept (or excluded) this mention. */
  reason: string;
  /** Provisional grade hint derived from severity words; null when none found. */
  grade_hint: number | null;
  grade_basis: string;
  onset_days: number | null;
  worsening: boolean;
  excluded_reason: ExcludedReason | null;
}

export type MedChange = "started" | "stopped" | "changed" | "taking";

export interface MedFinding {
  /** Lowercase lexicon name, e.g. "loperamide". */
  drug: string;
  change: MedChange;
  quote: string;
  span_start: number;
  span_end: number;
  reason: string;
  excluded_reason: ExcludedReason | null;
}

export type RedFlagLevel = "emergency" | "urgent";

export interface RedFlag {
  level: RedFlagLevel;
  category: string;
  quote: string;
  span_start: number;
  span_end: number;
  reason: string;
}

export interface ScanResult {
  symptoms: SymptomFinding[];
  excluded_symptoms: SymptomFinding[];
  meds: MedFinding[];
  excluded_meds: MedFinding[];
  red_flags: RedFlag[];
}

export interface ChartNote {
  id: Ulid;
  usubjid: string;
  /** Participant label (P-001 …) when the API joins it; otherwise derived from usubjid. */
  display_label?: string;
  note_date: string;
  author: string;
  note_type: string;
  text: string;
  ingested_at: IsoUtc;
  ingested_by: string;
  tier?: number | null;
  /** R4.1 phone calls: who called. */
  caller?: CallerKind | string | null;
  /** R4.1 phone calls: who placed the call. */
  call_direction?: CallDirection | string | null;
}

/** A row of `GET /notes`. Counts are optional: the page falls back to the scan. */
export interface ChartNoteListItem extends ChartNote {
  scan?: ScanResult | null;
  n_symptoms?: number;
  n_meds?: number;
  n_red_flags?: number;
  n_drafts?: number;
  draft_counts?: Partial<Record<"AE" | "VS" | "CM", number>>;
}

/** One chart note as the participant timeline lists it (possibly summarised). */
export interface ChartNoteSummary {
  id: Ulid;
  usubjid?: string;
  /** Date the note was written (ISO date or datetime). */
  note_date?: string | null;
  author?: string | null;
  note_type?: string | null;
  /** The note text, when the API includes it. Verbatim; never parsed here. */
  text?: string | null;
  ingested_at?: IsoUtc | null;
  ingested_by?: string | null;
  /** Some API builds attach counts of drafts the scan produced. */
  draft_count?: number | null;
  drafts?: unknown[] | null;
  escalation_tier?: number | null;
  /** R4.1 phone calls (note_type "phone_call"): who called and which way. */
  caller?: string | null;
  call_direction?: string | null;
}

export interface NoteDraft extends Omit<Draft, "evidence"> {
  evidence: Record<string, Evidence[]>;
  note_id?: Ulid | null;
  source?: QueueSource;
}

export interface NoteEscalation extends Escalation {
  note_id?: Ulid | null;
  source?: "check_in" | "chart_note";
}

/** A report clock as the note endpoints return it (started by a check-in or a note). */
export interface NoteSAEClock extends SAEClockRow {
  note_id?: Ulid | null;
  /** R3.2: `sae` or `aesi`. */
  kind?: ClockKind | string | null;
  /** The report packet already opened for this clock, when the API joins it. */
  packet_id?: Ulid | null;
  ae_draft_ids?: Ulid[] | null;
  has_ae_draft?: boolean | null;
}

export interface ScanRequest {
  text: string;
  /** YYYY-MM-DD; onset dates are computed relative to it. */
  ref_date?: string;
}

export interface NoteIngestRequest {
  usubjid: string;
  note_date: string;
  author: string;
  note_type: string;
  text: string;
  /** R4.1: only with note_type "phone_call". */
  caller?: CallerKind;
  call_direction?: CallDirection;
}

/** `POST /notes` response (R2.4). */
export interface NoteIngestResponse {
  note: ChartNote;
  scan: ScanResult;
  drafts: NoteDraft[];
  escalation: NoteEscalation | null;
  sae_clock: NoteSAEClock | null;
  rules_fired: RuleFiredPlain[];
  why: string[];
  /** R3.2: SDTM variable → plain label, when the API sends it. */
  labels?: Record<string, string> | null;
  /** R3.1: protocol assessment for the note's findings, when the API sends it. */
  protocol?: ProtocolAssessment | null;
}

/** `GET /notes/{id}` response: the note, its stored scan and drafts. */
export type NoteDetailResponse = NoteIngestResponse;

export interface NotesQuery {
  usubjid?: string;
  limit?: number;
  offset?: number;
}

export type NotesPage = Paginated<ChartNoteListItem>;

/** R4.1 "Log a call": the coordinator's call summary, scanned exactly like a chart note. */
export interface PhoneCallRequest {
  usubjid: string;
  /** YYYY-MM-DD the call took place. */
  note_date: string;
  /** Who logged it (the signed-in user's display name). */
  author: string;
  caller: CallerKind;
  call_direction: CallDirection;
  /** The call summary, stored verbatim. */
  text: string;
}

// ---------------------------------------------------------------------------
// R2.3 / R2.4 Escalations page rows
// ---------------------------------------------------------------------------

/** An escalation comes from a kiosk check-in or a chart note (R2.3/R2.4). */
export type EscalationSource = "check_in" | "chart_note";

export interface EscalationRow extends Omit<Escalation, "session_id"> {
  /** Null for chart-note escalations (R2.4). */
  session_id: Ulid | null;
  source?: EscalationSource | string | null;
  /** Set for chart-note escalations (session_id is then null). */
  note_id?: Ulid | null;
  tier_name?: string;
  /** When the escalation was created; the start of the time-to-acknowledge clock. */
  created_at?: IsoUtc | null;
  /**
   * Provenance of the vitals that fed any corroboration rule (CLAUDE.md §3.4(d)):
   * `true` = measured sensor, `false` = simulated. Rendered as a
   * MEASURED/SIMULATED badge when the API sends it, omitted (never guessed) until then.
   */
  vitals_is_measured?: boolean | null;
}

export interface PageEventRow extends PageEvent {
  usubjid?: string | null;
  escalation_id?: Ulid | null;
}

// ---------------------------------------------------------------------------
// §00.3 Generated text (interim_rules.narrative WrittenText)
// ---------------------------------------------------------------------------

/** One generated sentence and the evidence ids it cites (narrative.py Sentence). */
export interface WrittenSentence {
  text: string;
  evidence_ids: string[];
  section?: string | null;
  template_id?: string | null;
}

/**
 * Output of the text writer. `writer` is "template" or "llm" from the contract;
 * a normalizer may map anything else to "unknown" so a page never mislabels who
 * wrote the text.
 */
export interface WrittenText {
  kind: string;
  writer: "template" | "llm" | "unknown";
  sentences: WrittenSentence[];
  text: string;
  fallback_reason?: string | null;
  /**
   * Optional: the resolved pointers for every id the sentences cite, so
   * evidence chips resolve even for evidence the page did not load.
   */
  evidence?: QueryEvidence[] | null;
}

// ---------------------------------------------------------------------------
// R3.2 / R4.2 Report packets
// ---------------------------------------------------------------------------

export type PacketStatus = "draft" | "signed";

/**
 * One evidence pointer on a packet. Superset of `Evidence`: the kind union is
 * open (the API may add kinds such as `phone_call`), and the optional `quote`,
 * spans and `is_measured` are shown when present.
 */
export interface PacketEvidence {
  kind: string;
  id: string;
  ts: IsoUtc | null;
  note: string;
  /** Verbatim words from the source (chart note, call summary, answer text). */
  quote?: string | null;
  span_start?: number | null;
  span_end?: number | null;
  /** Vitals only: whether the sample came from a real sensor or a simulation. */
  is_measured?: boolean | null;
  /** Where the evidence lives, when the API can say (check-in session or note). */
  session_id?: Ulid | null;
  note_id?: Ulid | null;
}

/** A field value as the API sends it; displayed through `formatValue`. */
export type PacketValue = string | number | boolean | null | Array<string | number>;

export interface PacketField {
  /** SDTM variable or SAE-form field name, e.g. `AETERM`, `SAE_ONSET_DATE`. */
  name: string;
  /** Plain-language label shown first ("Side effect", "Started on"). */
  plain_label: string;
  value: PacketValue;
  evidence: PacketEvidence[];
  /** True when a person changed the pre-filled value (time-saved model). */
  edited?: boolean;
  /** Present for vitals fields; the page then shows MEASURED / SIMULATED. */
  is_measured?: boolean | null;
}

/** R4.2: one difference between this follow-up and the report before it. */
export interface PacketChange {
  field: string;
  plain_label?: string;
  before: PacketValue;
  after: PacketValue;
  evidence: PacketEvidence[];
}

export interface Packet {
  id: Ulid;
  clock_id: Ulid;
  kind: ClockKind;
  usubjid: string;
  status: PacketStatus;
  fields: PacketField[];
  missing_information: string[];
  narrative: WrittenText;
  created_at: IsoUtc | null;
  signed_by: string | null;
  signed_at: IsoUtc | null;
  /** R4.2: 0 = initial report, 1..n = follow-ups. */
  sequence: number;
  parent_packet_id: Ulid | null;
  /** R4.2: present on follow-ups (empty list on the initial report). */
  changes_since_previous: PacketChange[];

  // ---- Optional extras the page uses when the API sends them -------------
  display_label?: string | null;
  /** Packet version (PATCH creates a new one). */
  version?: number | null;
  /** 24-hour deadline; when absent the page reads the clock from /sae-clocks. */
  due_at?: IsoUtc | null;
  site_awareness_at?: IsoUtc | null;
  clock_stopped_at?: IsoUtc | null;
  /** Narrative text as a person last saved it, when it differs from the draft. */
  narrative_edited?: { text: string; edited_by: string | null; edited_at: IsoUtc | null } | null;
  /** Extra evidence the narrative cites that is not on any field. */
  evidence_index?: Record<string, PacketEvidence> | PacketEvidence[] | null;
  /** Ids of follow-up reports already started from this one. */
  followup_packet_ids?: Ulid[] | null;
  /** Mock-EDC acknowledgment id after signing. */
  mock_edc_ack_id?: string | null;
}

/** Body of `PATCH /packets/{id}` (versioned, audited). */
export interface PatchPacketRequest {
  /** Field name → new value. Only changed fields are sent. */
  fields?: Record<string, PacketValue>;
  /** The investigator's edited narrative text. */
  narrative_text?: string;
  note?: string;
}

/** `POST /packets {clock_id}` as pages that only navigate to the packet read it. */
export interface PacketRef {
  id: Ulid;
  clock_id?: Ulid;
  kind?: ClockKind | string;
  status?: PacketStatus | string;
}

/** Clock row as the packet page reads it from `GET /sae-clocks` (normalized). */
export interface PacketClock {
  id: Ulid;
  kind?: ClockKind;
  usubjid?: string;
  site_awareness_at: IsoUtc | null;
  due_at: IsoUtc | null;
  stopped_at: IsoUtc | null;
  decision: string | null;
}

/** The deadline the packet header counts down to, wherever it came from. */
export interface PacketDeadline {
  siteAwarenessAt: IsoUtc | null;
  dueAt: IsoUtc | null;
  stoppedAt: IsoUtc | null;
  decision: string | null;
}

// ---------------------------------------------------------------------------
// R3.2 / R3.3 Visit-prep brief
// ---------------------------------------------------------------------------
//
// Contract shape:
//   GET /participants/{usubjid}/brief?since=YYYY-MM-DD →
//     { usubjid, display_label, since, generated_at,
//       sections: [{ key, title, items: [{ text, evidence_ids, link }] }],
//       narrative: WrittenText, questions_to_ask: [str] }
//
// Fields marked "optional extension" are not in the contract; the page renders
// without them and shows richer chips (grade trend arrows, protocol flags,
// MEASURED/SIMULATED from the record, clock kinds and due times) when the API
// sends them. How each narrative.py fact maps onto an item is documented in
// pages/dashboard/brief/model.ts.

/** One provisional grade at one point in time (narrative.py GradePoint). */
export interface BriefGradePoint {
  grade: number;
  /** YYYY-MM-DD or ISO-8601 UTC. */
  date?: string | null;
  evidence_ids?: string[];
}

/** One line in a brief section. `text` is already plain language. */
export interface BriefItem {
  text: string;
  evidence_ids: string[];
  /**
   * In-app route ("/dashboard/checkins/…") or absolute http(s) URL; null when
   * none. Any other scheme (javascript:, data:, …) is shown as plain text.
   */
  link: string | null;

  // ---- optional extensions ----
  /** Provisional grades, oldest first (new side effects). */
  grades?: BriefGradePoint[];
  /** Explicit trend when the API computes it itself. */
  trend?: "up" | "down" | "same" | "new" | null;
  /** Protocol status of a medication change (protocol_rules.json §7.7). */
  protocol_flag?: ProtocolLevel | null;
  protocol_section?: string | null;
  printed_page?: number | null;
  /** Verbatim protocol exception text for a discouraged medication. */
  exception_text?: string | null;
  /** CM fields the coordinator still has to ask for (SDTM names). */
  missing_fields?: string[];
  /** Escalation tier 0..3 (escalations section). */
  tier?: number | null;
  /** Escalations: whether the site acknowledged it (narrative.py EscalationFact). */
  acknowledged?: boolean | null;
  /** Reporting clock kind (clocks section). */
  clock_kind?: ClockKind | null;
  due_at?: string | null;
  /** Clock items only ("running" / "reported (mock)"); escalations use `acknowledged`. */
  status?: string | null;
  /** Clock items: the report packet for this clock, when one has been started. */
  packet_id?: string | null;
  /** Clock items: that packet's status ("draft" / "signed"). */
  packet_status?: string | null;
  /** Vitals context: whether the values came from a real sensor. */
  is_measured?: boolean | null;
  source?: string | null;
  /** Notes section: "phone_call", "er_note", … */
  note_type?: string | null;
  /** Any timestamp worth showing next to the line. */
  ts?: string | null;
}

export interface BriefSection {
  /** Stable machine key, e.g. "new_side_effects", "med_changes", "vitals". */
  key: string;
  /** Plain-language heading from the API. */
  title: string;
  items: BriefItem[];
}

/** A "question to ask at the visit". The contract sends strings; objects are tolerated. */
export interface BriefQuestion {
  text: string;
  evidence_ids: string[];
  /** narrative.py QuestionKind: cm_missing_fields | unresolved_ae | unsigned_packet | other. */
  kind?: string | null;
}

/** Optional extension: what an evidence id points at, so a chip can name and link it. */
export interface BriefEvidenceRef {
  kind?: string | null;
  ts?: string | null;
  note?: string | null;
  link?: string | null;
}

/** The normalized brief the page renders. */
export interface Brief {
  usubjid: string;
  display_label: string;
  /** YYYY-MM-DD cut-off actually used by the API. */
  since: string | null;
  generated_at: string | null;
  sections: BriefSection[];
  narrative: WrittenText | null;
  questions_to_ask: BriefQuestion[];

  // ---- optional extensions ----
  /** One-line plain summary; derived on the page when absent. */
  summary?: string | null;
  /** YYYY-MM-DD of the next scheduled visit, if the API knows it. */
  next_visit?: string | null;
  /** Lookup for evidence chips, keyed by evidence id. */
  evidence?: Record<string, BriefEvidenceRef>;
  /** Synthea background chart (simulated); see timeline/BaselineCard#normalizeBaseline. */
  baseline?: unknown;
}

export interface BriefQuery {
  /** YYYY-MM-DD; omitted → the API's default (the previous visit date). */
  since?: string | null;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// R4.4 Sponsor queries
// ---------------------------------------------------------------------------

export type QueryStatus = "open" | "answered" | "closed";

/** "data" = a record-keeping question; "safety" = touches a safety reporting duty. */
export type QuerySeverity = "data" | "safety";

/**
 * One evidence pointer on a query. Wider than `Evidence` because queries can
 * cite chart notes, protocol pages and other queries' answers.
 */
export interface QueryEvidence {
  kind: string;
  id: string;
  ts?: string | null;
  note?: string | null;
  span_start?: number;
  span_end?: number;
}

/** A row of `GET /queries` (contract `Query` table + optional display extras). */
export interface QueryRow {
  id: string;
  /** Edit-check id ("query.*") or null for a manual query raised by a person. */
  check_id: string | null;
  domain: Domain;
  draft_id: string;
  usubjid: string;
  /** "P-007" when the API joins it; the page falls back to the USUBJID tail. */
  display_label?: string | null;
  /** SDTM variable name, e.g. "CMDOSE". */
  field: string;
  /**
   * Every field the edit check read, `field` first (QueryCandidate.fields),
   * e.g. all the missing CM details. Optional; the page falls back to `field`.
   */
  fields?: string[] | null;
  /** Plain label for `field` when the API sends one (R3.1 plain_language.json). */
  field_label?: string | null;
  text: string;
  severity: QuerySeverity;
  status: QueryStatus;
  /** "edit-check" or the user id of the person who raised it. */
  raised_by: string;
  raised_at: string;
  /** Hours since `raised_at`, computed by the API ("aging in hours"). */
  age_hours?: number | null;
  answer_text?: string | null;
  /** Evidence ids (or resolved pointers) attached to the answer. */
  answer_evidence?: Array<string | QueryEvidence> | null;
  answered_by?: string | null;
  answered_at?: string | null;
  closed_by?: string | null;
  closed_at?: string | null;
  /** Edit-check evidence (QueryCandidate.evidence) when the API includes it. */
  evidence?: QueryEvidence[] | null;
}

/** `GET /queries/{id}`: the row plus the template writer's suggested answer. */
export interface QueryDetail extends QueryRow {
  suggested_answer: WrittenText | null;
  /** Current draft (latest version) when the API embeds it; otherwise fetched. */
  draft?: Draft | null;
  /** Current value of `field` when the API resolves it. */
  current_value?: unknown;
  /**
   * Every evidence id the suggested answer could cite, resolved to its pointer
   * (the API sends this alongside `suggested_answer.evidence`).
   */
  evidence_index?: Record<string, QueryEvidence> | null;
}

export interface QueryCounts {
  open: number;
  answered: number;
  closed: number;
}

/** `GET /queries` page; `counts` is an optional convenience the API may add. */
export interface QueriesPage extends Paginated<QueryRow> {
  counts?: Partial<QueryCounts> | null;
}

export interface QueriesListQuery {
  status?: QueryStatus;
  usubjid?: string;
  limit?: number;
  offset?: number;
}

/** `POST /queries` (admin acting as the sponsor's monitor). */
export interface RaiseQueryRequest {
  draft_id: string;
  field: string;
  text: string;
  severity: QuerySeverity;
}

/** `POST /queries/{id}/answer` (coordinator, investigator or admin). */
export interface AnswerQueryRequest {
  answer_text: string;
  evidence_ids?: string[];
  /** Also correct the record: creates a new draft version (audited). */
  also_edit?: { field: string; value: unknown };
}

// ---------------------------------------------------------------------------
// R3.2 Time saved (GET /metrics/time-saved; R4.4 adds queries answered)
// ---------------------------------------------------------------------------

export interface TimeSavedMetrics {
  minutes_saved: number;
  minutes_manual_baseline: number;
  records_confirmed?: number;
  fields_prefilled?: number;
  fields_edited?: number;
  packets_signed?: number;
  briefs_generated?: number;
  queries_answered?: number;
  basis: string[];
  is_estimate?: boolean;
  disclaimer?: string;
}

// ---------------------------------------------------------------------------
// §2.3 Audit list filters
// ---------------------------------------------------------------------------

export interface AuditListQuery {
  entity_type?: string;
  entity_id?: string;
  /** Exact match on the server (e.g. `draft.confirmed`). */
  action?: string;
  actor_id?: string;
  limit?: number;
  offset?: number;
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
