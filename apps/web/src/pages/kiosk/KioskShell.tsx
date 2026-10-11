/**
 * Kiosk chrome (UI phase 2): `data-surface="kiosk"` scope (Atkinson, 20px root,
 * 26px with "Larger text"), a calm glass header with the camera status line,
 * "Larger text" and "Need help?", one main column for one question, and a bottom
 * slot that holds either the sticky KioskActionBar (question screens, which
 * carries the footer sentence) or the plain footer sentence (welcome, thank-you,
 * stop, saving). The study title and every clinical word stay off patient screens.
 *
 * The numbers card (`side`) is passed only in presenter mode (`?presenter=1`).
 * Its column width is {@link SIDE_COLUMN_REM}, handed to the grid as the
 * `--kiosk-side` custom property so the constant is the single source of truth
 * (docs/ISSUES.md #21). Header and main share {@link SHELL_MAX_W} at every step so
 * nothing jumps when the card appears.
 */
import { HelpCircle, Type } from "lucide-react";
import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Disclaimer } from "../../components/Disclaimer";
import { cn } from "@/lib/cn";
import { FALLBACK_SITE_PHONE } from "../../lib/gates";
import { Button } from "@/ui/button";
import { ReadAloudToggle } from "@/ui/kiosk/read-aloud";

export interface KioskShellProps {
  /** Quiet camera line, e.g. "Camera on · simulated" or "Camera off". Hidden when omitted. */
  statusLine?: string;
  /** The VitalsPanel, presenter mode only. */
  side?: ReactNode;
  /**
   * True on question screens: the shell then reserves the bottom slot for the sticky
   * KioskActionBar (rendered by the screen through {@link KioskBottom}, and carrying the
   * footer sentence). Otherwise the plain footer sentence is shown.
   */
  hasActionBar?: boolean;
  /** The study team's phone line (GET /settings/public); shown under the help text. */
  sitePhone?: string;
  /**
   * The help line closes whenever this value changes, so it never stays open for the
   * next person (the flow passes "active" during a check-in and the finished step after).
   */
  helpResetKey?: string;
  children: ReactNode;
}

/** Side column (vitals card) width in rem at `lg` and up. Feeds `--kiosk-side`. */
export const SIDE_COLUMN_REM = 23;

/** Shared max width of the header row and the main area (constant across steps). */
export const SHELL_MAX_W = "max-w-6xl";

/** Grid template at `lg`: question column + the side column read from `--kiosk-side`. */
export const SIDE_GRID_CLASS = "grid gap-6 lg:grid-cols-[minmax(0,1fr)_var(--kiosk-side)]";

/** Calm, fixed message for "Need help?"; no medical advice. */
export const HELP_TEXT =
  "Please ask the study team member nearby. They are happy to help you with this screen.";

/** `undefined` outside a shell (inline render), `null` until the slot element mounts. */
const BottomSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * Renders its children (the sticky action bar) into the shell's bottom slot, so the bar
 * is a direct child of the full-height shell and can stick to the viewport bottom.
 * Outside a shell (unit tests of a single screen) it renders inline.
 */
export function KioskBottom({ children }: { children: ReactNode }) {
  const slot = useContext(BottomSlot);
  if (slot === undefined) return <>{children}</>;
  if (slot === null) return null;
  return createPortal(children, slot);
}

export function KioskShell({
  statusLine,
  side,
  hasActionBar = false,
  sitePhone = FALLBACK_SITE_PHONE,
  helpResetKey,
  children,
}: KioskShellProps) {
  const [large, setLarge] = useState(false);
  // The help line is open only for the reset key it was opened under, so it closes in the
  // same render the key changes (playtest: it stayed open for the next person).
  const [helpOpenFor, setHelpOpenFor] = useState<string | null>(null);
  const resetKey = helpResetKey ?? "";
  const helpOpen = helpOpenFor === resetKey;
  const setHelpOpen = (next: (open: boolean) => boolean) =>
    setHelpOpenFor(next(helpOpen) ? resetKey : null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  return (
    <BottomSlot.Provider value={slot}>
      <div
        data-surface="kiosk"
        data-text-size={large ? "large" : undefined}
        className="flex min-h-screen flex-col bg-background font-sans text-foreground"
      >
        <header className="glass-strong sticky top-0 z-10 rounded-b-sheet border-t-0">
          <div
            className={cn(
              "mx-auto flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3",
              SHELL_MAX_W,
            )}
            data-testid="kiosk-header-row"
          >
            <div className="flex items-center gap-3 text-k-lead font-bold text-primary">
              <span className="inline-block size-8 rounded-control bg-primary" aria-hidden="true" />
              Interim check-in
            </div>
            {statusLine && (
              <p
                className="m-0 text-k-disclaimer text-muted-foreground"
                data-testid="kiosk-camera-status"
              >
                {statusLine}
              </p>
            )}
            <div className="ml-auto flex items-center gap-3">
              <Button
                variant="secondary"
                size="xl"
                className="min-h-12 min-w-0 px-4 text-k-helper"
                aria-pressed={large}
                leadingIcon={<Type />}
                onClick={() => setLarge((v) => !v)}
              >
                Larger text
              </Button>
              <ReadAloudToggle />
              <Button
                variant="secondary"
                size="xl"
                className="min-h-12 min-w-0 px-4 text-k-helper"
                aria-expanded={helpOpen}
                aria-controls="kiosk-help"
                leadingIcon={<HelpCircle />}
                onClick={() => setHelpOpen((v) => !v)}
              >
                Need help?
              </Button>
            </div>
          </div>
          {helpOpen && (
            <div
              id="kiosk-help"
              role="status"
              className={cn("mx-auto px-6 pb-4 text-k-body text-foreground", SHELL_MAX_W)}
            >
              <p className="m-0">{HELP_TEXT}</p>
              <p className="m-0 mt-2 font-bold" data-testid="help-phone">
                Call the study team: {sitePhone}
              </p>
            </div>
          )}
        </header>

        <main
          className={cn("mx-auto w-full flex-1 px-6", hasActionBar ? "py-4" : "py-8", SHELL_MAX_W)}
        >
          <div
            className={side ? SIDE_GRID_CLASS : undefined}
            style={
              side ? ({ "--kiosk-side": `${SIDE_COLUMN_REM}rem` } as CSSProperties) : undefined
            }
          >
            <div className="min-w-0">{children}</div>
            {side && (
              <div
                className="w-full max-w-md lg:sticky lg:top-24 lg:max-w-none lg:self-start"
                data-testid="kiosk-side"
              >
                {side}
              </div>
            )}
          </div>
        </main>

        {hasActionBar ? <div ref={setSlot} className="contents" /> : <Disclaimer large />}
      </div>
    </BottomSlot.Provider>
  );
}
