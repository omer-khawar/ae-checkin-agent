/**
 * Fetch GET /queue for a filter set and keep it fresh.
 *
 * - Re-fetches every `intervalMs` (default 15 s), skipping ticks while the tab
 *   is hidden and catching up on `visibilitychange`.
 * - Keeps the previous page on screen while a refresh or a filter change is in
 *   flight (`refreshing`), and only shows the blocking `loading` state when
 *   there is nothing to show yet.
 * - Calls `onRefresh(next, prev)` on every successful re-fetch of the SAME
 *   query so the page can diff for newly arrived Tier 3 items (the mock pager
 *   toast). A query change re-seeds instead of diffing: widening a filter is
 *   not a new arrival.
 * - Stale responses (an older request resolving after a newer one) are dropped.
 * - `enabled: false` holds the first fetch (the page uses it while a deep-linked
 *   participant label is still being resolved to a USUBJID); the hook reports
 *   `loading` meanwhile so the UI never shows a blank card.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { getQueue, nowIso } from "../../../lib/api";
import type { QueueQuery } from "../../../lib/types";
import { normalizeQueueItem } from "./normalize";
import type { QueuePage, QueueRow, RawQueueItem } from "./types";

export interface QueuePollingOptions {
  intervalMs?: number;
  onRefresh?: (next: QueueRow[], prev: QueueRow[]) => void;
  /** When false, no request is made until it becomes true (default true). */
  enabled?: boolean;
}

export interface QueuePollingState {
  data: QueuePage | null;
  error: unknown;
  /** No data yet and a request is in flight. */
  loading: boolean;
  /** Data is on screen and a newer request is in flight. */
  refreshing: boolean;
  /** UTC ISO of the last successful fetch. */
  updatedAt: string | null;
  refresh: () => void;
}

export const DEFAULT_REFRESH_MS = 15_000;

export function useQueuePolling(
  query: QueueQuery,
  { intervalMs = DEFAULT_REFRESH_MS, onRefresh, enabled = true }: QueuePollingOptions = {},
): QueuePollingState {
  // Serialise so an equal-by-value query object does not restart the effect.
  const key = JSON.stringify(query);
  const [data, setData] = useState<QueuePage | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Starts true so the very first paint already shows the loading state; the
  // effect below flips it as soon as the first request settles.
  const [inflight, setInflight] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [manualTick, setManualTick] = useState(0);

  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  /** Last successful result and the key it was fetched for. */
  const lastRef = useRef<{ key: string; items: QueueRow[] } | null>(null);
  /** Monotonic request counter so late responses never overwrite newer ones. */
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const q = JSON.parse(key) as QueueQuery;

    const load = async (reason: "initial" | "interval" | "visible") => {
      if (reason !== "initial" && typeof document !== "undefined" && document.hidden) return;
      const seq = ++seqRef.current;
      setInflight(true);
      try {
        const page = await getQueue(q);
        if (cancelled || seq !== seqRef.current) return;
        const items = (page.items as RawQueueItem[]).map(normalizeQueueItem);
        const prev = lastRef.current;
        if (prev && prev.key === key) onRefreshRef.current?.(items, prev.items);
        lastRef.current = { key, items };
        setData({ items, total: page.total, limit: page.limit, offset: page.offset });
        setError(null);
        setUpdatedAt(nowIso());
      } catch (e) {
        if (cancelled || seq !== seqRef.current) return;
        setError(e);
      } finally {
        if (!cancelled && seq === seqRef.current) setInflight(false);
      }
    };

    void load("initial");
    const timer = setInterval(() => void load("interval"), intervalMs);
    const onVisible = () => {
      if (!document.hidden) void load("visible");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs, manualTick, enabled]);

  const refresh = useCallback(() => setManualTick((t) => t + 1), []);

  return {
    data,
    error,
    loading: data === null && (inflight || !enabled),
    refreshing: inflight && data !== null,
    updatedAt,
    refresh,
  };
}
