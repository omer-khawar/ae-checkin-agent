/**
 * Global console shortcuts (not active while typing in a field):
 *   ?        open the shortcut sheet
 *   g w/q/e/n   go to Worklist / Queries / Escalations / Notes
 *   g u      open the next urgent item
 * "g" arms a 1.2 s window for the second key. Modifier combos are left to the browser.
 * (Ctrl/Cmd+K belongs to `useCommandMenu`.)
 */
import { useEffect } from "react";

import { isTypingTarget } from "@/ui/keyboard";

export const GO_KEYS: Record<string, { path: string; label: string }> = {
  w: { path: "/dashboard", label: "Worklist" },
  q: { path: "/dashboard/queries", label: "Queries" },
  e: { path: "/dashboard/escalations", label: "Escalations" },
  n: { path: "/dashboard/notes", label: "Notes" },
};

export interface ShortcutHandlers {
  go: (path: string) => void;
  showHelp: () => void;
  openNextUrgent: () => void;
  enabled?: boolean;
}

export function useGlobalShortcuts({
  go,
  showHelp,
  openNextUrgent,
  enabled = true,
}: ShortcutHandlers): void {
  useEffect(() => {
    if (!enabled) return undefined;
    let armedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // Ignore keys typed inside an open dialog (palette, sheet) except "?" handled by them.
      if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
      if (e.key === "?") {
        e.preventDefault();
        showHelp();
        return;
      }
      const now = Date.now();
      if (armedAt && now - armedAt < 1200) {
        armedAt = 0;
        const k = e.key.toLowerCase();
        if (GO_KEYS[k]) {
          e.preventDefault();
          go(GO_KEYS[k].path);
        } else if (k === "u") {
          e.preventDefault();
          openNextUrgent();
        }
        return;
      }
      if (e.key.toLowerCase() === "g") armedAt = now;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, showHelp, openNextUrgent, enabled]);
}
