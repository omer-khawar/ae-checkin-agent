/**
 * QuestionCard: the frosted glass card that holds one kiosk question (also used for the
 * welcome and login cards).
 *
 * Built for Interim (no 21st.dev source). Glass is chrome here: the card frames the
 * question; the answers inside it are opaque white rows (AnswerGroup).
 *
 * Audit rules (UI_AUDIT.md K-02, K-09, K-26, design-system "Kiosk type role"):
 * - Eyebrow (symptom name): 18px / 600, sentence case, never all caps.
 * - Title is the screen's H1: 30px / 700, line-height 1.3, max width 34rem
 *   (`text-k-question max-w-k-question`). Use `titleSize="screen"` for 36px screen titles
 *   (Welcome, Thank-you).
 * - Focus management: pass `focusKey` (e.g. the step index). The H1 receives focus on
 *   mount and whenever the key changes, so a screen reader starts at the new question.
 * - The H1's id is exposed (`titleId`) so the AnswerGroup can use
 *   `aria-labelledby={titleId}` and the question is read once, not twice.
 * - `.glass` at 78% fill keeps kiosk text >= 4.5:1 (README "Text on glass"); a solid
 *   96% fill is used when backdrop-filter is unsupported. No motion.
 */
import { useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface QuestionCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** The question (or screen title), rendered as the heading. */
  title: ReactNode;
  /** Small label above the title, e.g. "Shortness of breath". */
  eyebrow?: ReactNode;
  /** Helper text under the title, e.g. "Think about the last 7 days." */
  description?: ReactNode;
  /** Heading level; the kiosk question is the page H1. */
  headingLevel?: 1 | 2;
  /** `question` = 30px (default); `screen` = 36px for Welcome / Thank-you titles. */
  titleSize?: "question" | "screen";
  /** Id for the heading; generated when omitted. */
  titleId?: string;
  /** When this value changes (and on mount), focus moves to the heading. */
  focusKey?: string | number;
  /** Content under the heading: the AnswerGroup, inputs, etc. */
  children?: ReactNode;
}

export function QuestionCard({
  title,
  eyebrow,
  description,
  headingLevel = 1,
  titleSize = "question",
  titleId,
  focusKey,
  children,
  className,
  ...props
}: QuestionCardProps) {
  const autoId = useId();
  const headingId = titleId ?? `question-${autoId}`;
  const descriptionId = description ? `${headingId}-desc` : undefined;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const Heading = headingLevel === 1 ? "h1" : "h2";

  useEffect(() => {
    if (focusKey === undefined) return;
    headingRef.current?.focus({ preventScroll: false });
  }, [focusKey]);

  return (
    <section
      aria-labelledby={headingId}
      data-slot="question-card"
      className={cn(
        "glass mx-auto flex w-full max-w-k-content flex-col gap-6 rounded-sheet p-6 sm:p-10",
        className,
      )}
      {...props}
    >
      <header className="flex flex-col gap-2">
        {eyebrow ? (
          <p className="m-0 text-k-helper font-semibold text-muted-foreground">{eyebrow}</p>
        ) : null}
        <Heading
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className={cn(
            "m-0 max-w-k-question text-foreground",
            titleSize === "screen" ? "text-k-title" : "text-k-question",
          )}
        >
          {title}
        </Heading>
        {description ? (
          <p id={descriptionId} className="m-0 text-k-helper text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>
      {children}
    </section>
  );
}
