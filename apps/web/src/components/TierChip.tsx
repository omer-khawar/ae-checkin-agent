/**
 * Escalation tier chip: wrapper over `@/ui/badge`. Dashboard only; the kiosk never renders
 * a tier. The explicit tier name is the word (Log / Review within 1 business day / Nurse
 * call today / Urgent); `data-tier` stays for tests and styling hooks.
 */
import { Badge } from "@/ui/badge";
import { tierBadgeKind } from "@/ui/badge-kinds";

import { tierStyle } from "../lib/format";

export interface TierChipProps {
  tier: number | null | undefined;
  /** Use the shorter label (dense tables). */
  short?: boolean;
  className?: string;
}

export function TierChip({ tier, short, className }: TierChipProps) {
  const t = tierStyle(tier);
  const kind = tierBadgeKind(tier) ?? "neutral";
  return (
    <Badge
      kind={kind}
      label={short ? t.short : t.name}
      title={`Tier ${t.tier}: ${t.name}`}
      data-tier={t.tier}
      className={className}
    />
  );
}
