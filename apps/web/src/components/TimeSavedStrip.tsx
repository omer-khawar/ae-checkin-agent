/**
 * Dashboard header strip: "≈ N hours of coordinator time saved this week
 * (estimate)" (CLAUDE.md §00.5, CONTRACTS R3.2 `GET /metrics/time-saved`).
 *
 * Honest by construction:
 * - The word "estimate" is always visible next to the number, and the number is
 *   prefixed with "≈".
 * - A "How is this estimated?" disclosure lists the server's `basis[]` lines
 *   (per-category arithmetic from `packages/rules/data/time_model.json`) and
 *   the counts behind them: fields pre-filled / edited by a person, packets
 *   signed, briefs generated, queries answered.
 * - If the endpoint is missing or fails, the strip renders nothing: a missing
 *   estimate is better than a wrong or broken one.
 *
 * "This week" starts Monday 00:00 in the viewer's local time and is sent as a
 * `YYYY-MM-DD` date. Re-fetched every 5 minutes so the number moves during a
 * demo without hammering the API.
 *
 * The wrapper below follows `src/lib/api.ts` conventions (bearer token,
 * problem+json → ApiError); fold it into `api.ts` as `getTimeSaved()`.
 */
import { useEffect, useId, useRef, useState } from "react";

import {
  API_BASE,
  ApiError,
  buildQuery,
  getStoredToken,
  NetworkError,
  parseProblem,
} from "../lib/api";
import { cx } from "../lib/format";

/** `GET /metrics/time-saved?since=` (CONTRACTS R3.2; R4.4 adds queries answered). */
export interface TimeSavedMetrics {
  minutes_saved: number;
  minutes_manual_baseline: number;
  records_confirmed?: number;
  fields_prefilled?: number;
  fields_edited?: number;
  packets_signed?: number;
  briefs_generated?: number;
  queries_answered?: number;
  basis: string[];
  is_estimate?: boolean;
  disclaimer?: string;
}

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

async function fetchTimeSaved(since: string, signal?: AbortSignal): Promise<TimeSavedMetrics> {
  const url = `${API_BASE}/metrics/time-saved${buildQuery({ since })}`;
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
  };
  const token = getStoredToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal });
  } catch (e) {
    throw new NetworkError(url, e);
  }
  if (!res.ok) throw new ApiError(url, await parseProblem(res));
  const body = (await res.json()) as Partial<TimeSavedMetrics> | null;
  if (typeof body?.minutes_saved !== "number" || !Number.isFinite(body.minutes_saved)) {
    throw new Error("GET /metrics/time-saved returned no minutes_saved");
  }
  // Everything the disclosure renders is normalised here, so a partial answer
  // (an endpoint still being written, a serializer that drops a field) shows
  // fewer lines instead of throwing inside render and blanking the dashboard.
  const basis: unknown = body.basis;
  return {
    ...body,
    minutes_saved: body.minutes_saved,
    minutes_manual_baseline:
      typeof body.minutes_manual_baseline === "number" ? body.minutes_manual_baseline : 0,
    basis: Array.isArray(basis)
      ? basis.filter((line): line is string => typeof line === "string")
      : [],
  };
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
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const since = startOfWeekDate();

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => {
      fetchTimeSaved(since, ctrl.signal).then(
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

  // Close the disclosure on Escape or a click outside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!data) return null;

  const headline = `${formatSaved(data.minutes_saved)} of coordinator time saved this week`;

  return (
    <div ref={wrapRef} className={cx("relative", className)} data-testid="time-saved-strip">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm text-brand-950">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-4 w-4 text-brand-700"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <circle cx="10" cy="11" r="6.5" />
          <path d="M10 7.5V11l2.5 1.5M8 2.5h4" />
        </svg>
        <span className="font-semibold">{headline}</span>
        <span className="rounded bg-white px-1.5 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300">
          estimate
        </span>
        <button
          type="button"
          className="text-xs text-brand-800 underline underline-offset-2 hover:text-brand-950 focus-visible:outline-none focus-visible:ring-4"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          How is this estimated?
        </button>
      </div>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="How the time-saved estimate is calculated"
          className="absolute right-0 z-20 mt-1 w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-800 shadow-lg"
        >
          <p className="font-semibold text-slate-900">
            An estimate, not a measurement (week starting {since})
          </p>
          <p className="mt-1 text-slate-600">
            Each field Interim pre-filled from evidence and a person accepted unchanged counts as
            the minutes it would take to type by hand. Fields a person edited count for nothing.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">Fields pre-filled</dt>
              <dd className="tnum font-semibold">{count(data.fields_prefilled)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Fields edited by a person</dt>
              <dd className="tnum font-semibold">{count(data.fields_edited)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Records confirmed</dt>
              <dd className="tnum font-semibold">{count(data.records_confirmed)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Report packets signed</dt>
              <dd className="tnum font-semibold">{count(data.packets_signed)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Visit briefs generated</dt>
              <dd className="tnum font-semibold">{count(data.briefs_generated)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Sponsor queries answered</dt>
              <dd className="tnum font-semibold">{count(data.queries_answered)}</dd>
            </div>
          </dl>
          {data.basis.length > 0 && (
            <>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Basis
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-700">
                {data.basis.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Per-field minutes and their sources:{" "}
            <span className="font-mono">packages/rules/data/time_model.json</span>.
          </p>
        </div>
      )}
    </div>
  );
}
