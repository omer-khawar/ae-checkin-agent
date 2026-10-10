import type { ReactNode } from "react";

import { describeError, isApiError } from "../lib/api";
import { cx } from "../lib/format";
import { Button } from "./Button";

export interface ErrorBannerProps {
  /** An Error / ApiError / string. Nothing renders when null. */
  error: unknown;
  /** Override the message (e.g. participant-friendly wording on the kiosk). */
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/** Inline error with optional retry. Shows the problem+json title/detail when present. */
export function ErrorBanner({
  error,
  message,
  onRetry,
  retryLabel = "Try again",
  className,
}: ErrorBannerProps) {
  if (!error) return null;
  const text = describeError(error);
  const status = isApiError(error) ? error.status : null;
  return (
    <div
      role="alert"
      className={cx(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-red-800",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{message ?? "Something went wrong"}</div>
        <div className="mt-0.5 break-words text-sm opacity-90">
          {status !== null && <span className="tnum mr-1 font-mono">HTTP {status}</span>}
          {text}
        </div>
      </div>
      {onRetry && (
        <Button variant="secondary" size="md" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
