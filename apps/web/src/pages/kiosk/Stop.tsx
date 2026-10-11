import { useEffect } from "react";

import { FALLBACK_SITE_PHONE, FALLBACK_STOP_TEXT, UNSAVED_STOP_TEXT } from "../../lib/gates";
import { useReadAloud, useSpeakOnShow } from "../../lib/speech";
import { Button } from "@/ui/button";

/**
 * Fallback only if the API omits `stop_screen_text` (R5.1, verbatim from
 * escalation_ladder.json). The API's text always wins when present.
 */
const DEFAULT_STOP_TEXT = FALLBACK_STOP_TEXT;

export interface StopProps {
  /** The fixed, pre-approved text returned by POST /complete or POST /urgent. */
  text: string | undefined;
  /** The study team's phone line (GET /settings/public `site_phone`). */
  sitePhone?: string;
  /** True when POST /urgent could not be delivered: the "answers were saved" claim is dropped. */
  unsaved?: boolean;
  onDone: () => void;
  autoResetMs?: number;
}

/**
 * Stop screen (Tier 3 or an urgent answer). Shows the fixed text, the study team's phone
 * line and nothing else: no tier, no grade, no explanation, no colour that signals alarm.
 * A single "Done" button resets the kiosk for the next participant (it also resets itself
 * after a while).
 */
export function Stop({
  text,
  sitePhone = FALLBACK_SITE_PHONE,
  unsaved = false,
  onDone,
  autoResetMs = 90_000,
}: StopProps) {
  useEffect(() => {
    if (!autoResetMs) return;
    const t = setTimeout(onDone, autoResetMs);
    return () => clearTimeout(t);
  }, [onDone, autoResetMs]);

  const shown = unsaved ? UNSAVED_STOP_TEXT : text || DEFAULT_STOP_TEXT;
  const phoneLine = `Call the study team: ${sitePhone}`;
  const { on: readAloud } = useReadAloud();
  useSpeakOnShow([shown, phoneLine], readAloud);

  return (
    <section
      className="glass mx-auto flex w-full max-w-k-content flex-col items-center gap-8 rounded-sheet p-8 text-center sm:p-12"
      data-testid="stop-screen"
    >
      <p className="m-0 text-k-question leading-relaxed text-foreground">{shown}</p>
      <p className="m-0 text-k-lead font-bold text-foreground" data-testid="stop-phone">
        {phoneLine}
      </p>
      <Button size="xl" variant="secondary" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}
