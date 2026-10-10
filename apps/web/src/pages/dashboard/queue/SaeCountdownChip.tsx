/**
 * Live SAE-clock chip for a queue row (CLAUDE.md §3.4(f)).
 *
 * The 24 h site-to-sponsor obligation counts down from `sae_due_at`; the chip
 * turns red under 2 h or when overdue, and reads "stopped" once an investigator
 * has recorded a seriousness decision. `now` comes from the page's single
 * `useNow()` so every chip ticks together.
 */
import { cx, formatUtc } from "../../../lib/format";
import { formatRemaining, saeState } from "./countdown";

export interface SaeCountdownChipProps {
  dueAt: string | null;
  stopped: boolean;
  stoppedAt?: string | null;
  now: number;
  className?: string;
}

const BASE =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold";

export function SaeCountdownChip({
  dueAt,
  stopped,
  stoppedAt,
  now,
  className,
}: SaeCountdownChipProps) {
  const state = saeState(dueAt, stopped, now);

  if (state.kind === "stopped") {
    return (
      <span
        className={cx(BASE, "border-green-300 bg-green-100 text-green-800", className)}
        title={`SAE clock stopped by an investigator's seriousness decision${
          stoppedAt ? ` at ${formatUtc(stoppedAt)} (UTC)` : ""
        }`}
        data-sae="stopped"
      >
        SAE clock stopped
      </span>
    );
  }

  if (state.kind === "unknown") {
    return (
      <span
        className={cx(BASE, "border-slate-300 bg-slate-100 text-slate-800", className)}
        title="An SAE clock is running for this check-in but the API did not send its due time"
        data-sae="unknown"
      >
        SAE clock running
      </span>
    );
  }

  const r = formatRemaining(state.remainingMs);
  const urgent = state.urgent || state.overdue;
  const dueUtc = formatUtc(dueAt);
  const title = state.overdue
    ? `SAE report overdue: the 24 h site-to-sponsor window closed at ${dueUtc} (UTC)`
    : `SAE 24 h site-to-sponsor window closes at ${dueUtc} (UTC). Red under 2 h. Stops when an investigator records a seriousness decision.`;

  return (
    <span
      className={cx(
        BASE,
        urgent
          ? "border-red-700 bg-red-600 text-white"
          : "border-amber-300 bg-amber-100 text-amber-900",
        className,
      )}
      title={title}
      data-sae={state.overdue ? "overdue" : urgent ? "urgent" : "running"}
      aria-label={
        state.overdue
          ? `SAE report overdue by ${r.text} ${r.unit}`
          : `SAE report due in ${r.text} ${r.unit}`
      }
    >
      <span aria-hidden="true">SAE</span>
      <span className="tnum" aria-hidden="true">
        {r.overdue ? `overdue ${r.text}` : r.text}
      </span>
      <span className="font-normal opacity-80" aria-hidden="true">
        {r.unit}
        {r.overdue ? "" : " left"}
      </span>
    </span>
  );
}
