import { cx } from "../lib/format";

export interface ProgressBarProps {
  /** Completed steps. */
  value: number;
  /** Total steps. */
  max: number;
  /** Accessible label, e.g. "Check-in progress". */
  label: string;
  /** Show "3 of 13" text next to the bar. */
  showText?: boolean;
  className?: string;
}

export function ProgressBar({ value, max, label, showText = true, className }: ProgressBarProps) {
  const safeMax = Math.max(1, max);
  const clamped = Math.min(safeMax, Math.max(0, value));
  const pct = Math.round((clamped / safeMax) * 100);
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={`${clamped} of ${safeMax}`}
        className="h-3 flex-1 overflow-hidden rounded-full bg-slate-200"
      >
        <div
          className="h-full rounded-full bg-brand-600 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      {showText && (
        <span className="tnum shrink-0 text-base text-slate-600">
          {clamped} of {safeMax}
        </span>
      )}
    </div>
  );
}
