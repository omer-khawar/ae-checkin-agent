/**
 * The worklist table: ui/data-table (opaque, 36px rows, 13px cells, sticky header).
 *
 * Eight columns: participant, source, received, tier, deadline, vitals, drafts, status.
 * Rows arrive in server order (tier desc, completed_at desc); with no sort chosen they
 * are never re-ranked. Clicking a header sorts the rows on this page only (the caption
 * says so). The whole row opens the item (click or Enter); j/k move, x or Space selects,
 * c confirms the selected rows' drafts. Plain language leads; SDTM codes and tier
 * numbers stay in hover text.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { Check, FileText, Monitor, Phone } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";

import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { DataTable, type DataTableBulkContext, type DataTableColumnMeta } from "@/ui/data-table";

import { Time, formatUtc, vitalsStatusLabel } from "../../../lib/format";
import type { QueueSource } from "../../../lib/types";
import { callSummary, noteTypeWords } from "../notes/phoneCallLabels";
import { bulkLockReason, canBulkSelect, draftTotal } from "./bulk";
import { compactRemaining, plainRemaining, saeState } from "./countdown";
import { hasVitalsSamples, isNoteSource, packetHref } from "./normalize";
import { countLabel } from "./summary";
import type { QueueClock, QueueRow } from "./types";

export interface QueueTableProps {
  rows: QueueRow[];
  now: number;
  /** Dim the table while a refresh is in flight (data stays visible). */
  refreshing?: boolean;
  selection: Record<string, boolean>;
  onSelectionChange: (selection: Record<string, boolean>) => void;
  bulkActions?: (ctx: DataTableBulkContext<QueueRow>) => React.ReactNode;
  emptyState?: React.ReactNode;
}

const SOURCE_LABEL: Record<QueueSource, { word: string; title: string; Icon: typeof Monitor }> = {
  check_in: {
    word: "Check-in",
    title: "Participant kiosk check-in (symptom questions modeled on PRO-CTCAE, optional vitals)",
    Icon: Monitor,
  },
  chart_note: {
    word: "Chart note",
    title: "A clinic, urgent-care or ER note the site read; scanned by fixed rules (no LLM)",
    Icon: FileText,
  },
  phone_call: {
    word: "Phone call",
    title:
      "The coordinator's summary of a phone call, scanned by the same fixed rules as a chart note (no LLM)",
    Icon: Phone,
  },
};

const CLOCK_PLAIN = {
  sae: { plain: "Serious event", abbr: "SAE" },
  aesi: { plain: "Special-interest event", abbr: "AESI" },
  unknown: { plain: "24-hour report", abbr: null },
} as const;

/**
 * One small line after the source word: what kind of note it was ("Outside record") or who
 * was on the call, plus a "Follow-up" chip when the item updates an AE that is already open.
 */
export function SourceDetail({ row }: { row: QueueRow }) {
  const detail =
    row.source === "phone_call"
      ? callSummary(row.caller, row.call_direction)
      : row.source === "chart_note" && row.note_type
        ? noteTypeWords(row.note_type)
        : null;
  if (!detail && row.followup_count === 0) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {detail && (
        <span
          className="max-w-[8rem] truncate text-caption text-muted-foreground"
          data-testid="source-detail"
        >
          {detail}
        </span>
      )}
      {row.followup_count > 0 && (
        <span
          className="whitespace-nowrap rounded-control border border-info-border bg-info-bg px-1.5 text-caption font-medium text-info-fg"
          title="Matches a side effect that is already open for this participant (same term within the dedup window), so it is drafted as a follow-up, not a new AE"
          data-testid="followup-chip"
        >
          Follow-up
          <span className="sr-only">
            {" "}
            · {row.followup_count} open AE{row.followup_count === 1 ? "" : "s"}
          </span>
        </span>
      )}
    </span>
  );
}

/** Earliest running due time, for sorting the deadline column (no clock sorts last). */
function nextDue(row: QueueRow): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const c of row.clocks) {
    if (c.stopped || !c.due_at) continue;
    const t = Date.parse(c.due_at);
    if (Number.isFinite(t) && t < best) best = t;
  }
  return best;
}

