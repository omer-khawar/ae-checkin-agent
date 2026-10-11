/**
 * Chart-note types (CONTRACTS.md R2.4). These live here rather than in
 * `src/lib/types.ts` because that file is owned by another wave; the integrator
 * may move them there verbatim.
 *
 * Every shape is read through a `normalize*` function (see `normalize.ts`) so a
 * missing optional field, or the legacy field names from the scanner's source
 * repository (`grade`, `onset_days_ago`, `action`, `excluded`, `reasoning`,
 * `mentioned_as`), never breaks the page.
 */
import type {
  Draft,
  Escalation,
  Evidence,
  IsoUtc,
  Paginated,
  SAEClockRow,
  Ulid,
} from "../../../lib/types";
import type {
  CallDirection,
  CallerKind,
  ClockKind,
  ProtocolAssessment,
  RuleFiredPlain,
} from "../detail/r34Types";

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

/** Evidence pointer on a chart-note draft field: `kind: "chart_note"` plus the span. */
export interface NoteEvidence extends Omit<Evidence, "kind"> {
  kind: Evidence["kind"] | "chart_note";
  span_start?: number;
  span_end?: number;
}

export interface NoteDraft extends Omit<Draft, "evidence"> {
  evidence: Record<string, NoteEvidence[]>;
  note_id?: Ulid | null;
  source?: "check_in" | "chart_note" | "phone_call";
}

export interface NoteEscalation extends Escalation {
  note_id?: Ulid | null;
  source?: "check_in" | "chart_note";
}

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
