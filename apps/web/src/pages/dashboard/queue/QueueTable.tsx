/**
 * The queue table. Rows arrive in server order (tier desc, completed_at desc);
 * this component never re-sorts. Plain language leads (CLAUDE.md §00: most
 * judges are not clinicians); the SDTM domain codes and tier numbers stay one
 * step deeper, in small monospace badges and hover text. Every derived value
 * carries a `title` that says where it came from, and the detail page holds
 * the full evidence.
 */
import { Link } from "react-router-dom";

import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { TierChip } from "../../../components/TierChip";
import { cx, Time, vitalsStatusLabel } from "../../../lib/format";
import { hasVitalsSamples, isNoteSource } from "./normalize";
import { SaeCountdownChip } from "./SaeCountdownChip";
import { countLabel } from "./summary";
import type { QueueRow } from "./types";
import type { QueueSource } from "../../../lib/types";

export interface QueueTableProps {
  rows: QueueRow[];
  now: number;
  /** Dim the table while a refresh is in flight (data stays visible). */
  refreshing?: boolean;
}

const TH = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600";
const TD = "px-3 py-2.5 align-middle text-sm text-slate-900";

/** Inline SVG icons (no icon library, no third-party scripts). */
function SourceIcon({ source }: { source: QueueSource }) {
  const common = {
    "aria-hidden": true,
    viewBox: "0 0 20 20",
    className: "h-4 w-4 text-slate-500",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
  } as const;
  if (source === "phone_call") {
    return (
      <svg {...common}>
        <path d="M4.5 3h3l1.5 4-2 1.2a9 9 0 0 0 4.8 4.8L13 11l4 1.5v3A1.5 1.5 0 0 1 15.5 17 12.5 12.5 0 0 1 3 4.5 1.5 1.5 0 0 1 4.5 3z" />
      </svg>
    );
  }
  if (source === "chart_note") {
    return (
      <svg {...common}>
        <path d="M5 2.5h7l3 3v12H5z" />
        <path d="M12 2.5v3h3M7.5 9h5M7.5 12h5M7.5 15h3" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
      <path d="M7 17h6M10 13.5V17" />
    </svg>
  );
}

const SOURCE_LABEL: Record<QueueSource, { word: string; title: string }> = {
  check_in: {
    word: "Check-in",
    title: "Participant kiosk check-in (symptom questions modeled on PRO-CTCAE, optional vitals)",
  },
  chart_note: {
    word: "Chart note",
    title: "A clinic, urgent-care or ER note the site read; scanned by fixed rules (no LLM)",
  },
  phone_call: {
    word: "Phone call",
    title:
      "The coordinator's summary of a phone call, scanned by the same fixed rules as a chart note (no LLM)",
  },
};

function EscalationCell({ acked }: { acked: boolean | null }) {
  if (acked === null) {
    return (
      <span className="text-slate-400" title="No alert was raised for this item">
        —
      </span>
    );
  }
  return acked ? (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800"
      title="Alert acknowledged by the study team"
    >
      <span aria-hidden="true">✓</span> Acknowledged
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
      title="Alert not yet acknowledged; open the item to acknowledge it"
    >
      <span aria-hidden="true">!</span> Not acknowledged
    </span>
  );
}

function DraftsCell({ row }: { row: QueueRow }) {
  const c = row.draft_counts;
  const total = c.AE + c.VS + c.CM;
  const plain = [
    c.AE ? countLabel(c.AE, "side effect") : null,
    c.VS ? countLabel(c.VS, "vital sign") : null,
    c.CM ? countLabel(c.CM, "medication") : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-0.5">
      {total > 0 && <span className="text-sm text-slate-900">{plain.join(" · ")}</span>}
      <span
        className="tnum w-fit rounded bg-slate-100 px-1 font-mono text-[11px] text-slate-600"
        title="Drafted SDTM records: AE adverse events · VS vital signs · CM concomitant medications"
      >
        AE {c.AE} · VS {c.VS} · CM {c.CM}
      </span>
      {row.draft_status_summary ? (
        <span className="text-xs text-slate-600">{row.draft_status_summary}</span>
      ) : total === 0 ? (
        <span className="text-xs text-slate-500">no drafts</span>
      ) : null}
    </div>
  );
}

function VitalsCell({ row }: { row: QueueRow }) {
  if (isNoteSource(row.source)) {
    return (
      <span className="text-slate-400" title="Notes and calls carry no camera vitals">
        —
      </span>
    );
  }
  const label = vitalsStatusLabel(row.vitals_status);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span title="Vitals status from the rules engine (vitals never change a grade)">{label}</span>
      {hasVitalsSamples(row) && <MeasuredBadge isMeasured={row.is_measured} />}
    </div>
  );
}

