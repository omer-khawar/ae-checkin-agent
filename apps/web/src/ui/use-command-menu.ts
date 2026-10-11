/**
 * useCommandMenu: open state for <CommandMenu> plus the global shortcut that toggles it.
 *
 * Adapted from `useCommandShortcut` in "Command Menu" by uvain
 * (https://21st.dev/community/components/uvain/command-menu-palette, 21st.dev demo 33510).
 * Kept: Ctrl+K / Cmd+K toggles the menu from anywhere (even inside a text field, the
 * convention users expect). Added: an optional `/` shortcut that only OPENS the menu and is
 * ignored while the user is typing (audit G-14: "Ctrl+K, /"), key-repeat suppression, and an
 * `enabled` switch so the kiosk (or a page with its own palette) can turn the shortcut off.
 *
 * Lives in its own module (not command-menu.tsx) so that file exports only components
 * (react-refresh HMR rule); `@/ui/command-menu` re-exports nothing but components.
 */
import * as React from "react";

import { isTypingTarget } from "@/ui/keyboard";

export interface UseCommandMenuOptions {
  /** Letter used with Ctrl/Cmd. Default "k". */
  key?: string;
  /** Also open on "/" when focus is not in a text field. Default false. */
  slash?: boolean;
  /** Register the shortcuts at all. Default true. */
  enabled?: boolean;
}

export interface UseCommandMenuResult {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export function useCommandMenu({
  key = "k",
  slash = false,
  enabled = true,
}: UseCommandMenuOptions = {}): UseCommandMenuResult {
  const [open, setOpen] = React.useState(false);
  const toggle = React.useCallback(() => setOpen((o) => !o), []);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === key) {
        event.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (
        slash &&
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, slash, enabled]);

  return { open, setOpen, toggle };
}
