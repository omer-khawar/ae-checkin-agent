/**
 * Sheet: a dialog panel attached to an edge of the screen. Used for the "+ New ▾ (Note | Call)"
 * 480px form sheet (audit N-01), the Why-rail drawer below 1440px, the audit payload drawer,
 * filters and the shortcut sheet.
 *
 * Adapted from "Sheet" by kevingirelli
 * (https://21st.dev/community/components/kevingirelli/sheet, 21st.dev demo 35214), itself a
 * shadcn/Radix Dialog sheet. We kept the Radix Dialog base and its behaviour (focus moves in
 * on open, is trapped inside, returns to the trigger on close; Escape and an overlay click
 * close it; the page behind does not scroll; screen readers announce a dialog named by
 * `SheetTitle`), the part names, `side`, `showCloseButton`, `closeLabel` and
 * `overlayClassName`. We changed:
 * - Look: frosted `.glass-strong` chrome (92% fill, so teal links and muted text stay
 *   >= 4.5:1 over anything beneath; near-opaque fallback without backdrop-filter), inset 8px
 *   from the edges with our `rounded-sheet` radius, `shadow-elev-3`, and a 50% scrim built
 *   from the foreground token (audit elevation 3). Forms and data inside stay opaque: put
 *   them on `bg-surface` panels inside `SheetBody`.
 * - Motion: removed the slide-in/out animations (and the tailwindcss-animate dependency they
 *   need). The sheet appears and disappears in place.
 * - Sides: `right` (default) and `bottom`, plus `left`; `top` dropped (no use in Interim).
 * - Sizes: `size` sm 384px / md 480px (default, N-01) / lg 640px for side sheets.
 * - Close button: our `Button` (ghost, icon size, 32px) with the global focus ring token.
 * - Added `SheetBody` (the scrolling region) and a bordered header/footer so the actions stay
 *   visible while long content scrolls.
 * - Toasts stay usable while a sheet is open: the global <Toaster /> sits bottom-left (clear of
 *   a right sheet's footer), a click on a toast does not close the sheet, and keyboard focus
 *   may move to a toast (Alt+T, sonner's hotkey) without the focus trap pulling it back.
 *   Escape on a toast, or the toast closing, returns focus to where it was in the sheet.
 *
 * @example
 * <Sheet>
 *   <SheetTrigger asChild><Button>New note</Button></SheetTrigger>
 *   <SheetContent side="right">
 *     <SheetHeader>
 *       <SheetTitle>New note</SheetTitle>
 *       <SheetDescription>Paste a synthetic chart note for P-003.</SheetDescription>
 *     </SheetHeader>
 *     <SheetBody>…form…</SheetBody>
 *     <SheetFooter>
 *       <SheetClose asChild><Button>Cancel</Button></SheetClose>
 *       <Button variant="primary">Save note</Button>
 *     </SheetFooter>
 *   </SheetContent>
 * </Sheet>
 */
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

export type SheetSide = "right" | "bottom" | "left";
export type SheetSize = "sm" | "md" | "lg";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
/** Closes the sheet. Wrap a button or link with `asChild`. */
export const SheetClose = SheetPrimitive.Close;
export const SheetPortal = SheetPrimitive.Portal;

export const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(function SheetOverlay({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Overlay
      ref={ref}
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-50 bg-foreground/50", className)}
      {...props}
    />
  );
});

const SIDE_CLASSES: Record<SheetSide, string> = {
  right: "inset-y-2 right-2 w-[calc(100vw-1rem)]",
  left: "inset-y-2 left-2 w-[calc(100vw-1rem)]",
  bottom: "inset-x-2 bottom-2 max-h-[85vh]",
};

const SIZE_CLASSES: Record<SheetSize, string> = {
  sm: "max-w-[384px]",
  md: "max-w-[480px]",
  lg: "max-w-[640px]",
};

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> {
  /** The edge the panel is attached to. */
  side?: SheetSide;
  /** Width of a left/right sheet. Ignored for `bottom`. */
  size?: SheetSize;
  /** Renders an icon button in the top corner that closes the sheet. */
  showCloseButton?: boolean;
  /** Accessible name of the close button. */
  closeLabel?: string;
  /** Classes for the scrim behind the panel. */
  overlayClassName?: string;
}

/**
 * The panel itself, in a portal above a scrim. It needs a `SheetTitle` (use `sr-only` on it if
 * the design has no visible heading). Without a `SheetDescription`, pass
 * `aria-describedby={undefined}`.
 */
