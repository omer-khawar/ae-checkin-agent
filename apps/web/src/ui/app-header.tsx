/**
 * AppHeader: the console's single 48px app bar (UI_AUDIT.md G-01, G-05, G-13, G-26).
 *
 * Adapted from "Floating Header" by efferd
 * (https://21st.dev/community/components/efferd/floating-header, 21st.dev demo 8137).
 * We kept its frosted, sticky bar with a brand on the left, ghost-style nav links and a
 * right-hand action area. We changed:
 * - Layout: full-width, edge-to-edge bar on the console (`variant="bar"`, the default).
 *   The original rounded floating capsule survives only as `variant="floating"` for
 *   marketing-style pages; the console never uses it.
 * - Glass: our token-driven `.glass` utility (78% fill + blur + saturate, solid fallback
 *   without backdrop-filter or with reduced transparency) instead of `bg-background/80
 *   backdrop-blur-lg`. Active nav text stays `text-foreground` (semibold) so it keeps
 *   >= 4.5:1 on 78% glass; the teal is carried by a 2px underline (non-text, >= 3:1).
 * - Slots instead of hard-coded links: `brand`, `nav`, `search`, `study`, `actions`.
 * - Nav items gained count badges (G-13) with a screen-reader label, and `aria-current`
 *   driven styling so a router `<NavLink>` (via `asChild`) or a plain `active` flag both work.
 * - Removed: the mobile drawer (the console is a desktop tool; the Sheet lives in
 *   src/ui/sheet.tsx), the hover-duration brand effect and the mono-font logo.
 * - Added a "Skip to main content" link (first tab stop) and a labelled <nav> landmark.
 *
 * Usage:
 *   <AppHeader
 *     brand={<AppHeaderBrand asChild><Link to="/dashboard">Interim</Link></AppHeaderBrand>}
 *     nav={
 *       <AppHeaderNav label="Primary">
 *         <AppHeaderNavItem asChild count={3} countLabel="need action">
 *           <NavLink to="/dashboard" end>Queue</NavLink>
 *         </AppHeaderNavItem>
 *       </AppHeaderNav>
 *     }
 *     study={<StudyChip />}
 *     actions={<UserMenu />}
 *   />
 *   <main id="main">…</main>
 */
import { Slot, Slottable } from "@radix-ui/react-slot";

import * as React from "react";

import { cn } from "@/lib/cn";
import { BrandSymbol } from "@/ui/brand";

/* ---------------------------------------------------------------------------------------- */
/* AppHeader                                                                                */
/* ---------------------------------------------------------------------------------------- */

export interface AppHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  /** Left-most: product mark + wordmark, usually an `<AppHeaderBrand>`. */
  brand: React.ReactNode;
  /** Primary navigation, usually an `<AppHeaderNav>` of `<AppHeaderNavItem>`s. */
  nav?: React.ReactNode;
  /**
   * Right side, first: the "Jump to… /" command palette trigger. Give that button
   * `data-command-menu-trigger` so CommandMenu can return focus to it when the element that
   * opened the menu no longer exists.
   */
  search?: React.ReactNode;
  /** Right side: study chip ("R2810-ONC-1624 · NCT03088540"), SYNTHETIC, time-saved chip. */
  study?: React.ReactNode;
  /** Right-most: the user menu and any other actions. */
  actions?: React.ReactNode;
  /** `bar` (console default): full width, sticky at the top. `floating`: inset rounded capsule. */
  variant?: "bar" | "floating";
  /** Element id the skip link jumps to. Pass `null` to omit the skip link. */
  skipToId?: string | null;
  /** Visible text of the skip link. */
  skipLabel?: string;
}

export const AppHeader = React.forwardRef<HTMLElement, AppHeaderProps>(function AppHeader(
  {
    brand,
    nav,
    search,
    study,
    actions,
    variant = "bar",
    skipToId = "main",
    skipLabel = "Skip to main content",
    className,
    ...props
  },
  ref,
) {
  return (
    <>
      {skipToId ? (
        <a
          href={`#${skipToId}`}
          data-slot="app-header-skip"
          className={cn(
            "sr-only-focusable fixed left-3 top-2 z-[60] rounded-control border border-input",
            "bg-surface px-3 py-1.5 text-body font-medium text-foreground shadow-elev-2",
          )}
        >
          {skipLabel}
        </a>
      ) : null}
      <header
        ref={ref}
        data-slot="app-header"
        data-variant={variant}
        className={cn(
          "glass sticky z-40 flex h-appbar items-center gap-3 font-console text-body",
          variant === "bar"
            ? "top-0 w-full rounded-none px-4 xl:px-6"
            : "top-3 mx-auto w-full max-w-5xl rounded-sheet px-3",
          className,
        )}
        {...props}
      >
        <div className="flex shrink-0 items-center">{brand}</div>
        {nav ? <div className="flex shrink-0 items-center self-stretch">{nav}</div> : null}
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap [&>*]:shrink-0">
          {search}
          {study}
          {actions}
        </div>
      </header>
    </>
  );
});

/* ---------------------------------------------------------------------------------------- */
/* Brand                                                                                    */
/* ---------------------------------------------------------------------------------------- */

