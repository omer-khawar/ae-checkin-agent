/**
 * GlassCard: frosted chrome container for the kiosk welcome / login / question cards,
 * the landing and login panels, and sheet or palette bodies. CHROME ONLY: tables,
 * forms a coordinator reads closely, evidence, drafts and the Why panel stay opaque
 * (`bg-surface`), never glass (src/ui/README.md "Glass rules").
 *
 * Adapted from "Liquid Glass Card" by designali-in
 * (https://21st.dev/community/components/designali-in/liquid-glass-card, 21st.dev demo 3206,
 * original at https://ui.dalim.in/card). We kept the shadcn Card anatomy (Card, Header,
 * Title, Description, Action, Content, Footer with `data-slot`s). We removed the SVG
 * turbulence/displacement filter (`backdropFilter: url(#container-glass)`), the nine
 * stacked inset black/white shadows, the outer glow, `transition-all`, the dark-mode
 * block and the Tailwind v4 container-query/`has-data-*` selectors. The glass look now
 * comes from our token-driven `.glass` / `.glass-strong` utilities: 78% / 92% white
 * fill, blur(20px; 24px on the kiosk) + saturate(170%), 1px light hairline, inset top
 * highlight, soft shadow, and a 96% solid fallback without backdrop-filter or under
 * prefers-reduced-transparency.
 *
 * Contrast: `text-foreground` and `text-muted-foreground` pass 4.5:1 on `.glass` over
 * anything. Teal text (links, active items) needs `strength="strong"` on the console.
 *
 * Accessibility: render as a landmark-ish element with `as="section"` (or article,
 * aside, form) and the card is automatically labelled by its <GlassCardTitle>
 * (`aria-labelledby`), so a kiosk question card is announced by its question.
 */
import * as React from "react";

import { cn } from "@/lib/cn";

type CardElement = "div" | "section" | "article" | "aside" | "form" | "header";
type HeadingLevel = "h1" | "h2" | "h3" | "h4" | "p" | "div";

/** Elements that are announced with a name, so they get `aria-labelledby` from the title. */
const LABELLED_ELEMENTS: ReadonlySet<CardElement> = new Set([
  "section",
  "article",
  "aside",
  "form",
]);

const PADDING = {
  none: "",
  /** Console: 16px / 24px rhythm. */
  console: "gap-4 p-5",
  /** Kiosk: roomy, scales with --k-root (20px or 24px "larger text"). */
  kiosk: "gap-[1.2em] p-[1.6em]",
} as const;

export type GlassCardPadding = keyof typeof PADDING;

interface TitleRegistry {
  titleId: string;
  register: () => () => void;
}

const GlassCardContext = React.createContext<TitleRegistry | null>(null);

export interface GlassCardProps extends React.HTMLAttributes<HTMLElement> {
  /** Element to render. `section`/`article`/`aside`/`form` are labelled by the title. */
  as?: CardElement;
  /** `default` = .glass (78%); `strong` = .glass-strong (92%), needed for teal text on the console. */
  strength?: "default" | "strong";
  padding?: GlassCardPadding;
}

export const GlassCard = React.forwardRef<HTMLElement, GlassCardProps>(function GlassCard(
  { as = "div", strength = "default", padding = "console", className, children, ...props },
  ref,
) {
  const titleId = `${React.useId()}-title`;
  const [titleCount, setTitleCount] = React.useState(0);
  const registry = React.useMemo<TitleRegistry>(
    () => ({
      titleId,
      register: () => {
        setTitleCount((n) => n + 1);
        return () => setTitleCount((n) => n - 1);
      },
    }),
    [titleId],
  );

  const labelled =
    LABELLED_ELEMENTS.has(as) &&
    titleCount > 0 &&
    props["aria-labelledby"] === undefined &&
    props["aria-label"] === undefined;

  const Comp = as as React.ElementType;
  return (
    <GlassCardContext.Provider value={registry}>
      <Comp
        ref={ref}
        data-slot="glass-card"
        data-strength={strength}
        aria-labelledby={labelled ? titleId : undefined}
        className={cn(
          strength === "strong" ? "glass-strong" : "glass",
          "flex flex-col rounded-sheet text-foreground",
          PADDING[padding],
          className,
        )}
        {...props}
      >
        {children}
      </Comp>
    </GlassCardContext.Provider>
  );
});

export const GlassCardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function GlassCardHeader({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="glass-card-header"
      className={cn("flex items-start justify-between gap-3", className)}
      {...props}
    />
  );
});

export interface GlassCardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** Heading level; pick the one that fits the page outline. Default h2. */
  as?: HeadingLevel;
}

export const GlassCardTitle = React.forwardRef<HTMLHeadingElement, GlassCardTitleProps>(
  function GlassCardTitle({ as = "h2", className, id, ...props }, ref) {
    const ctx = React.useContext(GlassCardContext);
    const register = ctx?.register;
    // Only the context id is registered: a caller-supplied id is the caller's to wire up.
    const usesContextId = id === undefined && ctx !== null;
    React.useLayoutEffect(() => {
      if (!usesContextId || !register) return undefined;
      return register();
    }, [usesContextId, register]);

    const Comp = as as React.ElementType;
    return (
      <Comp
        ref={ref}
        id={id ?? ctx?.titleId}
        data-slot="glass-card-title"
        className={cn("font-semibold leading-tight text-foreground", className)}
        {...props}
      />
    );
  },
);

export const GlassCardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function GlassCardDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      data-slot="glass-card-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
});

/** Right-aligned slot in the header (a badge, a close button). */
export const GlassCardAction = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function GlassCardAction({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="glass-card-action"
      className={cn("ml-auto flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  );
});

export const GlassCardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function GlassCardContent({ className, ...props }, ref) {
  return (
    <div ref={ref} data-slot="glass-card-content" className={cn("min-w-0", className)} {...props} />
  );
});

export const GlassCardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function GlassCardFooter({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="glass-card-footer"
      className={cn("flex flex-wrap items-center gap-3", className)}
      {...props}
    />
  );
});
