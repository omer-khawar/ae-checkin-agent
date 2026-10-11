/**
 * KioskProgress: one counter, "Question 3 of 13", over a thin segmented bar.
 *
 * Adapted from "Progress Bar Stepper" by sean0205
 * (https://21st.dev/@sean0205/components/c-stepper-11, 21st.dev demo 29801). Kept: a row of
 * thin rounded segments, filled with the accent up to the current step, muted after it.
 * Removed: the step titles, the tablist/tab triggers and click-to-jump (the kiosk is a
 * linear flow; jumping between questions is not allowed, audit K-20), the context
 * provider and the stepper panels. Added: one visible counter and a single
 * role="progressbar" for assistive tech; the segments are decorative.
 *
 * Audit rules (UI_AUDIT.md K-25, K-09, K-26):
 * - One counter at 18px / 600 (`text-k-helper font-semibold`), sentence case, tabular
 *   figures so "9 of 13" -> "10 of 13" does not shift the layout.
 * - An 8px bar (`h-2`): track `bg-border`, fill `bg-primary`. Height is fixed and the
 *   segments are discrete, so nothing jumps or animates between steps.
 * - "Question N of M" is announced politely when it changes (`announce`, default on).
 *   Turn it off if the page already announces the step another way.
 * - Above `maxSegments` steps the bar is one continuous track (segments get too thin).
 */
import { type HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export interface KioskProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** 1-based current step. Clamped to 1..total. */
  current: number;
  total: number;
  /** Counter wording; defaults to "Question {current} of {total}". */
  formatLabel?: (current: number, total: number) => string;
  /** Announce the counter politely when it changes (aria-live). Default true. */
  announce?: boolean;
  /** Draw one segment per step up to this many steps; beyond it, a continuous bar. */
  maxSegments?: number;
}

const defaultLabel = (current: number, total: number) => `Question ${current} of ${total}`;

export function KioskProgress({
  current,
  total,
  formatLabel = defaultLabel,
  announce = true,
  maxSegments = 20,
  className,
  ...props
}: KioskProgressProps) {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeCurrent = Math.min(safeTotal, Math.max(1, Math.floor(current)));
  const label = formatLabel(safeCurrent, safeTotal);
  const segmented = safeTotal <= maxSegments;
  const percent = (safeCurrent / safeTotal) * 100;

  return (
    <div
      data-slot="kiosk-progress"
      className={cn("flex w-full flex-col gap-2", className)}
      {...props}
    >
      <p
        className="tabular m-0 text-k-helper font-semibold text-muted-foreground"
        aria-live={announce ? "polite" : undefined}
        aria-atomic={announce ? true : undefined}
      >
        {label}
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={1}
        aria-valuemax={safeTotal}
        aria-valuenow={safeCurrent}
        aria-valuetext={label}
        className="flex h-2 w-full gap-1"
      >
        {segmented ? (
          Array.from({ length: safeTotal }, (_, i) => (
            <span
              key={i}
              aria-hidden="true"
              data-state={i + 1 <= safeCurrent ? "complete" : "pending"}
              className={cn(
                "h-full flex-1 rounded-full",
                i + 1 <= safeCurrent ? "bg-primary" : "bg-border",
              )}
            />
          ))
        ) : (
          <span
            aria-hidden="true"
            className="relative h-full w-full overflow-hidden rounded-full bg-border"
          >
            <span
              data-slot="kiosk-progress-fill"
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${percent}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}
