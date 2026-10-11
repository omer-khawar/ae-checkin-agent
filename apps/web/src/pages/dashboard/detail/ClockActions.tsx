/**
 * Actions on a 24-hour report clock (SAE or AESI), shared by the check-in
 * detail, note detail and escalations pages:
 *
 *  - "Open report packet" (CLAUDE.md §00.2, CONTRACTS.md R3.2): POST /packets
 *    {clock_id} creates or returns the packet, then the page navigates to
 *    /dashboard/packets/:id. A clock that already names its packet skips the POST.
 *  - "Record seriousness decision" (R4.3): investigator only, for a running
 *    SAE clock whose source drafted no AE (so there is no attribution box to set
 *    AESER on). Never for a possible-AESI clock: that one asks "immune-related?",
 *    not "serious?", and is answered on its side-effect record (plain.ts
 *    canRecordDecision). When the page cannot tell whether an AE draft exists
 *    (the Escalations list), the wording stays neutral and links to the source.
 *    Two steps in the page: pick Serious / Not serious (+ optional
 *    note), then confirm. PATCH /sae-clocks/{id}/stop stops the clock and is
 *    audited as `sae_clock.stopped`. No dialog boxes (the artifact viewer blocks
 *    them), so the confirmation is built into the form.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Button } from "../../../components/Button";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { useToast } from "../../../components/Toast";
import { cx } from "../../../lib/format";
import type { ClockRow, Role } from "../../../lib/types";
import { canRecordDecision, clockChip, clockKind, decisionString } from "./plain";
import { openPacket, stopClock } from "../../../lib/api";
import { packetPath } from "../../../lib/routes";

export interface ClockActionsProps {
  clock: ClockRow;
  role: Role | null;
  /**
   * Whether an AE draft exists that the investigator can attribute instead.
   * `null` = unknown (the decision control is then offered for an SAE clock,
   * because a note-started clock with no AE has no other way to stop, but its
   * wording does not claim that no record exists).
   */
  hasAeDraft: boolean | null;
  /** Called with the stopped clock row the API returns. */
  onStopped?: (clock: ClockRow) => void;
  className?: string;
  /** Compact layout for table cells. */
  compact?: boolean;
}

