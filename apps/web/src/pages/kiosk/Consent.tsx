import { Button } from "../../components/Button";
import { ErrorBanner } from "../../components/ErrorBanner";

export interface ConsentProps {
  usubjid: string;
  busy: boolean;
  error: unknown;
  onRetry: () => void;
  /** true = camera on, false = continue without vitals. */
  onDecide: (consent: boolean) => void;
}

/**
 * Screen 2: plain-language camera consent (CLAUDE.md §3.3). Consent is asked
 * every session and is itself an audited event on the API side.
 */
export function Consent({ usubjid, busy, error, onRetry, onDecide }: ConsentProps) {
  return (
    <div className="mx-auto max-w-2xl">
      <p className="text-base text-slate-600">
        Study ID <span className="font-mono font-semibold text-slate-800">{usubjid}</span>
      </p>
      <h1 className="mt-1 text-4xl font-bold text-slate-900">
        May we use the camera during your check-in?
      </h1>

      <div className="mt-6 space-y-4 text-xl text-slate-800">
        <p>
          While you answer, the camera can estimate your pulse and breathing rate from your face and
          chest.
        </p>
        <ul className="list-disc space-y-2 pl-7 text-lg text-slate-700">
          <li>
            Only the <strong>numbers</strong> (pulse and breathing rate) are kept, with the time
            they were taken.
          </li>
          <li>
            <strong>No video or photos are stored</strong> or sent anywhere.
          </li>
          <li>The numbers are attached to your answers so the study team can see them together.</li>
          <li>
            They are not used to diagnose anything, and nobody will give you medical advice based on
            them.
          </li>
        </ul>
        <p className="text-lg text-slate-700">
          If you say <strong>No</strong>, the check-in continues exactly the same, just without the
          camera.
        </p>
      </div>

      {error ? (
        <ErrorBanner
          className="mt-6"
          error={error}
          message="We couldn't start the check-in. Please try again."
          onRetry={onRetry}
        />
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Button size="xl" onClick={() => onDecide(true)} disabled={busy} busy={busy}>
          Yes, use the camera
        </Button>
        <Button size="xl" variant="secondary" onClick={() => onDecide(false)} disabled={busy}>
          No, continue without it
        </Button>
      </div>
    </div>
  );
}
