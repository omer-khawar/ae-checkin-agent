/**
 * The queue table. Rows arrive in server order (tier desc, completed_at desc);
 * this component never re-sorts. Every derived value carries a `title` that
 * says where it came from, and the detail page holds the full evidence.
 */
import { Link } from "react-router-dom";

import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { TierChip } from "../../../components/TierChip";
import { cx, Time, vitalsStatusLabel } from "../../../lib/format";
import { hasVitalsSamples } from "./normalize";
import { SaeCountdownChip } from "./SaeCountdownChip";
import type { QueueRow, QueueSource } from "./types";

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
  if (source === "chart_note") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="h-4 w-4 text-slate-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M5 2.5h7l3 3v12H5z" />
        <path d="M12 2.5v3h3M7.5 9h5M7.5 12h5M7.5 15h3" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-4 w-4 text-slate-500"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
      <path d="M7 17h6M10 13.5V17" />
    </svg>
  );
}

const SOURCE_LABEL: Record<QueueSource, { word: string; title: string }> = {
  check_in: {
    word: "Check-in",
    title: "Participant kiosk check-in (PRO-CTCAE style items + vitals)",
  },
  chart_note: {
    word: "Chart note",
    title: "Deterministic scan of a chart note (regex + NegEx; no LLM)",
  },
};

function EscalationCell({ acked }: { acked: boolean | null }) {
  if (acked === null) {
    return (
      <span className="text-slate-400" title="No escalation for this item">
        —
      </span>
    );
  }
  return acked ? (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800"
      title="Escalation acknowledged by the study team"
    >
      <span aria-hidden="true">✓</span> Acked
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
      title="Escalation not yet acknowledged; open the check-in to acknowledge"
    >
      <span aria-hidden="true">!</span> Unacked
    </span>
  );
}

function DraftsCell({ row }: { row: QueueRow }) {
  const c = row.draft_counts;
  const total = c.AE + c.VS + c.CM;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="tnum font-mono text-xs text-slate-800"
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
  if (row.source === "chart_note") {
    return (
      <span className="text-slate-400" title="Chart notes carry no contactless vitals">
        —
      </span>
    );
  }
  const label = vitalsStatusLabel(row.vitals_status);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span title="Vitals assessment status from the rules engine (vitals never change a grade)">
        {label}
      </span>
      {hasVitalsSamples(row) && <MeasuredBadge isMeasured={row.is_measured} />}
    </div>
  );
}

export function QueueTable({ rows, now, refreshing }: QueueTableProps) {
  return (
    <div className="overflow-x-auto">
      <table
        className={cx("w-full min-w-[960px] border-collapse", refreshing && "opacity-70")}
        aria-busy={refreshing || undefined}
      >
        <caption className="sr-only">
          Check-ins and chart notes awaiting review, sorted by escalation tier (highest first) then
          most recent
        </caption>
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th scope="col" className={TH}>
              Participant
            </th>
            <th scope="col" className={TH}>
              Source
            </th>
            <th scope="col" className={TH}>
              Completed
            </th>
            <th scope="col" className={TH}>
              Tier
            </th>
            <th scope="col" className={TH}>
              <abbr
                title="Highest provisional CTCAE grade across items, from the participant's answers only"
                className="no-underline"
              >
                Max grade
              </abbr>
            </th>
            <th scope="col" className={TH}>
              Vitals
            </th>
            <th scope="col" className={TH}>
              <abbr
                title="Serious adverse event clock: 24 h from site awareness"
                className="no-underline"
              >
                SAE clock
              </abbr>
            </th>
            <th scope="col" className={TH}>
              Escalation
            </th>
            <th scope="col" className={TH}>
              Drafts
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
                  <Link
                    to={`/dashboard/participants/${encodeURIComponent(row.usubjid)}`}
                    className="font-semibold text-brand-800 underline-offset-2 hover:underline"
                    title={`${row.usubjid} · open participant timeline`}
                  >
                    {row.display_label}
                  </Link>
                </td>
                <td className={TD}>
                  <span className="inline-flex items-center gap-1.5" title={src.title}>
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
                <td className={cx(TD, "tnum")}>
                  {row.max_grade === null ? (
                    // The explanation depends on where the row came from: a
                    // chart-note finding only ever carries a grade hint, while a
                    // check-in simply reported nothing gradeable.
                    <span
                      className="text-slate-400"
                      title={
                        row.source === "chart_note"
                          ? "No provisional grade (chart-note findings carry a grade hint only)"
                          : "No provisional grade reported for this check-in"
                      }
                    >
                      —
                    </span>
                  ) : (
                    <span title="Provisional CTCAE grade from PRO-CTCAE composite scores; investigator to confirm">
                      G{row.max_grade} <span className="text-xs text-slate-500">provisional</span>
                    </span>
                  )}
                </td>
                <td className={TD}>
                  <VitalsCell row={row} />
                </td>
                <td className={TD}>
                  {row.has_sae_clock ? (
                    <SaeCountdownChip
                      dueAt={row.sae_due_at}
                      stopped={row.sae_stopped}
                      stoppedAt={row.sae_stopped_at}
                      now={now}
                    />
                  ) : (
                    <span className="text-slate-400" title="No seriousness trigger reported">
                      —
                    </span>
                  )}
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
