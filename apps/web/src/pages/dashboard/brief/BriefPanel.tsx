/**
 * Flat, opaque panel for the brief (data surfaces are never glass). Same props as the shared
 * `Card` the brief used before the UI revamp; compact 36px header, token colors, and
 * print-safe (no shadow, never split across pages).
 */
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface BriefPanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** Right-aligned header slot (counts, badges). */
  aside?: ReactNode;
  /** Remove inner padding (for lists that bring their own). */
  flush?: boolean;
  children: ReactNode;
}

export function BriefPanel({ title, aside, flush, className, children, ...rest }: BriefPanelProps) {
  return (
    <section
      className={cn("rounded-panel border border-border bg-surface print:shadow-none", className)}
      {...rest}
    >
      {(title || aside) && (
        <header className="flex min-h-row items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          {title ? <h2 className="text-body font-semibold text-foreground">{title}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className={flush ? "" : "p-3"}>{children}</div>
    </section>
  );
}
