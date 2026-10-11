import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  /** Right-aligned header slot (badges, actions). */
  aside?: ReactNode;
  /** Remove inner padding (for tables). */
  flush?: boolean;
  children: ReactNode;
}

/** Opaque data surface (never glass): `bg-surface`, hairline border, panel radius. */
export function Card({ title, aside, flush, className, children, ...rest }: CardProps) {
  return (
    <section className={cn("rounded-panel border border-border bg-surface", className)} {...rest}>
      {(title || aside) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          {title ? <h2 className="text-title font-semibold text-foreground">{title}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className={flush ? "" : "p-3"}>{children}</div>
    </section>
  );
}
