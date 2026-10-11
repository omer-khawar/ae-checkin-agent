import { CircleX } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

import { describeError, isApiError } from "../lib/api";

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
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-panel border border-danger-border bg-danger-bg px-3 py-2 text-danger-fg",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <div className="font-semibold">{message ?? "Something went wrong"}</div>
          <div className="mt-0.5 break-words text-table">
            {status !== null && <span className="tabular mr-1 font-mono">HTTP {status}</span>}
            {text}
          </div>
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
