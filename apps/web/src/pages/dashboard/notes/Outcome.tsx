/**
 * What ingesting a note produced: drafts (links to the detail page), the
 * escalation (tier chip + reasons) and the SAE clock, if any. Notes never
 * produce Tier 3 or a page (R2.4); the tier chip just paints what the API sent.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { TierChip } from "../../../components/TierChip";
import { formatCountdown, Time } from "../../../lib/format";
import type { NoteDraft, NoteEscalation, NoteSAEClock } from "./types";

export interface OutcomeProps {
  noteId: string;
  drafts: NoteDraft[];
  escalation: NoteEscalation | null;
  saeClock: NoteSAEClock | null;
  /** Hide the "Open note detail" link when already on the detail page. */
  showDetailLink?: boolean;
}

function secondsRemaining(clock: NoteSAEClock, now: number): number | null {
  if (clock.stopped_at) return null;
  const due = Date.parse(clock.due_at);
  if (Number.isNaN(due)) return clock.seconds_remaining ?? null;
  return Math.round((due - now) / 1000);
}

export function SaeClockLine({ clock }: { clock: NoteSAEClock }) {
  // Tick once a second so the countdown is live; the API's `seconds_remaining`
  // is only a fallback when `due_at` cannot be parsed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (clock.stopped_at) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [clock.stopped_at]);
  const remaining = secondsRemaining(clock, now);
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
      <div className="font-semibold">
        {clock.kind === "aesi"
          ? "Special-interest event clock started (possible AESI, investigator to confirm)"
          : "SAE clock started (hospital or emergency-room visit mentioned)"}
      </div>
      <div className="mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
        <span>
          Site aware: <Time iso={clock.site_awareness_at} />
        </span>
        <span>
          Investigator → sponsor due: <Time iso={clock.due_at} />
        </span>
        <span className="tnum font-medium">
          {clock.stopped_at
            ? `Stopped (${clock.decision ?? "decision recorded"})`
            : `Remaining: ${formatCountdown(remaining)}`}
        </span>
        <span className="text-red-800/80">
          24 h site obligation; sponsor 7/15-day clocks are informational.
        </span>
      </div>
    </div>
  );
}

export function Outcome({
  noteId,
  drafts,
  escalation,
  saeClock,
  showDetailLink = true,
}: OutcomeProps) {
  const counts = drafts.reduce<Record<string, number>>((acc, d) => {
    acc[d.domain] = (acc[d.domain] ?? 0) + 1;
    return acc;
  }, {});
  const followups = drafts.filter((d) => d.is_followup).length;
  // Belt and braces: `normalizeEscalation` already fills `reasons`, but a row
  // that reaches this component by another path must not blank the route.
  const reasons = escalation?.reasons ?? [];
  return (
    <div className="space-y-3" data-testid="ingest-outcome">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-slate-900">Drafts created:</span>
        {drafts.length === 0 ? (
          <span className="text-slate-600">none</span>
        ) : (
          <>
            {Object.entries(counts).map(([domain, n]) => (
              <span
                key={domain}
                className="tnum rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800"
              >
                {n} {domain}
              </span>
            ))}
            {followups > 0 && (
              <span className="rounded-full border border-brand-300 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-900">
                {followups} linked as follow-up (de-duplicated)
              </span>
            )}
          </>
        )}
        {showDetailLink && (
          <Link
            to={`/dashboard/notes/${encodeURIComponent(noteId)}`}
            className="ml-auto text-sm font-medium text-brand-700 underline"
          >
            Open note detail
          </Link>
        )}
      </div>

      {escalation ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
          <TierChip tier={escalation.tier} />
          <span className="text-slate-800">
            Escalation created
            {escalation.acked_at ? " (acknowledged)" : " (not yet acknowledged)"}
          </span>
          {reasons.length > 0 && (
            <ul className="w-full list-disc pl-5 text-xs text-slate-700">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <Link to="/dashboard/escalations" className="text-xs text-brand-700 underline">
            View escalations
          </Link>
        </div>
      ) : (
        <div className="text-sm text-slate-600">
          <TierChip tier={0} short className="mr-2" />
          No escalation: no urgent or emergency red flag in this note.
        </div>
      )}

      {saeClock && <SaeClockLine clock={saeClock} />}
    </div>
  );
}
