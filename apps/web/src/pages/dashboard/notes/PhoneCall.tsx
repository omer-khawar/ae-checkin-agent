/**
 * Phone-call intake (CLAUDE.md §00 step 2, CONTRACTS.md R4.1).
 *
 * A call is the second most common way a side effect reaches the site, after
 * the next visit. The coordinator types a short summary; the same deterministic
 * chart-note scanner reads it (no language model), so a call that mentions
 * "severe diarrhea since Tuesday, started loperamide" produces the same drafts,
 * evidence quotes and escalation a clinic note would.
 *
 *  - `PhoneIcon` / `NoteTypeLabel`: phone calls are listed with a phone icon and
 *    the words "Phone call" (never the icon alone).
 *  - `LogCallForm`: the "Log a call" quick form used on the Notes page (with a
 *    participant picker) and on the participant timeline (participant fixed).
 */
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { Button } from "../../../components/Button";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { TierChip } from "../../../components/TierChip";
import { useToast } from "../../../components/Toast";
import { useAuth } from "../../../lib/auth";
import { cx } from "../../../lib/format";
import type { Participant } from "../../../lib/types";
import type { CallDirection, CallerKind } from "../detail/r34Types";
import { logPhoneCall } from "./apiNotes";
import { CALLER_LABELS, DIRECTION_LABELS, isPhoneCall, noteTypeWords } from "./phoneCallLabels";
import type { NoteIngestResponse } from "./types";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function PhoneIcon({ className }: { className?: string }) {
  // Inline SVG (no icon font, no third-party script). Decorative: the text label carries meaning.
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cx("inline-block h-3.5 w-3.5 shrink-0", className)}
    >
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h1.148a1.5 1.5 0 0 1 1.465 1.175l.513 2.31a1.5 1.5 0 0 1-1.02 1.756l-.97.323a11.04 11.04 0 0 0 6.1 6.1l.323-.97a1.5 1.5 0 0 1 1.756-1.02l2.31.513A1.5 1.5 0 0 1 18 13.352V14.5a1.5 1.5 0 0 1-1.5 1.5H15C8.096 16 2.5 10.404 2.5 3.5V3.5Z" />
    </svg>
  );
}

/** The note type in words; phone calls get the phone icon beside "Phone call". */
export function NoteTypeLabel({
  noteType,
  className,
}: {
  noteType: string | null | undefined;
  className?: string;
}) {
  if (isPhoneCall(noteType)) {
    return (
      <span
        className={cx(
          "inline-flex items-center gap-1 rounded-md border border-teal-300 bg-teal-50 px-1.5 py-0.5 text-xs font-semibold text-teal-900",
          className,
        )}
        data-testid="phone-call-label"
      >
        <PhoneIcon />
        Phone call
      </span>
    );
  }
  return <span className={className}>{noteTypeWords(noteType)}</span>;
}

// ---------------------------------------------------------------------------
// "Log a call" quick form
// ---------------------------------------------------------------------------

/** Local calendar date as YYYY-MM-DD (a call date is a date, not an instant). */
function todayLocalIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const LABEL = "block text-xs font-semibold uppercase tracking-wide text-slate-600";
const INPUT =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:ring-4";

export interface LogCallFormProps {
  /** Participant picker options. Ignored when `usubjid` is fixed. */
  participants?: Participant[] | null;
  /** Fixed participant (timeline page). */
  usubjid?: string;
  /** Shown instead of the picker when the participant is fixed. */
  displayLabel?: string;
  /** Called after the API stored and scanned the call. */
  onLogged?: (result: NoteIngestResponse) => void;
  /** Stable prefix for element ids when two forms could share a page. */
  idPrefix?: string;
}

