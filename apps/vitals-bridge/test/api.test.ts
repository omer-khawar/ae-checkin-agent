import { describe, expect, it } from 'vitest';
import {
  ApiClient,
  bodyExcerpt,
  DEFAULT_MAX_BUFFER,
  describeError,
  TERMINAL_STATUSES,
  type FetchLike,
} from '../src/api.js';
import { silentLogger, type Logger } from '../src/log.js';
import type { VitalsSample } from '../src/sources/types.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
  body: unknown;
}

/** One scripted answer: an HTTP status (optionally with a body), or an Error to throw. */
type Scripted = number | Error | { status: number; body?: string };

/**
 * A scripted fetch: each entry answers one call. `delayMs` makes every answer asynchronous
 * (a POST "in flight" for that long), which the stop-race tests need.
 */
function fakeFetch(script: Scripted[] = [], delayMs = 0) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, init, body });
    const next = script.shift() ?? 200;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (next instanceof Error) throw next;
    const { status, body: text } =
      typeof next === 'number' ? { status: next, body: undefined } : next;
    return new Response(text ?? JSON.stringify({ accepted: 1 }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls };
}

/** A fetch that never answers but honours the abort signal, so timeouts can be exercised for real. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });

const postedPulses = (call: Call | undefined): number[] =>
  (call?.body as { samples: VitalsSample[] }).samples.map((s) => s.pulseBpm ?? -1);

function capturingLogger() {
  const lines: string[] = [];
  const log: Logger = {
    debug: (m) => lines.push(`DEBUG ${m}`),
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
  };
  return { log, lines };
}

const sample = (i: number): VitalsSample => ({
  tsUtc: new Date(Date.UTC(2026, 9, 10, 12, 0, i)).toISOString(),
  source: 'mock',
  isMeasured: false,
  pulseBpm: 70 + i,
  pulseConf: 0.9,
  windowS: 12,
  qualityFlags: i % 2 ? ['gate_pending_breathing'] : [],
});

function client(
  fetchImpl: FetchLike,
  extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {},
) {
  return new ApiClient({
    apiBase: 'http://api.test:8000/',
    fetchImpl,
    log: silentLogger,
    flushIntervalMs: 60_000,
    retryDelayMs: 1,
    ...extra,
  });
}

describe('ApiClient: batching', () => {
  it('POSTs {samples:[...]} in camelCase to /api/v1/sessions/{id}/vitals with the bridge token', async () => {
    const f = fakeFetch();
    const api = client(f.fn, { token: 'shh' });
    api.startBatching('01SESSION');
    expect(api.enqueue(sample(0))).toBe(true);
    expect(api.enqueue(sample(1))).toBe(true);
    const result = await api.flush();
    expect(result).toEqual({ attempted: 2, posted: 2, ok: true });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.url).toBe('http://api.test:8000/api/v1/sessions/01SESSION/vitals');
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-bridge-token']).toBe('shh');
    expect(headers['x-bridge-batch-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(call?.body).toEqual({ samples: [sample(0), sample(1)] });
    // camelCase exactly as CLAUDE.md §7.1; no snake_case leaks.
    expect(JSON.stringify(call?.body)).not.toMatch(/pulse_bpm|ts_utc|is_measured/);
    expect(api.buffered).toBe(0);
    expect(api.stats.posted).toBe(2);
    expect(api.stats.batches).toBe(1);
  });

  it('omits the token header when none is configured', async () => {
    const f = fakeFetch();
    const api = client(f.fn, { token: '' });
    api.startBatching('S');
    api.enqueue(sample(0));
    await api.flush();
    const headers = f.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-bridge-token']).toBeUndefined();
  });

  it('drops samples and skips flushes when no session is active', async () => {
    const f = fakeFetch();
    const api = client(f.fn);
    expect(api.enqueue(sample(0))).toBe(false);
    expect(await api.flush()).toEqual({ attempted: 0, posted: 0, ok: true });
    expect(f.calls).toHaveLength(0);
  });

  it('URL-encodes the session id', () => {
    const api = client(fakeFetch().fn);
    expect(api.vitalsUrl('a b/c')).toBe('http://api.test:8000/api/v1/sessions/a%20b%2Fc/vitals');
  });
});

describe('ApiClient: retry and buffering', () => {
  it('retries once on a non-2xx and succeeds', async () => {
    const f = fakeFetch([503, 200]);
    const api = client(f.fn);
    api.startBatching('S');
    api.enqueue(sample(0));
    const r = await api.flush();
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(api.stats.failedBatches).toBe(0);
  });

  it('retries once on a network error and succeeds', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const f = fakeFetch([boom, 200]);
    const api = client(f.fn);
    api.startBatching('S');
    api.enqueue(sample(0));
    expect((await api.flush()).ok).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it('after a failed retry keeps the batch buffered (oldest first) and logs politely once', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const f = fakeFetch([boom, boom]);
    const { log, lines } = capturingLogger();
    const api = client(f.fn, { log });
    api.startBatching('S');
    api.enqueue(sample(0));
    api.enqueue(sample(1));
    const r = await api.flush();
    expect(r).toEqual({
      attempted: 2,
      posted: 0,
      ok: false,
      reason: 'fetch failed [ECONNREFUSED]',
    });
    expect(f.calls).toHaveLength(2);
    expect(api.buffered).toBe(2);
    expect(api.stats.failedBatches).toBe(1);
    expect(api.stats.consecutiveFailures).toBe(1);
    expect(api.stats.posted).toBe(0);
    const warns = lines.filter((l) => l.startsWith('WARN'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/failed after one retry/);
    expect(warns[0]).toMatch(/ECONNREFUSED/);
    expect(warns[0]).toMatch(/buffered \(max 120\)/);

    // A sample enqueued meanwhile lands AFTER the requeued batch: order is preserved.
    api.enqueue(sample(2));
    f.calls.length = 0;
    const r2 = await api.flush();
    expect(r2.ok).toBe(true);
    expect(
      (f.calls[0]?.body as { samples: VitalsSample[] }).samples.map((s) => s.pulseBpm),
    ).toEqual([70, 71, 72]);
    expect(api.stats.consecutiveFailures).toBe(0);
    expect(lines.some((l) => l.startsWith('INFO API reachable again'))).toBe(true);
  });

  it('bounds the buffer at 120 by dropping the oldest samples', () => {
    const api = client(fakeFetch().fn);
    api.startBatching('S');
    for (let i = 0; i < 130; i++) api.enqueue(sample(i));
    expect(api.buffered).toBe(DEFAULT_MAX_BUFFER);
    expect(api.stats.dropped).toBe(10);
  });

  it('bounds the buffer when a failed batch is requeued on top of new samples', async () => {
    const boom = new Error('down');
    const f = fakeFetch([boom, boom]);
    const api = client(f.fn, { maxBuffer: 5 });
    api.startBatching('S');
    for (let i = 0; i < 4; i++) api.enqueue(sample(i));
    const flushing = api.flush(); // takes samples 0..3 in flight
    for (let i = 4; i < 8; i++) api.enqueue(sample(i)); // 4 more arrive meanwhile
    await flushing;
    expect(api.buffered).toBe(5);
    expect(api.stats.dropped).toBe(3); // the three oldest (0,1,2) went
  });

  it('shares one in-flight request between concurrent flush() calls', async () => {
    const f = fakeFetch();
    const api = client(f.fn);
    api.startBatching('S');
    api.enqueue(sample(0));
    const [a, b] = await Promise.all([api.flush(), api.flush()]);
    expect(a).toBe(b);
    expect(f.calls).toHaveLength(1);
  });

  it('stopBatching flushes, clears the session, and reports unposted samples', async () => {
    const f = fakeFetch();
    const api = client(f.fn);
    api.startBatching('S');
    api.enqueue(sample(0));
    const r = await api.stopBatching();
    expect(r?.posted).toBe(1);
    expect(api.activeSessionId).toBeNull();
    expect(api.enqueue(sample(1))).toBe(false);
    expect(await api.stopBatching()).toBeNull();
  });

  it('stopBatching discards what it could not deliver (stateless beyond the session)', async () => {
    const boom = new Error('down');
    const f = fakeFetch([boom, boom]);
    const { log, lines } = capturingLogger();
    const api = client(f.fn, { log });
    api.startBatching('S');
    api.enqueue(sample(0));
    const r = await api.stopBatching();
    expect(r?.ok).toBe(false);
    expect(api.buffered).toBe(0);
    expect(api.stats.dropped).toBe(1);
    expect(lines.some((l) => /could not be posted/.test(l))).toBe(true);
  });

  it('starting a different session discards the previous session buffer', () => {
    const api = client(fakeFetch().fn);
    api.startBatching('A');
    api.enqueue(sample(0));
    api.startBatching('B');
    expect(api.buffered).toBe(0);
    expect(api.stats.dropped).toBe(1);
    expect(api.activeSessionId).toBe('B');
  });

  it('flushes on the timer', async () => {
    const f = fakeFetch();
    const api = client(f.fn, { flushIntervalMs: 15 });
    api.startBatching('S');
    api.enqueue(sample(0));
    await new Promise((r) => setTimeout(r, 80));
    await api.stopBatching();
    expect(f.calls.length).toBeGreaterThanOrEqual(1);
    expect(api.stats.posted).toBe(1);
  });
});

describe('ApiClient: stopBatching delivers everything (the stop-during-POST race)', () => {
  // Reviewer repro (race.mts): a 150 ms POST is in flight with s0, s1 + s2 are enqueued meanwhile,
  // stop arrives. Before the fix the two newer samples were discarded with a misleading
  // "API unreachable" warning even though the API was healthy.
  it('waits for the in-flight POST, then posts what arrived meanwhile; nothing dropped, no WARN', async () => {
    const f = fakeFetch([], 60);
    const { log, lines } = capturingLogger();
    const api = client(f.fn, { log });
    api.startBatching('S');
    api.enqueue(sample(0));
    const inFlight = api.flush(); // s0 leaves now
    api.enqueue(sample(1));
    api.enqueue(sample(2));
    const r = await api.stopBatching();
    await inFlight;
    expect(f.calls).toHaveLength(2);
    expect(postedPulses(f.calls[0])).toEqual([70]);
    expect(postedPulses(f.calls[1])).toEqual([71, 72]);
    expect(r).toEqual({ attempted: 2, posted: 2, ok: true });
    expect(api.stats.posted).toBe(3);
    expect(api.stats.dropped).toBe(0);
    expect(api.buffered).toBe(0);
    expect(api.activeSessionId).toBeNull();
    expect(lines.filter((l) => l.startsWith('WARN'))).toEqual([]);
  });

  it('keeps flushing until the buffer is empty when samples arrive between final flushes', async () => {
    const f = fakeFetch([], 20);
    const api = client(f.fn);
    api.startBatching('S');
    api.enqueue(sample(0));
    const stopping = api.stopBatching();
    // A straggler from the source lands while the first final flush is in flight.
    api.enqueue(sample(1));
    await stopping;
    expect(f.calls).toHaveLength(2);
    expect(api.stats.posted).toBe(2);
    expect(api.stats.dropped).toBe(0);
  });

  it('reports the real reason when the final flush fails, never "unreachable" for an HTTP answer', async () => {
    const f = fakeFetch([503, 503]);
    const { log, lines } = capturingLogger();
    const api = client(f.fn, { log });
    api.startBatching('S');
    api.enqueue(sample(0));
    const r = await api.stopBatching();
    expect(r?.ok).toBe(false);
    expect(r?.reason).toBe('HTTP 503');
    const ended = lines.find((l) => /ended with 1 sample\(s\)/.test(l));
    expect(ended).toMatch(/\(HTTP 503\)/);
    expect(ended).not.toMatch(/unreachable/);
    expect(api.stats.dropped).toBe(1);
  });

  it('bounds the final flush with the short timeout (a Ctrl-C with the API down does not hang)', async () => {
    const { log, lines } = capturingLogger();
    const api = client(hangingFetch, {
      log,
      requestTimeoutMs: 10_000,
      finalFlushTimeoutMs: 30,
      retryDelayMs: 1,
    });
    api.startBatching('S');
    api.enqueue(sample(0));
    const t0 = Date.now();
    const r = await api.stopBatching();
    expect(Date.now() - t0).toBeLessThan(2_000); // two attempts of 30 ms, not two of 10 s
    expect(r).toMatchObject({ ok: false, reason: 'request timed out' });
    expect(api.stats.dropped).toBe(1);
    expect(lines.some((l) => /could not be posted \(request timed out\)/.test(l))).toBe(true);
  });
});

describe('ApiClient: terminal client errors are not retried', () => {
  it('lists exactly the statuses where re-sending the same bytes cannot help', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([400, 404, 413, 415, 422]);
    expect(TERMINAL_STATUSES.has(500)).toBe(false);
    expect(TERMINAL_STATUSES.has(429)).toBe(false);
    expect(TERMINAL_STATUSES.has(401)).toBe(false);
  });

  it('drops a 404 batch after ONE attempt with a WARN naming the status and the body', async () => {
    const f = fakeFetch([{ status: 404, body: '{"detail":"session 01X not found"}' }]);
    const { log, lines } = capturingLogger();
    const api = client(f.fn, { log });
    api.startBatching('01X');
    api.enqueue(sample(0));
    api.enqueue(sample(1));
    const r = await api.flush();
    expect(f.calls).toHaveLength(1); // no retry
    expect(r).toEqual({ attempted: 2, posted: 0, ok: false, reason: 'HTTP 404 (rejected)' });
    expect(api.buffered).toBe(0); // not requeued
    expect(api.stats.rejectedBatches).toBe(1);
    expect(api.stats.rejected).toBe(2);
    expect(api.stats.failedBatches).toBe(0);
    expect(api.stats.consecutiveFailures).toBe(0);
    const warns = lines.filter((l) => l.startsWith('WARN'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/HTTP 404/);
    expect(warns[0]).toMatch(/session 01X not found/);
    expect(warns[0]).toMatch(/without retry/);
  });

  it('a 422 is terminal too, while a 5xx still gets the retry and the buffer', async () => {
    const bad = client(fakeFetch([422]).fn);
    bad.startBatching('S');
    bad.enqueue(sample(0));
    expect((await bad.flush()).reason).toBe('HTTP 422 (rejected)');
    expect(bad.buffered).toBe(0);

    const f = fakeFetch([500, 500]);
    const down = client(f.fn);
    down.startBatching('S');
    down.enqueue(sample(0));
    expect((await down.flush()).reason).toBe('HTTP 500');
    expect(f.calls).toHaveLength(2);
    expect(down.buffered).toBe(1);
  });

  it('does not spam: a reset session (every POST 404) never fills the buffer', async () => {
    const f = fakeFetch(Array.from({ length: 10 }, () => 404));
    const api = client(f.fn);
    api.startBatching('S');
    for (let i = 0; i < 5; i++) {
      api.enqueue(sample(i));
      await api.flush();
    }
    expect(f.calls).toHaveLength(5); // one call per flush, no retries
    expect(api.buffered).toBe(0);
    expect(api.stats.rejected).toBe(5);
  });

  it('bodyExcerpt collapses whitespace and caps the length', () => {
    expect(bodyExcerpt('  {"a":\n  1}  ')).toBe('{"a": 1}');
    expect(bodyExcerpt('x'.repeat(300), 10)).toBe(`${'x'.repeat(10)}…`);
    expect(bodyExcerpt('')).toBe('');
  });
});

describe('ApiClient: a batch never leaks across sessions', () => {
  it('a batch of session A that fails after session B started is dropped, not requeued into B', async () => {
    const boom = new Error('down');
    const f = fakeFetch([boom, boom], 20);
    const { log, lines } = capturingLogger();
    const api = client(f.fn, { log });
    api.startBatching('A');
    api.enqueue(sample(0));
    const aPost = api.flush(); // A's batch in flight, about to fail twice
    api.startBatching('B'); // B takes over while A is still posting
    api.enqueue(sample(1));
    await aPost;
    expect(api.activeSessionId).toBe('B');
    expect(api.buffered).toBe(1); // only B's own sample
    expect(api.stats.dropped).toBe(1);
    expect(
      lines.some((l) => /session A: it failed to post and the session is no longer active/.test(l)),
    ).toBe(true);
  });
});

describe('ApiClient: settings/public', () => {
  it('returns the settings object', async () => {
    const f: FetchLike = (url) => {
      expect(url).toBe('http://api.test:8000/api/v1/settings/public');
      return Promise.resolve(
        new Response(JSON.stringify({ vitals_source: 'mock', mock_scenario: 'tachypnea' }), {
          status: 200,
        }),
      );
    };
    const api = client(f);
    expect(await api.getPublicSettings()).toEqual({
      vitals_source: 'mock',
      mock_scenario: 'tachypnea',
    });
  });

  it('tolerates HTTP errors, network errors and junk bodies by returning null', async () => {
    expect(await client(fakeFetch([500]).fn).getPublicSettings()).toBeNull();
    expect(await client(fakeFetch([new Error('nope')]).fn).getPublicSettings()).toBeNull();
    const junk: FetchLike = () => Promise.resolve(new Response('"just a string"', { status: 200 }));
    expect(await client(junk).getPublicSettings()).toBeNull();
    const notJson: FetchLike = () => Promise.resolve(new Response('<html>', { status: 200 }));
    expect(await client(notJson).getPublicSettings()).toBeNull();
  });

  it('gives up on a hanging API after its own short timeout (not the 5 s POST timeout)', async () => {
    const { log, lines } = capturingLogger();
    const api = client(hangingFetch, { log, requestTimeoutMs: 10_000, settingsTimeoutMs: 30 });
    const t0 = Date.now();
    expect(await api.getPublicSettings()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(lines.some((l) => /settings\/public failed \(request timed out\)/.test(l))).toBe(true);
  });
});

describe('describeError', () => {
  it('surfaces the OS error code and recognises timeouts', () => {
    const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(describeError(e)).toBe('fetch failed [ECONNREFUSED]');
    const t = new Error('x');
    t.name = 'TimeoutError';
    expect(describeError(t)).toBe('request timed out');
    expect(describeError('weird')).toBe('weird');
    expect(describeError(new Error('plain'))).toBe('plain');
  });

  it('looks through AggregateError members and nested causes for the code', () => {
    // Node's fetch may wrap a multi-address dial failure (localhost -> ::1 and 127.0.0.1) in an
    // AggregateError whose members carry the codes, or nest the code one level deeper.
    const member = Object.assign(new Error('connect ECONNREFUSED ::1:9'), { code: 'ECONNREFUSED' });
    const agg = Object.assign(new TypeError('fetch failed'), {
      cause: new AggregateError([member]),
    });
    expect(describeError(agg)).toBe('fetch failed [ECONNREFUSED]');
    const nested = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket'), { cause: { code: 'ENOTFOUND' } }),
    });
    expect(describeError(nested)).toBe('fetch failed [ENOTFOUND]');
    const bare = Object.assign(new TypeError('fetch failed'), { cause: new Error('no code here') });
    expect(describeError(bare)).toBe('fetch failed (no code here)');
  });
});
