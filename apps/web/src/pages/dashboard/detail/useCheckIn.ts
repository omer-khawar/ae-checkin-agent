/**
 * Data loading for the detail page: the check-in itself (required), plus the
 * items table (for answer wording) and the CTCAE reference (for grade hover
 * text), both optional — the page renders without them.
 */
import { useCallback, useEffect, useState } from "react";

import { getCheckIn, getItems, getReferenceCtcae } from "../../../lib/api";
import type { CheckInDetail, CtcaeTerm, Item } from "../../../lib/types";

export interface CheckInState {
  detail: CheckInDetail | null;
  items: Item[] | null;
  ctcae: CtcaeTerm[] | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
  /** Replace the detail in place (after a mutation returns the new row). */
  setDetail: (updater: (d: CheckInDetail) => CheckInDetail) => void;
}

export function useCheckIn(sessionId: string | undefined): CheckInState {
  const [detail, setDetailState] = useState<CheckInDetail | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [ctcae, setCtcae] = useState<CtcaeTerm[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      setError(new Error("No check-in id in the URL"));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCheckIn(sessionId)
      .then((d) => {
        if (!cancelled) setDetailState(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick]);

  // Optional reference data: failures are silent (the page degrades to defaults).
  useEffect(() => {
    let cancelled = false;
    getItems()
      .then((r) => {
        if (!cancelled && Array.isArray(r.items)) setItems(r.items);
      })
      .catch(() => undefined);
    getReferenceCtcae()
      .then((r) => {
        if (cancelled) return;
        const rows = Array.isArray(r) ? r : ((r as { terms?: CtcaeTerm[] }).terms ?? []);
        setCtcae(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const setDetail = useCallback((updater: (d: CheckInDetail) => CheckInDetail) => {
    setDetailState((d) => (d ? updater(d) : d));
  }, []);

  return { detail, items, ctcae, loading, error, reload, setDetail };
}
