/**
 * Smaller pieces of the packet page: header, deadline, missing-information
 * checklist, follow-up "changes since the previous report", the in-page sign
 * confirmation, and the report history card.
 */
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { cx, formatCountdown, Time } from "../../../lib/format";
import { EvidenceChips, type EvidenceSelection } from "./EvidenceBits";
import {
  explainer,
  formatValue,
  isEmptyValue,
  KIND_CODES,
  kindLabel,
  participantLabel,
  secondsUntil,
  sequenceLabel,
} from "./model";
import type { Packet, PacketChange, PacketDeadline } from "../../../lib/types";

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function PacketHeader({
  packet,
  deadline,
  nowMs,
}: {
  packet: Packet;
  deadline: PacketDeadline;
  nowMs: number;
}) {
  const signed = packet.status === "signed";
  return (
    <header className="space-y-3">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-600">
        <Link to="/dashboard" className="hover:underline">
          Queue
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          to={`/dashboard/participants/${encodeURIComponent(packet.usubjid)}`}
          className="hover:underline"
        >
          {participantLabel(packet)}
        </Link>
        <span aria-hidden="true"> / </span>
        <span>Report</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold text-slate-900">
            <span>{kindLabel(packet.kind)}</span>
            <code
              className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-600"
              title={
                packet.kind === "sae"
                  ? "Serious adverse event"
                  : "Adverse event of special interest"
              }
            >
              {KIND_CODES[packet.kind]}
            </code>
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              to={`/dashboard/participants/${encodeURIComponent(packet.usubjid)}`}
              className="font-semibold text-brand-800 underline-offset-2 hover:underline"
            >
              Participant {participantLabel(packet)}
            </Link>
            <span
              className="rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-800"
              data-testid="sequence-label"
            >
              {sequenceLabel(packet.sequence)}
            </span>
            <span
              className={cx(
                "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                signed
                  ? "border-green-300 bg-green-50 text-green-900"
                  : "border-amber-300 bg-amber-50 text-amber-900",
              )}
              data-testid="status-label"
            >
              {signed ? "Signed" : "Draft, not signed"}
            </span>
            {packet.version !== null && packet.version !== undefined && (
              <span className="text-xs text-slate-500">Version {packet.version}</span>
            )}
          </div>
        </div>
        <DeadlineBox packet={packet} deadline={deadline} nowMs={nowMs} />
      </div>
      <p className="max-w-3xl text-slate-700" data-testid="packet-explainer">
        {explainer(packet.kind)}
      </p>
    </header>
  );
}

/**
 * Countdown to the 24-hour deadline, or its final state once reported.
 *
 * Follow-up reports (sequence > 0) never count down: the initial report's
 * signature already stopped the 24-hour clock, and the contract (R4.2) gives
 * follow-ups no deadline of their own. Copying the original `due_at` onto a
 * follow-up must not turn into a red "overdue" box.
 */
