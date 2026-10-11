/**
 * Opaque data panel for the packet page (design-system data surface: flat,
 * hairline border, no glass). Same API as the shared Card so call sites stay
 * the same; the heading is an h2 at the console title size.
 */
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  aside?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}

export function Panel({ title, aside, flush, className, children, ...rest }: PanelProps) {
  return (
    <section className={cn("rounded-panel border border-border bg-surface", className)} {...rest}>
      {(title || aside) && (
        <header className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-3 py-2">
          {title ? <h2 className="text-title font-semibold text-foreground">{title}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className={flush ? "" : "p-3"}>{children}</div>
    </section>
  );
}
