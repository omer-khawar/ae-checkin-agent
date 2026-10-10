/**
 * MEASURED (green) / SIMULATED (violet). The word is always rendered as text so a
 * screenshot, a screen reader and a colour-blind judge all get the same answer.
 */
import { cx, MEASURED_STYLES, measuredLabel } from "../lib/format";

export interface MeasuredBadgeProps {
  isMeasured: boolean;
  /** Optional source name shown after the word, e.g. "mock". */
  source?: string | null;
  size?: "sm" | "md";
  className?: string;
}

export function MeasuredBadge({ isMeasured, source, size = "sm", className }: MeasuredBadgeProps) {
  const word = measuredLabel(isMeasured);
  const style = MEASURED_STYLES[word];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border font-bold uppercase tracking-wide",
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
        style.badgeClass,
        className,
      )}
      title={style.title}
      data-measured={isMeasured ? "true" : "false"}
    >
      <span>{word}</span>
      {source && <span className="font-mono font-normal normal-case opacity-80">{source}</span>}
    </span>
  );
}
