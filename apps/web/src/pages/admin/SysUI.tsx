/**
 * Shared pieces for the system pages (Audit, Eval, Admin, Login): an opaque panel and a
 * Button adapter that keeps the legacy prop names (`busy`, `block`) on top of the
 * design-system button (src/ui/button.tsx). Data surfaces stay opaque; glass is for chrome.
 */
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Button as UiButton, type ButtonProps as UiButtonProps } from "@/ui/button";

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** Right-aligned header slot (badges, actions). */
  aside?: ReactNode;
  /** Remove inner padding (for tables). */
  flush?: boolean;
  children: ReactNode;
}

/** Opaque, flat, hairline-bordered surface for data and forms. */
export function Panel({ title, aside, flush, className, children, ...rest }: PanelProps) {
  return (
    <section
      className={cn("rounded-panel border border-border bg-surface text-foreground", className)}
      {...rest}
    >
      {(title || aside) && (
        <header className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-4 py-2">
          {title ? <h2 className="text-title font-semibold">{title}</h2> : <span />}
          {aside}
        </header>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

type LegacyVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive";
type LegacySize = "sm" | "md" | "lg" | "xl";

export type ButtonProps = Omit<UiButtonProps, "size" | "variant" | "loading" | "fullWidth"> & {
  variant?: LegacyVariant;
  size?: LegacySize;
  busy?: boolean;
  block?: boolean;
};

/** Console button: `lg`/`xl` collapse to `md` (console controls are 28-32px). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { size, busy, block, variant, ...rest },
  ref,
) {
  const s = size === "sm" ? "sm" : "md";
  return (
    <UiButton {...rest} ref={ref} size={s} variant={variant} loading={busy} fullWidth={block} />
  );
});

/** Page title block used by the system pages: 20px title, 13px helper line. */
export function PageHead({
  title,
  children,
  actions,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-page font-semibold text-foreground">{title}</h1>
        {children ? <p className="mt-0.5 text-table text-muted-foreground">{children}</p> : null}
      </div>
      {actions}
    </div>
  );
}
