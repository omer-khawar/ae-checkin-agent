/**
 * CommandMenu: the coordinator's Ctrl/Cmd+K palette (jump to a participant, a page or an
 * action). Built on cmdk (ranking + keyboard) inside a Radix Dialog (focus trap, Escape,
 * focus return). Pair it with `useCommandMenu()` from `@/ui/use-command-menu`:
 *
 *   const menu = useCommandMenu({ slash: true });
 *   <CommandMenu open={menu.open} onOpenChange={menu.setOpen} items={items} groups={["Go to", "Participants"]} />
 *
 * Adapted from "Command Menu" by uvain (Layro System)
 * (https://21st.dev/community/components/uvain/command-menu-palette, 21st.dev demo 33510).
 * Kept: cmdk inside a Radix dialog, grouped items with an icon, a second "hint" line and
 * per-item <kbd> shortcut hints, `keywords` for matching, the sr-only dialog title, the
 * listbox -> group -> option ARIA repair (cmdk's sizer div marked presentational) and the
 * keyboard legend footer. Changed: items are DATA supplied by the caller (`items` + optional
 * `groups` order) instead of children; the panel is our frosted `.glass-strong` chrome
 * (glass is allowed for the command palette; the highlighted item is an OPAQUE `bg-accent`
 * pill so teal text keeps >= 4.5:1); type sizes moved up to our 12px floor (the source used
 * 10.5-11.5px); the squircle corner-shape, zoom-in/out animation and dark-mode scrim were
 * removed (no decorative motion: the dialog simply appears); key caps come from our shared
 * `@/ui/kbd` (symbols such as "↑" and "↵" are announced as words).
 *
 * Focus return (WCAG 2.4.3): the palette has no Radix Trigger (it opens from Ctrl+K, "/" or
 * any button), so Radix alone would drop focus on <body> when it closes. We record the element
 * that had focus when the menu opened and hand focus back to it on close; if that element is
 * gone, focus goes to the header's "Jump to…" button (`[data-command-menu-trigger]`).
 *
 * Accessibility: Radix gives the dialog role and focus trap; cmdk gives a
 * combobox input with `aria-activedescendant` over a listbox. Each item's accessible name is
 * its label (+ hint); the <kbd> hints are display-only and hidden from the name.
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";
import { Kbd, KbdCombo, KbdSequence } from "@/ui/kbd";

/* ------------------------------------------------------------------ types -- */

export interface CommandMenuItem {
  /** Unique id; also matched by the search (so "P-007" finds a participant by id). */
  id: string;
  label: string;
  /** Group heading this item sits under, e.g. "Go to", "Participants", "Actions". */
  group: string;
  /** Lucide icon element; decorative. */
  icon?: React.ReactNode;
  /** Second line under the label, e.g. "Tier 2 · check-in 14:02". */
  hint?: string;
  /** Display-only key hint ("G Q", or a combo object). The palette does not bind it. */
  shortcut?: CommandShortcut;
  /** Extra words the search should match (synonyms, SDTM names). */
  keywords?: string[];
  disabled?: boolean;
  onSelect: () => void;
}

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly CommandMenuItem[];
  /** Group order. Groups not listed follow in first-seen order. */
  groups?: readonly string[];
  placeholder?: string;
  emptyText?: React.ReactNode;
  /** Accessible dialog title (not painted). */
  title?: string;
  /** Close the dialog after an item runs. Default true. */
  closeOnSelect?: boolean;
  /** Replaces the keyboard legend in the footer. */
  footer?: React.ReactNode;
  className?: string;
}

/** "G Q" = keys pressed one after another; `{ keys: ["Ctrl", "E"], kind: "combo" }` = together. */
export type CommandShortcut = string | { keys: readonly string[]; kind?: "combo" | "sequence" };

function ShortcutHint({ shortcut }: { shortcut: CommandShortcut }) {
  if (typeof shortcut === "string") {
    return <KbdSequence keys={shortcut.split(" ").filter(Boolean)} />;
  }
  return shortcut.kind === "combo" ? (
    <KbdCombo keys={shortcut.keys} />
  ) : (
    <KbdSequence keys={shortcut.keys} />
  );
}

/* ------------------------------------------------------------------ parts -- */

function CommandList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>) {
  // cmdk wraps groups in a sizing div with no role; mark it presentational so the
  // listbox -> group -> option chain stays valid (from the source component).
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector("[cmdk-list-sizer]")?.setAttribute("role", "presentation");
    ref.current
      ?.querySelectorAll("[cmdk-separator]")
      .forEach((el) => el.setAttribute("role", "none"));
  });
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn("max-h-[min(420px,60dvh)] overflow-y-auto overscroll-contain p-1.5", className)}
      {...props}
    />
  );
}

