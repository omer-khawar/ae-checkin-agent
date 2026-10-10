/**
 * Kiosk chrome: calm header with progress, a main column for one question, the
 * small vitals card beside it (only when the participant consented), and the
 * persistent disclaimer. Light-only, large type, no clinical language.
 */
import type { ReactNode } from "react";

import { Disclaimer } from "../../components/Disclaimer";
import { ProgressBar } from "../../components/ProgressBar";

export interface KioskShellProps {
  /** e.g. the study short title; never a grade or tier. */
  subtitle?: string;
  progress?: { value: number; max: number } | null;
  /** The VitalsPanel, when consent was given. */
  side?: ReactNode;
  children: ReactNode;
}

export function KioskShell({ subtitle, progress, side, children }: KioskShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
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

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
        <div className={side ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]" : ""}>
          <div className="min-w-0">{children}</div>
          {side && <div className="lg:sticky lg:top-6 lg:self-start">{side}</div>}
        </div>
      </main>

      <Disclaimer large />
    </div>
  );
}
