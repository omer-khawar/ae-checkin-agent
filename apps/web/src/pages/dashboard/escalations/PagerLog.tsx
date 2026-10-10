/**
 * The mock pager log (GET /pages). Every row is a simulated page: the system
 * wrote an audit event and raised a dashboard toast; no real pager exists.
 */
import { Link } from "react-router-dom";

import { TierChip } from "../../../components/TierChip";
import { Time } from "../../../lib/format";
import type { PageEventRow } from "./types";

export interface PagerLogProps {
  rows: PageEventRow[];
}

export function PagerLog({ rows }: PagerLogProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
          <tr>
            <th scope="col" className="px-3 py-2">
              Sent
            </th>
            <th scope="col" className="px-3 py-2">
              Participant
            </th>
            <th scope="col" className="px-3 py-2">
              Tier
            </th>
            <th scope="col" className="px-3 py-2">
              Message
            </th>
            <th scope="col" className="px-3 py-2">
              Delivery
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((p) => (
            <tr key={p.id} data-page-id={p.id} className="align-top">
              <td className="px-3 py-2 whitespace-nowrap">
                <Time iso={p.ts} style="short" />
              </td>
              <td className="px-3 py-2">
                {p.usubjid ? (
                  <Link
                    to={`/dashboard/participants/${encodeURIComponent(p.usubjid)}`}
                    className="font-mono text-brand-700 underline"
                  >
                    {p.usubjid}
                  </Link>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
                {p.session_id && (
                  <div>
                    <Link
                      to={`/dashboard/checkins/${encodeURIComponent(p.session_id)}`}
                      className="text-xs text-brand-700 underline"
                    >
                      open check-in
                    </Link>
                  </div>
                )}
              </td>
              <td className="px-3 py-2">
                <TierChip tier={p.tier} short />
              </td>
              <td className="px-3 py-2 text-slate-800">{p.message}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <span
                  className="rounded-md border border-violet-300 bg-violet-100 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-violet-800"
                  title="The pager is simulated: an audit event plus a dashboard toast. Nobody was really paged."
                >
                  Simulated
                </span>{" "}
                <span className="text-xs text-slate-600">
                  {p.delivered ? "delivered" : "not delivered"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