function ClockBadge({ clock, now }: { clock: QueueClock; now: number }) {
  const k = CLOCK_PLAIN[clock.kind];
  const state = saeState(clock.due_at, clock.stopped, now);
  const href = packetHref(clock.packet_id, clock.clock_id);
  const intro =
    clock.kind === "unknown"
      ? "A 24-hour sponsor report clock is running; open the item to see which kind."
      : `${k.abbr}: report to the sponsor within 24 hours of site awareness (protocol ${clock.kind === "sae" ? "§9.4.2, p. 91" : "§9.4.3, p. 92"}).`;

  let badge: React.ReactElement;
  if (state.kind === "stopped") {
    badge = (
      <span data-sae="stopped" data-clock-kind={clock.kind}>
        <Badge
          kind="clock-stopped"
          size="sm"
          title={`${intro} Stopped by an investigator's decision${clock.stopped_at ? ` at ${formatUtc(clock.stopped_at)} (UTC)` : ""}.`}
        />
        <span className="sr-only">{`${k.plain} — clock stopped`}</span>
      </span>
    );
  } else if (state.kind === "unknown") {
    badge = (
      <span data-sae="unknown" data-clock-kind={clock.kind}>
        <Badge
          kind="info"
          size="sm"
          label="24-hour report"
          detail="running"
          title={`${intro} A clock is running but the API did not send its due time.`}
        />
        <span className="sr-only">{`${k.plain} — report clock running`}</span>
      </span>
    );
  } else {
    const spoken = plainRemaining(state.remainingMs);
    const phrase = clock.kind === "unknown" ? "due in" : "report due in";
    const phraseOver = clock.kind === "unknown" ? "overdue by" : "report overdue by";
    badge = (
      <span
        data-sae={state.overdue ? "overdue" : state.urgent ? "urgent" : "running"}
        data-clock-kind={clock.kind}
      >
        <Badge
          kind={clock.kind === "aesi" ? "aesi" : clock.kind === "sae" ? "sae-clock" : "info"}
          size="sm"
          short={clock.kind !== "unknown"}
          label={clock.kind === "unknown" ? "24-hour report" : undefined}
          title={`${intro} Window closes ${formatUtc(clock.due_at)} (UTC). Stops when an investigator records a decision.`}
          detail={compactRemaining(state.remainingMs)}
          className={cn(state.urgent && "ring-1 ring-tier-3-border")}
        />
        <span className="sr-only">{`${k.plain}: ${state.overdue ? phraseOver : phrase} ${spoken.spoken}`}</span>
      </span>
    );
  }
  if (!href) return badge;
  return (
    <Link
      to={href}
      className="focus-ring rounded-control"
      title={`Open the ${k.plain.toLowerCase()} report packet`}
    >
      {badge}
    </Link>
  );
}

function DeadlineCell({ row, now }: { row: QueueRow; now: number }) {
  if (row.clocks.length === 0) {
    return (
      <span className="text-subtle-foreground" title="No 24-hour report is due for this item">
        —
      </span>
    );
  }
  const [first, ...rest] = [...row.clocks].sort((a, b) => Number(a.stopped) - Number(b.stopped));
  return (
    <span className="inline-flex items-center gap-1">
      <ClockBadge clock={first} now={now} />
      {rest.length > 0 && (
        <span
          className="text-caption text-muted-foreground"
          title="More clocks on this item; open it to see them"
        >
          +{rest.length}
        </span>
      )}
    </span>
  );
}

