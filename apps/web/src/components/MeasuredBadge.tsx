/**
 * MEASURED / SIMULATED: wrapper over `@/ui/badge`. The word is always rendered as text so a
 * screenshot, a screen reader and a colour-blind judge all get the same answer.
 */
import { Badge } from "@/ui/badge";

import { measuredLabel } from "../lib/format";

export interface MeasuredBadgeProps {
  isMeasured: boolean;
  /** Optional source name shown after the word, e.g. "mock". */
  source?: string | null;
  size?: "sm" | "md";
  className?: string;
}

export function MeasuredBadge({ isMeasured, source, size = "sm", className }: MeasuredBadgeProps) {
  return (
    <Badge
      kind={isMeasured ? "measured" : "simulated"}
      label={measuredLabel(isMeasured)}
      detail={
        source ? <span className="font-mono font-normal normal-case">{source}</span> : undefined
      }
      size={size}
      data-measured={isMeasured ? "true" : "false"}
      className={className}
    />
  );
}
