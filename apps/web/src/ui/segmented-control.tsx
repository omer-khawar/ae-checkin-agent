/**
 * SegmentedControl: switch between a small set of related views (e.g. "Open · Acknowledged ·
 * All", "Plain · Both · Codes", per-sample vs per-summary VS rows).
 *
 * Adapted from "Segmented Control" by kuratlielia
 * (https://21st.dev/community/components/kuratlielia/segmented-control, 21st.dev demo 35020).
 * We kept its API shape (`options`, `value`, `onValueChange`, `label`, per-option `accessory`,
 * `onOptionIntent`), its roving keyboard model (only the selected option is a tab stop;
 * Arrow keys wrap, Home/End jump, and moving also selects) and its scroll-the-selection-
 * into-view behaviour for an overflowing track. We changed:
 * - Semantics: WAI-ARIA radio group (`role="radiogroup"` + `role="radio"` / `aria-checked`)
 *   instead of a group of `aria-pressed` buttons, so screen readers announce "2 of 3" and
 *   the single-choice nature. `label` is required (the group needs an accessible name).
 * - Motion: removed the motion/react gliding highlight (layout animation + spring), the smooth
 *   scrolling and the edge-fade mask. The selected option is a static white segment with a
 *   3:1 border and semibold text, so selection never depends on colour alone.
 * - Styling: Tailwind 3.4 + our tokens instead of a CSS module; console sizes `sm` 28px /
 *   `md` 32px (audit G-09); focus uses the global focus-visible ring token.
 * - Added: generic value type, per-option `disabled` (skipped by the keyboard) and `icon`.
 */
import * as React from "react";

import { cn } from "@/lib/cn";

export interface Segment<T extends string = string> {
  value: T;
  label: string;
  /** Decorative icon before the label (lucide-react element). Hidden from assistive tech. */
  icon?: React.ReactNode;
  /** Optional content after the label, such as a count badge. */
  accessory?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: ReadonlyArray<Segment<T>>;
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name of the group, e.g. "Show escalations". */
  label: string;
  /** Called when the pointer or focus reaches an option, before it is chosen (prefetch). */
  onOptionIntent?: (value: T) => void;
  size?: "sm" | "md";
  /** Stretch to the container width; segments share the space equally. */
  fullWidth?: boolean;
  className?: string;
  id?: string;
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  label,
  onOptionIntent,
  size = "md",
  fullWidth = false,
  className,
  id: idProp,
}: SegmentedControlProps<T>) {
  const autoId = React.useId();
  const id = idProp ?? autoId;
  const track = React.useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  // The tab stop is the selected option, or the first enabled one when nothing matches.
  const tabStopIndex =
    selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : options.findIndex((option) => !option.disabled);

  // Keep the selected option fully visible when the track overflows (no smooth scroll).
  React.useEffect(() => {
    const node = track.current;
    if (!node || node.scrollWidth <= node.clientWidth) return;
    const button = node.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!button) return;
    const room = 12;
    const start = button.offsetLeft - room;
    const end = button.offsetLeft + button.offsetWidth + room - node.clientWidth;
    if (node.scrollLeft > start) node.scrollLeft = Math.max(0, start);
    else if (node.scrollLeft < end) node.scrollLeft = end;
  }, [value]);

  const focusOption = (index: number) => {
    track.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.focus({ preventScroll: true });
  };

  /** Next enabled index from `from` in direction `step`, wrapping; -1 when none. */
  const nextEnabled = (from: number, step: 1 | -1): number => {
    const count = options.length;
    for (let i = 1; i <= count; i += 1) {
      const candidate = (((from + step * i) % count) + count) % count;
      if (!options[candidate]?.disabled) return candidate;
    }
    return -1;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target = -1;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = nextEnabled(index, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = nextEnabled(index, -1);
        break;
      case "Home":
        target = options.findIndex((option) => !option.disabled);
        break;
      case "End":
        target = nextEnabled(0, -1);
        break;
      default:
        return;
    }
    const option = options[target];
    if (target < 0 || !option) return;
    event.preventDefault();
    if (option.value !== value) onValueChange(option.value);
    focusOption(target);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      id={id}
      data-slot="segmented-control"
      className={cn(
        "max-w-full rounded-control border border-border bg-surface-subtle p-0.5 font-sans",
        fullWidth ? "flex w-full" : "inline-flex",
        className,
      )}
    >
      <div
        ref={track}
        className={cn(
          "flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          fullWidth && "w-full",
        )}
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              id={`${id}-${option.value}`}
              type="button"
              role="radio"
              aria-checked={selected}
              data-state={selected ? "checked" : "unchecked"}
              data-index={index}
              disabled={option.disabled}
              tabIndex={index === tabStopIndex ? 0 : -1}
              onClick={() => {
                if (!selected) onValueChange(option.value);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              onPointerEnter={onOptionIntent ? () => onOptionIntent(option.value) : undefined}
              onFocus={onOptionIntent ? () => onOptionIntent(option.value) : undefined}
              className={cn(
                "focus-ring transition-calm inline-flex shrink-0 select-none items-center justify-center",
                "whitespace-nowrap rounded-[calc(var(--radius-sm)-2px)] border font-medium",
                "[&_svg]:pointer-events-none [&_svg]:shrink-0",
                size === "sm"
                  ? "h-6 gap-1 px-2 text-caption [&_svg]:size-3.5"
                  : "h-7 gap-1.5 px-3 text-body [&_svg]:size-4",
                fullWidth && "flex-1",
                selected
                  ? "border-input bg-surface font-semibold text-foreground shadow-elev-1"
                  : "border-transparent text-muted-foreground hover:bg-surface/70 hover:text-foreground",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
              )}
            >
              {option.icon ? (
                <span aria-hidden="true" className="inline-flex">
                  {option.icon}
                </span>
              ) : null}
              {option.label}
              {option.accessory}
            </button>
          );
        })}
      </div>
    </div>
  );
}
