/**
 * HTTP client to the Interim API (docs/CONTRACTS.md §3.2).
 *
 * Responsibilities:
 *  - Buffer gated samples for the active session and POST them every 2 s as
 *    `{"samples": [VitalsSample...]}` (camelCase, exactly CLAUDE.md §7.1) to
 *    `{api}/api/v1/sessions/{sessionId}/vitals`, with `X-Bridge-Token` when configured.
 *  - On a 5xx / 408 / 429 or a network error: retry once, then keep the samples buffered (bounded
 *    to 120, oldest dropped) and try again on the next flush. The bridge must keep running while
 *    the API is down; a kiosk should never crash because the laptop lost Wi-Fi.
 *  - On a *terminal* client error (400, 404, 413, 415, 422) the batch is dropped with one WARN
 *    naming the status and a body excerpt. Re-sending identical bytes cannot succeed (the session
 *    was reset, or the payload is malformed), so retrying every 2 s would only spam the API and
 *    the log. This narrows the contract's "retry once, then keep buffering" to the errors where
 *    buffering can help; the deviation is logged in docs/DECISIONS.md.
 *  - `stopBatching()` delivers EVERYTHING still buffered before forgetting the session: it waits
 *    for an in-flight POST, then flushes until the buffer is empty or a flush fails. Samples that
 *    arrived while a POST was in flight are the last 1-2 s of eSource; they are never silently
 *    dropped while the API is healthy (CLAUDE.md §3.3: every vitals sample is persisted).
 *    The final flush uses a short per-request timeout (`finalFlushTimeoutMs`, 1.5 s) so a kiosk
 *    `stop` or a Ctrl-C with the API down is bounded (~3.25 s worst case), matching the web's
 *    2.5 s post-flush wait rather than the 5 s steady-state timeout.
 *  - `getPublicSettings()` reads `GET /api/v1/settings/public` on session start so the admin
 *    panel's `mock_scenario`, `min_confidence` and `timing_gates` win over built-in defaults. It
 *    has its own short timeout (`settingsTimeoutMs`, 1.5 s): a hanging API must not delay the
 *    first session status past the kiosk's capture-lost grace. A failure is tolerated and logged.
 *
 * The client is stateless beyond the current session: samples that could not be delivered before
 * the session ended are reported and discarded (the kiosk completes the check-in regardless; the
 * record is then flagged `vitals_status: "unavailable"` by the API).
 *
 * Uses the global `fetch` (Node 20+). `fetchImpl` is injectable for tests.
 */
import { ulid } from 'ulid';
import { type Logger, silentLogger } from './log.js';
import type { VitalsSample } from './sources/types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Shape of `GET /api/v1/settings/public` (docs/CONTRACTS.md §2.1); all fields optional here. */
export interface PublicSettings {
  vitals_source?: string;
  mock_scenario?: string;
  simulated_as_measured?: boolean;
  min_confidence?: number;
  timing_gates?: { pulse_s?: number; breathing_s?: number; hrv_s?: number };
}

export interface ApiClientOptions {
  /** e.g. http://localhost:8000 (a trailing slash is tolerated). */
  apiBase: string;
  /** Sent as X-Bridge-Token when set (env BRIDGE_TOKEN). */
  token?: string | undefined;
  fetchImpl?: FetchLike;
  log?: Logger;
  /** Max samples kept while the API is unreachable. Default 120 (= 2 min at 1 Hz). */
  maxBuffer?: number;
  /** Default 2000 ms. */
  flushIntervalMs?: number;
  /** Per-request timeout for periodic flushes. Default 5000 ms. */
  requestTimeoutMs?: number;
  /** Per-request timeout for the final flush in `stopBatching()`. Default 1500 ms. */
  finalFlushTimeoutMs?: number;
  /** Timeout for `GET /settings/public`. Default 1500 ms. */
  settingsTimeoutMs?: number;
  /** Pause before the single retry. Default 250 ms. */
  retryDelayMs?: number;
}

export interface FlushResult {
  attempted: number;
  posted: number;
  ok: boolean;
  reason?: string;
}

