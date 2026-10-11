/**
 * SAE clocks: the site's 24-hour obligation from the moment it became aware of a
 * hospitalisation (CLAUDE.md §3.4(f)). The countdown is recomputed from `due_at`
 * on every tick; the server's `seconds_remaining` is only a fallback. Sponsor
 * 7/15-day deadlines are listed under the fixed "informational" caption.
 *
 * R3.2 / R4.3: each clock names its kind (SAE or possible AESI, investigator to
 * confirm) and offers "Open report packet"; for the investigator, a running
 * SAE clock also offers "Record seriousness decision" (the only way a clock whose
 * source drafted no side-effect record can stop). AESI clocks never offer it:
 * they are answered by "Immune-related? No" on their side-effect record or by
 * signing the packet (plain.ts canRecordDecision).
 *
 * The API's clock rows (sae_clock_to_dict) carry no `has_ae_draft` /
 * `ae_draft_ids` hint yet, so the hint is usually unknown here and the
 * decision control uses neutral wording that links to the source.
 */
import { Link } from "react-router-dom";

import { cx, formatCountdown, Time } from "../../../lib/format";
import type { Role } from "../../../lib/types";
import { ClockActions } from "../detail/ClockActions";
import { clockChip, clockKind, clockName } from "../detail/plain";
import {
  formatDuration,
  INFORMATIONAL_CAPTION,
  informationalDeadlines,
  isClockActive,
  isOverdue,
  secondsRemaining,
} from "./model";
import type { SaeClockRowExt } from "./types";

export interface SaeClocksTableProps {
  rows: SaeClockRowExt[];
  nowMs: number;
  /** Signed-in role (packet / decision controls). */
  role?: Role | null;
  /** A clock was stopped from this table (R4.3). */
  onClockStopped?: (clock: SaeClockRowExt) => void;
}

/**
 * Whether an AE draft exists for this clock: the API's hint when present,
 * else unknown (null). The shipped API sends no hint (reported as a missing
 * dependency); "unknown" keeps the decision available for SAE clocks, with
 * wording that does not claim the source has no side-effect record.
 */
function aeDraftHint(clock: SaeClockRowExt): boolean | null {
  if (typeof clock.has_ae_draft === "boolean") return clock.has_ae_draft;
  if (Array.isArray(clock.ae_draft_ids)) return clock.ae_draft_ids.length > 0;
  return null;
}

/**
 * How this kind of clock stops, mirroring the API: AESER stops an SAE clock;
 * "Immune-related? No" (INTERIM_IRAE = N) stops a possible-AESI clock.
 */
function clockStopText(kind: "sae" | "aesi", active: boolean): string {
  if (kind === "aesi") {
    return active
      ? 'Stops when the investigator answers "Immune-related? No" on the side-effect record (INTERIM_IRAE = N); otherwise it is reported through the packet.'
      : "Investigator decision recorded.";
  }
  return active
    ? "Stops only when an investigator records a seriousness decision (AESER)."
    : "Investigator seriousness decision recorded.";
}

export function SaeClocksTable({ rows, nowMs, role = null, onClockStopped }: SaeClocksTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th scope="col" className="px-3 py-2">
              Participant
            </th>
            <th scope="col" className="px-3 py-2">
              Site became aware
            </th>
            <th scope="col" className="px-3 py-2">
              Site clock due (24 h)
            </th>
            <th scope="col" className="px-3 py-2">
              Status
            </th>
            <th scope="col" className="px-3 py-2">
              Sponsor deadlines
            </th>
            <th scope="col" className="px-3 py-2">
              Report
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((clock) => {
            const active = isClockActive(clock);
            const remaining = secondsRemaining(clock, nowMs);
            const overdue = isOverdue(clock, nowMs);
            const info = informationalDeadlines(clock.informational);
            const kind = clockKind(clock);
            return (
              <tr
                key={clock.id}
                data-sae-clock-id={clock.id}
                data-active={active ? "true" : "false"}
                data-clock-kind={kind}
                className={cx("align-top", overdue && "bg-red-50")}
              >
                <td className="px-3 py-2">
                  <Link
                    to={`/dashboard/participants/${encodeURIComponent(clock.usubjid)}`}
                    className="font-mono text-brand-700 underline"
                    title="Open the participant timeline"
                  >
                    {clock.usubjid}
                  </Link>
                  <div className="mt-1">
                    <span
                      className={cx(
                        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
                        kind === "aesi"
                          ? "border-violet-300 bg-violet-50 text-violet-900"
                          : "border-red-300 bg-red-50 text-red-900",
                      )}
                      title={clockName(kind)}
                    >
                      <span className="font-mono">{clockChip(kind)}</span>{" "}
                      <span className="font-normal">
                        {kind === "aesi"
                          ? "possible special-interest event, investigator to confirm"
                          : "possible serious event"}
                      </span>
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {clock.session_id ? (
                      <Link
                        to={`/dashboard/checkins/${encodeURIComponent(clock.session_id)}`}
                        className="text-brand-700 underline"
                      >
                        from check-in
                      </Link>
                    ) : clock.note_id ? (
                      <Link
                        to={`/dashboard/notes/${encodeURIComponent(clock.note_id)}`}
                        className="text-brand-700 underline"
                      >
                        from chart note or call
                      </Link>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <Time iso={clock.site_awareness_at} style="short" />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div>
                    <Time iso={clock.due_at} style="short" />
                  </div>
                  {active ? (
                    <div
                      className={cx(
                        "tnum text-base font-bold",
                        overdue ? "text-red-700" : "text-slate-900",
                      )}
                      title="Live countdown to due_at = site awareness + 24 h"
                    >
                      {overdue ? (
                        <>
                          <span className="uppercase">Overdue</span> by{" "}
                          {formatDuration(remaining === null ? null : -remaining)}
                        </>
                      ) : (
                        formatCountdown(remaining)
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">clock stopped</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {active ? (
                    <span className="rounded-md border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                      Active
                    </span>
                  ) : (
                    <div className="flex flex-col text-slate-800">
                      <span>
                        Stopped by <span className="font-medium">{clock.stopped_by ?? "—"}</span>
                      </span>
                      <Time
                        iso={clock.stopped_at}
                        style="short"
                        className="text-xs text-slate-600"
                      />
                      {clock.decision && (
                        <span className="text-xs">
                          Decision: <span className="font-mono">{clock.decision}</span>
                        </span>
                      )}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-slate-500" data-testid="clock-stop-rule">
                    {clockStopText(kind, active)}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {info.deadlines.length > 0 ? (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      {info.deadlines.map((d) => (
                        <div key={d.key} className="contents">
                          <dt className="text-slate-600">{d.label}</dt>
                          <dd className="whitespace-nowrap">
                            <Time iso={d.iso} style="short" />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <span className="text-xs text-slate-500">None attached</span>
                  )}
                  <div
                    className="mt-1 text-xs italic text-slate-500"
                    title={info.note ?? undefined}
                  >
                    {INFORMATIONAL_CAPTION}
                  </div>
                </td>
                <td className="w-64 px-3 py-2">
                  <ClockActions
                    clock={clock}
                    role={role}
                    hasAeDraft={aeDraftHint(clock)}
                    onStopped={(stopped) =>
                      onClockStopped?.({
                        ...clock,
                        stopped_at: stopped.stopped_at,
                        stopped_by: stopped.stopped_by,
                        decision: stopped.decision,
                        seconds_remaining: null,
                      })
                    }
                    compact
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
