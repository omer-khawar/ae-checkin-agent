/**
 * The list of queries for one tab. Each row's query text is a real button, so
 * the table is keyboard-navigable (Tab to a row, Enter to open its panel).
 * Plain words lead; the SDTM domain.field stays as a small monospace badge.
 */
import { cx, Time } from "../../../lib/format";
import { AgeChip, CodeBadge, SeverityChip, StatusChip } from "./bits";
import { ageHours, domainLabel, fieldLabel, isAgeAlert, participantLabel, raisedBy } from "./model";
import type { QueryRow } from "./types";

export interface QueriesTableProps {
  rows: QueryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  nowMs: number;
}

export function QueriesTable({ rows, selectedId, onSelect, nowMs }: QueriesTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Participant
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Record
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Question from the sponsor
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Kind
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Raised by
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Age
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => {
            const hours = ageHours(r, nowMs);
            const who = raisedBy(r);
            const selected = r.id === selectedId;
            return (
              <tr
                key={r.id}
                className={cx("align-top", selected ? "bg-brand-50" : "hover:bg-slate-50")}
                aria-current={selected ? "true" : undefined}
                data-query-row={r.id}
              >
                <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900">
                  {participantLabel(r)}
                </td>
                <td className="px-3 py-2">
                  <div className="text-slate-900">
                    {domainLabel(r.domain)}: {fieldLabel(r.field, r.field_label)}
                  </div>
                  <CodeBadge title="SDTM domain and variable">{`${r.domain}.${r.field}`}</CodeBadge>
                </td>
                <td className="max-w-md px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    className="text-left text-brand-800 underline-offset-2 hover:underline focus-visible:ring-2"
                    aria-label={`Open query: ${r.text}`}
                  >
                    {r.text}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <SeverityChip severity={r.severity} />
                </td>
                <td className="px-3 py-2">
                  <div className="text-slate-800">{who.label}</div>
                  {who.code && <CodeBadge>{who.code}</CodeBadge>}
                  <div className="text-xs text-slate-500">
                    <Time iso={r.raised_at} style="short" />
                  </div>
                </td>
                <td className="px-3 py-2">
                  <AgeChip hours={hours} alert={isAgeAlert(r, hours)} />
                </td>
                <td className="px-3 py-2">
                  <StatusChip status={r.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