export function ClockActions({
  clock,
  role,
  hasAeDraft,
  onStopped,
  className,
  compact,
}: ClockActionsProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<unknown>(null);
  const kind = clockKind(clock);

  const open = async () => {
    if (clock.packet_id) {
      navigate(packetPath(clock.packet_id));
      return;
    }
    setOpening(true);
    setOpenError(null);
    try {
      const packet = await openPacket(clock.id);
      if (!packet?.id) throw new Error("The API did not return a packet id");
      navigate(packetPath(packet.id));
    } catch (e) {
      setOpenError(e);
    } finally {
      setOpening(false);
    }
  };

  const showDecision = canRecordDecision(clock, role, hasAeDraft);

  return (
    <div className={cx("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          busy={opening}
          onClick={() => void open()}
          title={`Pre-filled ${clockChip(kind)} report: fields with evidence, missing information, draft narrative`}
        >
          Open report packet
        </Button>
        {!compact && (
          <span className="text-xs text-slate-600">
            Pre-filled from the evidence; the investigator reviews and signs.
          </span>
        )}
      </div>
      <ErrorBanner error={openError} message="Could not open the report packet" />
      {showDecision && (
        <DecisionForm
          clock={clock}
          hasAeDraft={hasAeDraft}
          onStopped={(row) => {
            toast.push({
              kind: "success",
              title: "Seriousness decision recorded",
              message: `The 24-hour clock for ${clock.usubjid} is stopped (${row.decision ?? "decision recorded"}).`,
            });
            onStopped?.(row);
          }}
        />
      )}
    </div>
  );
}

type Step = "closed" | "choose" | "confirm";

/** Where the clock came from, for the neutral "check the source first" link. */
function sourcePath(clock: ClockRow): { to: string; label: string } | null {
  if (clock.session_id) {
    return { to: `/dashboard/checkins/${encodeURIComponent(clock.session_id)}`, label: "check-in" };
  }
  if (clock.note_id) {
    return { to: `/dashboard/notes/${encodeURIComponent(clock.note_id)}`, label: "note" };
  }
  return null;
}

function DecisionForm({
  clock,
  hasAeDraft,
  onStopped,
}: {
  clock: ClockRow;
  hasAeDraft: boolean | null;
  onStopped: (clock: ClockRow) => void;
}) {
  const [step, setStep] = useState<Step>("closed");
  const [serious, setSerious] = useState<"Y" | "N" | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const base = `decision-${clock.id}`;

  if (step === "closed") {
    return (
      <div>
        <Button size="sm" variant="secondary" onClick={() => setStep("choose")}>
          Record seriousness decision
        </Button>
        {hasAeDraft === false ? (
          <p className="mt-1 text-xs text-slate-600">
            No side-effect record was drafted for this clock, so the decision is recorded on the
            clock itself (investigator only).
          </p>
        ) : (
          <DecisionUnknownHint clock={clock} />
        )}
      </div>
    );
  }

  const submit = async () => {
    if (serious === "") return;
    setBusy(true);
    setError(null);
    try {
      const row = await stopClock(clock.id, {
        decision: decisionString(serious),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onStopped({ ...clock, ...row });
      setStep("closed");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-2 rounded-xl border border-slate-300 bg-slate-50 p-3"
      aria-label="Record seriousness decision"
      onSubmit={(e) => {
        e.preventDefault();
        if (step === "choose" && serious !== "") setStep("confirm");
        else if (step === "confirm") void submit();
      }}
    >
      {step === "choose" ? (
        <>
          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">
              Is this a serious event?{" "}
              <span className="rounded bg-white px-1 font-mono text-[10px] font-normal text-slate-600">
                AESER
              </span>
            </legend>
            <div className="mt-1 flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="radio"
                  name={`${base}-serious`}
                  value="Y"
                  checked={serious === "Y"}
                  onChange={() => setSerious("Y")}
                />
                Serious
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="radio"
                  name={`${base}-serious`}
                  value="N"
                  checked={serious === "N"}
                  onChange={() => setSerious("N")}
                />
                Not serious
              </label>
            </div>
          </fieldset>
          <div>
            <label htmlFor={`${base}-note`} className="block text-xs font-medium text-slate-700">
              Reason (optional, written to the audit log)
            </label>
            <input
              id={`${base}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
              maxLength={2000}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={serious === ""}>
              Continue
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setStep("closed")}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-900" data-testid="decision-confirm">
            Record{" "}
            <span className="font-semibold">{serious === "Y" ? "serious" : "not serious"}</span>{" "}
            <span className="font-mono text-xs">({decisionString(serious as "Y" | "N")})</span> for{" "}
            <span className="font-medium">{clock.usubjid}</span>? This stops the 24-hour clock and
            is written to the audit log. It cannot be undone here.
          </p>
          {note.trim() && <p className="text-xs text-slate-700">Reason: {note.trim()}</p>}
          <ErrorBanner error={error} message="The decision was not recorded" />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="danger" busy={busy}>
              Yes, record decision
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setStep("choose")}
              disabled={busy}
            >
              Back
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

/**
 * Neutral copy when the page does not know whether the clock's source drafted a
 * side-effect record: point at the source, where the attribution box (if any)
 * is the better place to answer "Serious?".
 */
function DecisionUnknownHint({ clock }: { clock: ClockRow }) {
  const src = sourcePath(clock);
  return (
    <p className="mt-1 text-xs text-slate-600" data-testid="decision-neutral-hint">
      Use this only if the source has no side-effect record to attribute; otherwise answer
      &quot;Serious?&quot; on that record
      {src ? (
        <>
          {" "}
          (
          <Link to={src.to} className="text-brand-700 underline">
            open the {src.label}
          </Link>
          )
        </>
      ) : null}
      . Investigator only.
    </p>
  );
}
