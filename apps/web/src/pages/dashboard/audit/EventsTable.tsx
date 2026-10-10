/**
 * The audit event table: newest first, one row per event, an expandable
 * sub-row with the full prev_hash → hash pair and the pretty-printed payload.
 *
 * The chain-link glyph in the Hash column compares each row with the row below
 * it on the same page (see `chainLinkTo`). It is a reading aid; the server's
 * verify is the authority and the panel above the table says so.
 */
import { useState } from "react";
import { Link } from "react-router-dom";

import { MeasuredBadge } from "../../../components/MeasuredBadge";
import { TierChip } from "../../../components/TierChip";
import { useToast } from "../../../components/Toast";
import { cx, Time } from "../../../lib/format";
import type { AuditEvent } from "../../../lib/types";
import {
  actorRoleClass,
  CHAIN_LINK_TEXT,
  chainLinkTo,
  copyText,
  describeAction,
  entityLinkFor,
  isGenesis,
  payloadHighlights,
  prettyJson,
  truncateHash,
  type ChainLink,
} from "./auditLib";

export interface EventsTableProps {
  /** Already sorted newest first. */
  events: AuditEvent[];
}

const LINK_GLYPH_CLASS: Record<ChainLink, string> = {
  linked: "text-green-700",
  broken: "text-red-700",
  gap: "text-slate-400",
  end: "text-slate-400",
  genesis: "text-brand-700",
};

/** Two interlocking rings; stroke colour carries the chain-link status. */
function ChainGlyph({ status }: { status: ChainLink }) {
  const dashed = status === "gap" || status === "end";
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      aria-hidden="true"
      className={cx("inline-block shrink-0", LINK_GLYPH_CLASS[status])}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray={dashed ? "2 2" : undefined}
    >
      <path d="M8.5 11.5 11.5 8.5" />
      <path d="M7 13a3 3 0 0 1-4.2-4.2l2.4-2.4a3 3 0 0 1 4.2 0" />
      <path d="M13 7a3 3 0 0 1 4.2 4.2l-2.4 2.4a3 3 0 0 1-4.2 0" />
    </svg>
  );
}

function ActorCell({ event }: { event: AuditEvent }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <code className="font-mono text-[12px] text-slate-900">{event.actor_id || "—"}</code>
      <span
        className={cx(
          "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold",
          actorRoleClass(event.actor_role),
        )}
        data-role={event.actor_role}
      >
        {event.actor_role || "unknown"}
      </span>
    </div>
  );
}

function EntityCell({ event }: { event: AuditEvent }) {
  const link = entityLinkFor(event);
  const id = event.entity_id || "—";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {event.entity_type || "—"}
      </span>
      {link ? (
        <Link
          to={link.to}
          title={link.label}
          className="font-mono text-[12px] text-brand-800 underline underline-offset-2 hover:text-brand-900"
        >
          {id}
        </Link>
      ) : (
        <code className="font-mono text-[12px] text-slate-700">{id}</code>
      )}
    </div>
  );
}

function Highlights({ event }: { event: AuditEvent }) {
  const items = payloadHighlights(event);
  if (!items.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {items.map((h, i) => {
        if (h.kind === "measured") {
          return <MeasuredBadge key={i} isMeasured={h.isMeasured} source={h.source} />;
        }
        if (h.kind === "tier") return <TierChip key={i} tier={h.tier} short />;
        return (
          <span
            key={i}
            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700"
          >
            {h.label}={h.value}
          </span>
        );
      })}
    </div>
  );
}

interface RowProps {
  event: AuditEvent;
  older: AuditEvent | undefined;
  expanded: boolean;
  onToggle: () => void;
}

