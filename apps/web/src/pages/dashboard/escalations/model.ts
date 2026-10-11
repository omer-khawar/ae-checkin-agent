/**
 * Pure helpers for the Escalations page: no React, no I/O, unit-tested.
 *
 * Everything time-based takes `nowMs` as an argument so the live countdowns are
 * deterministic in tests and so one `useNow()` tick drives every cell.
 */
import type { ClockRow, EscalationRow, EscalationSource, Paginated } from "../../../lib/types";
import type { AckFilter } from "./types";

// ---------------------------------------------------------------------------
// Generic
// ---------------------------------------------------------------------------

/** `GET /sae-clocks` may return a bare array or a paginated envelope; accept both. */
export function normalizeList<T>(x: T[] | Paginated<T> | null | undefined): T[] {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  return Array.isArray(x.items) ? x.items : [];
}

/** Union of lists by `id`, first occurrence wins. */
export function mergeById<T extends { id: string }>(...lists: T[][]): T[] {
  const seen = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) if (!seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

export function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Median of finite numbers; null when there are none. */
export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Clamp a client-side page offset so it always lands on a real page. Needed
 * because the row set can shrink underneath the pager (acknowledging the only
 * row on the last page of the "Open" filter): without this the page would show
 * an empty table and hide the pagination control.
 */
export function clampOffset(offset: number, total: number, pageSize: number): number {
  const size = Math.max(1, Math.floor(pageSize));
  if (total <= 0) return 0;
  const lastPageOffset = Math.floor((total - 1) / size) * size;
  return Math.min(Math.max(0, offset), lastPageOffset);
}

/** "1h 05m" / "2m 03s" / "45s" for a non-negative duration. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export function escalationSource(e: EscalationRow): EscalationSource {
  if (e.source === "chart_note" || e.source === "check_in") return e.source;
  return e.note_id ? "chart_note" : "check_in";
}

export const SOURCE_LABELS: Record<EscalationSource, string> = {
  check_in: "Check-in",
  chart_note: "Chart note",
};

export function isAcked(e: EscalationRow): boolean {
  return e.acked_at !== null && e.acked_at !== undefined;
}

/**
 * When the escalation's clock started. The API's `created_at` is authoritative;
 * `paged_at` is the fallback for a contract-shaped row (Tier 3 only), else null.
 */
export function escalationStartedAt(e: EscalationRow): string | null {
  return e.created_at ?? e.paged_at ?? null;
}

/**
 * Seconds from creation to acknowledgement. Acked rows use the server's
 * `seconds_to_ack` (falling back to the two timestamps); open rows tick live
 * against `nowMs`. Null when nothing can be computed.
 */
export function secondsToAck(e: EscalationRow, nowMs: number): number | null {
  const start = parseMs(escalationStartedAt(e));
  if (isAcked(e)) {
    if (typeof e.seconds_to_ack === "number" && Number.isFinite(e.seconds_to_ack)) {
      return e.seconds_to_ack;
    }
    const end = parseMs(e.acked_at);
    return start !== null && end !== null ? (end - start) / 1000 : null;
  }
  return start !== null ? (nowMs - start) / 1000 : null;
}

export function filterEscalations(rows: EscalationRow[], filter: AckFilter): EscalationRow[] {
  if (filter === "all") return rows;
  return rows.filter((e) => (filter === "acked" ? isAcked(e) : !isAcked(e)));
}

/** Open first, then tier descending, then newest first. */
export function sortEscalations(rows: EscalationRow[]): EscalationRow[] {
  return [...rows].sort((a, b) => {
    const ackDiff = Number(isAcked(a)) - Number(isAcked(b));
    if (ackDiff !== 0) return ackDiff;
    if (b.tier !== a.tier) return b.tier - a.tier;
    return (parseMs(escalationStartedAt(b)) ?? 0) - (parseMs(escalationStartedAt(a)) ?? 0);
  });
}

/** Median time-to-ack across acknowledged rows, in seconds (null when none). */
export function medianSecondsToAck(rows: EscalationRow[]): { median: number | null; n: number } {
  const values = rows
    .filter(isAcked)
    .map((e) => secondsToAck(e, 0))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  return { median: median(values), n: values.length };
}

// ---------------------------------------------------------------------------
// SAE clocks
// ---------------------------------------------------------------------------

export function isClockActive(c: ClockRow): boolean {
  return c.stopped_at === null || c.stopped_at === undefined;
}

/**
 * Live seconds until `due_at` (negative = overdue). Stopped clocks return null.
 * Falls back to the server's `seconds_remaining` snapshot if `due_at` is unparsable.
 */
export function secondsRemaining(c: ClockRow, nowMs: number): number | null {
  if (!isClockActive(c)) return null;
  const due = parseMs(c.due_at);
  if (due !== null) return (due - nowMs) / 1000;
  return typeof c.seconds_remaining === "number" ? c.seconds_remaining : null;
}

export function isOverdue(c: ClockRow, nowMs: number): boolean {
  const s = secondsRemaining(c, nowMs);
  return s !== null && s < 0;
}

/** Active clocks first (soonest due first), then stopped clocks (most recently stopped first). */
export function sortClocks(rows: ClockRow[]): ClockRow[] {
  return [...rows].sort((a, b) => {
    const activeDiff = Number(isClockActive(b)) - Number(isClockActive(a));
    if (activeDiff !== 0) return activeDiff;
    if (isClockActive(a)) return (parseMs(a.due_at) ?? 0) - (parseMs(b.due_at) ?? 0);
    return (parseMs(b.stopped_at) ?? 0) - (parseMs(a.stopped_at) ?? 0);
  });
}

export interface InformationalDeadline {
  key: string;
  label: string;
  iso: string;
}

/** Known keys from packages/rules/interim_rules/seriousness.py; unknown keys are humanised. */
const INFORMATIONAL_LABELS: Record<string, string> = {
  sponsor_fatal_or_life_threatening_due: "Sponsor 7-day (fatal or life-threatening)",
  sponsor_other_serious_due: "Sponsor 15-day (other serious)",
};

function humanise(key: string): string {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Split the clock's `informational` map into date-valued deadlines (rendered as
 * times) and the free-text `source` / `note` strings the rules engine attaches.
 */
export function informationalDeadlines(info: Record<string, string> | null | undefined): {
  deadlines: InformationalDeadline[];
  source: string | null;
  note: string | null;
} {
  const deadlines: InformationalDeadline[] = [];
  let source: string | null = null;
  let note: string | null = null;
  for (const [key, value] of Object.entries(info ?? {})) {
    if (typeof value !== "string") continue;
    if (key === "source") source = value;
    else if (key === "note") note = value;
    else if (parseMs(value) !== null && /\d{4}-\d{2}-\d{2}/.test(value)) {
      deadlines.push({ key, label: INFORMATIONAL_LABELS[key] ?? humanise(key), iso: value });
    }
  }
  deadlines.sort((a, b) => (parseMs(a.iso) ?? 0) - (parseMs(b.iso) ?? 0));
  return { deadlines, source, note };
}

/** The fixed caption for sponsor deadlines (CLAUDE.md §3.4(f)). */
export const INFORMATIONAL_CAPTION = "Informational, not owned by this system (21 CFR 312.32)";
