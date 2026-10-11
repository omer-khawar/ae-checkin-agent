/**
 * The list of queries for one tab, on the shared DataTable (opaque, dense, keyboard
 * navigable: Tab into the rows, arrows to move, Enter opens the side panel). The query
 * text is also a real button so it has an accessible name. Plain words lead; the SDTM
 * domain.field stays as a small monospace badge. Age is the aging/SLA column: it turns
 * red with the word "late" once an open query has waited more than 72 hours.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { Time } from "../../../lib/format";
import type { QueryRow } from "../../../lib/types";
import { DataTable, type DataTableColumnMeta } from "@/ui/data-table";
import { AgeChip, CodeBadge, SeverityChip, StatusChip } from "./bits";
import { ageHours, domainLabel, fieldLabel, isAgeAlert, participantLabel, raisedBy } from "./model";

export interface QueriesTableProps {
  rows: QueryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  nowMs: number;
}

export function QueriesTable({ rows, selectedId, onSelect, nowMs }: QueriesTableProps) {
  const columns = useMemo<ColumnDef<QueryRow>[]>(
    () => [
      {
        id: "participant",
        header: "Participant",
        enableSorting: false,
        meta: {
          width: "6.5rem",
          rowHeader: false,
          cellClassName: "whitespace-nowrap py-1.5 font-medium text-foreground align-top",
        } satisfies DataTableColumnMeta,
        cell: ({ row }) => participantLabel(row.original),
      },
      {
        id: "record",
        header: "Record",
        enableSorting: false,
        meta: { width: "15rem", cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: r } }) => (
          <div>
            <div className="text-foreground">
              {domainLabel(r.domain)}: {fieldLabel(r.field, r.field_label)}
            </div>
            <CodeBadge title="SDTM domain and variable">{`${r.domain}.${r.field}`}</CodeBadge>
          </div>
        ),
      },
      {
        id: "text",
        header: "Question from the sponsor",
        enableSorting: false,
        meta: { cellClassName: "py-1.5 align-top" } satisfies DataTableColumnMeta,
        cell: ({ row: { original: r } }) => (
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            className="text-left text-primary underline-offset-2 hover:underline"
            aria-label={`Open query: ${r.text}`}
            aria-current={r.id === selectedId ? "true" : undefined}
          >
            {r.text}
          </button>
        ),
      },
      {
        id: "kind",
        header: "Kind",
        enableSorting: false,
        meta: { width: "6.5rem", cellClassName: "align-top py-1.5" } satisfies DataTableColumnMeta,
        cell: ({ row }) => <SeverityChip severity={row.original.severity} />,
      },
      {
        id: "raised",
        header: "Raised by",
        enableSorting: false,
        meta: {
          width: "11rem",
          hideBelow: "lg",
          cellClassName: "py-1.5 align-top",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: r } }) => {
          const who = raisedBy(r);
          return (
            <div>
              <div className="text-foreground">{who.label}</div>
              {who.code && <CodeBadge>{who.code}</CodeBadge>}
              <div className="text-caption text-muted-foreground">
                <Time iso={r.raised_at} style="short" />
              </div>
            </div>
          );
        },
      },
      {
        id: "age",
        header: "Age",
        enableSorting: false,
        meta: {
          width: "6rem",
          numeric: true,
          cellClassName: "whitespace-nowrap align-top py-1.5",
        } satisfies DataTableColumnMeta,
        cell: ({ row: { original: r } }) => {
          const hours = ageHours(r, nowMs);
          return <AgeChip hours={hours} alert={isAgeAlert(r, hours)} />;
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        meta: { width: "7.5rem", cellClassName: "align-top py-1.5" } satisfies DataTableColumnMeta,
        cell: ({ row }) => <StatusChip status={row.original.status} />,
      },
    ],
    [nowMs, onSelect, selectedId],
  );

  return (
    <DataTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      caption="Sponsor queries"
      scrollX
      onRowActivate={(r) => onSelect(r.id)}
      getRowClassName={(r) => (r.id === selectedId ? "bg-surface-selected" : undefined)}
    />
  );
}
