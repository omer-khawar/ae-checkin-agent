/**
 * Small private building blocks for the landing page.
 *
 * TODO(ui-revamp): swap GlassPanel / ButtonLink for `@/ui/glass-card` and
 * `@/ui/button` once the phase-1 design system lands; these exist so the landing
 * page does not depend on files another workflow is still writing.
 */
import { cn } from "@/lib/cn";
import { ArrowUpRight } from "lucide-react";
import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";

/** Frosted card: `.glass-strong` (92% fill) so teal link text stays >= 4.5:1 on it (src/ui/README.md). */
export function GlassPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("glass-strong rounded-sheet", className)} {...props} />;
}

type ButtonVariant = "primary" | "secondary";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-semibold motion-safe:transition-colors";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // primary-foreground on primary: 5.47:1 (AA); on primary-strong 7.58:1.
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary-strong",
  secondary:
    "border border-border-strong bg-surface text-foreground shadow-sm hover:bg-surface-subtle",
};

const BUTTON_SIZE = {
  sm: "min-h-9 px-4 text-sm",
  lg: "min-h-12 px-6 text-base",
} as const;

export function ButtonLink({
  to,
  variant = "primary",
  size = "lg",
  className,
  children,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZE;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
    >
      {children}
    </Link>
  );
}

/** Link that leaves the app: new tab, no referrer, and says so to screen readers. */
export function ExternalLink({
  href,
  children,
  className,
  icon = true,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; icon?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "font-medium text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary",
        className,
      )}
      {...rest}
    >
      {children}
      {icon && (
        <ArrowUpRight aria-hidden="true" className="ml-0.5 inline h-3.5 w-3.5 align-[-2px]" />
      )}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Eyebrow + heading + optional intro, shared by every section. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  intro,
  align = "left",
}: {
  id: string;
  eyebrow: string;
  title: string;
  intro?: string;
  align?: "left" | "center";
}) {
  return (
    <div
      className={cn("flex max-w-3xl flex-col gap-3", align === "center" && "mx-auto text-center")}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
      <h2
        id={id}
        className="text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
      >
        {title}
      </h2>
      {intro && (
        <p className="text-pretty text-lg leading-relaxed text-muted-foreground">{intro}</p>
      )}
    </div>
  );
}
