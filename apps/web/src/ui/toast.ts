/**
 * `notify()`: fire a toast into the global `<Toaster />` (src/ui/toaster.tsx).
 *
 * Kept in a .ts file without components so React Fast Refresh keeps working for toaster.tsx.
 * Usage pattern adapted from "Sonner Toast" by bundui
 * (https://21st.dev/community/components/bundui/toast1): title + description + Undo action.
 *
 *   notify.success("Draft confirmed", { description: "AE 3 · Dyspnea, grade 2 (provisional)" });
 *   notify.warning("Draft rejected", { undo: () => api.reopenDraft(id) });
 *   notify.danger("Export failed", { description: problem.detail });   // stays until dismissed
 *
 * Durations: success 5 s, info 6 s, warning 8 s, danger until dismissed; any toast with an
 * action or Undo lasts at least 10 s. Sonner pauses the timer while hovered or focused.
 */
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";

import { ToastCard, type ToastTone } from "@/ui/toaster";

export type { ToastTone };

export interface NotifyOptions {
  description?: ReactNode;
  /** Shows an "Undo" button; runs this, then dismisses the toast. */
  undo?: () => void;
  /** Label of the undo button. */
  undoLabel?: string;
  /** A different single action (ignored when `undo` is set). */
  action?: { label: string; onClick: () => void };
  /** Milliseconds; `Infinity` keeps the toast until dismissed. */
  duration?: number;
  /** Reuse an id to update a toast in place instead of stacking a new one. */
  id?: string | number;
  /** Show the close button (default true). */
  dismissible?: boolean;
}

export const TOAST_DURATION: Record<ToastTone, number> = {
  success: 5000,
  info: 6000,
  warning: 8000,
  danger: Number.POSITIVE_INFINITY,
};

/** Minimum time on screen for a toast that offers an action (WCAG 2.2.1). */
export const ACTION_MIN_DURATION = 10000;

function show(tone: ToastTone, title: ReactNode, options: NotifyOptions = {}): string | number {
  const { description, undo, undoLabel = "Undo", action, id, dismissible = true } = options;
  const resolvedAction = undo ? { label: undoLabel, onClick: undo } : action;
  const base = options.duration ?? TOAST_DURATION[tone];
  const duration = resolvedAction ? Math.max(base, ACTION_MIN_DURATION) : base;

  return toast.custom(
    (toastId) =>
      createElement(ToastCard, {
        tone,
        title,
        description,
        action: resolvedAction
          ? {
              label: resolvedAction.label,
              onClick: () => {
                resolvedAction.onClick();
                toast.dismiss(toastId);
              },
            }
          : undefined,
        onDismiss: dismissible ? () => toast.dismiss(toastId) : undefined,
      }),
    // Only pass `id` when set: sonner 1.7 spreads these options after its generated id, so
    // `id: undefined` would erase it and the toast could never be dismissed.
    id === undefined ? { duration } : { duration, id },
  );
}

type Notify = ((tone: ToastTone, title: ReactNode, options?: NotifyOptions) => string | number) & {
  success: (title: ReactNode, options?: NotifyOptions) => string | number;
  info: (title: ReactNode, options?: NotifyOptions) => string | number;
  warning: (title: ReactNode, options?: NotifyOptions) => string | number;
  danger: (title: ReactNode, options?: NotifyOptions) => string | number;
  dismiss: (id?: string | number) => void;
};

export const notify: Notify = Object.assign(show, {
  success: (title: ReactNode, options?: NotifyOptions) => show("success", title, options),
  info: (title: ReactNode, options?: NotifyOptions) => show("info", title, options),
  warning: (title: ReactNode, options?: NotifyOptions) => show("warning", title, options),
  danger: (title: ReactNode, options?: NotifyOptions) => show("danger", title, options),
  dismiss: (id?: string | number) => {
    toast.dismiss(id);
  },
});
