/**
 * SAE clock countdown arithmetic (CLAUDE.md §3.4(f)): the site has 24 h from
 * `site_awareness_at` to report to the sponsor; the queue row carries only
 * `sae_due_at`, so everything here derives from that. Pure; the chip passes in
 * `now` so the display is testable.
 */

/** Chip turns red when less than this remains. */
export const URGENT_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type SaeState =
  | { kind: "stopped" }
  | { kind: "unknown" } // has_sae_clock but the API sent no due_at
  | { kind: "running"; remainingMs: number; urgent: boolean; overdue: boolean };

export function saeState(dueAt: string | null, stopped: boolean, nowMs: number): SaeState {
  if (stopped) return { kind: "stopped" };
  if (!dueAt) return { kind: "unknown" };
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return { kind: "unknown" };
  const remainingMs = due - nowMs;
  return {
    kind: "running",
    remainingMs,
    overdue: remainingMs < 0,
    urgent: remainingMs < URGENT_THRESHOLD_MS,
  };
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

export interface RemainingText {
  /** "hh:mm" (unit hrs) when at least an hour remains, else "mm:ss" (unit min). */
  text: string;
  unit: "hrs" | "min";
  overdue: boolean;
}

/** Overdue values are shown as positive elapsed time with `overdue: true`. */
export function formatRemaining(remainingMs: number): RemainingText {
  const overdue = remainingMs < 0;
  const s = Math.floor(Math.abs(remainingMs) / 1000);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return { text: `${two(h)}:${two(m)}`, unit: "hrs", overdue };
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return { text: `${two(m)}:${two(sec)}`, unit: "min", overdue };
}
