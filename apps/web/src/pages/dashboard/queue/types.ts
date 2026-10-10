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

export type QueueSource = "check_in" | "chart_note";

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
  sae_clock_stopped?: boolean | null;
  sae_clock?: { stopped_at?: IsoUtc | null; due_at?: IsoUtc | null } | null;
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
