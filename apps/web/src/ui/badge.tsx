/**
 * Badge: the semantic status chip (tier, SAE, AESI, measured/simulated, draft state,
 * query severity/status, UI feedback). Every badge renders a Lucide icon AND a word;
 * colour is the third cue, never the only one.
 *
 * Adapted from "Badge" by coss.com (https://21st.dev/community/components/coss.com/coss-badge,
 * 21st.dev demo 11356, "With Icon"). We kept the cva size/variant split, the icon-inside
 * sizing rule and the `data-slot` convention. We changed:
 *   - variants are SEMANTIC kinds from `badge-kinds.ts` (icon + word built in) instead of
 *     free-form colours, so a caller cannot ship a colour-only chip;
 *   - colours come only from our status token families (`bg-{tone}-bg` etc.), no `/8`
 *     opacity tints, no dark-mode block (light only, DECISIONS D-006);
 *   - text never below 12px (`text-caption`; the original went to 10px);
 *   - Base UI `useRender` polymorphism removed: a badge is static text. A clickable chip
 *     is a <Button> (or a link) that contains a <Badge>, so focus and role stay honest;
 *   - no transition (the original animated box-shadow).
 *
 * Figures: only `detail` (countdowns, source names) uses tabular figures; the word keeps
 * proportional punctuation so "Check-in" or "P-007" do not render with widened hyphens.
 *
 * Accessibility: the icon is aria-hidden; the word is real text. With `short` the dense
 * word (e.g. "T2") is visible and the full meaning ("Tier 2: Nurse call today.") is
 * announced instead via an sr-only span. The full meaning is also the hover title.
 */
import * as React from "react";

import { cn } from "@/lib/cn";

import { BADGE_KINDS, type BadgeKind, type BadgeTone } from "./badge-kinds";

/** Literal class strings (Tailwind's content scanner needs them spelled out). */
const TONE_CLASSES: Record<BadgeTone, string> = {
  "tier-0": "border-tier-0-border bg-tier-0-bg text-tier-0-fg",
  "tier-1": "border-tier-1-border bg-tier-1-bg text-tier-1-fg",
  // T2 gets a 2px border (audit): one more shape cue between amber and orange.
  "tier-2": "border-2 border-tier-2-border bg-tier-2-bg text-tier-2-fg",
  // T3 is solid red with white text (6.47:1).
  "tier-3": "border-tier-3-border bg-tier-3-bg text-tier-3-fg font-semibold",
  measured: "border-measured-border bg-measured-bg text-measured-fg",
  simulated: "border-simulated-border bg-simulated-bg text-simulated-fg",
  sae: "border-sae-border bg-sae-bg text-sae-fg",
  aesi: "border-aesi-border bg-aesi-bg text-aesi-fg",
  neutral: "border-neutral-border bg-neutral-bg text-neutral-fg",
  info: "border-info-border bg-info-bg text-info-fg",
  success: "border-success-border bg-success-bg text-success-fg",
  warning: "border-warning-border bg-warning-bg text-warning-fg",
  danger: "border-danger-border bg-danger-bg text-danger-fg",
};

const SIZE_CLASSES = {
  /** Dense console tables (36px rows): 20px tall, 12px text, 12px icon. */
  sm: "h-5 gap-1 px-1.5 text-caption [&_svg]:size-3",
  /** Console default: 24px tall, 12px text, 14px icon. */
  md: "h-6 gap-1.5 px-2 text-caption [&_svg]:size-3.5",
  /** Kiosk (measured/simulated only): 16px text, 18px icon. */
  lg: "min-h-8 gap-2 px-3 py-1 text-k-disclaimer [&_svg]:size-[1.125em]",
} as const;

export type BadgeSize = keyof typeof SIZE_CLASSES;

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** What the badge means. Drives tone, icon and word. */
  kind: BadgeKind;
  size?: BadgeSize;
  /** Show the dense word (e.g. "T2", "SAE") when the kind has one. */
  short?: boolean;
  /** Replace the word (e.g. "Simulated · ignored for rules"). Empty strings are ignored. */
  label?: string;
  /** Extra text after the word, e.g. a countdown "20:35" or a source name "mock". Tabular figures. */
  detail?: React.ReactNode;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { kind, size = "md", short = false, label, detail, className, title, ...props },
  ref,
) {
  const spec = BADGE_KINDS[kind];
  const Icon = spec.icon;
  const word = label && label.trim() ? label : spec.label;
  const shortWord = "short" in spec && !label ? spec.short : undefined;
  const showShort = short && shortWord !== undefined;
  const uppercase = "uppercase" in spec && spec.uppercase;

  return (
    <span
      ref={ref}
      data-slot="badge"
      data-kind={kind}
      title={title ?? spec.description}
      className={cn(
        "inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-control border font-medium leading-none",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        SIZE_CLASSES[size],
        TONE_CLASSES[spec.tone],
        uppercase && "uppercase tracking-wide",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" focusable="false" strokeWidth={2} />
      {showShort ? (
        <>
          <span aria-hidden="true">{shortWord}</span>
          <span className="sr-only">{spec.description}</span>
        </>
      ) : (
        <span>{word}</span>
      )}
      {detail !== undefined && detail !== null && detail !== "" ? (
        <span
          data-slot="badge-detail"
          className="tabular font-semibold normal-case tracking-normal"
        >
          {detail}
        </span>
      ) : null}
    </span>
  );
});
