/**
 * The escalation table: one row per tier >= 2 event, with the plain-English
 * reasons the rules engine recorded, the paging and acknowledgement timestamps,
 * and a live time-to-acknowledge for open rows. Built on the shared DataTable
 * (opaque, 36px minimum rows, tabular figures).
 */
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { Link } from "react-router-dom";

import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { Time } from "../../../lib/format";
import type { EscalationRow } from "../../../lib/types";
import { Badge } from "@/ui/badge";
import { tierBadgeKind } from "@/ui/badge-kinds";
import { Button } from "@/ui/button";
import { DataTable, type DataTableColumnMeta } from "@/ui/data-table";
import {
  escalationSource,
  escalationStartedAt,
  formatDuration,
  isAcked,
  secondsToAck,
  SOURCE_LABELS,
} from "./model";

export interface EscalationsTableProps {
  rows: EscalationRow[];
  nowMs: number;
  /** Whether the signed-in role may acknowledge (coordinator / investigator). */
  canAck: boolean;
  ackingId: string | null;
  onAck: (row: EscalationRow) => void;
}

/** Where the escalation came from, with a link to the record when a route exists. */
export function SourceCell({ row }: { row: EscalationRow }) {
  const source = escalationSource(row);
  if (source === "check_in" && row.session_id) {
    return (
      <div className="flex flex-col">
        <span>{SOURCE_LABELS.check_in}</span>
        <Link
          to={`/dashboard/checkins/${encodeURIComponent(row.session_id)}`}
          className="text-caption text-primary underline"
          title="Open the check-in detail (answers, drafts, every rule that fired)"
        >
          open check-in
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <span>{SOURCE_LABELS[source]}</span>
      {row.note_id && (
        <span className="font-mono text-caption text-muted-foreground" title="Chart note id">
          {row.note_id}
        </span>
      )}
    </div>
  );
}

export function EscalationsTable({ rows, nowMs, canAck, ackingId, onAck }: EscalationsTableProps) {
  const columns = useMemo<ColumnDef<EscalationRow>[]>(
    () => [
      {
        id: "participant",
        header: "Participant",
        enableSorting: false,
        meta: { width: "9.5rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: row } }) => {
          const started = escalationStartedAt(row);
          return (
            <div>
              <Link
                to={`/dashboard/participants/${encodeURIComponent(row.usubjid)}`}
                className="whitespace-nowrap font-mono text-primary underline"
                title="Open the participant timeline"
              >
                {row.usubjid}
              </Link>
              {started && (
                <div className="text-caption text-muted-foreground">
                  raised <Time iso={started} style="short" />
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        enableSorting: false,
        meta: { width: "8rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row }) => <SourceCell row={row.original} />,
      },
      {
        id: "tier",
        header: "Tier",
        enableSorting: false,
        meta: { width: "13rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row }) => {
          const kind = tierBadgeKind(row.original.tier);
          return kind ? <Badge kind={kind} /> : <span>{row.original.tier}</span>;
        },
      },
      {
        id: "reasons",
        header: "Reasons (from the rules engine)",
        enableSorting: false,
        meta: { width: "26rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: row } }) => (
          <div>
            {row.reasons && row.reasons.length > 0 ? (
              <>
                <ul className="list-disc space-y-0.5 pl-4 text-foreground">
                  {row.reasons.slice(0, 2).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                {row.reasons.length > 2 && (
                  <details className="mt-0.5">
                    <summary className="cursor-pointer text-caption text-primary">
                      Show {row.reasons.length - 2} more reasons
                    </summary>
                    <ul className="list-disc space-y-0.5 pl-4 text-foreground">
                      {row.reasons.slice(2).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">No reasons recorded</span>
            )}
            {/* Vitals provenance for corroboration reasons: nothing is shown rather than guessed. */}
            {typeof row.vitals_is_measured === "boolean" && (
              <div className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                <span>vitals used by the rules:</span>
                <MeasuredBadge isMeasured={row.vitals_is_measured} />
              </div>
            )}
          </div>
        ),
      },
      {
        id: "paged",
        header: "Paged",
        enableSorting: false,
        meta: {
          width: "9rem",
          tabular: true,
          hideBelow: "lg",
          cellClassName: "py-1.5 align-top whitespace-nowrap",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: row } }) =>
          row.paged_at ? (
            <Time iso={row.paged_at} style="short" />
          ) : (
            <span
              className="text-muted-foreground"
              title={
                row.tier >= 3
                  ? "Tier 3 pages the on-call role; no page time was recorded"
                  : "Only tier 3 pages the on-call role (mock pager)"
              }
            >
              {row.tier >= 3 ? "—" : "not paged (tier 2)"}
            </span>
          ),
      },
      {
        id: "acknowledged",
        header: "Acknowledged",
        enableSorting: false,
        meta: {
          width: "9.5rem",
          tabular: true,
          cellClassName: "py-1.5 align-top whitespace-nowrap",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: row } }) =>
          isAcked(row) ? (
            <div className="flex flex-col">
              <span className="font-medium text-foreground">{row.acked_by ?? "—"}</span>
              <Time
                iso={row.acked_at}
                style="short"
                className="text-caption text-muted-foreground"
              />
            </div>
          ) : (
            <Badge kind="warning" label="Open" size="sm" />
          ),
      },
      {
        id: "tta",
        header: "Time to acknowledge",
        enableSorting: false,
        meta: {
          width: "9rem",
          numeric: true,
          cellClassName: "py-1.5 align-top whitespace-nowrap",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: row } }) => {
          const seconds = secondsToAck(row, nowMs);
          if (seconds === null) return <span className="text-muted-foreground">—</span>;
          if (isAcked(row)) {
            return <span title="Acknowledged at minus raised at">{formatDuration(seconds)}</span>;
          }
          return (
            <span
              className="font-semibold text-warning-fg"
              title="Still open: elapsed since the escalation was raised, updating live"
            >
              {formatDuration(seconds)}{" "}
              <span className="text-caption font-normal text-muted-foreground">and counting</span>
            </span>
          );
        },
      },
      {
        id: "action",
        header: () => <span className="sr-only">Action</span>,
        enableSorting: false,
        meta: {
          width: "9rem",
          cellClassName: "py-1.5 align-top whitespace-nowrap",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: row } }) => {
          if (isAcked(row)) return null;
          // A disabled button is unfocusable; the no-permission case is visible text.
          if (!canAck) {
            return (
              <p
                className="max-w-[11rem] whitespace-normal text-caption text-muted-foreground"
                data-testid="ack-read-only"
              >
                <span className="font-semibold text-foreground">
                  Coordinator or investigator acknowledges.
                </span>{" "}
                Your role is read-only here.
              </p>
            );
          }
          const busy = ackingId === row.id;
          return (
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={ackingId !== null && !busy}
              onClick={() => onAck(row)}
              title="Records escalation.acked in the audit log with your identity"
              aria-label={`Acknowledge escalation for ${row.usubjid}`}
            >
              Acknowledge
            </Button>
          );
        },
      },
    ],
    [nowMs, canAck, ackingId, onAck],
  );

  return (
    <div data-testid="escalations-table">
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        caption="Escalations, tier 2 and above"
        scrollX
        getRowClassName={(r) => (isAcked(r) ? undefined : "bg-warning-bg/30")}
      />
    </div>
  );
}
