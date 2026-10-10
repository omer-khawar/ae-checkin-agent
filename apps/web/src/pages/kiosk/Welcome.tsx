import { useState, type FormEvent } from "react";

import { Button } from "../../components/Button";
import { ErrorBanner } from "../../components/ErrorBanner";
import type { Study } from "../../lib/types";

export interface WelcomeProps {
  study: Study | null;
  loading: boolean;
  /** Error loading /items or /study. */
  loadError: unknown;
  onRetryLoad: () => void;
  /** Error from the previous attempt to start a session (e.g. unknown ID). */
  startError: unknown;
  initialId?: string;
  onStart: (studyId: string) => void;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Screen 1: welcome + study ID. The kiosk is unauthenticated so there is no
 * participant picker; the ID is validated for real by POST /sessions.
 */
export function Welcome({
  study,
  loading,
  loadError,
  onRetryLoad,
  startError,
  initialId = "",
  onStart,
}: WelcomeProps) {
  const [id, setId] = useState(initialId);
  const [touched, setTouched] = useState(false);
  const trimmed = id.trim();
  const valid = ID_PATTERN.test(trimmed);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    onStart(trimmed.toUpperCase());
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-4xl font-bold text-slate-900">Welcome</h1>
      <p className="mt-3 text-xl text-slate-700">
        This short check-in asks how you have been feeling in the last 7 days. It takes about three
        minutes.
      </p>
      {study && (
        <p className="mt-2 text-base text-slate-600">
          Study: <span className="font-medium text-slate-800">{study.title}</span>
        </p>
      )}

      {loadError ? (
        <ErrorBanner
          className="mt-6"
          error={loadError}
          message="The check-in could not load. Please ask the study team."
          onRetry={onRetryLoad}
        />
      ) : null}

      {startError ? (
        <ErrorBanner
          className="mt-6"
          error={startError}
          message="We couldn't start a check-in with that study ID. Please check it and try again, or ask the study team."
        />
      ) : null}

      <form onSubmit={submit} className="mt-8" noValidate>
        <label htmlFor="study-id" className="block text-lg font-semibold text-slate-800">
          Your study ID
        </label>
        <input
          id="study-id"
          name="study-id"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={id}
          onChange={(e) => setId(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="e.g. P-007"
          aria-describedby="study-id-hint"
          aria-invalid={touched && !valid ? true : undefined}
          className="mt-2 block w-full rounded-xl border border-slate-300 bg-white px-4 py-4 font-mono text-2xl tracking-wide text-slate-900 placeholder:text-slate-400"
        />
        <p id="study-id-hint" className="mt-2 text-base text-slate-600">
          It is printed on your study card, e.g. <span className="font-mono">P-007</span>.
        </p>
        {touched && !valid && (
          <p className="mt-2 text-base font-medium text-red-700" role="alert">
            Please enter your study ID to continue.
          </p>
        )}

        <Button
          type="submit"
          size="xl"
          block
          className="mt-8"
          disabled={loading || Boolean(loadError)}
          busy={loading}
        >
          Start check-in
        </Button>
      </form>
    </div>
  );
}
