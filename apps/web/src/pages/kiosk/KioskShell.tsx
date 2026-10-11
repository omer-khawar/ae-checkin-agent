/**
 * Kiosk chrome: calm header with progress, a main column for one question, the
 * small vitals card beside it (only when the participant left the camera on),
 * and the persistent disclaimer. Light-only, large type, no clinical language.
 *
 * Vitals card width (docs/ISSUES.md #21): the card lays its three metrics out
 * in a 3-column grid. At the old 18rem side column each column was ~77px, so
 * "HRV (RMSSD)" (~79px in uppercase 12px) wrapped to two lines and values such
 * as "128 beats/min" (~97px) were pushed sideways. The side column is now
 * {@link SIDE_COLUMN_REM} wide (~104px per metric), and when the layout stacks
 * below `lg` the card is capped at `max-w-md` (~130px per metric) so it stays
 * small and secondary instead of stretching across the page.
 *
 * The column width is passed to the grid as the `--kiosk-side` custom property
 * built from {@link SIDE_COLUMN_REM}, so the constant is the single source of
 * truth (the Tailwind class only says "use the variable"; it never repeats the
 * number). Header and main share {@link SHELL_MAX_W} at every step, so the logo
 * and progress bar line up with the content edges and nothing jumps when the
 * vitals card appears; each screen centres its own narrower column inside it.
 */
import type { CSSProperties, ReactNode } from "react";

import { Disclaimer } from "../../components/Disclaimer";
import { ProgressBar } from "../../components/ProgressBar";
import { cx } from "../../lib/format";

export interface KioskShellProps {
  /** e.g. the study short title; never a grade or tier. */
  subtitle?: string;
  progress?: { value: number; max: number } | null;
  /** The VitalsPanel, when the camera is on for this session. */
  side?: ReactNode;
  children: ReactNode;
}

/** Side column (vitals card) width in rem at `lg` and up. Feeds `--kiosk-side`. */
export const SIDE_COLUMN_REM = 23;

/** Shared max width of the header row and the main area (constant across steps). */
export const SHELL_MAX_W = "max-w-6xl";

/** Grid template at `lg`: question column + the side column read from `--kiosk-side`. */
export const SIDE_GRID_CLASS = "grid gap-6 lg:grid-cols-[minmax(0,1fr)_var(--kiosk-side)]";

export function KioskShell({ subtitle, progress, side, children }: KioskShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div
          className={cx(
            "mx-auto flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4",
            SHELL_MAX_W,
          )}
          data-testid="kiosk-header-row"
        >
          <div className="flex items-center gap-2 text-xl font-bold text-brand-800">
            <span className="inline-block h-7 w-7 rounded-lg bg-brand-700" aria-hidden="true" />
            Interim check-in
          </div>
          {subtitle && <div className="truncate text-base text-slate-600">{subtitle}</div>}
          {progress && (
            <ProgressBar
              className="basis-full sm:ml-auto sm:basis-72"
              value={progress.value}
              max={progress.max}
              label="Check-in progress"
            />
          )}
        </div>
      </header>

      <main className={cx("mx-auto w-full flex-1 px-6 py-8", SHELL_MAX_W)}>
        <div
          className={side ? SIDE_GRID_CLASS : undefined}
          style={side ? ({ "--kiosk-side": `${SIDE_COLUMN_REM}rem` } as CSSProperties) : undefined}
        >
          <div className="min-w-0">{children}</div>
          {side && (
            <div
              className="w-full max-w-md lg:sticky lg:top-6 lg:max-w-none lg:self-start"
              data-testid="kiosk-side"
            >
              {side}
            </div>
          )}
        </div>
      </main>

      <Disclaimer large />
    </div>
  );
}
