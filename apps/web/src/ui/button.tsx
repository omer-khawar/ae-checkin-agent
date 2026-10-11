/**
 * Button: the one action control for the console and the kiosk.
 *
 * Adapted from "Glass Button" by jahed (https://21st.dev/community/components/jahed/glass-button,
 * 21st.dev demo 4922). We kept the idea of a frosted, light-edged button and the cva
 * variant/size split. We removed everything decorative: the animated conic border
 * (@property angle transitions), the 3D rotateX press, the scale-on-hover, the
 * text-shadow sheen and the injected <style> block. The glass look now comes from our
 * `.glass-strong` utility (token-driven, solid fallback without backdrop-filter).
 *
 * Variants (README "Tailwind names"):
 * - `primary`   solid teal, white text (5.47:1 console, 7.58:1 kiosk).
 * - `secondary` opaque white with a 3:1 control border.
 * - `ghost`     no fill until hover; for toolbars and table rows.
 * - `danger`    OUTLINE danger (audit D-06: Reject must not look like Confirm).
 * - `destructive` solid danger, for the second, confirming tap only.
 * - `glass`     frosted chrome (app header, kiosk action bar). Uses .glass-strong so
 *               even teal text stays >= 4.5:1 over anything beneath.
 *
 * Sizes: console `sm` 28px / `md` 32px / `icon` 32x32 (audit G-09: console controls
 * 28-32px); kiosk `xl` >= 64px (`min-h-k-option`) with the kiosk answer type size.
 * Kiosk `xl` compound rules (audit K-03, merged from the former kiosk/kiosk-button.tsx):
 * `primary` + `xl` (Next) is 72px tall and at least 200px wide; `secondary` + `xl`
 * (Back) keeps 64px, gets a 2px control border like the answer options, min 160px.
 *
 * Accessibility: native <button type="button"> by default (no accidental form submit),
 * the global focus-visible ring token, `aria-busy` + disabled while `loading`, and an
 * icon-only size that REQUIRES an `aria-label` at the type level. `asChild` renders the
 * styles onto a child element (e.g. a router <Link>) via Radix Slot.
 *
 * Motion: colour/border/shadow only (`transition-calm`, <= 200ms); none under
 * prefers-reduced-motion (global rule in index.css). The loading spinner turns only
 * with `motion-safe:`.
 */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";

const buttonVariants = cva(
  [
    "focus-ring transition-calm relative inline-flex shrink-0 select-none items-center justify-center",
    "whitespace-nowrap rounded-control border font-medium",
    "disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary-strong active:bg-primary-strong",
        secondary:
          "border-input bg-surface text-foreground hover:bg-surface-subtle active:bg-surface-selected",
        ghost:
          "border-transparent bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
        danger:
          "border-destructive bg-surface text-destructive hover:bg-danger-bg active:bg-danger-bg",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-danger-fg",
        glass:
          "glass-strong text-foreground hover:[--glass-alpha-fallback:1] hover:[--glass-alpha-strong:1]",
      },
      size: {
        sm: "h-7 gap-1.5 px-2.5 text-caption [&_svg]:size-3.5",
        md: "h-8 gap-2 px-3 text-body [&_svg]:size-4",
        icon: "size-8 p-0 [&_svg]:size-4",
        xl: "min-h-k-option gap-3 px-7 py-3 text-k-answer font-semibold [&_svg]:size-6",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    compoundVariants: [
      // K-03: the kiosk primary action (Next) is the biggest target on the screen.
      { variant: "primary", size: "xl", className: "min-h-[72px] min-w-[200px] font-bold" },
      // K-03 / K-01: Back is 64px with the same 2px boundary as an answer option.
      {
        variant: "secondary",
        size: "xl",
        className: "min-w-[160px] border-2 hover:border-foreground",
      },
    ],
    defaultVariants: { variant: "secondary", size: "md", fullWidth: false },
  },
);

type ButtonVariantProps = VariantProps<typeof buttonVariants>;
export type ButtonVariant = NonNullable<ButtonVariantProps["variant"]>;
export type ButtonSize = NonNullable<ButtonVariantProps["size"]>;

type BaseProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  variant?: ButtonVariant;
  fullWidth?: boolean;
  /** Render the styles onto the single child element instead of a <button>. */
  asChild?: boolean;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
  /** Icon shown before the label (lucide-react element). Hidden from assistive tech. */
  leadingIcon?: React.ReactNode;
  /** Icon shown after the label. Hidden from assistive tech. */
  trailingIcon?: React.ReactNode;
};

/** An icon-only button has no visible word, so it must carry an accessible name. */
export type ButtonProps =
  | (BaseProps & { size: "icon"; "aria-label": string })
  | (BaseProps & { size?: Exclude<ButtonSize, "icon">; "aria-label"?: string });

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    fullWidth,
    asChild = false,
    loading = false,
    disabled,
    leadingIcon,
    trailingIcon,
    type,
    children,
    ...props
  },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size, fullWidth }), className);

  if (asChild) {
    // Slot needs exactly one child; icons and spinner are the child's business.
    return (
      <Slot ref={ref} className={classes} data-slot="button" {...props}>
        {children}
      </Slot>
    );
  }

  const lead = loading ? (
    <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
  ) : (
    leadingIcon
  );

  return (
    <button
      ref={ref}
      type={type ?? "button"}
      data-slot="button"
      data-variant={variant ?? "secondary"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {lead ? <IconSlot>{lead}</IconSlot> : null}
      {children}
      {trailingIcon ? <IconSlot>{trailingIcon}</IconSlot> : null}
    </button>
  );
});

/** Wraps a decorative icon so screen readers skip it even if the caller forgot aria-hidden. */
function IconSlot({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden="true" className="inline-flex">
      {children}
    </span>
  );
}