/* ----------------------------------------------------- toast pass-through -- */

const TOASTER_SELECTOR = "[data-sonner-toaster]";

function inToaster(node: EventTarget | null | undefined): boolean {
  return node instanceof Element && node.closest(TOASTER_SELECTOR) !== null;
}

/**
 * Lets keyboard focus visit the toaster while this (modal) sheet is open. Radix's focus trap
 * listens for focusin/focusout on `document`; a listener on <body> runs after React's own
 * handlers and before the trap, so stopping propagation there exempts only toast focus moves.
 * When focus leaves a toast for nowhere (the toast closed), it goes back into the sheet.
 */
function useToastFocusPassThrough(contentRef: React.RefObject<HTMLElement>) {
  const lastInside = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const body = document.body;
    const backToSheet = () => {
      const target = lastInside.current?.isConnected ? lastInside.current : contentRef.current;
      target?.focus({ preventScroll: true });
    };
    const onFocusIn = (event: FocusEvent) => {
      if (inToaster(event.target)) {
        event.stopPropagation();
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && contentRef.current?.contains(target)) {
        lastInside.current = target;
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (inToaster(event.relatedTarget)) {
        event.stopPropagation();
        return;
      }
      if (inToaster(event.target) && !contentRef.current?.contains(event.relatedTarget as Node)) {
        event.stopPropagation();
        // Toast removed (Undo / dismiss / timeout) or focus left it: return to the sheet.
        window.setTimeout(() => {
          if (!document.activeElement || document.activeElement === document.body) backToSheet();
        }, 0);
      }
    };
    body.addEventListener("focusin", onFocusIn);
    body.addEventListener("focusout", onFocusOut);
    return () => {
      body.removeEventListener("focusin", onFocusIn);
      body.removeEventListener("focusout", onFocusOut);
    };
  }, [contentRef]);

  return lastInside;
}

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(function SheetContent(
  {
    className,
    children,
    side = "right",
    size = "md",
    showCloseButton = true,
    closeLabel = "Close",
    overlayClassName,
    onPointerDownOutside,
    onFocusOutside,
    onInteractOutside,
    onEscapeKeyDown,
    ...props
  },
  ref,
) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );
  const lastInside = useToastFocusPassThrough(contentRef);

  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        ref={setRefs}
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "glass-strong fixed z-50 flex flex-col overflow-hidden rounded-sheet font-sans text-body",
          "shadow-elev-3 outline-none",
          SIDE_CLASSES[side],
          side !== "bottom" && SIZE_CLASSES[size],
          className,
        )}
        {...props}
        // A click or focus move onto a toast (e.g. its Undo) must not close the sheet.
        onPointerDownOutside={(event) => {
          if (inToaster(event.target)) event.preventDefault();
          onPointerDownOutside?.(event);
        }}
        onFocusOutside={(event) => {
          if (inToaster(event.target)) event.preventDefault();
          onFocusOutside?.(event);
        }}
        onInteractOutside={(event) => {
          if (inToaster(event.target)) event.preventDefault();
          onInteractOutside?.(event);
        }}
        // Escape on a toast goes back into the sheet instead of closing it.
        onEscapeKeyDown={(event) => {
          if (inToaster(document.activeElement)) {
            event.preventDefault();
            (lastInside.current?.isConnected ? lastInside.current : contentRef.current)?.focus();
            return;
          }
          onEscapeKeyDown?.(event);
        }}
      >
        {children}
        {showCloseButton ? (
          <SheetPrimitive.Close asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label={closeLabel}
              data-slot="sheet-close-button"
              className="absolute right-3 top-3"
            >
              <X aria-hidden="true" />
            </Button>
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});

/** Title + description block. Leaves room on the right for the close button. */
export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b border-border px-4 pb-3 pr-14 pt-4",
        className,
      )}
      {...props}
    />
  );
}

/** The scrolling region between the header and the footer. */
export function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", className)}
      {...props}
    />
  );
}

/** Actions row, pinned to the bottom of the panel, primary action last (right). */
export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "mt-auto flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

/** Names the sheet for screen readers. */
export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(function SheetTitle({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Title
      ref={ref}
      data-slot="sheet-title"
      className={cn("text-title font-semibold text-foreground", className)}
      {...props}
    />
  );
});

/** Read out after the title when the sheet opens. */
export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(function SheetDescription({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Description
      ref={ref}
      data-slot="sheet-description"
      className={cn("text-body text-muted-foreground", className)}
      {...props}
    />
  );
});
