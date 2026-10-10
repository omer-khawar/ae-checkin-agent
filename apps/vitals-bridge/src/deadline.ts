/**
 * `withDeadline(promise, ms)`: resolve with the promise's outcome, or with `{timedOut: true}` once
 * `ms` elapse, whichever comes first. The underlying work is NOT cancelled (it keeps running in
 * the background); the caller just stops waiting for it.
 *
 * Used by the CLI's shutdown path: a Ctrl-C must return the terminal within a few seconds even if
 * the API is down and a periodic POST is mid-retry (CLAUDE.md §7.5 / README). Kept in its own
 * module so it can be unit-tested without spawning the CLI.
 */
export type DeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true };

export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