function VitalsCell({ row }: { row: QueueRow }) {
  if (isNoteSource(row.source)) {
    return (
      <span className="text-subtle-foreground" title="Notes and calls carry no camera vitals">
        —
      </span>
    );
  }
  const label = vitalsStatusLabel(row.vitals_status);
  if (!hasVitalsSamples(row)) {
    return (
      <span
        className="text-muted-foreground"
        title="Vitals status from the rules engine (vitals never change a grade)"
      >
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge
        kind={row.is_measured ? "measured" : "simulated"}
        label={row.is_measured ? "MEASURED" : "SIMULATED"}
        size="sm"
        className="uppercase"
        title={`${label}. Vitals never change a grade.`}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function DraftsCell({ row }: { row: QueueRow }) {
  const c = row.draft_counts;
  if (draftTotal(row) === 0) {
    return <span className="text-subtle-foreground">no drafts</span>;
  }
  const plain = [
    c.AE ? countLabel(c.AE, "side effect") : null,
    c.VS ? countLabel(c.VS, "vital sign") : null,
    c.CM ? countLabel(c.CM, "medication") : null,
  ].filter(Boolean);
  return (
    <span
      className="block max-w-[13rem] truncate"
      title={`AE ${c.AE} · VS ${c.VS} · CM ${c.CM} (drafted SDTM records: adverse events, vital signs, concomitant medications)`}
    >
      {plain.join(" · ")}
    </span>
  );
}

function StatusCell({ row }: { row: QueueRow }) {
  if (row.escalation_acked === false) {
    return (
      <span
        className="font-medium text-warning-fg"
        title="Alert not yet acknowledged; open the item to acknowledge it"
      >
        Not acknowledged
      </span>
    );
  }
  const acked =
    row.escalation_acked === true ? (
      <span
        className="inline-flex items-center text-success-fg"
        title="Alert acknowledged by the study team"
      >
        <Check aria-hidden="true" className="size-3.5" />
        <span className="sr-only">Acknowledged</span>
      </span>
    ) : null;
  if (row.draft_status_summary) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="block max-w-[8rem] truncate" title={row.draft_status_summary}>
          {row.draft_status_summary}
        </span>
        {acked}
      </span>
    );
  }
  return acked ?? <span className="text-subtle-foreground">—</span>;
}

export function QueueTable({
  rows,
  now,
  refreshing,
  selection,
  onSelectionChange,
  bulkActions,
  emptyState,
}: QueueTableProps) {
  const navigate = useNavigate();

  const columns = useMemo<ColumnDef<QueueRow, unknown>[]>(
    () => [
      {
        id: "participant",
        header: "Participant",
        accessorFn: (r) => r.display_label,
        sortingFn: "alphanumeric",
        meta: { rowHeader: true, width: "9rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <Link
                to={`/dashboard/participants/${encodeURIComponent(r.usubjid)}`}
                className="focus-ring rounded-control font-semibold text-link hover:underline"
                title={`${r.usubjid} · open participant timeline`}
              >
                {r.display_label}
              </Link>
              {r.usubjid && (
                <Link
                  to={`/dashboard/participants/${encodeURIComponent(r.usubjid)}/brief`}
                  className="focus-ring rounded-control text-caption text-link hover:underline"
                  aria-label={`Visit brief for ${r.display_label}`}
                  title="Everything since the last visit, on one printable page"
                >
                  Brief
                </Link>
              )}
            </span>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        accessorFn: (r) => r.source,
        meta: { width: "10rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => {
          const r = row.original;
          const src = SOURCE_LABEL[r.source];
          return (
            <span className="inline-flex max-w-[12rem] items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 whitespace-nowrap"
                title={src.title}
                data-testid="source-chip"
              >
                <src.Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                {r.href ? (
                  <Link
                    to={r.href}
                    className="focus-ring rounded-control hover:underline"
                    aria-label={`Open ${src.word.toLowerCase()} for ${r.display_label}`}
                  >
                    {src.word}
                  </Link>
                ) : (
                  <span>{src.word}</span>
                )}
              </span>
              <SourceDetail row={r} />
            </span>
          );
        },
      },
      {
        id: "received",
        header: "Received",
        accessorFn: (r) => r.completed_at ?? "",
        meta: { tabular: true, width: "9rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            <Time iso={row.original.completed_at} style="short" />
          </span>
        ),
      },
      {
        id: "tier",
        header: "Tier",
        accessorFn: (r) => r.tier,
        meta: { width: "8rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => (
          <Badge
            kind={`tier-${Math.max(0, Math.min(3, row.original.tier))}` as "tier-0"}
            size="sm"
            label={row.original.tier_name}
            title={`Tier ${row.original.tier}: ${row.original.tier_name}. Decided by the rules engine.${row.original.max_grade === null ? "" : ` Most severe symptom: provisional grade ${row.original.max_grade}, investigator to confirm.`}`}
          />
        ),
      },
      {
        id: "deadline",
        header: "Deadline",
        accessorFn: (r) => nextDue(r),
        meta: { tabular: true, width: "9rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => <DeadlineCell row={row.original} now={now} />,
      },
      {
        id: "vitals",
        header: "Vitals",
        accessorFn: (r) => (isNoteSource(r.source) ? "" : String(r.vitals_status ?? "")),
        meta: { width: "9rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => <VitalsCell row={row.original} />,
      },
      {
        id: "drafts",
        header: "Drafts",
        accessorFn: (r) => draftTotal(r),
        cell: ({ row }) => <DraftsCell row={row.original} />,
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => (r.escalation_acked === false ? 0 : r.needs_action ? 1 : 2),
        meta: { width: "9rem" } satisfies DataTableColumnMeta,
        cell: ({ row }) => <StatusCell row={row.original} />,
      },
    ],
    [now],
  );

  return (
    <div className={cn(refreshing && "opacity-80 transition-opacity")}>
      <DataTable<QueueRow>
        data={rows}
        columns={columns}
        getRowId={(r) => r.key}
        getRowLabel={(r) => `${r.display_label} ${SOURCE_LABEL[r.source].word.toLowerCase()}`}
        caption="Check-ins, chart notes and phone calls awaiting review, most urgent first, then most recent. Sorting a column reorders this page only."
        selectable
        rowSelection={selection}
        onRowSelectionChange={onSelectionChange}
        canSelectRow={canBulkSelect}
        selectDisabledReason={(r) => bulkLockReason(r)}
        bulkActions={bulkActions}
        onRowActivate={(r) => {
          if (r.href) navigate(r.href);
        }}
        getRowHref={(r) => r.href}
        getRowClassName={(r) => (r.tier === 3 ? "bg-danger-bg" : undefined)}
        emptyState={emptyState}
        stickyTop="var(--appbar-h, 0px)"
      />
    </div>
  );
}
