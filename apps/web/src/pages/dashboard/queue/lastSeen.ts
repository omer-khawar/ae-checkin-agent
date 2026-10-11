/**
 * "Since you were last here": when did this browser last leave the dashboard?
 *
 * The timestamp is written to localStorage when the page unloads (`pagehide`,
 * with `beforeunload` as a fallback) and read once when the queue mounts, so
 * moving between dashboard pages inside the app does not reset it. With
 * nothing stored (first visit, private window, blocked storage) it defaults to
 * 24 hours ago. It is a per-browser convenience, not an audit fact: nothing
 * here is sent to the API.
 *
 * Two guards keep the Monday-morning view (CLAUDE.md §00.6) from vanishing:
 * - A visit shorter than `MIN_VISIT_MS` (a reload, a quick peek, a tab closed
 *   right away) is not recorded, so reloading the queue does not zero the
 *   overnight counts. Only a visit long enough to have read the queue counts
 *   as "having been here".
 * - When a stored time is in use, `resetToDefault()` (the "Show last 24 hours"
 *   button) forgets it and goes back to the 24-hour window, so the overnight
 *   view is always one click away without devtools.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const LAST_SEEN_STORAGE_KEY = "interim.queue.lastSeenAt";
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** A queue visit shorter than this is not written as "last seen" on unload. */
export const MIN_VISIT_MS = 2 * 60 * 1000;

export interface LastSeen {
  /** UTC ISO timestamp the summary counts from. */
  since: string;
  /** True when nothing usable was stored and the 24-hour default applies. */
  isDefault: boolean;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultLastSeen(nowMs: number): LastSeen {
  return { since: new Date(nowMs - DEFAULT_LOOKBACK_MS).toISOString(), isDefault: true };
}

/**
 * Read the stored timestamp. Missing, unparseable or future values fall back to
 * `nowMs - 24 h` (a future value would hide everything, so it is not trusted).
 */
export function readLastSeen(nowMs: number = Date.now()): LastSeen {
  const fallback = defaultLastSeen(nowMs);
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(LAST_SEEN_STORAGE_KEY) ?? null;
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > nowMs) return fallback;
  return { since: new Date(t).toISOString(), isDefault: false };
}

/** Store "now" (or a given instant) as the last-seen time. Storage errors are ignored. */
export function writeLastSeen(iso: string = new Date().toISOString()): void {
  try {
    storage()?.setItem(LAST_SEEN_STORAGE_KEY, iso);
  } catch {
    /* blocked storage: the summary simply keeps the 24 h default next time */
  }
}

/** Forget the stored time, so the next read is the 24-hour default. Errors are ignored. */
export function clearLastSeen(): void {
  try {
    storage()?.removeItem(LAST_SEEN_STORAGE_KEY);
  } catch {
    /* blocked storage: nothing was stored either */
  }
}

/**
 * The last-seen time for this page view, fixed at mount, plus:
 * - `markSeen()` moves it to now (the "Mark all as seen" button);
 * - `resetToDefault()` forgets it and shows the last 24 hours again.
 * Registers the unload listeners that record when the coordinator left, but
 * only after a visit of at least `minVisitMs` (see the file comment).
 */
export function useLastSeen(
  minVisitMs: number = MIN_VISIT_MS,
): LastSeen & { markSeen: () => void; resetToDefault: () => void } {
  const [value, setValue] = useState<LastSeen>(() => readLastSeen());
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    mountedAt.current = Date.now();
    const onLeave = () => {
      if (Date.now() - mountedAt.current >= minVisitMs) writeLastSeen();
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [minVisitMs]);

  const markSeen = useCallback(() => {
    const now = new Date().toISOString();
    writeLastSeen(now);
    setValue({ since: now, isDefault: false });
  }, []);

  const resetToDefault = useCallback(() => {
    clearLastSeen();
    // Restart the visit timer too: leaving straight after this click must not
    // overwrite the overnight view that was just restored.
    mountedAt.current = Date.now();
    setValue(defaultLastSeen(Date.now()));
  }, []);

  return { ...value, markSeen, resetToDefault };
}
