/**
 * Smaller pieces of the packet page: header, deadline, missing-information
 * checklist, follow-up "changes since the previous report", the in-page sign
 * confirmation, and the report history card.
 */
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Panel as Card } from "./Panel";
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
      <nav aria-label="Breadcrumb" className="text-body text-muted-foreground">
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
          <h1 className="flex flex-wrap items-center gap-2 text-page font-bold text-foreground">
            <span>{kindLabel(packet.kind)}</span>
            <code
              className="rounded border border-border-strong bg-surface-subtle px-1.5 py-0.5 font-mono text-caption font-semibold text-muted-foreground"
              title={
                packet.kind === "sae"
                  ? "Serious adverse event"
                  : "Adverse event of special interest"
              }
            >
              {KIND_CODES[packet.kind]}
            </code>
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-body">
            <Link
              to={`/dashboard/participants/${encodeURIComponent(packet.usubjid)}`}
              className="font-semibold text-primary underline-offset-2 hover:underline"
            >
              Participant {participantLabel(packet)}
            </Link>
            <span
              className="rounded-full border border-border-strong bg-surface px-2.5 py-0.5 text-caption font-semibold text-foreground"
              data-testid="sequence-label"
            >
              {sequenceLabel(packet.sequence)}
            </span>
            <span
              className={cx(
                "rounded-full border px-2.5 py-0.5 text-caption font-semibold",
                signed
                  ? "border-success-border bg-success-bg text-success-fg"
                  : "border-warning-border bg-warning-bg text-warning-fg",
              )}
              data-testid="status-label"
            >
              {signed ? "Signed" : "Draft, not signed"}
            </span>
            {packet.version !== null && packet.version !== undefined && (
              <span className="text-caption text-muted-foreground">Version {packet.version}</span>
            )}
          </div>
        </div>
        <DeadlineBox packet={packet} deadline={deadline} nowMs={nowMs} />
      </div>
      <p className="max-w-3xl text-foreground" data-testid="packet-explainer">
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
  const base = "min-w-56 rounded-panel border px-4 py-3 text-body";

  if (packet.sequence > 0) {
    return (
      <div
        className={cx(base, "border-border-strong bg-surface-subtle text-foreground")}
        role="status"
        data-testid="deadline"
      >
        <div className="text-caption font-semibold uppercase tracking-wide">24-hour clock</div>
        <div className="mt-0.5 font-semibold">Stopped by the initial report</div>
        <div className="text-caption">
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
      <div
        className={cx(base, "border-success-border bg-success-bg text-success-fg")}
        role="status"
        data-testid="deadline"
      >
        <div className="text-caption font-semibold uppercase tracking-wide">24-hour clock</div>
        <div className="mt-0.5 font-semibold">
          {signed ? "Reported (mock)" : (deadline.decision ?? "Stopped")}
        </div>
        <div className="text-caption">
          <Time iso={packet.signed_at ?? deadline.stoppedAt} fallback="" />
        </div>
      </div>
    );
  }
  const secs = secondsUntil(deadline.dueAt, nowMs);
  if (secs === null) {
    return (
      <div className={cx(base, "border-border-strong bg-surface-subtle text-foreground")}>
        <div className="text-caption font-semibold uppercase tracking-wide">24-hour clock</div>
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
          ? "border-danger-border bg-danger-bg text-danger-fg"
          : urgent
            ? "border-tier-2-border bg-tier-2-bg text-tier-2-fg"
            : "border-warning-border bg-warning-bg text-warning-fg",
      )}
      data-testid="deadline"
    >
      <div className="text-caption font-semibold uppercase tracking-wide">
        Report due to sponsor
      </div>
      <div className="tnum mt-0.5 text-title font-bold" aria-live="off">
        {overdue ? formatCountdown(secs) : `${formatCountdown(secs)} left`}
      </div>
      <div className="text-caption">
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

