/**
 * Time-saved chip for the app header: "≈ 3.5 h saved · estimate" (CLAUDE.md §00.5, CONTRACTS
 * R3.2 `GET /metrics/time-saved`). It replaces the old full-width strip.
 *
 * Honest by construction:
 * - "estimate" is always visible beside the number, and the number is prefixed with "≈".
 * - Clicking the chip opens a popover with the server's `basis[]` lines (per-category
 *   arithmetic from `packages/rules/data/time_model.json`) and the counts behind them.
 * - If the endpoint is missing or fails, nothing renders: no number beats a wrong one.
 *
 * "This week" starts Monday 00:00 in the viewer's local time, sent as `YYYY-MM-DD`.
 * Re-fetched every 5 minutes. Export name kept (`TimeSavedStrip`) for the shell and tests.
 */
import { Clock } from "lucide-react";
import { useEffect, useState } from "react";

import { getTimeSaved } from "../lib/api";
import { cn } from "@/lib/cn";
import type { TimeSavedMetrics } from "../lib/types";
import { HeaderMenu } from "./shell/HeaderMenu";

export const TIME_SAVED_REFRESH_MS = 5 * 60_000;

/** Local Monday 00:00 of the week containing `now`, as `YYYY-MM-DD`. */
function startOfWeekDate(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceMonday = (d.getDay() + 6) % 7; // getDay(): Sunday 0 … Saturday 6
  d.setDate(d.getDate() - daysSinceMonday);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** "≈ 3.5 hours" / "≈ 1 hour" / "≈ 25 minutes" (under an hour reads better in minutes). */
function formatSaved(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "≈ 0 minutes";
  if (minutes < 60) {
    const m = Math.max(1, Math.round(minutes));
    return `≈ ${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.round((minutes / 60) * 10) / 10;
  return `≈ ${h} hour${h === 1 ? "" : "s"}`;
}

/** Short form for the chip: "≈ 3.5 h" / "≈ 25 min". */
function formatSavedShort(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "≈ 0 min";
  if (minutes < 60) return `≈ ${Math.max(1, Math.round(minutes))} min`;
  return `≈ ${Math.round((minutes / 60) * 10) / 10} h`;
}

function count(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "not reported";
}

export interface TimeSavedStripProps {
  refreshIntervalMs?: number;
  className?: string;
}

export function TimeSavedStrip({
  refreshIntervalMs = TIME_SAVED_REFRESH_MS,
  className,
}: TimeSavedStripProps) {
  const [data, setData] = useState<TimeSavedMetrics | null>(null);
  const since = startOfWeekDate();

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => {
      getTimeSaved(since, ctrl.signal).then(
        (m) => {
          if (!ctrl.signal.aborted) setData(m);
        },
        () => {
          // Hidden gracefully: no strip rather than a broken or stale number.
          if (!ctrl.signal.aborted) setData(null);
        },
      );
    };
    load();
    const timer = setInterval(load, refreshIntervalMs);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [since, refreshIntervalMs]);

  if (!data) return null;

  const headline = `${formatSaved(data.minutes_saved)} of coordinator time saved this week`;

  return (
    <div className={cn(className)} data-testid="time-saved-strip">
      <HeaderMenu
        label="How is this estimated?"
        panelLabel="How the time-saved estimate is calculated"
        panelClassName="w-[min(34rem,calc(100vw-2rem))] p-4"
        triggerClassName="border-border bg-surface/70 px-2.5"
        trigger={
          <>
            <Clock aria-hidden="true" className="size-4 text-primary" />
            <span className="tabular font-semibold">
              {formatSavedShort(data.minutes_saved)} saved
            </span>
            <span className="rounded-control border border-border-strong px-1 text-caption text-muted-foreground">
              estimate
            </span>
          </>
        }
      >
        {() => (
          <div className="text-body">
            <p className="font-semibold text-foreground">{headline}</p>
            <p className="mt-0.5 text-muted-foreground">
              An estimate, not a measurement (week starting {since})
            </p>
            <p className="mt-1 text-muted-foreground">
              Each field Interim pre-filled from evidence and a person accepted unchanged counts as
              the minutes it would take to type by hand. Fields a person edited count for nothing.
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {[
                ["Fields pre-filled", data.fields_prefilled],
                ["Fields edited by a person", data.fields_edited],
                ["Records confirmed", data.records_confirmed],
                ["Report packets signed", data.packets_signed],
                ["Visit briefs generated", data.briefs_generated],
                ["Sponsor queries answered", data.queries_answered],
              ].map(([label, v]) => (
                <div key={label as string}>
                  <dt className="text-caption text-muted-foreground">{label as string}</dt>
                  <dd className="tabular font-semibold">{count(v as number | undefined)}</dd>
                </div>
              ))}
            </dl>
            {data.basis.length > 0 && (
              <>
                <p className="mt-3 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                  Basis
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-caption text-foreground">
                  {data.basis.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-3 text-caption text-muted-foreground">
              Per-field minutes and their sources:{" "}
              <span className="font-mono">packages/rules/data/time_model.json</span>.
            </p>
          </div>
        )}
      </HeaderMenu>
    </div>
  );
}
