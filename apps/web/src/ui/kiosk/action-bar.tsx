/**
 * KioskActionBar: the sticky glass bar at the bottom of every kiosk question screen.
 *
 * Built for Interim (no 21st.dev source). Uses the shared Button (`@/ui/button`, size
 * `xl`), whose kiosk compound variants carry the audit's sizes.
 *
 * Audit rules (UI_AUDIT.md K-03, K-19, design-system "Sizes"):
 * - Sticky to the bottom, 88px (`min-h-k-actionbar`) plus the safe-area inset, glass
 *   chrome (`.glass-strong`: kiosk text and the teal accent stay >= 4.5:1 over anything
 *   scrolling beneath; solid fallback without backdrop-filter).
 * - Back: secondary, 64px; hidden (not just disabled) on the first question.
 * - Next: primary #115E59, 72px tall, >= 200px wide, ALWAYS enabled by default. The page
 *   validates on tap and shows "Please choose an answer" next to the answers.
 * - The not-a-medical-device disclaimer lives in the bar, word for word.
 * - `position="static"` drops the stickiness, for short screens (< 500px tall, K-19).
 * - No motion beyond the Button's colour transition.
 * - Focus Not Obscured (WCAG 2.4.11): while sticky, the bar measures its own height
 *   (it wraps to ~98px+ at the larger text size) and publishes it as `--k-actionbar-live`
 *   on its scroll container and on <html>. index.css turns that into
 *   `scroll-padding-bottom` on the kiosk scroller (and on <html> for full-page kiosk
 *   routes), so focus moves and scrollIntoView stop above the bar.
 */
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from "react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

/** CLAUDE.md §3.8 footer text. Do not paraphrase. */
export const KIOSK_DISCLAIMER =
  "Interim is a research data-capture tool. It is not a medical device and does not provide medical advice.";

export interface KioskActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  onNext: () => void;
  /** When omitted, or when `showBack` is false, the Back button is not rendered. */
  onBack?: () => void;
  showBack?: boolean;
  nextLabel?: ReactNode;
  backLabel?: ReactNode;
  /** Shows a spinner on Next, sets aria-busy and blocks double taps while saving. */
  nextLoading?: boolean;
  /** The audit keeps Next enabled; use only for a hard block (e.g. offline). */
  nextDisabled?: boolean;
  /** Footer disclaimer; defaults to the verbatim text. Pass `null` to hide it. */
  disclaimer?: ReactNode;
  /** `sticky` (default) or `static` for short viewports. */
  position?: "sticky" | "static";
  /** Accessible name of the toolbar region. */
  label?: string;
}

export function KioskActionBar({
  onNext,
  onBack,
  showBack = true,
  nextLabel = "Next",
  backLabel = "Back",
  nextLoading = false,
  nextDisabled = false,
  disclaimer = KIOSK_DISCLAIMER,
  position = "sticky",
  label = "Question navigation",
  className,
  ...props
}: KioskActionBarProps) {
  const backVisible = showBack && typeof onBack === "function";
  const barRef = useRef<HTMLDivElement>(null);
  useActionBarClearance(barRef, position === "sticky");

  return (
    <div
      ref={barRef}
      role="region"
      aria-label={label}
      data-slot="kiosk-action-bar"
      data-position={position}
      className={cn(
        "glass-strong z-20 w-full rounded-t-sheet border-x-0 border-b-0",
        "pb-[env(safe-area-inset-bottom,0px)]",
        position === "sticky" ? "sticky bottom-0" : "static",
        className,
      )}
      {...props}
    >
      <div className="mx-auto flex min-h-k-actionbar w-full max-w-k-content flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        <p className="m-0 min-w-0 flex-1 basis-64 text-k-disclaimer text-muted-foreground">
          {disclaimer}
        </p>
        <div className="ml-auto flex items-center gap-4">
          {backVisible ? (
            <Button variant="secondary" size="xl" onClick={onBack} leadingIcon={<ArrowLeft />}>
              {backLabel}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="xl"
            onClick={onNext}
            loading={nextLoading}
            disabled={nextDisabled}
            trailingIcon={<ArrowRight />}
          >
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Nearest ancestor that scrolls vertically, or null when the document itself scrolls. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Publishes the bar's rendered height as `--k-actionbar-live` so index.css can reserve
 * `scroll-padding-bottom` for it. Cleans up on unmount or when the bar stops being sticky.
 */
function useActionBarClearance(ref: RefObject<HTMLDivElement>, active: boolean) {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!active || !bar) return undefined;
    const targets = [scrollParent(bar), document.documentElement].filter(
      (t): t is HTMLElement => t !== null,
    );
    const publish = () => {
      const h = `${Math.ceil(bar.getBoundingClientRect().height)}px`;
      for (const t of targets) t.style.setProperty("--k-actionbar-live", h);
    };
    publish();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(publish) : undefined;
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      for (const t of targets) t.style.removeProperty("--k-actionbar-live");
    };
  }, [ref, active]);
}