export interface AppHeaderBrandProps extends React.HTMLAttributes<HTMLElement> {
  /** Render onto the single child (e.g. a router `<Link>`), keeping the mark inside it. */
  asChild?: boolean;
  /** Replaces the default mark. Decorative: hidden from assistive tech. */
  logo?: React.ReactNode;
}

/** Product mark + wordmark. With `asChild`, the child's own text is the wordmark. */
export const AppHeaderBrand = React.forwardRef<HTMLElement, AppHeaderBrandProps>(
  function AppHeaderBrand({ asChild = false, logo, className, children, ...props }, ref) {
    const Comp: React.ElementType = asChild ? Slot : "span";
    return (
      <Comp
        ref={ref}
        data-slot="app-header-brand"
        className={cn(
          "transition-calm inline-flex items-center gap-2 rounded-control px-1.5 py-1",
          "font-brand text-[17px] font-extrabold tracking-tight text-foreground no-underline",
          asChild && "hover:bg-accent",
          className,
        )}
        {...props}
      >
        <span aria-hidden="true" className="inline-flex size-7 items-center justify-center">
          {logo ?? <BrandSymbol className="size-7" />}
        </span>
        <Slottable>{children ?? "Interim"}</Slottable>
      </Comp>
    );
  },
);

/* ---------------------------------------------------------------------------------------- */
/* Nav                                                                                      */
/* ---------------------------------------------------------------------------------------- */

export interface AppHeaderNavProps extends React.HTMLAttributes<HTMLElement> {
  /** Accessible name of the <nav> landmark. */
  label?: string;
}

/** A labelled <nav> landmark; each child is wrapped in a list item. */
export const AppHeaderNav = React.forwardRef<HTMLElement, AppHeaderNavProps>(function AppHeaderNav(
  { label = "Primary", className, children, ...props },
  ref,
) {
  return (
    <nav
      ref={ref}
      aria-label={label}
      data-slot="app-header-nav"
      className={cn("ml-2 flex h-full items-center", className)}
      {...props}
    >
      <ul className="flex h-full items-center gap-0.5">
        {React.Children.map(children, (child) =>
          child === null || child === undefined || child === false ? null : (
            <li className="flex h-full items-center">{child}</li>
          ),
        )}
      </ul>
    </nav>
  );
});

export interface AppHeaderNavItemProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Render onto the single child (e.g. react-router `<NavLink>`). */
  asChild?: boolean;
  /**
   * Marks this item as the current section (sets aria-current="page"). Leave it undefined
   * when the child (e.g. `<NavLink>`) sets aria-current itself. Route ownership for deep
   * pages (G-05: check-in -> Queue, packet -> Escalations) is the caller's decision.
   */
  active?: boolean;
  /** Count badge (G-13). Hidden when 0, null or undefined; shows "99+" above 99. */
  count?: number | null;
  /** Read after the count by screen readers, e.g. "need action", "not acknowledged". */
  countLabel?: string;
  /** Urgent badge: solid danger fill (e.g. T3 not acknowledged, query open > 72 h). */
  urgent?: boolean;
}

export const AppHeaderNavItem = React.forwardRef<HTMLAnchorElement, AppHeaderNavItemProps>(
  function AppHeaderNavItem(
    { asChild = false, active, count, countLabel, urgent = false, className, children, ...props },
    ref,
  ) {
    const Comp: React.ElementType = asChild ? Slot : "a";
    const currentProps: Pick<React.AriaAttributes, "aria-current"> =
      active === undefined ? {} : { "aria-current": active ? "page" : undefined };
    return (
      <Comp
        ref={ref}
        data-slot="app-header-nav-item"
        {...currentProps}
        className={cn(
          "transition-calm relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2.5",
          "text-body font-medium text-muted-foreground no-underline",
          "hover:bg-accent hover:text-accent-foreground",
          // Current section: semibold dark text (AA on glass) + a 2px teal underline on the
          // bar's bottom edge (48px bar, 32px item: 8px below the item).
          "after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-2 after:h-0.5",
          "after:rounded-full after:bg-transparent after:content-['']",
          "aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
          "aria-[current=page]:after:bg-primary",
          className,
        )}
        {...props}
      >
        <Slottable>{children}</Slottable>
        {typeof count === "number" && count > 0 ? (
          <CountBadge count={count} label={countLabel} urgent={urgent} />
        ) : null}
      </Comp>
    );
  },
);

/** Small numeric pill. The visible number is paired with screen-reader words. */
function CountBadge({
  count,
  label,
  urgent,
}: {
  count: number;
  label: string | undefined;
  urgent: boolean;
}) {
  return (
    <span
      data-slot="app-header-count"
      data-urgent={urgent || undefined}
      className={cn(
        "tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1",
        "text-caption font-semibold leading-none",
        urgent
          ? "bg-destructive text-destructive-foreground"
          : "bg-primary text-primary-foreground",
      )}
    >
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
      {/* Exact count in words for screen readers: "Queue (3 need action)". */}
      <span className="sr-only">{` (${count}${label ? ` ${label}` : ""})`}</span>
    </span>
  );
}
