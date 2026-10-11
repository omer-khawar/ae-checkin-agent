/**
 * Local type extensions for the participant timeline page.
 *
 * `src/lib/types.ts` mirrors CONTRACTS.md §2.2, where the timeline response has
 * no `notes[]`. Revision R2.4 adds `notes[]` (chart-note scanning). This page
 * cannot edit the shared types file (ownership rules for this wave), so it
 * widens the shared `Timeline` type here. When `notes[]` is added to
 * `src/lib/types.ts`, delete this file's `TimelineWithNotes` and import from there.
 *
 * Every field beyond `id` is optional on purpose: the exact summary shape the
 * API puts in `timeline.notes[]` is not pinned by the contract, and the page
 * must render whatever subset arrives.
 */
import type { AEOpen, IsoUtc, Timeline, Ulid } from "../../../lib/types";

/** One chart note as the timeline lists it (R2.4 `ChartNote`, possibly summarised). */
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

/**
 * `AEOpen` plus the optional timestamps the rules-side `OpenAE` carries
 * (`first_reported_at`, `last_reported_at`). When absent we fall back to the
 * linked sessions' timestamps.
 */
export interface AEOpenRow extends AEOpen {
  first_reported_at?: IsoUtc | null;
  last_reported_at?: IsoUtc | null;
}

export interface TimelineWithNotes extends Omit<Timeline, "open_aes"> {
  open_aes: AEOpenRow[];
  notes?: ChartNoteSummary[];
}
