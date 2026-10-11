/**
 * Queue-page view model.
 *
 * The raw API row is `QueueItem` in src/lib/types.ts (R1 shape widened with the
 * R2.4 note fields and the R3.2 clock fields, all optional).
 * `normalizeQueueItem()` turns it into a `QueueRow` the table can render
 * without null-checking every field.
 */
import type {
  ClockKind,
  Domain,
  IsoUtc,
  QueueSource,
  Ulid,
  VitalsStatus,
} from "../../../lib/types";

/**
 * Which 24-hour report clock a chip shows (R3.2): serious event or
 * special-interest event. `unknown` = the API did not say (or said something
 * unrecognised); the chip then makes no SAE/AESI claim and reads "24-hour
 * report due in hh:mm".
 */
export type QueueClockKind = ClockKind | "unknown";

/** A normalized report clock the chip can render. */
export interface QueueClock {
  key: string;
  /** The API's clock id (null for legacy single-clock rows, which carry none). */
  clock_id: Ulid | null;
  kind: QueueClockKind;
  due_at: IsoUtc | null;
  stopped: boolean;
  stopped_at: IsoUtc | null;
  packet_id: Ulid | null;
}

export interface QueueRow {
  /** Stable React key and "seen" key for the pager: session_id or note_id. */
  key: string;
  source: QueueSource;
  session_id: Ulid | null;
  note_id: Ulid | null;
  usubjid: string;
  display_label: string;
  completed_at: IsoUtc | null;
  tier: number;
  tier_name: string;
  max_grade: number | null;
  vitals_status: VitalsStatus | string | null;
  is_measured: boolean;
  has_sae_clock: boolean;
  sae_due_at: IsoUtc | null;
  sae_stopped: boolean;
  sae_stopped_at: IsoUtc | null;
  /** Every 24-hour report clock on the item (serious and/or special-interest). */
  clocks: QueueClock[];
  /** Needs a person: drafts awaiting review or an unacknowledged escalation. */
  needs_action: boolean;
  /** null = no escalation for this item; true/false = acknowledged or not. */
  escalation_acked: boolean | null;
  draft_counts: Record<Domain, number>;
  draft_status_summary: string;
  /** Chart-note type (null for check-ins), e.g. "ed_note", "outside_record". */
  note_type: string | null;
  /** Phone calls: who was on the call and which way (null when unknown). */
  caller: string | null;
  call_direction: string | null;
  /** AE drafts that follow up an already-open AE instead of opening a new one. */
  followup_count: number;
  /** Detail route: /dashboard/checkins/:session_id or /dashboard/notes/:note_id. */
  href: string;
}

export interface QueuePage {
  items: QueueRow[];
  total: number;
  limit: number;
  offset: number;
}

/** The filter controls, as kept in the URL search params. */
export interface QueueFilterState {
  /** What the user typed or picked: a display label (P-007) or a full USUBJID. */
  participant: string;
  minTier: number;
  status: "open" | "all";
  includeEval: boolean;
  offset: number;
}