export function LogCallForm({
  participants,
  usubjid: fixedUsubjid,
  displayLabel,
  onLogged,
  idPrefix = "call",
}: LogCallFormProps) {
  const { auth, hasRole } = useAuth();
  const toast = useToast();
  // Logging a call stores a record and may create drafts / an escalation, so it
  // is a coordinator or admin action, like ingesting a chart note (R2.4).
  const canLog = hasRole("coordinator", "admin");

  const [usubjid, setUsubjid] = useState(fixedUsubjid ?? "");
  const [caller, setCaller] = useState<CallerKind>("participant");
  const [direction, setDirection] = useState<CallDirection>("inbound");
  const [date, setDate] = useState(todayLocalIso);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<NoteIngestResponse | null>(null);

  const who = fixedUsubjid ?? usubjid;
  const ready = canLog && who.trim() !== "" && summary.trim() !== "" && date !== "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await logPhoneCall({
        usubjid: who.trim(),
        note_date: date,
        author: auth?.display_name || auth?.role || "coordinator",
        caller,
        call_direction: direction,
        text: summary.trim(),
      });
      setResult(res);
      setSummary("");
      const n = res.drafts.length;
      toast.push({
        kind: res.escalation && res.escalation.tier >= 2 ? "warning" : "success",
        title: `Call logged: ${n} draft${n === 1 ? "" : "s"} created`,
        message: res.escalation
          ? `Escalation created${res.sae_clock ? "; 24-hour report clock started" : ""}.`
          : "No escalation.",
      });
      onLogged?.(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const id = (s: string) => `${idPrefix}-${s}`;

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Log a call">
      <p className="text-xs text-slate-600">
        Type what was said in a sentence or two. The same pattern scanner that reads chart notes (no
        language model) proposes side-effect and medication drafts with the exact words quoted.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("participant")} className={LABEL}>
            Call is about
          </label>
          {fixedUsubjid ? (
            <p id={id("participant")} className="mt-1 text-sm font-medium text-slate-900">
              {displayLabel ?? fixedUsubjid}
            </p>
          ) : participants ? (
            <select
              id={id("participant")}
              value={usubjid}
              onChange={(e) => setUsubjid(e.target.value)}
              className={INPUT}
              required
            >
              <option value="">Select…</option>
              {participants.map((p) => (
                <option key={p.usubjid} value={p.usubjid} title={p.usubjid}>
                  {p.display_label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={id("participant")}
              value={usubjid}
              onChange={(e) => setUsubjid(e.target.value)}
              placeholder="USUBJID or P-003"
              className={INPUT}
              required
            />
          )}
        </div>
        <div>
          <label htmlFor={id("date")} className={LABEL}>
            Date of call
          </label>
          <input
            id={id("date")}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT}
            required
          />
        </div>
        <div>
          <label htmlFor={id("caller")} className={LABEL}>
            Who was on the call
          </label>
          <select
            id={id("caller")}
            value={caller}
            onChange={(e) => setCaller(e.target.value as CallerKind)}
            className={INPUT}
          >
            {(Object.keys(CALLER_LABELS) as CallerKind[]).map((k) => (
              <option key={k} value={k}>
                {CALLER_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend className={LABEL}>Direction</legend>
          <div className="mt-2 flex flex-col gap-1 text-sm text-slate-800">
            {(Object.keys(DIRECTION_LABELS) as CallDirection[]).map((k) => (
              <label key={k} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={id("direction")}
                  value={k}
                  checked={direction === k}
                  onChange={() => setDirection(k)}
                />
                {DIRECTION_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div>
        <label htmlFor={id("summary")} className={LABEL}>
          Call summary
        </label>
        <textarea
          id={id("summary")}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          className={INPUT}
          placeholder="e.g. Daughter called: mother has had watery diarrhea 6 times a day since Tuesday, started loperamide."
          required
        />
        <p className="mt-1 text-xs text-slate-500">
          Stored word for word; only findings are drafted.
        </p>
      </div>

      <ErrorBanner error={error} message="The call was not logged" />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" busy={busy} disabled={!ready}>
          Log call
        </Button>
        {!canLog && (
          <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            coordinator or admin only · read-only for your role
          </span>
        )}
      </div>

      {result && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900"
          role="status"
          data-testid="call-logged"
        >
          <PhoneIcon />
          <span>
            Call logged. {result.drafts.length} draft{result.drafts.length === 1 ? "" : "s"}{" "}
            created.
          </span>
          {result.escalation && <TierChip tier={result.escalation.tier} short />}
          {result.note.id && (
            <Link
              to={`/dashboard/notes/${encodeURIComponent(result.note.id)}`}
              className="font-medium text-brand-700 underline"
            >
              Open call record
            </Link>
          )}
        </div>
      )}
    </form>
  );
}