function EventRow({ event, older, expanded, onToggle }: RowProps) {
  const toast = useToast();
  const status = chainLinkTo(event, older);
  const detailsId = `audit-details-${event.id}`;
  const hoverText = `prev_hash ${event.prev_hash || "—"}\n→ hash ${event.hash || "—"}\n${CHAIN_LINK_TEXT[status]}`;

  async function copy(label: string, value: string | null | undefined) {
    // A row can arrive without a hash (the cell then shows "—"); never copy "undefined".
    if (!value) {
      toast.push({ kind: "warning", title: `No ${label} to copy` });
      return;
    }
    const ok = await copyText(value);
    toast.push(
      ok
        ? { kind: "success", title: `${label} copied` }
        : { kind: "warning", title: "Clipboard unavailable", message: value },
    );
  }

  return (
    <>
      <tr
        className={cx("align-top", expanded ? "bg-brand-50/40" : "hover:bg-slate-50")}
        data-seq={event.seq}
        data-chain-link={status}
      >
        <td className="tnum px-3 py-2 font-mono text-[12px] text-slate-600">{event.seq ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-2 text-sm">
          <Time iso={event.ts_utc} />
        </td>
        <td className="px-3 py-2">
          <ActorCell event={event} />
        </td>
        <td className="px-3 py-2">
          <code className="font-mono text-[12px] font-semibold text-slate-900">
            {event.action || "—"}
          </code>
          <div className="text-xs text-slate-600">{describeAction(event.action)}</div>
          <Highlights event={event} />
        </td>
        <td className="px-3 py-2">
          <EntityCell event={event} />
        </td>
        <td className="px-3 py-2">
          {/* The hash cell is a button so keyboard users reach the hover text via expansion. */}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            title={hoverText}
            className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[12px] text-slate-900 hover:bg-slate-100"
          >
            <ChainGlyph status={status} />
            <span>{truncateHash(event.hash)}</span>
            {isGenesis(event) && (
              <span className="rounded bg-brand-50 px-1 text-[10px] font-semibold uppercase text-brand-800">
                genesis
              </span>
            )}
          </button>
        </td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            {expanded ? "Hide" : "Payload"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr id={detailsId} className="bg-brand-50/40" data-testid={`audit-details-${event.seq}`}>
          <td colSpan={7} className="px-3 pb-3 pt-0">
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-slate-600">Event id</dt>
                <dd>
                  <code className="break-all font-mono text-[12px]">{event.id}</code>
                </dd>
                <dt className="text-slate-600">prev_hash</dt>
                <dd className="flex items-start gap-2">
                  <code className="break-all font-mono text-[12px] text-slate-700">
                    {event.prev_hash || "—"}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy("prev_hash", event.prev_hash)}
                    disabled={!event.prev_hash}
                    className="shrink-0 text-xs text-brand-800 underline disabled:no-underline disabled:opacity-50"
                  >
                    Copy
                  </button>
                </dd>
                <dt className="text-slate-600">hash</dt>
                <dd className="flex items-start gap-2">
                  <code className="break-all font-mono text-[12px] text-slate-900">
                    {event.hash || "—"}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy("hash", event.hash)}
                    disabled={!event.hash}
                    className="shrink-0 text-xs text-brand-800 underline disabled:no-underline disabled:opacity-50"
                  >
                    Copy
                  </button>
                </dd>
                <dt className="text-slate-600">Chain link</dt>
                <dd className="flex items-center gap-1.5">
                  <ChainGlyph status={status} />
                  <span>{CHAIN_LINK_TEXT[status]}</span>
                </dd>
                <dt className="text-slate-600">UTC</dt>
                <dd>
                  <code className="font-mono text-[12px]">{event.ts_utc}</code>
                </dd>
              </dl>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Payload
                  </span>
                  <button
                    type="button"
                    onClick={() => void copy("Payload", prettyJson(event.payload))}
                    className="text-xs text-brand-800 underline"
                  >
                    Copy JSON
                  </button>
                </div>
                <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[12px] leading-relaxed text-slate-100">
                  {prettyJson(event.payload)}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function EventsTable({ events }: EventsTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] border-collapse text-left">
        <caption className="sr-only">Audit events, newest first</caption>
        <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          <tr>
            <th scope="col" className="px-3 py-2">
              Seq
            </th>
            <th scope="col" className="px-3 py-2">
              Time
            </th>
            <th scope="col" className="px-3 py-2">
              Actor
            </th>
            <th scope="col" className="px-3 py-2">
              Action
            </th>
            <th scope="col" className="px-3 py-2">
              Entity
            </th>
            <th scope="col" className="px-3 py-2">
              Hash
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {events.map((e, i) => (
            <EventRow
              key={e.id}
              event={e}
              older={events[i + 1]}
              expanded={expanded.has(e.id)}
              onToggle={() => toggle(e.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
