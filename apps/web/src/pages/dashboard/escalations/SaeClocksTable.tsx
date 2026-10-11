/**
 * Report clocks: the site's 24-hour obligation from the moment it became aware of a
 * serious event or possible special-interest event (CLAUDE.md 3.4(f), 00.1). The countdown
 * is recomputed from `due_at` on every tick; the server's `seconds_remaining` is only a
 * fallback. Sponsor 7/15-day deadlines are listed under the fixed "informational" caption.
 *
 * Each clock names its kind (SAE or possible AESI, investigator to confirm) and offers
 * "Open report packet"; for the investigator, a running SAE clock also offers "Record
 * seriousness decision" (the only way a clock whose source drafted no side-effect record
 * can stop). AESI clocks never offer it (plain.ts canRecordDecision).
 *
 * The countdown always reads "due in 22:25" or "Overdue by ..." so it can never be mistaken
 * for a time of day.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { Link } from "react-router-dom";

import { formatCountdown, Time } from "../../../lib/format";
import type { ClockRow, Role } from "../../../lib/types";
import { Badge } from "@/ui/badge";
import { DataTable, type DataTableColumnMeta } from "@/ui/data-table";
import { cn } from "@/lib/cn";
import { ClockActions } from "../detail/ClockActions";
import { clockKind, clockName } from "../detail/plain";
import {
  formatDuration,
  INFORMATIONAL_CAPTION,
  informationalDeadlines,
  isClockActive,
  isOverdue,
  secondsRemaining,
} from "./model";

export interface SaeClocksTableProps {
  rows: ClockRow[];
  nowMs: number;
  /** Signed-in role (packet / decision controls). */
  role?: Role | null;
  /** A clock was stopped from this table. */
  onClockStopped?: (clock: ClockRow) => void;
}

/** The API's has-AE-draft hint when present, else unknown (null). */
function aeDraftHint(clock: ClockRow): boolean | null {
  if (typeof clock.has_ae_draft === "boolean") return clock.has_ae_draft;
  if (Array.isArray(clock.ae_draft_ids)) return clock.ae_draft_ids.length > 0;
  return null;
}

/** How this kind of clock stops, mirroring the API. */
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
  const columns = useMemo<ColumnDef<ClockRow>[]>(
    () => [
      {
        id: "participant",
        header: "Participant",
        enableSorting: false,
        meta: { width: "13rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: clock } }) => {
          const kind = clockKind(clock);
          return (
            <div>
              <Link
                to={`/dashboard/participants/${encodeURIComponent(clock.usubjid)}`}
                className="whitespace-nowrap font-mono text-primary underline"
                title="Open the participant timeline"
              >
                {clock.usubjid}
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <Badge kind={kind === "aesi" ? "aesi" : "sae"} size="sm" title={clockName(kind)} />{" "}
                <span className="text-caption text-muted-foreground">
                  {kind === "aesi"
                    ? "possible special-interest event, investigator to confirm"
                    : "possible serious event"}
                </span>
              </div>
              <div className="text-caption text-muted-foreground">
                {clock.session_id ? (
                  <Link
                    to={`/dashboard/checkins/${encodeURIComponent(clock.session_id)}`}
                    className="text-primary underline"
                  >
                    from check-in
                  </Link>
                ) : clock.note_id ? (
                  <Link
                    to={`/dashboard/notes/${encodeURIComponent(clock.note_id)}`}
                    className="text-primary underline"
                  >
                    from chart note or call
                  </Link>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: "aware",
        header: "Site became aware",
        enableSorting: false,
        meta: {
          width: "9.5rem",
          tabular: true,
          hideBelow: "lg",
          cellClassName: "py-1.5 align-top whitespace-nowrap",
        } satisfies DataTableColumnMeta,
        cell: ({ row }) => <Time iso={row.original.site_awareness_at} style="short" />,
      },
      {
        id: "due",
        header: "Site clock due (24 h)",
        enableSorting: false,
        meta: {
          width: "11rem",
          tabular: true,
          cellClassName: "py-1.5 align-top whitespace-nowrap",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: clock } }) => {
          const active = isClockActive(clock);
          const remaining = secondsRemaining(clock, nowMs);
          const overdue = isOverdue(clock, nowMs);
          return (
            <div>
              <div>
                <Time iso={clock.due_at} style="short" />
              </div>
              {active ? (
                <div
                  className={cn(
                    "text-title font-bold tabular",
                    overdue ? "text-danger-fg" : "text-foreground",
                  )}
                  title="Live countdown to due_at = site awareness + 24 h"
                >
                  {overdue ? (
                    <>
                      <span className="uppercase">Overdue</span> by{" "}
                      {formatDuration(remaining === null ? null : -remaining)}
                    </>
                  ) : (
                    <>
                      <span className="text-caption font-normal text-muted-foreground">
                        due in{" "}
                      </span>
                      {formatCountdown(remaining)}
                    </>
                  )}
                </div>
              ) : (
                <div className="text-caption text-muted-foreground">clock stopped</div>
              )}
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        meta: { width: "15rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: clock } }) => {
          const active = isClockActive(clock);
          const kind = clockKind(clock);
          return (
            <div>
              {active ? (
                <Badge kind="warning" label="Active" size="sm" />
              ) : (
                <div className="flex flex-col text-foreground">
                  <Badge kind="clock-stopped" size="sm" />
                  <span>
                    Stopped by <span className="font-medium">{clock.stopped_by ?? "—"}</span>
                  </span>
                  <Time
                    iso={clock.stopped_at}
                    style="short"
                    className="text-caption text-muted-foreground"
                  />
                  {clock.decision && (
                    <span className="text-caption">
                      Decision: <span className="font-mono">{clock.decision}</span>
                    </span>
                  )}
                </div>
              )}
              <div
                className="mt-1 text-caption text-muted-foreground"
                data-testid="clock-stop-rule"
              >
                {clockStopText(kind, active)}
              </div>
            </div>
          );
        },
      },
      {
        id: "sponsor",
        header: "Sponsor deadlines",
        enableSorting: false,
        meta: {
          width: "15rem",
          hideBelow: "xl",
          cellClassName: "py-1.5 align-top",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: clock } }) => {
          const info = informationalDeadlines(clock.informational);
          return (
            <div>
              {info.deadlines.length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption">
                  {info.deadlines.map((d) => (
                    <div key={d.key} className="contents">
                      <dt className="text-muted-foreground">{d.label}</dt>
                      <dd className="whitespace-nowrap tabular">
                        <Time iso={d.iso} style="short" />
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <span className="text-caption text-muted-foreground">None attached</span>
              )}
              <div
                className="mt-1 text-caption italic text-muted-foreground"
                title={info.note ?? undefined}
              >
                {INFORMATIONAL_CAPTION}
              </div>
            </div>
          );
        },
      },
      {
        id: "report",
        header: "Report",
        enableSorting: false,
        meta: { width: "16rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: clock } }) => (
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
        ),
      },
    ],
    [nowMs, role, onClockStopped],
  );

  return (
    <div data-testid="clocks-table">
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(c) => c.id}
        caption="Report clocks (SAE and possible AESI)"
        scrollX
        getRowClassName={(c) => (isOverdue(c, nowMs) ? "bg-danger-bg/40" : undefined)}
      />
    </div>
  );
}
