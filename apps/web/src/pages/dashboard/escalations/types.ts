/**
 * Local extensions of the shared contract types for the Escalations page.
 *
 * The API serialisers (apps/api/interim_api/services/common.py) emit a few
 * fields beyond CONTRACTS.md §2.2 (`source`, `note_id`, `tier_name`,
 * `created_at`, `overdue`, `usubjid` on pages). They are optional here so the
 * page renders against both the contract shape and the shipped API, and so this
 * folder never has to edit src/lib/types.ts (ownership rule).
 */
import type { Escalation, IsoUtc, PageEvent, SAEClockRow, Ulid } from "../../../lib/types";

/** CONTRACTS.md R2.3/R2.4: an escalation comes from a kiosk check-in or a chart note. */
export type EscalationSource = "check_in" | "chart_note";

export interface EscalationRow extends Omit<Escalation, "session_id"> {
  /** Null for chart-note escalations (CONTRACTS.md R2.4); the shared type says Ulid. */
  session_id: Ulid | null;
  source?: EscalationSource | string | null;
  /** Set for chart-note escalations (session_id is then null). */
  note_id?: Ulid | null;
  tier_name?: string;
  /** When the escalation was created; the start of the time-to-acknowledge clock. */
  created_at?: IsoUtc | null;
  /**
   * Provenance of the vitals that fed any corroboration rule (CLAUDE.md §3.4(d)):
   * `true` = measured sensor, `false` = simulated (mock source, or the admin
   * "treat simulated as measured" toggle). NOT in CONTRACTS.md §2.2 nor in the
   * shipped `escalation_to_dict` yet; rendered as a MEASURED/SIMULATED badge
   * when the API starts sending it, omitted (never guessed) until then.
   */
  vitals_is_measured?: boolean | null;
}

export interface SaeClockRowExt extends Omit<SAEClockRow, "session_id"> {
  /** Null when the clock was started by a chart note (CONTRACTS.md R2.4). */
  session_id: Ulid | null;
  note_id?: Ulid | null;
  /** Server-side snapshot; the page recomputes from `due_at` live. */
  overdue?: boolean;
  created_at?: IsoUtc | null;
}

export interface PageEventRow extends PageEvent {
  usubjid?: string | null;
  escalation_id?: Ulid | null;
}

export type AckFilter = "open" | "acked" | "all";