export function MissingInfoCard({ items, signed = false }: { items: string[]; signed?: boolean }) {
  return (
    <Card
      title="Information still needed"
      aside={
        <span
          className={cx(
            "rounded-full px-2 py-0.5 text-caption font-semibold",
            items.length ? "bg-warning-bg text-warning-fg" : "bg-success-bg text-success-fg",
          )}
        >
          {items.length}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="text-body text-muted-foreground">
          Nothing missing that Interim can detect. The investigator still reviews every field.
        </p>
      ) : (
        <>
          <p className="mb-2 text-body text-muted-foreground">
            {signed
              ? "Marked not available at signing. Send them in a follow-up report."
              : "Chase these before signing, or send them in a follow-up report."}
          </p>
          <ul className="space-y-1.5" aria-label="Information still needed">
            {items.map((m, i) => (
              <li key={i} className="flex items-start gap-2 text-body text-foreground">
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-block h-4 w-4 flex-none rounded border-2 border-warning-border"
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
        <p className="p-4 text-body text-muted-foreground">
          No field changed since the previous report. A follow-up can still add a narrative or
          answer missing information.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-body">
            <thead className="bg-surface-subtle text-caption uppercase tracking-wide text-muted-foreground">
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
            <tbody className="divide-y divide-border">
              {changes.map((c, i) => {
                const label = c.plain_label ?? labelFor(c.field);
                return (
                  <tr key={`${c.field}:${i}`} className="align-top" data-change={c.field}>
                    <th scope="row" className="px-4 py-3 font-normal">
                      <div className="font-semibold text-foreground">{label}</div>
                      <code className="mt-0.5 inline-block rounded border border-border bg-surface-subtle px-1 py-px font-mono text-caption text-muted-foreground">
                        {c.field}
                      </code>
                    </th>
                    <td className="px-4 py-3">
                      <span
                        className={cx(
                          isEmptyValue(c.before)
                            ? "italic text-muted-foreground"
                            : "text-muted-foreground line-through",
                        )}
                      >
                        {formatValue(c.before)}
                      </span>
                      <span aria-hidden="true" className="mx-2 text-subtle-foreground">
                        →
                      </span>
                      <span className="sr-only"> changed to </span>
                      <span className="font-semibold text-foreground">{formatValue(c.after)}</span>
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
  dirty = false,
  busy,
  onConfirm,
  onCancel,
}: {
  packet: Packet;
  /** Deprecated: the open items are read from the packet. Kept so callers need no change. */
  missingCount?: number;
  /**
   * True when the page holds unsaved edits. The signature must cover what the
   * server holds, so confirming is blocked until they are saved or discarded.
   */
  dirty?: boolean;
  busy: boolean;
  /** Receives the open items the investigator marked "Not available", verbatim. */
  onConfirm: (notAvailable: string[]) => void;
  onCancel: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [marked, setMarked] = useState<Record<number, boolean>>({});
  const checkId = useId();
  const headingId = useId();
  const isFollowUp = packet.sequence > 0;
  const items = packet.missing_information;
  const allMarked = items.every((_, i) => marked[i]);
  const ready = reviewed && allMarked && !dirty;
  const unmarked = items.filter((_, i) => !marked[i]).length;
  return (
    <section
      role="region"
      aria-labelledby={headingId}
      className="rounded-panel border-2 border-primary bg-surface p-4"
      data-testid="sign-confirm"
    >
      <h2 id={headingId} className="text-title font-semibold text-foreground">
        Sign this {isFollowUp ? "follow-up" : "report"}?
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-body text-foreground">
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
      {items.length > 0 && (
        <fieldset className="mt-3 rounded-control border border-warning-border bg-warning-bg p-3">
          <legend className="px-1 text-body font-semibold text-warning-fg">
            {items.length} item{items.length === 1 ? " is" : "s are"} still listed as missing
          </legend>
          <p className="mb-2 text-body text-warning-fg">
            Mark each one “Not available” to sign now and send it in a follow-up report, or cancel
            and chase it first.
          </p>
          <ul className="space-y-1.5">
            {items.map((m, i) => (
              <li key={i}>
                <label className="flex items-start gap-2 text-body text-foreground">
                  <input
                    type="checkbox"
                    checked={Boolean(marked[i])}
                    onChange={(e) => setMarked((prev) => ({ ...prev, [i]: e.target.checked }))}
                    className="mt-0.5 size-4 accent-primary"
                    aria-label={`Not available: ${m}`}
                  />
                  <span>
                    {m} <span className="text-muted-foreground">· Not available</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          id={checkId}
          type="checkbox"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
          className="size-4 accent-primary"
        />
        <label htmlFor={checkId} className="text-body text-foreground">
          I reviewed the narrative and every field.
        </label>
      </div>
      {dirty && (
        <p className="mt-2 text-body font-semibold text-danger-fg" role="alert">
          There are unsaved changes. Cancel, then save or discard them before signing.
        </p>
      )}
      {!dirty && reviewed && unmarked > 0 && (
        <p className="mt-2 text-caption text-muted-foreground">
          {unmarked} missing item{unmarked === 1 ? "" : "s"} still need “Not available”.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => onConfirm(items.filter((_, i) => marked[i]))}
          disabled={!ready}
          loading={busy}
        >
          Yes, sign the {isFollowUp ? "follow-up" : "report"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/** Compact deadline for the sticky action bar. Not the `deadline` test id: the header owns that. */
export function DeadlineChip({
  packet,
  deadline,
  nowMs,
}: {
  packet: Packet;
  deadline: PacketDeadline;
  nowMs: number;
}) {
  if (packet.sequence > 0) {
    return <Badge kind="neutral" label="Clock stopped by the initial report" />;
  }
  if (packet.status === "signed" || deadline.stoppedAt) {
    return <Badge kind="success" label="Clock stopped" />;
  }
  const secs = secondsUntil(deadline.dueAt, nowMs);
  if (secs === null) return <Badge kind="neutral" label="Deadline not available" />;
  return (
    <Badge
      kind={secs < 0 ? "danger" : "sae-clock"}
      label={secs < 0 ? "Overdue" : "Due in"}
      detail={formatCountdown(secs)}
      data-testid="deadline-chip"
    />
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function HistoryCard({ packet }: { packet: Packet }) {
  const followUps = packet.followup_packet_ids ?? [];
  return (
    <Card title="Report history">
      <dl className="space-y-2 text-body">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Drafted</dt>
          <dd>
            <Time iso={packet.created_at} style="short" />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Signed</dt>
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
            <dt className="text-muted-foreground">Mock EDC receipt</dt>
            <dd>
              <code className="font-mono text-caption">{packet.mock_edc_ack_id}</code>
            </dd>
          </div>
        )}
        {followUps.length > 0 && (
          <div>
            <dt className="text-muted-foreground">Follow-up reports</dt>
            <dd>
              <ul className="mt-1 space-y-1">
                {followUps.map((fid, i) => (
                  <li key={fid}>
                    <Link
                      to={`/dashboard/packets/${encodeURIComponent(fid)}`}
                      className="font-semibold text-primary underline underline-offset-2"
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
        <p className="mt-2 text-body">
          <Link
            to={`/dashboard/packets/${encodeURIComponent(packet.parent_packet_id)}`}
            className="font-semibold text-primary underline underline-offset-2"
          >
            Open the previous report
          </Link>
        </p>
      )}
      <p className="pt-2">
        <code className="break-all font-mono text-caption text-subtle-foreground">
          packet {packet.id}
        </code>
      </p>
    </Card>
  );
}
