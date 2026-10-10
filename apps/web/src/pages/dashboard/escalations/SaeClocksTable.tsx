/**
 * SAE clocks: the site's 24-hour obligation from the moment it became aware of a
 * hospitalisation (CLAUDE.md §3.4(f)). The countdown is recomputed from `due_at`
 * on every tick; the server's `seconds_remaining` is only a fallback. Sponsor
 * 7/15-day deadlines are listed under the fixed "informational" caption.
 */
import { Link } from "react-router-dom";

import { cx, formatCountdown, Time } from "../../../lib/format";
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
}

export function SaeClocksTable({ rows, nowMs }: SaeClocksTableProps) {
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
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((clock) => {
            const active = isClockActive(clock);
            const remaining = secondsRemaining(clock, nowMs);
            const overdue = isOverdue(clock, nowMs);
            const info = informationalDeadlines(clock.informational);
            return (
              <tr
                key={clock.id}
                data-sae-clock-id={clock.id}
                data-active={active ? "true" : "false"}
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
                  <div className="text-xs text-slate-500">
                    {clock.session_id ? (
                      <Link
                        to={`/dashboard/checkins/${encodeURIComponent(clock.session_id)}`}
                        className="text-brand-700 underline"
                      >
                        from check-in
                      </Link>
                    ) : clock.note_id ? (
                      <span title={clock.note_id}>from chart note</span>
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
                  <div className="mt-1 text-xs text-slate-500">
                    {active
                      ? "Stops only when an investigator records a seriousness decision (AESER)."
                      : "Investigator seriousness decision recorded."}
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