function GradeCell({ row }: { row: QueueRow }) {
  if (row.max_grade === null) {
    // The explanation depends on where the row came from: a note finding only
    // ever carries a grade hint, while a check-in simply reported nothing gradeable.
    return (
      <span
        className="text-slate-400"
        title={
          isNoteSource(row.source)
            ? "No provisional grade (chart-note findings carry a grade hint only)"
            : "No provisional grade reported for this check-in"
        }
      >
        —
      </span>
    );
  }
  return (
    <span title="Provisional CTCAE grade from the participant's answers; investigator to confirm">
      Grade {row.max_grade} <span className="text-xs text-slate-500">provisional</span>
    </span>
  );
}

function ClocksCell({ row, now }: { row: QueueRow; now: number }) {
  if (row.clocks.length === 0) {
    return (
      <span className="text-slate-400" title="No 24-hour report is due for this item">
        —
      </span>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {row.clocks.map((c) => (
        <SaeCountdownChip
          key={c.key}
          kind={c.kind}
          dueAt={c.due_at}
          stopped={c.stopped}
          stoppedAt={c.stopped_at}
          packetId={c.packet_id}
          clockId={c.clock_id}
          now={now}
        />
      ))}
    </div>
  );
}

export function QueueTable({ rows, now, refreshing }: QueueTableProps) {
  return (
    <div className="overflow-x-auto">
      <table
        className={cx("w-full min-w-[1040px] border-collapse", refreshing && "opacity-70")}
        aria-busy={refreshing || undefined}
      >
        <caption className="sr-only">
          Check-ins, chart notes and phone calls awaiting review, most urgent first, then most
          recent
        </caption>
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th scope="col" className={TH}>
              Participant
            </th>
            <th scope="col" className={TH}>
              Came in as
            </th>
            <th scope="col" className={TH}>
              When
            </th>
            <th scope="col" className={TH}>
              <abbr
                title="Escalation tier from the rules engine (T0 Log … T3 Urgent)"
                className="no-underline"
              >
                Priority
              </abbr>
            </th>
            <th scope="col" className={TH}>
              <abbr
                title="Highest provisional CTCAE grade across symptoms, from the participant's answers only"
                className="no-underline"
              >
                Most severe
              </abbr>
            </th>
            <th scope="col" className={TH}>
              Vitals
            </th>
            <th scope="col" className={TH}>
              <abbr
                title="24-hour sponsor report clocks: serious adverse events (SAE, protocol §9.4.2) and adverse events of special interest (AESI, §9.4.3)"
                className="no-underline"
              >
                Report due
              </abbr>
            </th>
            <th scope="col" className={TH}>
              Alert
            </th>
            <th scope="col" className={TH}>
              Drafted records
            </th>
            <th scope="col" className={cx(TH, "text-right")}>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const src = SOURCE_LABEL[row.source];
            return (
              <tr
                key={row.key}
                className={cx(
                  "border-b border-slate-100 hover:bg-slate-50",
                  row.tier === 3 && "bg-red-50/60",
                )}
                data-tier={row.tier}
                data-source={row.source}
              >
                <td className={TD}>
                  <div className="flex flex-col items-start gap-0.5">
                    <Link
                      to={`/dashboard/participants/${encodeURIComponent(row.usubjid)}`}
                      className="font-semibold text-brand-800 underline-offset-2 hover:underline"
                      title={`${row.usubjid} · open participant timeline`}
                    >
                      {row.display_label}
                    </Link>
                    {row.usubjid && (
                      <Link
                        to={`/dashboard/participants/${encodeURIComponent(row.usubjid)}/brief`}
                        className="text-xs text-brand-700 underline underline-offset-2 hover:text-brand-900"
                        aria-label={`Visit brief for ${row.display_label}`}
                        title="Everything since the last visit, on one printable page"
                      >
                        Brief
                      </Link>
                    )}
                  </div>
                </td>
                <td className={TD}>
                  <span
                    className="inline-flex items-center gap-1.5 whitespace-nowrap"
                    title={src.title}
                    data-testid="source-chip"
                  >
                    <SourceIcon source={row.source} />
                    <span>{src.word}</span>
                  </span>
                </td>
                <td className={cx(TD, "whitespace-nowrap")}>
                  <Time iso={row.completed_at} style="short" />
                </td>
                <td className={TD}>
                  <TierChip tier={row.tier} />
                </td>
                <td className={cx(TD, "tnum whitespace-nowrap")}>
                  <GradeCell row={row} />
                </td>
                <td className={TD}>
                  <VitalsCell row={row} />
                </td>
                <td className={TD}>
                  <ClocksCell row={row} now={now} />
                </td>
                <td className={TD}>
                  <EscalationCell acked={row.escalation_acked} />
                </td>
                <td className={TD}>
                  <DraftsCell row={row} />
                </td>
                <td className={cx(TD, "text-right")}>
                  {row.href ? (
                    <Link
                      to={row.href}
                      className="inline-flex min-h-9 items-center justify-center rounded-xl border border-brand-800 bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:ring-4"
                      aria-label={`Open ${src.word.toLowerCase()} for ${row.display_label}`}
                    >
                      Open
                    </Link>
                  ) : (
                    <span
                      className="text-xs text-slate-400"
                      title="The API sent neither a session id nor a note id"
                    >
                      no detail
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
