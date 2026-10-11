/**
 * Pure helpers for the participant timeline: ordering, de-duplication and the
 * row shapes the Recharts charts and their table-view twins share.
 *
 * Nothing here decides anything clinical. Grades and composites arrive from
 * the API (rules engine output); this file only sorts and labels them.
 */
import type {
  ConmedDirection,
  Item,
  Session,
  SymptomPoint,
  VitalsSeriesPoint,
} from "../../../lib/types";

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Epoch milliseconds for an ISO string, or NaN. */
export function toMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return new Date(iso).getTime();
}

/** The best timestamp for a session row: completion wins, then start. */
export function sessionTs(s: Pick<Session, "started_at" | "completed_at">): string {
  return s.completed_at ?? s.started_at;
}

/**
 * X-axis domain for a numeric time axis. A single point (or all-equal
 * timestamps) would collapse the domain and Recharts would draw the mark at
 * the left edge, so pad it by half a day on each side; otherwise pad 5 %.
 */
export function timeDomain(msValues: number[]): [number, number] {
  const valid = msValues.filter((v) => Number.isFinite(v));
  if (valid.length === 0) {
    const now = Date.now();
    return [now - 86_400_000, now];
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const span = max - min;
  const pad = span === 0 ? 43_200_000 : span * 0.05;
  return [min - pad, max + pad];
}

const TICK_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Short local date for an axis tick ("Oct 3"). */
export function formatTick(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return TICK_FMT.format(new Date(ms));
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a calendar date with no time part ("2026-10-02"), as R2.4 `ChartNote.note_date` is. */
export function isDateOnly(value: string | null | undefined): value is string {
  return typeof value === "string" && DATE_ONLY_RE.test(value);
}

// Calendar dates are formatted in UTC on purpose: `new Date("2026-10-02")` is
// UTC midnight, and a local-time formatter would print the previous day in any
// timezone west of Greenwich. A date has no timezone, so it must not shift.
const DATE_ONLY_FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

/**
 * "2026-10-02" → "Oct 02, 2026" in every timezone. Returns null for anything
 * that is not a valid date-only string, so callers fall back to `<Time>` for
 * real datetimes (which do carry a timezone and are shown in local time).
 */
export function formatDateOnly(value: string | null | undefined): string | null {
  if (!isDateOnly(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return DATE_ONLY_FMT.format(new Date(ms));
}

// ---------------------------------------------------------------------------
// Items (labels for the symptom sparklines)
// ---------------------------------------------------------------------------

export interface ItemMeta {
  label: string;
  ctcaeTerm: string | null;
  order: number;
}

/** "shortness_of_breath" → "Shortness of breath" (fallback when GET /items is unavailable). */
export function humanizeItemId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  if (!words) return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Build a lookup from the items table so sparklines carry the real short labels. */
export function itemMetaFromItems(items: Item[] | null | undefined): Record<string, ItemMeta> {
  const out: Record<string, ItemMeta> = {};
  for (const it of items ?? []) {
    out[it.id] = {
      label: it.short_label || it.label || humanizeItemId(it.id),
      ctcaeTerm: it.ctcae_term || null,
      order: Number.isFinite(it.order) ? it.order : Number.MAX_SAFE_INTEGER,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Symptom series
// ---------------------------------------------------------------------------

export interface SymptomRow extends SymptomPoint {
  /** Epoch ms of `ts` for the numeric x axis. */
  t: number;
}

export interface SymptomSeries {
  itemId: string;
  label: string;
  ctcaeTerm: string | null;
  rows: SymptomRow[];
  /** The most recent point (direct label for the sparkline's endpoint). */
  latest: SymptomRow | null;
  /** Highest provisional grade ever reported for this item. */
  maxGrade: number;
}

function clampGrade(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(3, Math.max(0, Math.round(v)));
}

/**
 * Sort ascending by time and keep one row per session (the last one wins, as
 * an API that re-runs rules would emit the latest). Rows with an unparseable
 * timestamp are dropped: they cannot be placed on a time axis.
 */
export function symptomRows(points: SymptomPoint[] | null | undefined): SymptomRow[] {
  const bySession = new Map<string, SymptomRow>();
  for (const p of points ?? []) {
    if (!p || typeof p.session_id !== "string") continue;
    const t = toMs(p.ts);
    if (!Number.isFinite(t)) continue;
    bySession.set(p.session_id, {
      session_id: p.session_id,
      ts: p.ts,
      composite: clampGrade(p.composite),
      grade: clampGrade(p.grade),
      t,
    });
  }
  return [...bySession.values()].sort((a, b) => a.t - b.t);
}

/**
 * One series per item, ordered by the items table (`order`), then by label for
 * items the table does not know. Items with no points are kept (empty state),
 * so a participant who never reported an item still shows a flat sparkline.
 */
export function buildSymptomSeries(
  symptomSeries: Record<string, SymptomPoint[]> | null | undefined,
  meta: Record<string, ItemMeta>,
): SymptomSeries[] {
  const ids = new Set<string>([...Object.keys(meta), ...Object.keys(symptomSeries ?? {})]);
  const out: SymptomSeries[] = [];
  for (const itemId of ids) {
    const rows = symptomRows(symptomSeries?.[itemId]);
    const m = meta[itemId];
    out.push({
      itemId,
      label: m?.label ?? humanizeItemId(itemId),
      ctcaeTerm: m?.ctcaeTerm ?? null,
      rows,
      latest: rows.length ? rows[rows.length - 1] : null,
      maxGrade: rows.reduce((acc, r) => Math.max(acc, r.grade), 0),
    });
  }
  return out.sort((a, b) => {
    const oa = meta[a.itemId]?.order ?? Number.MAX_SAFE_INTEGER;
    const ob = meta[b.itemId]?.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.label.localeCompare(b.label);
  });
}

// ---------------------------------------------------------------------------
// Vitals series
// ---------------------------------------------------------------------------

export interface VitalsRow extends VitalsSeriesPoint {
  t: number;
}

/** Sorted ascending, one row per session, unparseable timestamps dropped. */
export function vitalsRows(series: VitalsSeriesPoint[] | null | undefined): VitalsRow[] {
  const bySession = new Map<string, VitalsRow>();
  for (const p of series ?? []) {
    if (!p || typeof p.session_id !== "string") continue;
    const t = toMs(p.ts);
    if (!Number.isFinite(t)) continue;
    bySession.set(p.session_id, {
      session_id: p.session_id,
      ts: p.ts,
      pulse_median: numOrNull(p.pulse_median),
      breathing_median: numOrNull(p.breathing_median),
      is_measured: p.is_measured === true,
      source: p.source ?? null,
      t,
    });
  }
  return [...bySession.values()].sort((a, b) => a.t - b.t);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** True when at least one row has a value for the metric (otherwise the chart shows an empty state). */
export function hasMetric(rows: VitalsRow[], key: "pulse_median" | "breathing_median"): boolean {
  return rows.some((r) => r[key] !== null);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Newest first by completion (then start) time; incomplete sessions sort by start. */
export function sessionsNewestFirst(sessions: Session[] | null | undefined): Session[] {
  return [...(sessions ?? [])]
    .filter((s): s is Session => Boolean(s) && typeof s.id === "string")
    .sort((a, b) => toMs(sessionTs(b)) - toMs(sessionTs(a)));
}

/** Lookup of session id → session for the AE list's first/last links. */
export function sessionIndex(sessions: Session[] | null | undefined): Record<string, Session> {
  const out: Record<string, Session> = {};
  for (const s of sessions ?? []) if (s && typeof s.id === "string") out[s.id] = s;
  return out;
}

// ---------------------------------------------------------------------------
// Con-meds
// ---------------------------------------------------------------------------

export const DIRECTION_LABELS: Record<ConmedDirection, string> = {
  started: "Started",
  stopped: "Stopped",
  both: "Started and stopped",
};

export function directionLabel(direction: ConmedDirection | string | null | undefined): string {
  if (!direction) return "Not stated";
  return (DIRECTION_LABELS as Record<string, string>)[direction] ?? direction;
}

/** Route to a check-in detail page (CONTRACTS.md §4). */
export function checkinPath(sessionId: string): string {
  return `/dashboard/checkins/${encodeURIComponent(sessionId)}`;
}

/**
 * Route to a chart-note page: `/dashboard/notes/:noteId` → NoteDetail (added to
 * App.tsx by the notes page alongside R2.4). Kept in one place so a route
 * rename is a one-line edit.
 */
export function notePath(noteId: string): string {
  return `/dashboard/notes/${encodeURIComponent(noteId)}`;
}