function CommandRow({
  item,
  onRun,
}: {
  item: CommandMenuItem;
  onRun: (item: CommandMenuItem) => void;
}) {
  return (
    <CommandPrimitive.Item
      value={item.id}
      keywords={[item.label, ...(item.keywords ?? []), ...(item.hint ? [item.hint] : [])]}
      disabled={item.disabled}
      onSelect={() => onRun(item)}
      className={cn(
        "flex min-h-row cursor-pointer select-none items-center gap-2.5 rounded-control px-2.5 py-1.5 text-body text-foreground",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60",
      )}
    >
      {item.icon ? (
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 text-muted-foreground [&_svg]:size-4"
        >
          {item.icon}
        </span>
      ) : null}
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{item.label}</span>
        {item.hint ? (
          <span className="tabular truncate text-caption text-muted-foreground">{item.hint}</span>
        ) : null}
      </span>
      {item.shortcut ? (
        <span aria-hidden="true" className="flex shrink-0">
          <ShortcutHint shortcut={item.shortcut} />
        </span>
      ) : null}
    </CommandPrimitive.Item>
  );
}

function groupItems(items: readonly CommandMenuItem[], order: readonly string[] = []) {
  const byGroup = new Map<string, CommandMenuItem[]>();
  for (const g of order) byGroup.set(g, []);
  for (const item of items) {
    const list = byGroup.get(item.group);
    if (list) list.push(item);
    else byGroup.set(item.group, [item]);
  }
  return [...byGroup.entries()].filter(([, list]) => list.length > 0);
}

/* ------------------------------------------------------------------- menu -- */

export function CommandMenu({
  open,
  onOpenChange,
  items,
  groups,
  placeholder = "Search participants, pages and actions",
  emptyText = "No matches.",
  title = "Command menu",
  closeOnSelect = true,
  footer,
  className,
}: CommandMenuProps) {
  const grouped = React.useMemo(() => groupItems(items, groups), [items, groups]);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  // Radix fires onOpenAutoFocus before it moves focus, so activeElement is still the opener.
  const rememberOpener = () => {
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  };

  const contentRef = React.useRef<HTMLDivElement>(null);

  const restoreFocus = (event: Event) => {
    event.preventDefault();
    const opener = returnFocusRef.current;
    returnFocusRef.current = null;
    // If the chosen item already moved focus somewhere else (e.g. it opened a sheet), keep it.
    const active = document.activeElement;
    const focusIsLost =
      !active || active === document.body || contentRef.current?.contains(active) === true;
    if (!focusIsLost) return;
    const target =
      opener && opener.isConnected
        ? opener
        : document.querySelector<HTMLElement>("[data-command-menu-trigger]");
    target?.focus({ preventScroll: true });
  };

  const run = (item: CommandMenuItem) => {
    if (closeOnSelect) onOpenChange(false);
    item.onSelect();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/20" />
        <DialogPrimitive.Content
          ref={contentRef}
          onOpenAutoFocus={rememberOpener}
          onCloseAutoFocus={restoreFocus}
          className={cn(
            "glass-strong fixed left-1/2 top-[12dvh] z-50 w-[calc(100vw-24px)] max-w-[600px] -translate-x-1/2",
            "overflow-hidden rounded-sheet text-foreground shadow-glass outline-none",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Type to filter. Use the up and down arrow keys to move, Enter to run, Escape to close.
          </DialogPrimitive.Description>

          {/* vimBindings off: cmdk would otherwise swallow Ctrl+K (as "up"), so the shortcut could not close the menu. */}
          <CommandPrimitive loop vimBindings={false} label={title} className="flex w-full flex-col">
            <div className="flex items-center gap-2.5 border-b border-border px-3.5">
              <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                placeholder={placeholder}
                className="h-12 w-full bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>

            <CommandList>
              <CommandPrimitive.Empty className="px-3 py-8 text-center text-body text-muted-foreground">
                {emptyText}
              </CommandPrimitive.Empty>
              {grouped.map(([heading, list], index) => (
                <React.Fragment key={heading}>
                  {index > 0 ? (
                    <CommandPrimitive.Separator className="-mx-1.5 my-1 h-px bg-border" />
                  ) : null}
                  <CommandPrimitive.Group
                    heading={heading}
                    className={cn(
                      "py-1",
                      "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5",
                      "[&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-medium",
                      "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.04em]",
                      "[&_[cmdk-group-heading]]:text-muted-foreground",
                    )}
                  >
                    {list.map((item) => (
                      <CommandRow key={item.id} item={item} onRun={run} />
                    ))}
                  </CommandPrimitive.Group>
                </React.Fragment>
              ))}
            </CommandList>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3.5 py-2 text-caption text-muted-foreground">
              {footer ?? (
                <>
                  <span className="inline-flex items-center gap-1">
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd>
                    move
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd>↵</Kbd>
                    run
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd>Esc</Kbd>
                    close
                  </span>
                </>
              )}
            </div>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
