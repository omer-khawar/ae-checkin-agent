import { useEffect } from "react";

import { Button } from "../../components/Button";

/**
 * Fallback only if the API omits `stop_screen_text`. Verbatim from CLAUDE.md §3.4(e).
 * The API's text always wins when present.
 */
export const DEFAULT_STOP_TEXT =
  "Thank you. A member of the study team will contact you today. If you feel you need urgent help right now, call 911 or go to the nearest emergency room.";

export interface StopProps {
  /** The fixed, pre-approved text returned by POST /complete. */
  text: string | undefined;
  onDone: () => void;
  autoResetMs?: number;
}

/**
 * Tier 3 stop screen. Shows the API's fixed text and nothing else: no tier, no
 * grade, no explanation. A single "Done" button resets the kiosk for the next
 * participant (it also resets itself after a while).
 */
export function Stop({ text, onDone, autoResetMs = 90_000 }: StopProps) {
  useEffect(() => {
    if (!autoResetMs) return;
    const t = setTimeout(onDone, autoResetMs);
    return () => clearTimeout(t);
  }, [onDone, autoResetMs]);

  return (
    <div className="mx-auto max-w-2xl text-center" data-testid="stop-screen">
      <p className="text-3xl font-semibold leading-relaxed text-slate-900 sm:text-4xl">
        {text || DEFAULT_STOP_TEXT}
      </p>
      <Button size="xl" variant="secondary" className="mt-12" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
