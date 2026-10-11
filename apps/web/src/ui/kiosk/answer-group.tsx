/**
 * AnswerGroup: the kiosk's single-choice answer scale (one PRO-CTCAE attribute, a gate
 * question, the camera choice).
 *
 * Adapted from "Accessible Radio Group" by a11ypros
 * (https://21st.dev/r/a11ypros/a11y-radio, 21st.dev demo 34674; MIT, ported from
 * A11Y Pros' a11y-radio). Kept: native <input type="radio"> per option, a labelled
 * group, helper and error text joined into aria-describedby, the error as role="alert".
 * Changed: <fieldset>/<legend> instead of a div + span label (so the question is the
 * group's name), role="radiogroup" on the fieldset, explicit roving tabindex and
 * arrow/Home/End handling (identical in every browser and in jsdom), the whole 64px row
 * is the tap target, and all styling comes from our kiosk tokens. Visual reference for
 * the row style: "Radio Group 8" by sean0205 (https://21st.dev/@sean0205/components/c-radio-group-8),
 * viewed only, not retrieved.
 *
 * Audit rules (docs/ui-audit/UI_AUDIT.md K-01, K-09, K-24, contradiction 4):
 * - One column in scale order, rows >= 64px (`min-h-k-option`), 12px gaps (`gap-k-gap`),
 *   left-aligned 22px labels (`text-k-answer`).
 * - Unselected: white fill, 2px `border-input` (#64748B, 4.76:1) and an empty radio.
 *   Hover only darkens the border.
 * - Selected: solid `bg-primary` (#115E59) fill, white label at 700 and a check icon,
 *   so the state never relies on colour or the border alone.
 * - Focus: the kiosk focus token (3px #1E3A8A outline, 3px offset) drawn on the row when
 *   its radio has :focus-visible. It is blue so focus never reads as "selected".
 * - Motion: colour only (`transition-calm`, 150ms, off under prefers-reduced-motion).
 *   No auto-advance: choosing an answer never moves to the next screen.
 *
 * Values may be numbers (PRO-CTCAE 0..4) or strings; the radio's DOM value is the
 * option index, so any value type round-trips without string conversion.
 */
import { Check, Circle } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type FieldsetHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

export interface AnswerOption<V extends string | number = string | number> {
  value: V;
  /** Visible label, e.g. "Moderate". */
  label: ReactNode;
  /** Optional second line under the label (helper size). */
  description?: ReactNode;
  disabled?: boolean;
}

export interface AnswerGroupProps<V extends string | number = string | number>
  extends Omit<
    FieldsetHTMLAttributes<HTMLFieldSetElement>,
    "onChange" | "defaultValue" | "children" | "role"
  > {
  /** Radio `name`; unique per screen. */
  name: string;
  options: readonly AnswerOption<V>[];
  /** Controlled selection. `null` = nothing chosen yet. */
  value?: V | null;
  /** Uncontrolled initial selection. */
  defaultValue?: V | null;
  onValueChange?: (value: V) => void;
  /**
   * Visible group name rendered as the <legend>. Omit it when the question is already the
   * screen's H1 (QuestionCard) and pass `aria-labelledby={titleId}` instead, so screen
   * readers do not read the question twice (K-09).
   */
  legend?: ReactNode;
  /** Keep the legend for assistive tech but hide it visually. */
  legendHidden?: boolean;
  /** Helper line under the options (18px). Hidden while an error shows. */
  helperText?: ReactNode;
  /** Inline validation, e.g. "Please choose an answer". Announced via role="alert". */
  error?: ReactNode;
  required?: boolean;
}

/**
 * Scroll the whole option row (not just the 1px sr-only radio) into view. `block: "nearest"`
 * honours the scroll container's `scroll-padding-bottom` (set from the measured height of the
 * sticky KioskActionBar in index.css), so a focused or selected row never sits under the bar
 * (WCAG 2.4.11 Focus Not Obscured).
 */
