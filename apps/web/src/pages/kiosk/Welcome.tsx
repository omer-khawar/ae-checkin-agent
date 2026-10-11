import { ArrowRight } from "lucide-react";
import { useState, type FormEvent } from "react";

import { QuestionCard } from "@/ui/kiosk/question-card";
import { Button } from "@/ui/button";
import { KioskError } from "./KioskError";

export interface WelcomeProps {
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
  /** `useCamera` is false unless the participant ticked the optional camera box (R5.6). */
  onStart: (studyId: string, useCamera: boolean) => void;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Exact copy kept from the old consent screen (CLAUDE.md §00, D-026). */
export const NO_VIDEO_TEXT = "Only pulse and breathing numbers are kept; no video is stored.";
export const CAMERA_OPT_IN_LABEL = "Use the camera to read my pulse and breathing (optional)";

/**
 * Screen 1 (and the only screen before the questions): welcome, study ID and
 * the optional camera box, on one glass card. No study title and no clinical words.
 *
 * There is no per-session consent step any more: camera use is covered by the
 * informed consent form signed at enrollment (CLAUDE.md §00, DECISIONS.md
 * D-026; the API records `consent_basis: "enrollment_icf"`). The camera is OFF
 * by default (R5.6); the participant can opt in here with one tap, and the
 * check-in runs exactly the same without it. The kiosk is unauthenticated, so
 * there is no participant picker; the ID is validated for real by POST /sessions.
 */
export function Welcome({
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
  /** Camera is OFF by default; the participant opts in (R5.6). */
  const [useCamera, setUseCamera] = useState(false);
  /** The normalised ID of the last submit, so a rejection can be tied to it. */
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const trimmed = id.trim();
  const normalized = trimmed.toUpperCase();
  const valid = ID_PATTERN.test(trimmed);
  /**
   * The "check your study ID" message describes the ID that was rejected; once
   * the participant edits the box it no longer applies, so it is hidden (it
   * reappears if they type the same rejected ID back).
   */
  const showStartError = Boolean(startError) && normalized === submittedId;

  /** Start (or retry) with the values currently on screen. */
  function attemptStart() {
    setTouched(true);
    if (!valid || busy) return;
    setSubmittedId(normalized);
    onStart(normalized, useCamera);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    attemptStart();
  }

  return (
    <div className="mx-auto w-full max-w-k-content">
      <QuestionCard
        title="Welcome"
        titleSize="screen"
        description="This short check-in asks how you have been feeling in the last 7 days. It takes about three minutes."
        focusKey="welcome"
      >
        {loadError ? (
          <KioskError
            message="The check-in could not load. Please ask the study team."
            onRetry={onRetryLoad}
          />
        ) : null}

        {showStartError ? (
          <KioskError message="We couldn't start a check-in with that study ID. Please check it and try again, or ask the study team." />
        ) : null}

        {startFailure ? (
          <KioskError
            message="We couldn't start the check-in. Please try again."
            onRetry={attemptStart}
          />
        ) : null}

        <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
          <div>
            <label htmlFor="study-id" className="block text-k-lead font-semibold">
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
              className="mt-3 block min-h-k-option w-full rounded-control border-2 border-input bg-surface px-5 font-mono text-k-lead tracking-wide text-foreground placeholder:text-subtle-foreground disabled:opacity-60"
            />
            <p id="study-id-hint" className="mt-2 text-k-helper text-muted-foreground">
              It is printed on your study card, e.g. <span className="font-mono">P-007</span>.
            </p>
            {touched && !valid && (
              <p role="alert" className="mt-2 text-k-helper font-semibold text-destructive">
                Please enter your study ID to continue.
              </p>
            )}
          </div>

          {/* Camera opt-in. The whole row is the label, so the tap target is large;
              the native checkbox keeps Space/Enter and screen-reader semantics. */}
          <div className="rounded-control border-2 border-border bg-surface p-5">
            <p className="m-0 text-k-helper text-muted-foreground" id="camera-note">
              While you answer, the camera can read your pulse and breathing rate.{" "}
              <span className="font-semibold text-foreground">{NO_VIDEO_TEXT}</span>
            </p>
            <label
              htmlFor="use-camera"
              className="mt-3 flex min-h-k-option cursor-pointer items-center gap-4 rounded-control px-1 text-k-answer font-semibold hover:bg-surface-subtle"
            >
              <input
                id="use-camera"
                type="checkbox"
                checked={useCamera}
                onChange={(e) => setUseCamera(e.target.checked)}
                disabled={busy}
                aria-describedby="camera-note camera-state"
                className="size-8 shrink-0 cursor-pointer accent-primary"
              />
              {CAMERA_OPT_IN_LABEL}
            </label>
            <p
              id="camera-state"
              className="mt-1 text-k-helper text-muted-foreground"
              aria-live="polite"
            >
              {useCamera
                ? "The camera will be on. You can untick the box above to turn it off."
                : "The camera will stay off. The check-in is exactly the same without it."}
            </p>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="xl"
            fullWidth
            loading={loading || busy}
            disabled={Boolean(loadError)}
            trailingIcon={<ArrowRight />}
          >
            Start check-in
          </Button>
        </form>
      </QuestionCard>
    </div>
  );
}
