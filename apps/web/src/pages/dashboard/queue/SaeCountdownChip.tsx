/**
 * Live 24-hour report-clock chip for a queue row (CLAUDE.md §3.4(f), §00.1;
 * CONTRACTS R3.2).
 *
 * Three kinds of clock share this chip:
 * - `sae`     → "Serious event — report due in hh:mm" (protocol §9.4.2, p. 91:
 *   every serious adverse event is reported within 24 hours of site awareness).
 * - `aesi`    → "Special-interest event — report due in hh:mm" (protocol §9.4.3,
 *   p. 92: adverse events of special interest follow the same 24-hour rule;
 *   Interim's AESI is "possible, investigator to confirm").
 * - `unknown` → "24-hour report — due in hh:mm" with no SAE/AESI badge: the API
 *   did not say which kind, and guessing would put a false regulatory label on
 *   screen.
 *
 * Plain language leads; the regulatory abbreviation (SAE / AESI) sits in a
 * small monospace badge inside the chip and in the hover text, one step deeper.
 * The chip turns red under 2 h or when overdue and reads "clock stopped" once an
 * investigator records a decision.
 *
 * One click from the clock to its report packet (§00.2): with a `packetId` the
 * chip links to /dashboard/packets/:packetId; with only a `clockId` it links to
 * /dashboard/packets/new?clock=:clockId, which creates (or opens) the packet
 * for that clock (POST /packets {clock_id}) and then shows it.
 *
 * Accessibility: the visible text stays readable to assistive technology; only
 * the terse "23:14" is hidden from it and replaced by a spoken "23 hours 14
 * minutes" in an sr-only span (no aria-label on a generic span, which screen
 * readers ignore). `now` comes from the page's single `useNow()` so every chip
 * ticks together.
 */
import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import { cx, formatUtc } from "../../../lib/format";
import { plainRemaining, saeState } from "./countdown";
import { packetHref } from "./normalize";
import type { ClockKind } from "./types";

export interface SaeCountdownChipProps {
  dueAt: string | null;
  stopped: boolean;
  stoppedAt?: string | null;
  now: number;
  /** Serious event (default), special-interest event, or not reported by the API. */
  kind?: ClockKind;
  /** When set, the chip links to /dashboard/packets/:packetId. */
  packetId?: string | null;
  /** When set without a packet, the chip links to the create-or-open packet route. */
  clockId?: string | null;
  className?: string;
}

const BASE =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold";

/** Plain name first, abbreviation and protocol reference for the hover. */
const CLOCK_KIND_TEXT: Record<ClockKind, { plain: string; abbr: string | null; intro: string }> = {
  sae: {
    plain: "Serious event",
    abbr: "SAE",
    intro:
      "SAE (serious adverse event): report to the sponsor within 24 hours of site awareness (protocol §9.4.2, p. 91).",
  },
  aesi: {
    plain: "Special-interest event",
    abbr: "AESI",
    intro:
      "AESI (possible adverse event of special interest, investigator to confirm): report to the sponsor within 24 hours of site awareness (protocol §9.4.3, p. 92).",
  },
  unknown: {
    plain: "24-hour report",
    abbr: null,
    intro:
      "A 24-hour sponsor report clock is running. The server did not say whether it is for a serious event (SAE) or a special-interest event (AESI); open the item to see.",
  },
};

function KindBadge({ abbr }: { abbr: string | null }) {
  if (!abbr) return null;
  return (
    <span
      aria-hidden="true"
      className="rounded bg-white/60 px-1 font-mono text-[10px] font-medium leading-4 opacity-80"
    >
      {abbr}
    </span>
  );
}

export function SaeCountdownChip({
  dueAt,
  stopped,
  stoppedAt,
  now,
  kind = "sae",
  packetId,
  clockId,
  className,
}: SaeCountdownChipProps) {
  const k = CLOCK_KIND_TEXT[kind];
  const state = saeState(dueAt, stopped, now);
  const intro = k.intro;

  let chip: ReactElement;
  if (state.kind === "stopped") {
    chip = (
      <span
        className={cx(BASE, "border-green-300 bg-green-100 text-green-800", className)}
        title={`${intro} Clock stopped by an investigator's decision${
          stoppedAt ? ` at ${formatUtc(stoppedAt)} (UTC)` : ""
        }.`}
        data-sae="stopped"
        data-clock-kind={kind}
      >
        {k.plain} — clock stopped
        <KindBadge abbr={k.abbr} />
      </span>
    );
  } else if (state.kind === "unknown") {
    chip = (
      <span
        className={cx(BASE, "border-slate-300 bg-slate-100 text-slate-800", className)}
        title={`${intro} A clock is running but the API did not send its due time.`}
        data-sae="unknown"
        data-clock-kind={kind}
      >
        {k.plain} — report clock running
        <KindBadge abbr={k.abbr} />
      </span>
    );
  } else {
    const r = plainRemaining(state.remainingMs);
    const urgent = state.urgent || state.overdue;
    const dueUtc = formatUtc(dueAt);
    const title = state.overdue
      ? `${intro} Overdue: the window closed at ${dueUtc} (UTC).`
      : `${intro} Window closes at ${dueUtc} (UTC). Red under 2 h. Stops when an investigator records a decision.`;
    // "24-hour report — due in" reads better than "24-hour report — report due in".
    const phrase =
      kind === "unknown"
        ? state.overdue
          ? "overdue by"
          : "due in"
        : state.overdue
          ? "report overdue by"
          : "report due in";
    chip = (
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
        data-clock-kind={kind}
      >
        <span aria-hidden="true">
          {k.plain} — {phrase} <span className="tnum">{r.text}</span>
        </span>
        <span className="sr-only">{`${k.plain}: ${phrase} ${r.spoken}`}</span>
        <KindBadge abbr={k.abbr} />
      </span>
    );
  }

  const href = packetHref(packetId, clockId);
  if (!href) return chip;
  return (
    <Link
      to={href}
      className="rounded-full focus-visible:outline-none focus-visible:ring-4"
      title={
        packetId
          ? `Open the ${k.plain.toLowerCase()} report packet`
          : `Open a pre-filled ${k.plain.toLowerCase()} report packet for this clock`
      }
    >
      {chip}
    </Link>
  );
}
