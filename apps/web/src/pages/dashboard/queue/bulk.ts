/**
 * Bulk review helpers for the worklist: which rows may be selected, and the
 * "Confirm all drafts" run. Selection is deliberately limited to low-risk rows
 * (Tier 0-1, no running 24-hour clock, at least one draft) so a tick-box can
 * never confirm something that needs an investigator's attention.
 */
import { confirmDraft, getCheckIn, getNote } from "../../../lib/api";
import type { QueueRow } from "./types";

export function draftTotal(row: QueueRow): number {
  const c = row.draft_counts;
  return c.AE + c.VS + c.CM;
}

export function canBulkSelect(row: QueueRow): boolean {
  return (
    row.tier <= 1 &&
    row.clocks.every((c) => c.stopped) &&
    row.escalation_acked !== false &&
    draftTotal(row) > 0 &&
    Boolean(row.session_id || row.note_id)
  );
}

export function bulkLockReason(row: QueueRow): string {
  if (row.tier >= 2) return "Tier 2 and above are reviewed one at a time";
  if (row.clocks.some((c) => !c.stopped))
    return "A 24-hour report clock is running; review it one at a time";
  if (row.escalation_acked === false) return "An alert is not acknowledged yet; open it first";
  return "No drafts to confirm";
}

export interface PendingDraft {
  id: string;
  rowKey: string;
  label: string;
  domain: string;
}

/** Loads the still-unconfirmed drafts of the selected rows (one detail call per row). */
export async function loadPendingDrafts(rows: readonly QueueRow[]): Promise<PendingDraft[]> {
  const lists = await Promise.all(
    rows.map(async (row) => {
      const drafts = row.session_id
        ? (await getCheckIn(row.session_id)).drafts
        : row.note_id
          ? (await getNote(row.note_id)).drafts
          : [];
      return drafts
        .filter((d) => d.status === "draft")
        .map((d) => ({ id: d.id, rowKey: row.key, label: row.display_label, domain: d.domain }));
    }),
  );
  return lists.flat();
}

export interface BulkResult {
  confirmed: number;
  failed: number;
}

/** Calls the existing confirm endpoint once per draft; one failure never stops the rest. */
export async function confirmAll(drafts: readonly PendingDraft[]): Promise<BulkResult> {
  const settled = await Promise.allSettled(drafts.map((d) => confirmDraft(d.id)));
  const confirmed = settled.filter((s) => s.status === "fulfilled").length;
  return { confirmed, failed: settled.length - confirmed };
}
