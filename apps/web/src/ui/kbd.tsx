/**
 * Kbd: keyboard-shortcut caps for the console (command palette rows, shortcut sheet,
 * button hints such as "Confirm  C", "Next item  ]", "Search  Ctrl K").
 *
 * Adapted from "Combo Kbd" by ai2 (https://21st.dev/community/components/ai2/kbd-combo,
 * 21st.dev demo 28308). We kept its accessibility model, which was already right: the
 * root is a <kbd> holding one sr-only phrase ("Control plus K", "G then P") while the
 * visual caps are aria-hidden, so a screen reader hears one readable name. We kept the
 * Combo (`connector="none"`), Plus (`connector="plus"`) and Sequence variants and
 * dropped Chain and Group (not needed). We changed: colours to our tokens (`bg-surface`,
 * `border-border`, a 2px `border-border-strong` bottom edge as the only "key" cue),
 * sizes to our 12px text floor (the original used 10px connectors), and symbols such
 * as "⌘", "⇧", "↵", "]" are spoken as words.
 * Static: no motion.
 */
import * as React from "react";

import { cn } from "@/lib/cn";

export type KbdSize = "sm" | "md";

const CAP_SIZE: Record<KbdSize, string> = {
  /** Inline hints inside 28-32px buttons and 36px rows. */
  sm: "h-5 min-w-5 px-1 text-caption",
  /** Shortcut sheet, command palette footer. */
  md: "h-6 min-w-6 px-1.5 text-caption",
};

const GAP: Record<KbdSize, string> = { sm: "gap-1", md: "gap-1.5" };

const CAP_BASE =
  "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-control " +
  "border border-border border-b-2 border-b-border-strong bg-surface font-mono font-medium leading-none " +
  "text-foreground [&_svg]:size-3 [&_svg]:shrink-0";

/** How a screen reader should say a key cap. Unlisted keys are read as written. */
const SPOKEN: Record<string, string> = {
  "⌘": "Command",
  Cmd: "Command",
  "⌥": "Option",
  Alt: "Alt",
  "⇧": "Shift",
  "⌃": "Control",
  Ctrl: "Control",
  Esc: "Escape",
  "↵": "Enter",
  "⏎": "Enter",
  "⌫": "Backspace",
  "⇥": "Tab",
  "↑": "Up arrow",
  "↓": "Down arrow",
  "←": "Left arrow",
  "→": "Right arrow",
  "/": "Slash",
  "?": "Question mark",
  "[": "Left bracket",
  "]": "Right bracket",
  ",": "Comma",
  ".": "Period",
};

function spoken(key: string): string {
  return SPOKEN[key] ?? key;
}

/** One visual cap. aria-hidden by the parent; never used alone. */
function Cap({ size, children }: { size: KbdSize; children: React.ReactNode }) {
  return <kbd className={cn(CAP_BASE, CAP_SIZE[size])}>{children}</kbd>;
}

export interface KbdProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  /** The key as printed on the cap, e.g. "K", "Esc", "⌘", "]". */
  children: string;
  size?: KbdSize;
}

/** A single key. Symbols are announced as words ("]" → "Right bracket"). */
export const Kbd = React.forwardRef<HTMLElement, KbdProps>(function Kbd(
  { children, size = "sm", className, ...props },
  ref,
) {
  const said = spoken(children);
  return (
    <kbd ref={ref} data-slot="kbd" className={cn(CAP_BASE, CAP_SIZE[size], className)} {...props}>
      {said === children ? (
        children
      ) : (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="sr-only">{said}</span>
        </>
      )}
    </kbd>
  );
});

export interface KbdComboProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  /** Keys pressed together, in order: ["Ctrl", "K"]. */
  keys: readonly string[];
  size?: KbdSize;
  /** `none` = caps side by side (Combo); `plus` = a visible "+" between caps (Plus). */
  connector?: "none" | "plus";
}

/** Keys pressed together: announced as "Control plus K". */
export const KbdCombo = React.forwardRef<HTMLElement, KbdComboProps>(function KbdCombo(
  { keys, size = "sm", connector = "none", className, ...props },
  ref,
) {
  return (
    <kbd
      ref={ref}
      data-slot="kbd-combo"
      className={cn("inline-flex w-fit shrink-0 items-center whitespace-nowrap", className)}
      {...props}
    >
      <span className="sr-only">{keys.map(spoken).join(" plus ")}</span>
      <span aria-hidden="true" className={cn("inline-flex items-center", GAP[size])}>
        {keys.map((k, i) => (
          <React.Fragment key={`${k}-${i}`}>
            {connector === "plus" && i > 0 ? (
              <span className="text-caption text-muted-foreground">+</span>
            ) : null}
            <Cap size={size}>{k}</Cap>
          </React.Fragment>
        ))}
      </span>
    </kbd>
  );
});

export interface KbdSequenceProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  /** Keys pressed one after another: ["G", "Q"]. */
  keys: readonly string[];
  size?: KbdSize;
}

/** Keys pressed one after another: announced as "G then Q". */
export const KbdSequence = React.forwardRef<HTMLElement, KbdSequenceProps>(function KbdSequence(
  { keys, size = "sm", className, ...props },
  ref,
) {
  return (
    <kbd
      ref={ref}
      data-slot="kbd-sequence"
      className={cn("inline-flex w-fit shrink-0 items-center whitespace-nowrap", className)}
      {...props}
    >
      <span className="sr-only">{keys.map(spoken).join(" then ")}</span>
      <span aria-hidden="true" className={cn("inline-flex items-center", GAP[size])}>
        {keys.map((k, i) => (
          <React.Fragment key={`${k}-${i}`}>
            {i > 0 ? (
              <span className="font-sans text-caption text-muted-foreground">then</span>
            ) : null}
            <Cap size={size}>{k}</Cap>
          </React.Fragment>
        ))}
      </span>
    </kbd>
  );
});
