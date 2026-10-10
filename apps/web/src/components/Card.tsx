import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../lib/format";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  /** Right-aligned header slot (badges, actions). */
  aside?: ReactNode;
  /** Remove inner padding (for tables). */
  flush?: boolean;
  children: ReactNode;
}

/** White surface with a slate border; the only container style in the app. */
export function Card({ title, aside, flush, className, children, ...rest }: CardProps) {
  return (
    <section
      className={cx("rounded-2xl border border-slate-200 bg-white shadow-card", className)}
      {...rest}
    >
      {(title || aside) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          {title ? <h2 className="text-base font-semibold text-slate-900">{title}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}