export interface ApiStats {
  /** Samples acknowledged by the API. */
  posted: number;
  /** Successful batch POSTs. */
  batches: number;
  /** Batches that failed after the retry (retryable failures: 5xx, network, timeout). */
  failedBatches: number;
  /** Batches the API rejected with a terminal client error (400/404/413/415/422); not retried. */
  rejectedBatches: number;
  /** Samples in rejected batches. */
  rejected: number;
  /** Samples dropped because the bounded buffer overflowed or the session ended unposted. */
  dropped: number;
  consecutiveFailures: number;
}

export const DEFAULT_MAX_BUFFER = 120;
export const DEFAULT_FLUSH_INTERVAL_MS = 2000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_FINAL_FLUSH_TIMEOUT_MS = 1500;
export const DEFAULT_SETTINGS_TIMEOUT_MS = 1500;
export const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * HTTP statuses for which re-sending the same batch cannot succeed. 400/422: the payload is
 * malformed (a bridge bug, not a network condition). 404: the session is gone (e.g. the admin ran
 * POST /admin/reset mid-check-in). 413/415: the request itself is unacceptable. Everything else
 * (5xx, 408, 429, 401/403 while an operator fixes BRIDGE_TOKEN on the API side) is retried and
 * buffered, because the API may start accepting the very same bytes shortly.
 */
export const TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 415, 422]);

/** Upper bound on consecutive flushes `stopBatching()` performs; guards against a source that keeps emitting. */
const MAX_FINAL_FLUSHES = 10;

/** Characters of the response body quoted in a terminal-rejection log line. */
const BODY_EXCERPT_CHARS = 200;

/**
 * Find an OS error code (ECONNREFUSED, ENOTFOUND, ...) on a fetch failure's `cause`. Node wraps
 * the dial error either directly or, when it tried several addresses (happy eyeballs), inside an
 * AggregateError whose `errors[]` carry the codes; look through both.
 */
function errorCode(cause: unknown, depth = 0): string | null {
  if (cause === null || typeof cause !== 'object' || depth > 3) return null;
  const c = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof c.code === 'string' && c.code.length > 0) return c.code;
  if (Array.isArray(c.errors)) {
    for (const inner of c.errors) {
      const code = errorCode(inner, depth + 1);
      if (code) return code;
    }
  }
  return errorCode(c.cause, depth + 1);
}

