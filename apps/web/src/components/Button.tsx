/**
 * Legacy Button, now a thin wrapper over `@/ui/button` (UI phase 2). Names and props are
 * unchanged so pages keep compiling; new code should import `@/ui/button` directly.
 *
 * Mapping: primary/secondary/ghost pass through, `danger` is the OUTLINE danger (audit D-06),
 * `option` (kiosk answer tile) keeps its own token-based look, `busy` is `loading`.
 * Sizes: sm/md map to the console sizes, lg/xl to the kiosk-scale control.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Button as UiButton } from "@/ui/button";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "option";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  block?: boolean;
  /** For `variant="option"`: draws the selected state and sets aria-pressed. */
  selected?: boolean;
  /** Show a spinner and disable the button. */
  busy?: boolean;
  children: ReactNode;
}

const OPTION_BASE =
  "focus-ring transition-calm inline-flex items-center justify-start gap-2 rounded-control border-2 border-input " +
  "bg-surface text-left font-medium text-foreground hover:border-primary hover:bg-surface-subtle " +
  "disabled:cursor-not-allowed disabled:opacity-60";
const OPTION_SELECTED = "!border-primary !bg-primary !text-primary-foreground";
const OPTION_SIZES: Record<ButtonSize, string> = {
  sm: "min-h-8 px-3 text-body",
  md: "min-h-10 px-4 text-body",
  lg: "min-h-12 px-5 text-title",
  xl: "min-h-k-option px-6 text-k-answer",
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
  if (variant === "option") {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          OPTION_BASE,
          OPTION_SIZES[size],
          block && "w-full",
          selected && OPTION_SELECTED,
          className,
        )}
        aria-pressed={Boolean(selected)}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        {...rest}
      >
        {children}
      </button>
    );
  }
  const uiSize = size === "sm" ? "sm" : size === "md" ? "md" : "xl";
  return (
    <UiButton
      ref={ref}
      type={type ?? "button"}
      variant={variant}
      size={uiSize}
      fullWidth={block}
      loading={busy}
      disabled={disabled}
      className={cn(size === "lg" && "!min-h-12 !text-title", className)}
      {...rest}
    >
      {children}
    </UiButton>
  );
});
