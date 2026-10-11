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

/**
 * Plain-language remaining time for the report-clock chip:
 * "21:14" (hh:mm) when at least an hour remains, "42 min" below that,
 * and a spoken form for screen readers ("21 hours 14 minutes").
 * Overdue values are positive elapsed time with `overdue: true`.
 */
export interface PlainRemaining {
  /** Visible text: "21:14" or "42 min" (or "under 1 min"). */
  text: string;
  /** Screen-reader text: "21 hours 14 minutes", "42 minutes". */
  spoken: string;
  overdue: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function plainRemaining(remainingMs: number): PlainRemaining {
  const overdue = remainingMs < 0;
  const totalMin = Math.floor(Math.abs(remainingMs) / 60_000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return {
      text: `${two(h)}:${two(m)}`,
      spoken: `${plural(h, "hour")} ${plural(m, "minute")}`,
      overdue,
    };
  }
  if (totalMin === 0) return { text: "under 1 min", spoken: "under 1 minute", overdue };
  return { text: `${totalMin} min`, spoken: plural(totalMin, "minute"), overdue };
}