/**
 * Human-readable one-liner for a fetch failure: the OS error code when there is one
 * (`fetch failed [ECONNREFUSED]`), otherwise the cause's own message (`fetch failed (bad port)`),
 * otherwise just the message.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'request timed out';
    const cause: unknown = (err as Error & { cause?: unknown }).cause;
    const code = errorCode(cause);
    if (code) return `${err.message} [${code}]`;
    if (cause instanceof Error && cause.message && cause.message !== err.message) {
      return `${err.message} (${cause.message})`;
    }
    return err.message;
  }
  return String(err);
}

/** One line of a response body for a log message: whitespace collapsed, length capped. */
export function bodyExcerpt(body: string, max = BODY_EXCERPT_CHARS): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient {
  readonly stats: ApiStats = {
    posted: 0,
    batches: 0,
    failedBatches: 0,
    rejectedBatches: 0,
    rejected: 0,
    dropped: 0,
    consecutiveFailures: 0,
  };
  readonly apiBase: string;

  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger;
  private readonly maxBuffer: number;
  private readonly flushIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly finalFlushTimeoutMs: number;
  private readonly settingsTimeoutMs: number;
  private readonly retryDelayMs: number;

  private buffer: VitalsSample[] = [];
  private sessionId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<FlushResult> | null = null;
  private overflowWarnings = 0;

  constructor(opts: ApiClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, '');
    this.token = opts.token && opts.token.length > 0 ? opts.token : undefined;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.log = opts.log ?? silentLogger;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.finalFlushTimeoutMs = opts.finalFlushTimeoutMs ?? DEFAULT_FINAL_FLUSH_TIMEOUT_MS;
    this.settingsTimeoutMs = opts.settingsTimeoutMs ?? DEFAULT_SETTINGS_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /** Samples waiting to be posted. */
  get buffered(): number {
    return this.buffer.length;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  vitalsUrl(sessionId: string): string {
    return `${this.apiBase}/api/v1/sessions/${encodeURIComponent(sessionId)}/vitals`;
  }

  /** Begin accepting samples for `sessionId` and flushing them every `flushIntervalMs`. */
  startBatching(sessionId: string): void {
    if (this.sessionId !== null && this.sessionId !== sessionId && this.buffer.length > 0) {
      // Samples belong to a session; never let them leak into another one.
      this.log.warn(
        `discarding ${this.buffer.length} unposted sample(s) from session ${this.sessionId} before starting ${sessionId}`,
      );
      this.stats.dropped += this.buffer.length;
      this.buffer = [];
    }
    this.sessionId = sessionId;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Never let the flush timer alone keep the process alive.
    this.timer.unref();
  }

  /**
   * Stop the timer, deliver everything still buffered, then forget the session.
   *
   * Order matters: a POST started by the timer may be in flight, and samples enqueued since it
   * started are NOT part of it (`flush()` only shares the in-flight promise). So: wait for the
   * in-flight request, then flush again until the buffer is empty or a flush fails. Only what a
   * failed flush left behind is discarded, and the log says why (the real reason, never a generic
   * "unreachable" when the API answered).
   */
  async stopBatching(): Promise<FlushResult | null> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sessionId === null) return null;
    const sessionId = this.sessionId;

    let result: FlushResult = { attempted: 0, posted: 0, ok: true };
    if (this.inFlight) result = await this.inFlight;
    let rounds = 0;
    while (result.ok && this.sessionId === sessionId && this.buffer.length > 0) {
      if (rounds >= MAX_FINAL_FLUSHES) {
        result = { attempted: 0, posted: 0, ok: false, reason: 'samples kept arriving after stop' };
        break;
      }
      rounds += 1;
      result = await this.flush({ requestTimeoutMs: this.finalFlushTimeoutMs });
    }

    if (this.sessionId !== sessionId) {
      // A concurrent startBatching() for another session already took over; nothing to clean up.
      return result;
    }
    if (this.buffer.length > 0) {
      const reason = result.reason ?? (result.ok ? 'flush incomplete' : 'flush failed');
      this.log.warn(
        `session ${sessionId} ended with ${this.buffer.length} sample(s) that could not be posted (${reason}); discarding them. The API will mark the check-in's vitals as unavailable/partial.`,
      );
      this.stats.dropped += this.buffer.length;
      this.buffer = [];
    }
    this.sessionId = null;
    return result;
  }

  /** Queue a gated sample. Returns false (and drops it) when no session is active. */
  enqueue(sample: VitalsSample): boolean {
    if (this.sessionId === null) return false;
    this.buffer.push(sample);
    this.enforceBound();
    return true;
  }

  /**
   * POST everything buffered (one batch). Concurrent callers share the in-flight request; note
   * that samples enqueued after a POST started are NOT in it (see `stopBatching`).
   */
  flush(opts: { requestTimeoutMs?: number } = {}): Promise<FlushResult> {
    if (this.inFlight) return this.inFlight;
    if (this.sessionId === null || this.buffer.length === 0) {
      return Promise.resolve({ attempted: 0, posted: 0, ok: true });
    }
    const sessionId = this.sessionId;
    const batch = this.buffer;
    this.buffer = [];
    const p = this.post(sessionId, batch, opts.requestTimeoutMs ?? this.requestTimeoutMs).finally(
      () => {
        this.inFlight = null;
      },
    );
    this.inFlight = p;
    return p;
  }

  /** GET /api/v1/settings/public; null (never a throw) when the API cannot be reached in time. */
  async getPublicSettings(): Promise<PublicSettings | null> {
    const url = `${this.apiBase}/api/v1/settings/public`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.settingsTimeoutMs),
      });
      if (!res.ok) {
        this.log.warn(`GET ${url} returned HTTP ${res.status}; using the CLI/env settings`);
        return null;
      }
      const data: unknown = await res.json();
      if (data === null || typeof data !== 'object') {
        this.log.warn(`GET ${url} returned a non-object body; using the CLI/env settings`);
        return null;
      }
      return data as PublicSettings;
    } catch (err) {
      this.log.warn(`GET ${url} failed (${describeError(err)}); using the CLI/env settings`);
      return null;
    }
  }

  // ---- internals ---------------------------------------------------------------------------

  private async post(
    sessionId: string,
    batch: VitalsSample[],
    timeoutMs: number,
  ): Promise<FlushResult> {
    const url = this.vitalsUrl(sessionId);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      // Idempotency hint for the API (optional for it to honour): one ULID per batch attempt pair.
      'x-bridge-batch-id': ulid(),
    };
    if (this.token) headers['x-bridge-token'] = this.token;
    const body = JSON.stringify({ samples: batch });

    let reason = 'unknown';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Drain the body so the socket can be reused; keep it for a terminal-rejection excerpt.
        const text = await res.text().catch(() => '');
        if (res.ok) {
          this.onBatchPosted(batch.length);
          return { attempted: batch.length, posted: batch.length, ok: true };
        }
        reason = `HTTP ${res.status}`;
        if (TERMINAL_STATUSES.has(res.status)) {
          return this.onBatchRejected(url, batch, res.status, text);
        }
      } catch (err) {
        reason = describeError(err);
      }
      if (attempt === 1) {
        this.log.debug(`POST ${url} attempt 1 failed (${reason}); retrying once`);
        await sleep(this.retryDelayMs);
      }
    }

    this.requeue(sessionId, batch);
    this.stats.failedBatches += 1;
    this.stats.consecutiveFailures += 1;
    this.logFailure(url, reason);
    return { attempted: batch.length, posted: 0, ok: false, reason };
  }

  private onBatchPosted(n: number): void {
    const failures = this.stats.consecutiveFailures;
    this.stats.posted += n;
    this.stats.batches += 1;
    this.stats.consecutiveFailures = 0;
    if (failures > 0) {
      this.log.info(
        `API reachable again: posted ${n} sample(s) after ${failures} failed batch(es)`,
      );
    }
  }

  /** A terminal client error: the batch is gone for good; say so once, with the API's own words. */
  private onBatchRejected(
    url: string,
    batch: VitalsSample[],
    status: number,
    body: string,
  ): FlushResult {
    this.stats.rejectedBatches += 1;
    this.stats.rejected += batch.length;
    const excerpt = bodyExcerpt(body);
    this.log.warn(
      `POST ${url} rejected with HTTP ${status}; dropping ${batch.length} sample(s) without retry ` +
        `(re-sending the same batch cannot succeed)${excerpt ? `: ${excerpt}` : ''}`,
    );
    return { attempted: batch.length, posted: 0, ok: false, reason: `HTTP ${status} (rejected)` };
  }

  /**
   * Put a failed batch back at the FRONT of the buffer (it is older than anything queued since),
   * but only while the same session is still active: a batch must never leak into the buffer of
   * a session that started while it was in flight.
   */
  private requeue(sessionId: string, batch: VitalsSample[]): void {
    if (this.sessionId !== sessionId) {
      this.stats.dropped += batch.length;
      this.log.warn(
        `discarding ${batch.length} sample(s) of session ${sessionId}: it failed to post and the session is no longer active`,
      );
      return;
    }
    this.buffer = [...batch, ...this.buffer];
    this.enforceBound();
  }

  private enforceBound(): void {
    if (this.buffer.length <= this.maxBuffer) return;
    const excess = this.buffer.length - this.maxBuffer;
    this.buffer.splice(0, excess); // oldest first
    this.stats.dropped += excess;
    this.overflowWarnings += 1;
    if (this.overflowWarnings === 1 || this.overflowWarnings % 30 === 0) {
      this.log.warn(
        `vitals buffer full (${this.maxBuffer}); dropped ${excess} oldest sample(s), ${this.stats.dropped} dropped in total`,
      );
    }
  }

  private logFailure(url: string, reason: string): void {
    const n = this.stats.consecutiveFailures;
    const buffered = this.buffer.length;
    if (n === 1) {
      this.log.warn(
        `POST ${url} failed after one retry (${reason}). Keeping ${buffered} sample(s) buffered (max ${this.maxBuffer}); will try again on the next flush.`,
      );
    } else if (n % 5 === 0) {
      this.log.warn(
        `API still unreachable: ${n} consecutive failed batches (last: ${reason}); ${buffered} sample(s) buffered, ${this.stats.dropped} dropped so far`,
      );
    } else {
      this.log.debug(`POST ${url} failed again (${reason}); ${buffered} buffered`);
    }
  }
}
