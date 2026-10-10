import { useEffect } from "react";

import { Button } from "../../components/Button";

export interface ThankYouProps {
  onDone: () => void;
  /** Return to the welcome screen automatically after this many ms (0 = never). */
  autoResetMs?: number;
}

/** Final screen for Tiers 0–2. Next steps only; no grades, tiers or clinical words. */
export function ThankYou({ onDone, autoResetMs = 45_000 }: ThankYouProps) {
  useEffect(() => {
    if (!autoResetMs) return;
    const t = setTimeout(onDone, autoResetMs);
    return () => clearTimeout(t);
  }, [onDone, autoResetMs]);

  return (
    <div className="mx-auto max-w-2xl text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-100 text-3xl text-brand-800"
      >
        ✓
      </div>
      <h1 className="mt-6 text-4xl font-bold text-slate-900">
        Thank you. Your check-in is complete.
      </h1>
      <div className="mt-6 space-y-3 text-xl text-slate-700">
        <p>Your answers have been saved for the study team to review.</p>
        <p>
          If anything changes before your next visit, you can do another check-in or contact the
          study team.
        </p>
        <p className="text-lg text-slate-600">
          If you feel you need urgent help at any time, call 911 or go to the nearest emergency
          room.
        </p>
      </div>
      <Button size="xl" className="mt-10" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