function revealOption(input: HTMLInputElement | null | undefined) {
  const row = input?.closest("label");
  if (row && typeof row.scrollIntoView === "function") {
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

export function AnswerGroup<V extends string | number = string | number>({
  name,
  options,
  value,
  defaultValue = null,
  onValueChange,
  legend,
  legendHidden = false,
  helperText,
  error,
  required = false,
  disabled = false,
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  ...fieldsetProps
}: AnswerGroupProps<V>) {
  const autoId = useId();
  const baseId = id ?? `answer-${autoId}`;
  const helperId = helperText && !error ? `${baseId}-helper` : undefined;
  const errorId = error ? `${baseId}-error` : undefined;
  const describedBy = [ariaDescribedBy, helperId, errorId].filter(Boolean).join(" ") || undefined;

  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<V | null>(defaultValue);
  const selected = isControlled ? value : internal;
  const selectedIndex = options.findIndex((o) => o.value === selected);

  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const isEnabled = (i: number) => !disabled && !options[i]?.disabled;
  const firstEnabled = options.findIndex((_, i) => isEnabled(i));
  // Roving tabindex, as browsers do for a native radio group: Tab lands on the chosen
  // option, or on the first enabled one when nothing is chosen yet.
  const tabStop = selectedIndex >= 0 && isEnabled(selectedIndex) ? selectedIndex : firstEnabled;

  const choose = (index: number) => {
    const option = options[index];
    if (!option || !isEnabled(index)) return;
    if (!isControlled) setInternal(option.value);
    if (option.value !== selected) onValueChange?.(option.value);
  };

  const step = (from: number, delta: 1 | -1): number => {
    const n = options.length;
    for (let k = 1; k <= n; k += 1) {
      const i = (((from + delta * k) % n) + n) % n;
      if (isEnabled(i)) return i;
    }
    return from;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    let target: number | null = null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        target = step(index, 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        target = step(index, -1);
        break;
      case "Home":
        target = firstEnabled;
        break;
      case "End":
        target = lastEnabled(options.length, isEnabled);
        break;
      case " ":
        event.preventDefault();
        choose(index);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (target === null || target < 0) return;
    const input = inputs.current[target];
    input?.focus({ preventScroll: true });
    revealOption(input);
    // Selection follows focus, the native radio-group behaviour.
    choose(target);
  };

  return (
    <fieldset
      {...fieldsetProps}
      id={baseId}
      role="radiogroup"
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      data-slot="answer-group"
      className={cn("m-0 min-w-0 border-0 p-0", className)}
    >
      {legend ? (
        <legend
          className={cn("mb-4 p-0 text-k-question text-foreground", legendHidden && "sr-only")}
        >
          {legend}
        </legend>
      ) : null}

      <div className="flex flex-col gap-k-gap">
        {options.map((option, index) => {
          const checked = index === selectedIndex;
          const optionDisabled = !isEnabled(index);
          const optionId = `${baseId}-opt-${index}`;
          const descId = option.description ? `${optionId}-desc` : undefined;
          return (
            <label
              key={`${String(option.value)}-${index}`}
              htmlFor={optionId}
              data-state={checked ? "checked" : "unchecked"}
              data-disabled={optionDisabled || undefined}
              className={cn(
                "transition-calm flex min-h-k-option w-full cursor-pointer select-none items-center gap-4",
                // Clear the sticky action bar when focused or scrolled to (WCAG 2.4.11).
                "scroll-my-4",
                "rounded-control border-2 px-5 py-3 text-left",
                // Focus ring on the row, from the kiosk focus tokens (blue, outside the row).
                "has-[:focus-visible]:outline has-[:focus-visible]:outline-[length:var(--focus-width)]",
                "has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-offset-[var(--focus-offset)]",
                checked
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-surface text-foreground hover:border-foreground",
                optionDisabled && "cursor-not-allowed opacity-60 hover:border-input",
              )}
            >
              <input
                ref={(el) => {
                  inputs.current[index] = el;
                }}
                id={optionId}
                type="radio"
                name={name}
                value={String(index)}
                checked={checked}
                disabled={optionDisabled}
                required={required}
                tabIndex={index === tabStop ? 0 : -1}
                aria-describedby={descId}
                onChange={() => choose(index)}
                onKeyDown={(e) => onKeyDown(e, index)}
                onFocus={(e) => revealOption(e.currentTarget)}
                className="sr-only"
              />
              <span aria-hidden="true" className="inline-flex shrink-0">
                {checked ? (
                  <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary-foreground text-primary">
                    <Check className="size-5" strokeWidth={3} />
                  </span>
                ) : (
                  <Circle className="size-7 text-muted-foreground" strokeWidth={2} />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={cn("text-k-answer", checked ? "font-bold" : "font-semibold")}>
                  {option.label}
                </span>
                {option.description ? (
                  <span
                    id={descId}
                    className={cn(
                      "text-k-helper",
                      checked ? "text-primary-foreground" : "text-muted-foreground",
                    )}
                  >
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>

      {helperText && !error ? (
        <p id={helperId} className="mt-4 text-k-helper text-muted-foreground">
          {helperText}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-4 text-k-helper font-semibold text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function lastEnabled(count: number, isEnabled: (i: number) => boolean): number {
  for (let i = count - 1; i >= 0; i -= 1) if (isEnabled(i)) return i;
  return -1;
}
