import { Loader2 } from "lucide-react";

import { KioskError } from "./KioskError";

export interface SubmittingProps {
  error: unknown;
  onRetry: () => void;
}

/** Shown while the bridge flushes (≤ 2.5 s) and `/complete` runs. */
export function Submitting({ error, onRetry }: SubmittingProps) {
  return (
    <section
      className="glass mx-auto flex w-full max-w-k-content flex-col items-center gap-4 rounded-sheet p-10 text-center"
      role="status"
      aria-live="polite"
    >
      {error ? (
        <KioskError
          message="We couldn't finish saving your check-in. Please try again."
          onRetry={onRetry}
          className="w-full"
        />
      ) : (
        <>
          <Loader2
            aria-hidden="true"
            className="size-12 text-primary motion-safe:animate-spin"
            strokeWidth={2.5}
          />
          <h1 className="m-0 text-k-question">Saving your answers…</h1>
          <p className="m-0 text-k-body text-muted-foreground">This only takes a moment.</p>
        </>
      )}
    </section>
  );
}
