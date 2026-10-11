import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

export interface KioskErrorProps {
  /** Plain-language sentence. Never an HTTP code, a field name or a technical word. */
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/**
 * Patient-facing error: one calm sentence and an optional "Try again". The cause
 * (status code, problem+json detail) is deliberately not shown.
 */
export function KioskError({
  message,
  onRetry,
  retryLabel = "Try again",
  className,
}: KioskErrorProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 rounded-control border-2 border-danger-border bg-danger-bg p-4 text-k-body text-danger-fg",
        className,
      )}
    >
      <p className="m-0 min-w-0 flex-1 font-semibold">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="xl" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
