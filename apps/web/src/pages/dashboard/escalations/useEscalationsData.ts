/**
 * Loads everything the Escalations page shows in one pass:
 *   GET /escalations (every page)                  → EscalationRow[]
 *   GET /sae-clocks?active=true|false (every page, merged) → SaeClockRowExt[]
 *   GET /pages (every page)                        → PageEventRow[]
 *
 * All three are fetched client-side in full (bounded by `fetchAllPages`) so the
 * summary tiles, the open/acked filter and the median time-to-acknowledge are
 * computed over the same complete set. The demo dataset is small (tens of rows);
 * see DECISIONS in the final report for the trade-off.
 *
 * The three loads are independent (`Promise.allSettled`): if one endpoint fails
 * the other sections still render, and the failed one reports its own error so
 * the page can show a per-section banner. A section's data is `null` while it
 * has not loaded (first load, or failed on the latest reload).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAllPages, listEscalations, listPages } from "../../../lib/api";
import { listSaeClocksPage } from "./api";
import { mergeById } from "./model";
import type { EscalationRow, PageEventRow, SaeClockRowExt } from "./types";

export interface EscalationsData {
  escalations: EscalationRow[] | null;
  clocks: SaeClockRowExt[] | null;
  pages: PageEventRow[] | null;
}

export type SectionKey = keyof EscalationsData;

/** Per-section load errors; `null` when that section loaded. */
export type SectionErrors = Record<SectionKey, unknown>;

export interface UseEscalationsData {
  /** `null` until the first load settles; afterwards every key is an array or `null` (failed). */
  data: EscalationsData | null;
  errors: SectionErrors;
  /** True when every section failed: the page shows one banner instead of three. */
  allFailed: boolean;
  loading: boolean;
  reload: () => void;
  /** Replace one escalation in place (after an acknowledgement). */
  replaceEscalation: (next: EscalationRow) => void;
  /** Replace one clock in place (after a seriousness decision, R4.3). */
  replaceClock: (next: SaeClockRowExt) => void;
}

const NO_ERRORS: SectionErrors = { escalations: null, clocks: null, pages: null };

/**
 * `GET /sae-clocks?active=true` is the contract; the shipped API treats
 * `active=false` as "stopped only" (services/dashboard.py#list_sae_clocks), so
 * both are walked in full and merged by id. If one of the two fails the other
 * alone is shown; if both fail the section reports an error.
 */
async function loadClocks(): Promise<SaeClockRowExt[]> {
  // SAEClockRow is structurally assignable to SaeClockRowExt (only widens session_id).
  const walk = (active: boolean) =>
    fetchAllPages<SaeClockRowExt>((limit, offset) => listSaeClocksPage({ active, limit, offset }));
  const [active, stopped] = await Promise.allSettled([walk(true), walk(false)]);
  if (active.status === "rejected" && stopped.status === "rejected") throw active.reason;
  const a = active.status === "fulfilled" ? active.value : [];
  const b = stopped.status === "fulfilled" ? stopped.value : [];
  return mergeById(a, b);
}

function settledValue<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

function settledError<T>(r: PromiseSettledResult<T>): unknown {
  return r.status === "rejected" ? (r.reason ?? new Error("Request failed")) : null;
}

export function useEscalationsData(): UseEscalationsData {
  const [data, setData] = useState<EscalationsData | null>(null);
  const [errors, setErrors] = useState<SectionErrors>(NO_ERRORS);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    void Promise.allSettled([
      fetchAllPages<EscalationRow>((limit, offset) => listEscalations({ limit, offset })),
      loadClocks(),
      fetchAllPages<PageEventRow>((limit, offset) => listPages({ limit, offset })),
    ]).then(([escalations, clocks, pages]) => {
      if (seq !== requestSeq.current) return; // a newer reload superseded this one
      setData({
        escalations: settledValue(escalations),
        clocks: settledValue(clocks),
        pages: settledValue(pages),
      });
      setErrors({
        escalations: settledError(escalations),
        clocks: settledError(clocks),
        pages: settledError(pages),
      });
      setLoading(false);
    });
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const replaceEscalation = useCallback((next: EscalationRow) => {
    setData((prev) =>
      prev && prev.escalations
        ? { ...prev, escalations: prev.escalations.map((e) => (e.id === next.id ? next : e)) }
        : prev,
    );
  }, []);

  const replaceClock = useCallback((next: SaeClockRowExt) => {
    setData((prev) =>
      prev && prev.clocks
        ? {
            ...prev,
            clocks: prev.clocks.map((c) => (c.id === next.id ? { ...c, ...next } : c)),
          }
        : prev,
    );
  }, []);

  const allFailed = errors.escalations !== null && errors.clocks !== null && errors.pages !== null;

  return { data, errors, allFailed, loading, reload, replaceEscalation, replaceClock };
}
