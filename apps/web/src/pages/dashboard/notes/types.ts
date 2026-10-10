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
  RuleFired,
  SAEClockRow,
  Ulid,
} from "../../../lib/types";

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
  source?: "check_in" | "chart_note";
}

export interface NoteEscalation extends Escalation {
  note_id?: Ulid | null;
  source?: "check_in" | "chart_note";
}

export interface NoteSAEClock extends SAEClockRow {
  note_id?: Ulid | null;
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
}

/** `POST /notes` response (R2.4). */
export interface NoteIngestResponse {
  note: ChartNote;
  scan: ScanResult;
  drafts: NoteDraft[];
  escalation: NoteEscalation | null;
  sae_clock: NoteSAEClock | null;
  rules_fired: RuleFired[];
  why: string[];
}

/** `GET /notes/{id}` response: the note, its stored scan and drafts. */
export type NoteDetailResponse = NoteIngestResponse;

export interface NotesQuery {
  usubjid?: string;
  limit?: number;
  offset?: number;
}

export type NotesPage = Paginated<ChartNoteListItem>;
