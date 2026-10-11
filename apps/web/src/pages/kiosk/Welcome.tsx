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
  /** POST /sessions is in flight. */
  busy?: boolean;
  /** The study ID was not recognised (404 / 422 from POST /sessions). */
  startError: unknown;
  /**
   * Any other failure starting the session (network, 5xx); offers "Try again".
   * The retry is owned by this screen and re-submits what the inputs show NOW
   * (the participant may have corrected the ID or ticked the camera opt-out
   * after the failure), through `onStart`.
   */
  startFailure?: unknown;
  initialId?: string;
  /** `useCamera` is true unless the participant ticked "I'd rather not use the camera". */
  onStart: (studyId: string, useCamera: boolean) => void;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Exact copy kept from the old consent screen (CLAUDE.md §00, D-026). */
export const NO_VIDEO_TEXT = "Only pulse and breathing numbers are kept; no video is stored.";
export const CAMERA_OPT_OUT_LABEL = "I'd rather not use the camera";

/**
 * Screen 1 (and the only screen before the questions): welcome, study ID and
 * the camera opt-out.
 *
 * There is no per-session consent step any more: camera use is covered by the
 * informed consent form signed at enrollment (CLAUDE.md §00, DECISIONS.md
 * D-026; the API records `consent_basis: "enrollment_icf"`). The camera is on
 * by default; the participant can still opt out here with one tap, and the
 * check-in runs exactly the same without it. The kiosk is unauthenticated, so
 * there is no participant picker; the ID is validated for real by POST /sessions.
 */
export function Welcome({
  study,
  loading,
  loadError,
  onRetryLoad,
  busy = false,
  startError,
  startFailure,
  initialId = "",
  onStart,
}: WelcomeProps) {
  const [id, setId] = useState(initialId);
  const [touched, setTouched] = useState(false);
  const [noCamera, setNoCamera] = useState(false);
  /** The normalised ID of the last submit, so a rejection can be tied to it. */
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const trimmed = id.trim();
  const normalized = trimmed.toUpperCase();
  const valid = ID_PATTERN.test(trimmed);
  /**
   * The "check your study ID" banner describes the ID that was rejected; once
   * the participant edits the box it no longer applies, so it is hidden (it
   * reappears if they type the same rejected ID back).
   */
  const showStartError = Boolean(startError) && normalized === submittedId;

  /** Start (or retry) with the values currently on screen. */
  function attemptStart() {
    setTouched(true);
    if (!valid || busy) return;
    setSubmittedId(normalized);
    onStart(normalized, !noCamera);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    attemptStart();
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

      {showStartError ? (
        <ErrorBanner
          className="mt-6"
          error={startError}
          message="We couldn't start a check-in with that study ID. Please check it and try again, or ask the study team."
        />
      ) : null}

      {startFailure ? (
        <ErrorBanner
          className="mt-6"
          error={startFailure}
          message="We couldn't start the check-in. Please try again."
          onRetry={attemptStart}
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
          disabled={busy}
          className="mt-2 block w-full rounded-xl border border-slate-300 bg-white px-4 py-4 font-mono text-2xl tracking-wide text-slate-900 placeholder:text-slate-400 disabled:bg-slate-100"
        />
        <p id="study-id-hint" className="mt-2 text-base text-slate-600">
          It is printed on your study card, e.g. <span className="font-mono">P-007</span>.
        </p>
        {touched && !valid && (
          <p className="mt-2 text-base font-medium text-red-700" role="alert">
            Please enter your study ID to continue.
          </p>
        )}

        {/* Camera opt-out. The whole row is the label, so the tap target is large;
            the native checkbox keeps Space/Enter and screen-reader semantics. */}
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-base text-slate-700" id="camera-note">
            While you answer, the camera can read your pulse and breathing rate.{" "}
            <span className="font-medium text-slate-800">{NO_VIDEO_TEXT}</span>
          </p>
          <label
            htmlFor="no-camera"
            className="mt-3 flex min-h-tap cursor-pointer items-center gap-4 rounded-lg px-1 py-2 text-lg font-medium text-slate-900 hover:bg-slate-50"
          >
            <input
              id="no-camera"
              type="checkbox"
              checked={noCamera}
              onChange={(e) => setNoCamera(e.target.checked)}
              disabled={busy}
              aria-describedby="camera-note camera-state"
              className="h-7 w-7 shrink-0 cursor-pointer rounded border-slate-400 accent-brand-700"
            />
            {CAMERA_OPT_OUT_LABEL}
          </label>
          <p id="camera-state" className="mt-1 text-base text-slate-600" aria-live="polite">
            {noCamera
              ? "The camera will stay off. The check-in is exactly the same without it."
              : "The camera will be on. You can tick the box above to turn it off."}
          </p>
        </div>

        <Button
          type="submit"
          size="xl"
          block
          className="mt-8"
          disabled={loading || busy || Boolean(loadError)}
          busy={loading || busy}
        >
          Start check-in
        </Button>
      </form>
    </div>
  );
}
