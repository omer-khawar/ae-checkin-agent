/**
 * Toaster + ToastCard: global, polite notifications (audit G-13 "a global aria-live toast",
 * D-06/undo for reversible actions such as Reject or Acknowledge).
 *
 * Adapted from "Sonner Toast" by bundui (https://21st.dev/community/components/bundui/toast1,
 * 21st.dev demo 19941): a sonner toast with a title, a description and an "Undo" action. We
 * kept sonner and that content model (title, description, one action, Undo). We changed:
 * - Rendering: every toast is our own `ToastCard` (via `toast.custom`, see `src/ui/toast.ts`),
 *   so the markup, buttons and focus ring are ours. The card is frosted `.glass-strong`
 *   chrome (92% fill: teal and muted text stay >= 4.5:1), `rounded-sheet`, elevation 2.
 * - Tone: success / info / warning / danger, each with its Lucide icon in a tinted circle and
 *   a screen-reader tone word ("Warning:") before the title, so colour is never the only cue.
 *   These tones are UI feedback only (README), never clinical status.
 * - Motion: sonner's slide/stack transforms are neutralised; toasts fade in/out in 200ms
 *   (opacity only) and sonner's own reduced-motion rule turns that off. `expand` is on so
 *   toasts never collapse into an animated pile.
 * - Accessibility: sonner's container is the live region (`aria-live="polite"`, labelled
 *   "Notifications", Alt+T moves focus to it). Timers pause on hover/focus; danger toasts stay
 *   until dismissed; Undo toasts last at least 10 s (WCAG 2.2.1).
 *
 * - Placement: bottom-LEFT by default. Side sheets open on the right, so toasts never cover a
 *   sheet's footer actions ("Close", "Confirm draft"). While a modal sheet is open, toasts stay
 *   clickable and keyboard-reachable (Alt+T): see the toast pass-through in `@/ui/sheet`.
 *   On the kiosk pass `position="top-center"` so toasts never sit on the action bar.
 *
 * Mount `<Toaster />` once near the root (console and kiosk shells). Fire toasts with
 * `notify(...)` from `@/ui/toast`.
 */
import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type * as React from "react";
import { Toaster as SonnerToaster, type ToasterProps as SonnerToasterProps } from "sonner";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

export type ToastTone = "success" | "info" | "warning" | "danger";

const TONE: Record<ToastTone, { word: string; icon: LucideIcon; chip: string }> = {
  success: { word: "Success", icon: CircleCheck, chip: "bg-success-bg text-success-fg" },
  info: { word: "Info", icon: Info, chip: "bg-info-bg text-info-fg" },
  warning: { word: "Warning", icon: TriangleAlert, chip: "bg-warning-bg text-warning-fg" },
  danger: { word: "Error", icon: CircleX, chip: "bg-danger-bg text-danger-fg" },
};

export interface ToastCardProps {
  tone: ToastTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** One action button (e.g. "Undo", "Open"). */
  action?: { label: string; onClick: () => void };
  /** Dismiss handler for the close button; omit to hide the button. */
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}

/** The visual toast. Exported so pages and tests can render it inline (e.g. in a story). */
export function ToastCard({
  tone,
  title,
  description,
  action,
  onDismiss,
  dismissLabel = "Dismiss notification",
  className,
}: ToastCardProps) {
  const { word, icon: Icon, chip } = TONE[tone];
  return (
    <div
      data-slot="toast"
      data-tone={tone}
      className={cn(
        "glass-strong flex w-full items-start gap-3 rounded-sheet p-3 font-sans text-body shadow-elev-2",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full",
          chip,
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="font-semibold text-foreground">
          <span className="sr-only">{`${word}: `}</span>
          {title}
        </p>
        {description ? <p className="mt-0.5 text-muted-foreground">{description}</p> : null}
      </div>
      {action ? (
        <Button size="sm" variant="secondary" className="mt-px" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {onDismiss ? (
        <Button
          size="icon"
          variant="ghost"
          aria-label={dismissLabel}
          className="-my-1 -mr-1 size-7"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

export type ToasterProps = Omit<SonnerToasterProps, "theme" | "richColors" | "icons">;

/** Opacity-only, <= 200ms. Inline so it beats sonner's injected transform transitions. */
const CALM_TRANSITION: React.CSSProperties = {
  transition: "opacity var(--motion-max, 200ms) ease-out",
};

export function Toaster({
  position = "bottom-left",
  visibleToasts = 4,
  gap = 8,
  offset = 16,
  containerAriaLabel = "Notifications",
  toastOptions,
  ...props
}: ToasterProps) {
  return (
    <SonnerToaster
      theme="light"
      position={position}
      expand
      visibleToasts={visibleToasts}
      gap={gap}
      offset={offset}
      containerAriaLabel={containerAriaLabel}
      toastOptions={{
        unstyled: true,
        ...toastOptions,
        style: { ...CALM_TRANSITION, ...toastOptions?.style },
      }}
      {...props}
    />
  );
}
