/**
 * HeaderMenu: a small disclosure popover for the app header (study chip, time-saved chip,
 * user menu, System menu). Disclosure pattern, not ARIA "menu": the trigger has
 * `aria-expanded`/`aria-controls`, Escape closes and returns focus to the trigger, a click
 * outside closes. The panel is opaque-ish (`glass-strong`) because it floats over data.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface HeaderMenuProps {
  /** Trigger content. */
  trigger: ReactNode;
  /** Accessible name of the trigger when the content is not text. */
  label?: string;
  /** Native tooltip on the trigger. */
  triggerTitle?: string;
  /** Accessible name of the panel. */
  panelLabel: string;
  align?: "left" | "right";
  triggerClassName?: string;
  panelClassName?: string;
  testId?: string;
  /** Receives `close` so items can dismiss the panel. */
  children: (close: () => void) => ReactNode;
}

export function HeaderMenu({
  trigger,
  label,
  triggerTitle,
  panelLabel,
  align = "right",
  triggerClassName,
  panelClassName,
  testId,
  children,
}: HeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative" data-testid={testId}>
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        title={triggerTitle}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "focus-ring transition-calm inline-flex h-8 items-center gap-1.5 rounded-control border border-transparent px-2 text-body text-foreground hover:bg-accent",
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="region"
          aria-label={panelLabel}
          className={cn(
            "glass-strong absolute top-full z-50 mt-2 w-72 rounded-sheet p-2 text-body text-foreground shadow-elev-2",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** A full-width row inside a HeaderMenu panel. */
export function MenuRow({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "focus-ring transition-calm flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-body hover:bg-accent",
        className,
      )}
      {...props}
    />
  );
}
