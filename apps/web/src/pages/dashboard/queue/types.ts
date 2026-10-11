/**
 * Queue-page view model.
 *
 * `QueueItem` in src/lib/types.ts predates CONTRACTS.md Revision 2 (R2.4): it has
 * no `source` / `note_id`, assumes `session_id` is always set, and carries no
 * "SAE clock stopped" signal. This folder cannot edit the shared types, so the
 * raw API row is widened here and `normalizeQueueItem()` turns it into a
 * `QueueRow` the table can render without null-checking every field.
 */
import type { Domain, IsoUtc, QueueItem, Ulid, VitalsStatus } from "../../../lib/types";

/**
 * Where an item came from. `phone_call` is a chart note whose `note_type` is
 * "phone_call" (CONTRACTS R4.1): the API files it under `source: "chart_note"`,
 * but the coordinator reads "Phone call", so the queue gives it its own value.
 */
export type QueueSource = "check_in" | "chart_note" | "phone_call";

/**
 * Which 24-hour report clock (CONTRACTS R3.2): serious event or special-interest
 * event. `unknown` = the API did not say (or said something unrecognised); the
 * chip then makes no SAE/AESI claim and reads "24-hour report due in hh:mm".
 */
export type ClockKind = "sae" | "aesi" | "unknown";

/** One clock as the API may send it inside a queue row (`clocks[]`, R3.2). */
export interface RawQueueClock {
  id?: Ulid | null;
  kind?: ClockKind | string | null;
  due_at?: IsoUtc | null;
  stopped_at?: IsoUtc | null;
  /** When a packet exists for the clock, the chip links to it (R3.2 packets). */
  packet_id?: Ulid | null;
}

/** A normalized report clock the chip can render. */
export interface QueueClock {
  key: string;
  /** The API's clock id (null for legacy single-clock rows, which carry none). */
  clock_id: Ulid | null;
  kind: ClockKind;
  due_at: IsoUtc | null;
  stopped: boolean;
  stopped_at: IsoUtc | null;
  packet_id: Ulid | null;
}

/**
 * What GET /queue may actually return: the R1 shape plus the R2.4 note fields
 * and a few optional SAE-clock fields the API is free to add. Everything beyond
 * the R1 contract is optional so a minimal API still renders.
 */
export interface RawQueueItem extends Omit<QueueItem, "session_id" | "max_grade" | "draft_counts"> {
  session_id?: Ulid | null;
  note_id?: Ulid | null;
  source?: QueueSource | string;
  max_grade?: number | null;
  draft_counts?: Partial<Record<Domain, number>> | null;
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
  clocks?: RawQueueClock[] | null;
  /** R2.4 / R4.1: chart-note type; "phone_call" marks a logged call. */
  note_type?: string | null;
  note_date?: string | null;
  /** True while drafts await review or an escalation is unacknowledged (API-computed). */
  is_open?: boolean | null;
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
