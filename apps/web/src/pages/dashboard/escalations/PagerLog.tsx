/**
 * The mock pager log (GET /pages). Every row is a simulated page: the system
 * wrote an audit event and raised a dashboard toast; no real pager exists.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router-dom";

import { Time } from "../../../lib/format";
import type { PageEventRow } from "../../../lib/types";
import { Badge } from "@/ui/badge";
import { tierBadgeKind } from "@/ui/badge-kinds";
import { DataTable, type DataTableColumnMeta } from "@/ui/data-table";

export interface PagerLogProps {
  rows: PageEventRow[];
}

const COLUMNS: ColumnDef<PageEventRow>[] = [
  {
    id: "sent",
    header: "Sent",
    enableSorting: false,
    meta: {
      width: "9.5rem",
      tabular: true,
      cellClassName: "whitespace-nowrap",
    } satisfies DataTableColumnMeta,
    cell: ({ row }) => <Time iso={row.original.ts} style="short" />,
  },
  {
    id: "participant",
    header: "Participant",
    enableSorting: false,
    meta: { width: "10rem", cellClassName: "py-1.5" } satisfies DataTableColumnMeta,
    cell: ({ row: { original: p } }) => (
      <div>
        {p.usubjid ? (
          <Link
            to={`/dashboard/participants/${encodeURIComponent(p.usubjid)}`}
            className="font-mono text-primary underline"
          >
            {p.usubjid}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {p.session_id && (
          <div>
            <Link
              to={`/dashboard/checkins/${encodeURIComponent(p.session_id)}`}
              className="text-caption text-primary underline"
            >
              open check-in
            </Link>
          </div>
        )}
      </div>
    ),
  },
  {
    id: "tier",
    header: "Tier",
    enableSorting: false,
    meta: { width: "5.5rem" } satisfies DataTableColumnMeta,
    cell: ({ row }) => {
      const kind = tierBadgeKind(row.original.tier);
      return kind ? <Badge kind={kind} short size="sm" /> : <span>{row.original.tier}</span>;
    },
  },
  {
    id: "message",
    header: "Message",
    enableSorting: false,
    meta: { cellClassName: "py-1.5" } satisfies DataTableColumnMeta,
    cell: ({ row }) => <span className="text-foreground">{row.original.message}</span>,
  },
  {
    id: "delivery",
    header: "Delivery",
    enableSorting: false,
    meta: { width: "13rem", cellClassName: "whitespace-nowrap" } satisfies DataTableColumnMeta,
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1.5">
        <Badge
          kind="simulated"
          label="Simulated"
          size="sm"
          title="The pager is simulated: an audit event plus a dashboard toast. Nobody was really paged."
        />
        <span className="text-caption text-muted-foreground">
          {row.original.delivered ? "delivered" : "not delivered"}
        </span>
      </span>
    ),
  },
];

export function PagerLog({ rows }: PagerLogProps) {
  return (
    <div data-testid="pager-table">
      <DataTable
        data={rows}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        caption="Mock pager log (simulated)"
        scrollX
      />
    </div>
  );
}
