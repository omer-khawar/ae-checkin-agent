/**
 * Escalation tier chip. Dashboard only: the kiosk never renders a tier.
 */
import { cx, tierStyle } from "../lib/format";

export interface TierChipProps {
  tier: number | null | undefined;
  /** Use the shorter label (dense tables). */
  short?: boolean;
  className?: string;
}

export function TierChip({ tier, short, className }: TierChipProps) {
  const t = tierStyle(tier);
  const label = short ? t.short : t.name;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        t.chipClass,
        className,
      )}
      title={`Tier ${t.tier}: ${t.name}`}
      data-tier={t.tier}
    >
      <span className="tnum">T{t.tier}</span>
      <span aria-hidden="true">·</span>
      <span>{label}</span>
    </span>
  );
}
