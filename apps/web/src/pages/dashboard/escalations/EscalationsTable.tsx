/**
 * The escalation table: one row per tier ≥ 2 event, with the plain-English
 * reasons the rules engine recorded, the paging and acknowledgement timestamps,
 * and a live time-to-acknowledge for open rows.
 */
import { Link } from "react-router-dom";

import { Button } from "../../../components/Button";
import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { TierChip } from "../../../components/TierChip";
import { Time } from "../../../lib/format";
import { cx } from "../../../lib/format";
import {
  escalationSource,
  escalationStartedAt,
  formatDuration,
  isAcked,
  secondsToAck,
  SOURCE_LABELS,
} from "./model";
import type { EscalationRow } from "./types";

export interface EscalationsTableProps {
  rows: EscalationRow[];
  nowMs: number;
  /** Whether the signed-in role may acknowledge (coordinator / admin). */
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
          className="font-mono text-xs text-brand-700 underline"
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
        <span className="font-mono text-xs text-slate-500" title="Chart note id">
          {row.note_id}
        </span>
      )}
    </div>
  );
}

export function EscalationsTable({ rows, nowMs, canAck, ackingId, onAck }: EscalationsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th scope="col" className="px-3 py-2">
              Participant
            </th>
            <th scope="col" className="px-3 py-2">
              Source
            </th>
            <th scope="col" className="px-3 py-2">
              Tier
            </th>
            <th scope="col" className="px-3 py-2">
              Reasons (from the rules engine)
            </th>
            <th scope="col" className="px-3 py-2">
              Paged
            </th>
            <th scope="col" className="px-3 py-2">
              Acknowledged
            </th>
            <th scope="col" className="px-3 py-2">
              Time to acknowledge
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((row) => {
            const acked = isAcked(row);
            const seconds = secondsToAck(row, nowMs);
            const started = escalationStartedAt(row);
            const busy = ackingId === row.id;
            return (
              <tr
                key={row.id}
                data-escalation-id={row.id}
                data-acked={acked ? "true" : "false"}
                className={cx("align-top", !acked && "bg-amber-50/40")}
              >
                <td className="px-3 py-2">
                  <Link
                    to={`/dashboard/participants/${encodeURIComponent(row.usubjid)}`}
                    className="font-mono text-brand-700 underline"
                    title="Open the participant timeline"
                  >
                    {row.usubjid}
                  </Link>
                  {started && (
                    <div className="text-xs text-slate-500">
                      raised <Time iso={started} style="short" />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <SourceCell row={row} />
                </td>
                <td className="px-3 py-2">
                  <TierChip tier={row.tier} />
                </td>
                <td className="px-3 py-2">
                  {row.reasons && row.reasons.length > 0 ? (
                    <ul className="list-disc space-y-0.5 pl-4 text-slate-800">
                      {row.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-slate-500">No reasons recorded</span>
                  )}
                  {/* Vitals provenance for corroboration reasons (CLAUDE.md §13: the word
                      "simulated" appears next to anything simulated). The API does not
                      send `vitals_is_measured` yet; nothing is shown rather than guessed. */}
                  {typeof row.vitals_is_measured === "boolean" && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <span>vitals used by the rules:</span>
                      <MeasuredBadge isMeasured={row.vitals_is_measured} />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.paged_at ? (
                    <Time iso={row.paged_at} style="short" />
                  ) : (
                    <span
                      className="text-slate-500"
                      title={
                        row.tier >= 3
                          ? "Tier 3 pages the on-call role; no page time was recorded"
                          : "Only tier 3 pages the on-call role (mock pager)"
                      }
                    >
                      {row.tier >= 3 ? "—" : "not paged (tier 2)"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {acked ? (
                    <div className="flex flex-col">
                      <span className="font-medium text-slate-900">{row.acked_by ?? "—"}</span>
                      <Time iso={row.acked_at} style="short" className="text-xs text-slate-600" />
                    </div>
                  ) : (
                    <span className="rounded-md border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                      Open
                    </span>
                  )}
                </td>
                <td className="tnum px-3 py-2 whitespace-nowrap">
                  {seconds === null ? (
                    <span className="text-slate-500">—</span>
                  ) : acked ? (
                    <span title="Acknowledged at − raised at">{formatDuration(seconds)}</span>
                  ) : (
                    <span
                      className="font-semibold text-amber-900"
                      title="Still open: elapsed since the escalation was raised, updating live"
                    >
                      {formatDuration(seconds)}{" "}
                      <span className="text-xs font-normal text-slate-500">and counting</span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {/* A disabled <button> is unfocusable, so a hover-only explanation never
                      reaches keyboard or screen-reader users. The no-permission case is
                      therefore visible text; `disabled` is kept only for the in-flight state. */}
                  {!acked &&
                    (canAck ? (
                      <Button
                        size="sm"
                        variant="primary"
                        busy={busy}
                        disabled={ackingId !== null && !busy}
                        onClick={() => onAck(row)}
                        title="Records escalation.acked in the audit log with your identity"
                        aria-label={`Acknowledge escalation for ${row.usubjid}`}
                      >
                        Acknowledge
                      </Button>
                    ) : (
                      <p
                        className="max-w-[11rem] whitespace-normal text-xs text-slate-600"
                        data-testid="ack-read-only"
                      >
                        <span className="font-semibold text-slate-800">
                          Coordinator acknowledges.
                        </span>{" "}
                        Investigators are read-only here in v1 (except AESER/AEREL on the check-in).
                      </p>
                    ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