export function DeadlineBox({
  packet,
  deadline,
  nowMs,
}: {
  packet: Packet;
  deadline: PacketDeadline;
  nowMs: number;
}) {
  const signed = packet.status === "signed";
  const base = "min-w-[14rem] rounded-xl border px-4 py-3 text-sm";

  if (packet.sequence > 0) {
    return (
      <div
        className={cx(base, "border-slate-300 bg-slate-50 text-slate-800")}
        role="status"
        data-testid="deadline"
      >
        <div className="text-xs font-semibold uppercase tracking-wide">24-hour clock</div>
        <div className="mt-0.5 font-semibold">Stopped by the initial report</div>
        <div className="text-xs">
          {deadline.stoppedAt ? (
            <>
              Initial report sent <Time iso={deadline.stoppedAt} style="short" />
            </>
          ) : (
            "This follow-up has no deadline of its own"
          )}
          {signed && packet.signed_at && (
            <>
              {" "}
              · follow-up sent <Time iso={packet.signed_at} style="short" />
            </>
          )}
        </div>
      </div>
    );
  }

  if (signed || deadline.stoppedAt) {
    return (
      <div className={cx(base, "border-green-300 bg-green-50 text-green-900")} role="status">
        <div className="text-xs font-semibold uppercase tracking-wide">24-hour clock</div>
        <div className="mt-0.5 font-semibold">
          {signed ? "Reported (mock)" : (deadline.decision ?? "Stopped")}
        </div>
        <div className="text-xs">
          <Time iso={packet.signed_at ?? deadline.stoppedAt} fallback="" />
        </div>
      </div>
    );
  }
  const secs = secondsUntil(deadline.dueAt, nowMs);
  if (secs === null) {
    return (
      <div className={cx(base, "border-slate-300 bg-slate-50 text-slate-700")}>
        <div className="text-xs font-semibold uppercase tracking-wide">24-hour clock</div>
        <div className="mt-0.5">Deadline not available</div>
      </div>
    );
  }
  const overdue = secs < 0;
  const urgent = !overdue && secs < 4 * 3600;
  return (
    <div
      className={cx(
        base,
        overdue
          ? "border-red-400 bg-red-50 text-red-900"
          : urgent
            ? "border-orange-300 bg-orange-50 text-orange-900"
            : "border-amber-300 bg-amber-50 text-amber-900",
      )}
      data-testid="deadline"
    >
      <div className="text-xs font-semibold uppercase tracking-wide">Report due to sponsor</div>
      <div className="tnum mt-0.5 text-xl font-bold" aria-live="off">
        {overdue ? formatCountdown(secs) : `${formatCountdown(secs)} left`}
      </div>
      <div className="text-xs">
        Due <Time iso={deadline.dueAt} style="short" />
        {deadline.siteAwarenessAt && (
          <>
            {" "}
            · site aware <Time iso={deadline.siteAwarenessAt} style="short" />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missing information
// ---------------------------------------------------------------------------

export function MissingInfoCard({ items }: { items: string[] }) {
  return (
    <Card
      title="Information still needed"
      aside={
        <span
          className={cx(
            "rounded-full px-2 py-0.5 text-xs font-semibold",
            items.length ? "bg-amber-100 text-amber-900" : "bg-green-100 text-green-900",
          )}
        >
          {items.length}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="text-sm text-slate-600">
          Nothing missing that Interim can detect. The investigator still reviews every field.
        </p>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-600">
            Chase these before signing, or send them in a follow-up report.
          </p>
          <ul className="space-y-1.5" aria-label="Information still needed">
            {items.map((m, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-900">
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-block h-4 w-4 flex-none rounded border-2 border-amber-500"
                />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Follow-up: changes since the previous report (R4.2)
// ---------------------------------------------------------------------------

export function ChangesCard({
  changes,
  labelFor,
  selectedKey,
  onSelectEvidence,
}: {
  changes: PacketChange[];
  /** Plain label for a field name when the change itself has none. */
  labelFor: (field: string) => string;
  selectedKey: string | null;
  onSelectEvidence: (s: EvidenceSelection) => void;
}) {
  return (
    <Card title="Changes since the previous report" flush>
      {changes.length === 0 ? (
        <p className="p-4 text-sm text-slate-600">
          No field changed since the previous report. A follow-up can still add a narrative or
          answer missing information.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Field
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Before → after
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Evidence
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {changes.map((c, i) => {
                const label = c.plain_label ?? labelFor(c.field);
                return (
                  <tr key={`${c.field}:${i}`} className="align-top" data-change={c.field}>
                    <th scope="row" className="px-4 py-3 font-normal">
                      <div className="font-semibold text-slate-900">{label}</div>
                      <code className="mt-0.5 inline-block rounded border border-slate-200 bg-slate-50 px-1 py-px font-mono text-[10px] text-slate-500">
                        {c.field}
                      </code>
                    </th>
                    <td className="px-4 py-3">
                      <span
                        className={cx(
                          isEmptyValue(c.before)
                            ? "italic text-slate-500"
                            : "text-slate-600 line-through",
                        )}
                      >
                        {formatValue(c.before)}
                      </span>
                      <span aria-hidden="true" className="mx-2 text-slate-400">
                        →
                      </span>
                      <span className="sr-only"> changed to </span>
                      <span className="font-semibold text-slate-900">{formatValue(c.after)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <EvidenceChips
                        items={c.evidence.map((e) => ({ id: e.id, evidence: e }))}
                        keyPrefix={`change:${c.field}:${i}`}
                        context={`Change to ${label}`}
                        selectedKey={selectedKey}
                        onSelect={onSelectEvidence}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sign confirmation (in-page; the viewer has no window.confirm)
// ---------------------------------------------------------------------------

export function SignConfirm({
  packet,
  missingCount,
  dirty = false,
  busy,
  onConfirm,
  onCancel,
}: {
  packet: Packet;
  missingCount: number;
  /**
   * True when the page holds unsaved edits. The signature must cover what the
   * server holds, so confirming is blocked until they are saved or discarded.
   */
  dirty?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const checkId = useId();
  const headingId = useId();
  const isFollowUp = packet.sequence > 0;
  return (
    <section
      role="region"
      aria-labelledby={headingId}
      className="rounded-2xl border-2 border-brand-700 bg-brand-50 p-4"
      data-testid="sign-confirm"
    >
      <h2 id={headingId} className="text-lg font-bold text-slate-900">
        Sign this {packet.sequence > 0 ? "follow-up" : "report"}?
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
        <li>The report and its narrative become final under your name.</li>
        {isFollowUp ? (
          <li>
            The 24-hour clock was already stopped by the initial report; this follow-up is added to
            the same event.
          </li>
        ) : (
          <li>The 24-hour clock stops and is recorded as “reported (mock)”.</li>
        )}
        <li>A copy is posted to the mock EDC inside Interim. Nothing is sent to a real sponsor.</li>
        <li>Signing is written to the audit trail.</li>
      </ul>
      {missingCount > 0 && (
        <p className="mt-2 text-sm font-semibold text-amber-900">
          {missingCount} item{missingCount === 1 ? " is" : "s are"} still listed as missing. You can
          sign now and send them in a follow-up report.
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          id={checkId}
          type="checkbox"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
          className="h-5 w-5 rounded border-slate-400 text-brand-700 focus:ring-brand-600"
        />
        <label htmlFor={checkId} className="text-sm text-slate-900">
          I have reviewed every field and the narrative.
        </label>
      </div>
      {dirty && (
        <p className="mt-2 text-sm font-semibold text-red-800" role="alert">
          There are unsaved changes. Cancel, then save or discard them before signing.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={onConfirm} disabled={!reviewed || dirty} busy={busy}>
          Yes, sign the {isFollowUp ? "follow-up" : "report"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function HistoryCard({ packet }: { packet: Packet }) {
  const followUps = packet.followup_packet_ids ?? [];
  return (
    <Card title="Report history">
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Drafted</dt>
          <dd>
            <Time iso={packet.created_at} style="short" />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Signed</dt>
          <dd>
            {packet.signed_at ? (
              <>
                <Time iso={packet.signed_at} style="short" /> by{" "}
                {packet.signed_by ?? "investigator"}
              </>
            ) : (
              "Not yet"
            )}
          </dd>
        </div>
        {packet.mock_edc_ack_id && (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Mock EDC receipt</dt>
            <dd>
              <code className="font-mono text-xs">{packet.mock_edc_ack_id}</code>
            </dd>
          </div>
        )}
        {followUps.length > 0 && (
          <div>
            <dt className="text-slate-500">Follow-up reports</dt>
            <dd>
              <ul className="mt-1 space-y-1">
                {followUps.map((fid, i) => (
                  <li key={fid}>
                    <Link
                      to={`/dashboard/packets/${encodeURIComponent(fid)}`}
                      className="font-semibold text-brand-800 underline underline-offset-2"
                    >
                      Follow-up {packet.sequence + i + 1}
                    </Link>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      {packet.parent_packet_id && (
        <p className="mt-2 text-sm">
          <Link
            to={`/dashboard/packets/${encodeURIComponent(packet.parent_packet_id)}`}
            className="font-semibold text-brand-800 underline underline-offset-2"
          >
            Open the previous report
          </Link>
        </p>
      )}
      <p className="pt-2">
        <code className="break-all font-mono text-[10px] text-slate-400">packet {packet.id}</code>
      </p>
    </Card>
  );
}
