/**
 * Pure counting for the "Since you were last here" row (CONTRACTS R3.3).
 * Input is the normalized queue (every page, status=all) and the last-seen
 * instant; output is plain counts the row renders. No I/O, unit-tested.
 */
import type { QueueRow } from "./types";

export interface SinceSummary {
  /** Kiosk check-ins completed after `since`. */
  checkIns: number;
  /** Chart notes (ER, urgent care, clinic) the site read after `since`. */
  notes: number;
  /** Logged phone calls after `since`. */
  calls: number;
  /** Of the new items, how many still need a person (drafts to review or an unacknowledged alert). */
  needAction: number;
  /** 24-hour report clocks still running across the whole queue (not only new items). */
  clocksRunning: number;
  /** Of those, how many are special-interest (AESI) clocks. */
  aesiClocksRunning: number;
  /** Of those, how many are serious-event (SAE) clocks; the rest are of unknown kind. */
  saeClocksRunning: number;
  /** True when the API had more rows than were fetched, so counts are a floor. */
  truncated: boolean;
}

/** Items whose `completed_at` (for notes: when the site read them) is after `sinceIso`. */
export function rowsSince(rows: readonly QueueRow[], sinceIso: string): QueueRow[] {
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return [...rows];
  return rows.filter((r) => {
    const t = r.completed_at ? Date.parse(r.completed_at) : Number.NaN;
    return Number.isFinite(t) && t > since;
  });
}

export function summarizeSince(
  rows: readonly QueueRow[],
  sinceIso: string,
  total: number = rows.length,
): SinceSummary {
  const fresh = rowsSince(rows, sinceIso);
  let clocksRunning = 0;
  let aesiClocksRunning = 0;
  let saeClocksRunning = 0;
  for (const r of rows) {
    for (const c of r.clocks) {
      if (c.stopped) continue;
      clocksRunning += 1;
      if (c.kind === "aesi") aesiClocksRunning += 1;
      else if (c.kind === "sae") saeClocksRunning += 1;
    }
  }
  return {
    checkIns: fresh.filter((r) => r.source === "check_in").length,
    notes: fresh.filter((r) => r.source === "chart_note").length,
    calls: fresh.filter((r) => r.source === "phone_call").length,
    needAction: fresh.filter((r) => r.needs_action).length,
    clocksRunning,
    aesiClocksRunning,
    saeClocksRunning,
    truncated: total > rows.length,
  };
}

/** "1 check-in" / "3 check-ins". */
export function countLabel(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
