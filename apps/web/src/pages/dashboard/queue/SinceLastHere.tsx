/**
 * "Since you were last here" (CONTRACTS R3.3, CLAUDE.md §00.6): the Monday-
 * morning answer to "what happened overnight?", in plain words, above the queue.
 *
 *   Since you were last here (Sun 6:02 PM): 3 check-ins · 2 chart notes ·
 *   1 phone call · 4 need action · 1 open sponsor query · 2 report clocks running
 *
 * Counts come from the whole non-eval queue (every page, every status; see
 * `queueApi.fetchWholeQueue`) plus `GET /queries?status=open`. The queries
 * count is hidden when that endpoint is unavailable; a failed queue count shows
 * one quiet line (the queue below has its own error banner). Re-counts every
 * minute and whenever `refreshKey` changes (the page's Refresh button).
 *
 * When a stored "last here" time is in use, a "Show last 24 hours" button
 * forgets it, so the overnight view is never more than one click away (a
 * rehearsal visit before a demo reset would otherwise hide the reseeded items).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "../../../components/Button";
import { cx, formatLocal, formatUtc } from "../../../lib/format";
import { useLastSeen } from "./lastSeen";
import { countOpenQueries, fetchWholeQueue } from "./queueApi";
import { countLabel, type SinceSummary, summarizeSince } from "./summary";
import type { QueueRow } from "./types";

export const SUMMARY_REFRESH_MS = 60_000;

export interface SinceLastHereProps {
  /** Bump to re-count now (the page's Refresh button). */
  refreshKey?: number;
  refreshIntervalMs?: number;
  /** Shortest visit recorded as "last here" on unload (tests pass a small one). */
  minVisitMs?: number;
}

interface Counts {
  rows: QueueRow[];
  total: number;
}

function Stat({
  n,
  children,
  tone = "neutral",
  title,
}: {
  n: number;
  children: string;
  tone?: "neutral" | "action" | "clock";
  title?: string;
}) {
  const active = n > 0;
  return (
    <li
      className={cx(
        "inline-flex items-baseline gap-1 rounded-lg border px-2.5 py-1 text-sm",
        !active && "border-slate-200 bg-white text-slate-500",
        active && tone === "neutral" && "border-slate-300 bg-white text-slate-900",
        active && tone === "action" && "border-amber-300 bg-amber-50 text-amber-950",
        active && tone === "clock" && "border-red-300 bg-red-50 text-red-900",
      )}
      title={title}
    >
      {children}
    </li>
  );
}

/** " (1 serious, 1 special-interest)" for the clocks stat's hover; empty when none run. */
function kindBreakdown(s: SinceSummary): string {
  if (s.clocksRunning === 0) return "";
  const other = s.clocksRunning - s.saeClocksRunning - s.aesiClocksRunning;
  const parts = [
    s.saeClocksRunning ? `${s.saeClocksRunning} serious` : "",
    s.aesiClocksRunning ? `${s.aesiClocksRunning} special-interest` : "",
    other ? `${other} kind not reported` : "",
  ].filter(Boolean);
  return ` (${parts.join(", ")})`;
}

export function SinceLastHere({
  refreshKey = 0,
  refreshIntervalMs = SUMMARY_REFRESH_MS,
  minVisitMs,
}: SinceLastHereProps) {
  const { since, isDefault, markSeen, resetToDefault } = useLastSeen(minVisitMs);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [failed, setFailed] = useState(false);
  const [openQueries, setOpenQueries] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchWholeQueue().then(
        (c) => {
          if (cancelled) return;
          setCounts(c);
          setFailed(false);
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
      // Optional (R4.4): a missing or failing endpoint just hides the count.
      void countOpenQueries().then(
        (n) => {
          if (!cancelled) setOpenQueries(n);
        },
        () => {
          if (!cancelled) setOpenQueries(null);
        },
      );
    };
    load();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) load();
    }, refreshIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshKey, refreshIntervalMs]);

  const summary: SinceSummary | null = counts
    ? summarizeSince(counts.rows, since, counts.total)
    : null;
  const sinceText = isDefault ? "in the last 24 hours" : `since ${formatLocal(since, "short")}`;
  const nothingNew = summary !== null && summary.checkIns + summary.notes + summary.calls === 0;

  return (
    <section
      aria-labelledby="since-last-here-heading"
      className="rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-3"
      data-testid="since-last-here"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="since-last-here-heading" className="text-sm font-semibold text-slate-900">
          Since you were last here{" "}
          <span className="font-normal text-slate-600" title={`${formatUtc(since)} (UTC)`}>
            ({sinceText})
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          {!isDefault && (
            <Button
              size="sm"
              variant="ghost"
              onClick={resetToDefault}
              title="Forget when you were last here and count everything from the last 24 hours (this browser only)"
            >
              Show last 24 hours
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={markSeen}
            title="Count only what arrives from now on (stored in this browser only)"
          >
            Mark all as seen
          </Button>
        </div>
      </div>

      {summary === null && !failed ? (
        <p className="mt-1 text-sm text-slate-600">Counting what is new…</p>
      ) : summary === null ? (
        <p className="mt-1 text-sm text-slate-600">
          Could not count new items right now; the queue below is still current.
        </p>
      ) : (
        <>
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="What is new">
            <Stat n={summary.checkIns} title="Kiosk check-ins completed by participants">
              {countLabel(summary.checkIns, "check-in")}
            </Stat>
            <Stat
              n={summary.notes}
              title="Chart notes (ER, urgent care, clinic) read by the site and scanned for side effects"
            >
              {countLabel(summary.notes, "chart note")}
            </Stat>
            <Stat n={summary.calls} title="Phone calls logged by the study team">
              {countLabel(summary.calls, "phone call")}
            </Stat>
            <Stat
              n={summary.needAction}
              tone="action"
              title="New items with drafts awaiting review or an alert nobody has acknowledged yet"
            >
              {`${summary.needAction} need${summary.needAction === 1 ? "s" : ""} action`}
            </Stat>
            {openQueries !== null && (
              <li>
                <Link
                  to="/dashboard/queries"
                  className={cx(
                    "inline-flex items-baseline rounded-lg border px-2.5 py-1 text-sm underline-offset-2 hover:underline focus-visible:ring-4",
                    openQueries > 0
                      ? "border-amber-300 bg-amber-50 text-amber-950"
                      : "border-slate-200 bg-white text-slate-500",
                  )}
                  title="Questions from the sponsor's reviewers still waiting for an answer (all, not only new)"
                >
                  {countLabel(openQueries, "open sponsor query", "open sponsor queries")}
                </Link>
              </li>
            )}
            <Stat
              n={summary.clocksRunning}
              tone="clock"
              title={`24-hour sponsor report clocks still running across the queue${kindBreakdown(
                summary,
              )}`}
            >
              {countLabel(summary.clocksRunning, "report clock running", "report clocks running")}
            </Stat>
          </ul>
          {nothingNew && (
            <p className="mt-1 text-xs text-slate-600">Nothing new has arrived {sinceText}.</p>
          )}
          {summary.truncated && (
            <p className="mt-1 text-xs text-slate-600">
              Counted from the first {counts?.rows.length} items only; the true numbers may be
              higher.
            </p>
          )}
        </>
      )}
    </section>
  );
}
