/**
 * Button with large tap targets. Kiosk screens use `size="xl"` (min 4.25rem high);
 * the dashboard uses `md`. Always a real <button> so keyboard users get Enter/Space.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cx } from "../lib/format";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "option";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  block?: boolean;
  /** For `variant="option"`: draws the selected state and sets aria-pressed. */
  selected?: boolean;
  /** Show a spinner-ish label and disable the button. */
  busy?: boolean;
  children: ReactNode;
}

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold border transition-colors duration-200 select-none " +
  "disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-4";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-700 text-white border-brand-800 hover:bg-brand-800 active:bg-brand-900",
  secondary: "bg-white text-slate-900 border-slate-300 hover:bg-slate-100 active:bg-slate-200",
  ghost: "bg-transparent text-slate-700 border-transparent hover:bg-slate-100 active:bg-slate-200",
  danger: "bg-red-600 text-white border-red-700 hover:bg-red-700 active:bg-red-800",
  option:
    "bg-white text-slate-900 border-slate-300 hover:border-brand-500 hover:bg-brand-50 active:bg-brand-100 text-left justify-start",
};

const OPTION_SELECTED = "!bg-brand-50 !border-brand-700 !text-brand-900 ring-2 ring-brand-700/40";

const SIZES: Record<ButtonSize, string> = {
  sm: "text-sm px-3 py-1.5 min-h-9",
  md: "text-base px-4 py-2 min-h-11",
  lg: "text-lg px-6 py-3 min-h-tap",
  xl: "text-xl px-7 py-4 min-h-tap-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    block,
    selected,
    busy,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  const isOption = variant === "option";
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cx(
        BASE,
        VARIANTS[variant],
        SIZES[size],
        block && "w-full",
        isOption && selected && OPTION_SELECTED,
        className,
      )}
      aria-pressed={isOption ? Boolean(selected) : undefined}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {busy && (
        <span
          aria-hidden="true"
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
});
