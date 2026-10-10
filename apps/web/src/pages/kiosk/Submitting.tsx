import { ErrorBanner } from "../../components/ErrorBanner";

export interface SubmittingProps {
  error: unknown;
  onRetry: () => void;
}

/** Shown while the bridge flushes (≤ 2.5 s) and `/complete` runs. */
export function Submitting({ error, onRetry }: SubmittingProps) {
  return (
    <div className="mx-auto max-w-2xl text-center" role="status" aria-live="polite">
      {error ? (
        <ErrorBanner
          error={error}
          message="We couldn't finish saving your check-in. Please try again."
          onRetry={onRetry}
        />
      ) : (
        <>
          <span
            aria-hidden="true"
            className="mx-auto block h-12 w-12 animate-spin rounded-full border-4 border-brand-200 border-t-brand-700"
          />
          <h1 className="mt-6 text-3xl font-bold text-slate-900">Saving your answers…</h1>
          <p className="mt-2 text-lg text-slate-600">This only takes a moment.</p>
        </>
      )}
    </div>
  );
}
