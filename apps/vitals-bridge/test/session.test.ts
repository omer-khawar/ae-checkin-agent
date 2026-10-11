import { describe, expect, it } from 'vitest';
import { ApiClient, type FetchLike } from '../src/api.js';
import { silentLogger } from '../src/log.js';
import { BridgeSession, type BroadcastSink } from '../src/session.js';
import type {
  SourceName,
  SourceStatus,
  VitalsSample,
  VitalsSource,
  WaveformBatch,
  WaveformCapable,
} from '../src/sources/types.js';
import type { BridgeToWeb } from '../src/ws.js';

/** A scripted source: tests push samples/statuses by hand. `name` is configurable to test non-mock paths. */
class FakeSource implements VitalsSource, WaveformCapable {
  readonly isMeasured: boolean;
  startedWith: Array<{ cameraId?: string; scenario?: string }> = [];
  stops = 0;
  failStart = false;
  private sampleCb: ((s: VitalsSample) => void) | null = null;
  private statusCb: ((s: SourceStatus) => void) | null = null;
  private waveCb: ((w: WaveformBatch) => void) | null = null;

  constructor(readonly name: SourceName = 'mock') {
    this.isMeasured = name !== 'mock';
  }
  start(opts: { cameraId?: string; scenario?: string }): Promise<void> {
    if (this.failStart) return Promise.reject(new Error('camera busy'));
    this.startedWith.push(opts);
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stops += 1;
    this.emitStatus({ state: 'idle' });
    return Promise.resolve();
  }
  onSample(cb: (s: VitalsSample) => void): void {
    this.sampleCb = cb;
  }
  onStatus(cb: (s: SourceStatus) => void): void {
    this.statusCb = cb;
  }
  onWaveform(cb: (w: WaveformBatch) => void): void {
    this.waveCb = cb;
  }
  emitSample(s: Partial<VitalsSample> = {}): void {
    this.sampleCb?.({
      tsUtc: '2026-10-10T12:00:00.000Z',
      source: this.name,
      isMeasured: this.isMeasured,
      pulseBpm: 72,
      pulseConf: 0.9,
      breathingBpm: 14,
      breathingConf: 0.85,
      windowS: 12,
      qualityFlags: [],
      ...s,
    });
  }
  emitStatus(s: SourceStatus): void {
    this.statusCb?.(s);
  }
  emitWave(): void {
    this.waveCb?.({ values: [0.1, 0.5, 0.9], tsUtc: '2026-10-10T12:00:00.000Z' });
  }
}

class FakeSink implements BroadcastSink {
  readonly messages: BridgeToWeb[] = [];
  broadcast(msg: BridgeToWeb): void {
    this.messages.push(msg);
  }
  ofType<T extends BridgeToWeb['type']>(type: T): Array<Extract<BridgeToWeb, { type: T }>> {
    return this.messages.filter((m): m is Extract<BridgeToWeb, { type: T }> => m.type === type);
  }
}

interface Harness {
  source: FakeSource;
  sink: FakeSink;
  api: ApiClient;
  session: BridgeSession;
  posts: unknown[];
  clock: { nowMs: number };
  /** Resolves the deferred settings GET (only when `deferSettings` was set). */
  releaseSettings: () => void;
  logLines: string[];
}

function harness(
  opts: {
    settings?: Record<string, unknown> | Error;
    /** Hold the settings GET until `releaseSettings()` is called (models a slow / hanging API). */
    deferSettings?: boolean;
    name?: SourceName;
    defaultScenario?: string | null;
    minConf?: number;
    gates?: { pulseS: number; breathingS: number; hrvS: number };
  } = {},
): Harness {
  const posts: unknown[] = [];
  let releaseSettings: () => void = () => undefined;
  const gateSettings: Promise<void> = opts.deferSettings
    ? new Promise((resolve) => {
        releaseSettings = resolve;
      })
    : Promise.resolve();
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/settings/public')) {
      await gateSettings;
      if (opts.settings instanceof Error) throw opts.settings;
      return new Response(JSON.stringify(opts.settings ?? {}), { status: 200 });
    }
    posts.push({
      url,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown,
    });
    return new Response('{"accepted":1}', { status: 200 });
  };
  const logLines: string[] = [];
  const log = {
    debug: (m: string) => logLines.push(`DEBUG ${m}`),
    info: (m: string) => logLines.push(`INFO ${m}`),
    warn: (m: string) => logLines.push(`WARN ${m}`),
    error: (m: string) => logLines.push(`ERROR ${m}`),
  };
  const clock = { nowMs: Date.parse('2026-10-10T12:00:00.000Z') };
  const source = new FakeSource(opts.name ?? 'mock');
  const sink = new FakeSink();
  const api = new ApiClient({
    apiBase: 'http://api.test',
    fetchImpl,
    log: silentLogger,
    flushIntervalMs: 60_000,
    settingsTimeoutMs: 60_000, // the deferred GET is released by the test, never by a timeout
  });
  const session = new BridgeSession({
    source,
    api,
    defaultScenario: opts.defaultScenario === undefined ? 'resting' : opts.defaultScenario,
    ...(opts.minConf !== undefined ? { minConf: opts.minConf } : {}),
    ...(opts.gates !== undefined ? { gates: opts.gates } : {}),
    log,
    now: () => clock.nowMs,
    version: '0.1.0',
  });
  session.attachSink(sink);
  return {
    source,
    sink,
    api,
    session,
    posts,
    clock,
    releaseSettings: () => releaseSettings(),
    logLines,
  };
}

/** Bring a started session to "collecting" with `seconds` of continuous capture on the clock. */
function collectFor(h: Harness, seconds: number): void {
  h.source.emitStatus({ state: 'collecting' });
  h.clock.nowMs += seconds * 1000;
}

describe('BridgeSession: scenario resolution', () => {
  it('uses the start message scenario first', async () => {
    const h = harness({ settings: { mock_scenario: 'tachypnea' } });
    h.session.setScenario('dropout');
    await h.session.start('S', 'post_exercise');
    expect(h.source.startedWith[0]).toEqual({ scenario: 'post_exercise' });
    expect(h.session.currentScenario()).toBe('post_exercise');
  });

  it('then a queued set_scenario (consumed by that start)', async () => {
    const h = harness({ settings: { mock_scenario: 'tachypnea' } });
    h.session.setScenario('dropout');
    expect(h.session.currentScenario()).toBe('dropout');
    await h.session.start('S');
    expect(h.source.startedWith[0]).toEqual({ scenario: 'dropout' });
    await h.session.stop();
    await h.session.start('S2');
    expect(h.source.startedWith[1]).toEqual({ scenario: 'tachypnea' }); // queue was consumed
  });

  it('then mock_scenario from GET /settings/public', async () => {
    const h = harness({ settings: { vitals_source: 'mock', mock_scenario: 'low_quality' } });
    await h.session.start('S');
    expect(h.source.startedWith[0]).toEqual({ scenario: 'low_quality' });
  });

  it('then the CLI/env default when the API is unreachable or returns junk', async () => {
    const down = harness({ settings: new Error('ECONNREFUSED') });
    await down.session.start('S');
    expect(down.source.startedWith[0]).toEqual({ scenario: 'resting' });

    const junk = harness({
      settings: { mock_scenario: 'sprinting' },
      defaultScenario: 'tachypnea',
    });
    await junk.session.start('S');
    expect(junk.source.startedWith[0]).toEqual({ scenario: 'tachypnea' });

    const none = harness({ settings: {}, defaultScenario: null });
    await none.session.start('S');
    expect(none.source.startedWith[0]).toEqual({ scenario: 'resting' });
  });

  it('ignores an unknown scenario in the start message and continues', async () => {
    const h = harness({ settings: { mock_scenario: 'dropout' } });
    await h.session.start('S', 'bogus');
    expect(h.source.startedWith[0]).toEqual({ scenario: 'dropout' });
  });

  it('non-mock sources get no scenario and refuse set_scenario', async () => {
    const h = harness({ name: 'presage', settings: { mock_scenario: 'dropout' } });
    expect(h.session.supportsScenarios).toBe(false);
    expect(h.session.currentScenario()).toBeNull();
    expect(() => h.session.setScenario('resting')).toThrow(/mock source only/);
    await h.session.start('S');
    expect(h.source.startedWith[0]).toEqual({});
    expect(h.session.hello().scenario).toBeNull();
    expect(h.session.hello().isMeasured).toBe(true);
  });

  it('rejects an unknown name in set_scenario', () => {
    const h = harness();
    expect(() => h.session.setScenario('sprinting')).toThrow(/unknown scenario "sprinting"/);
  });
});

describe('BridgeSession: pipeline', () => {
  it('gates samples against the injected clock, broadcasts them and enqueues them for the API', async () => {
    const h = harness({ settings: {} });
    await h.session.start('S');
    expect(h.sink.ofType('status').at(-1)).toMatchObject({ state: 'warming', sessionId: 'S' });

    h.source.emitStatus({ state: 'collecting', message: 'face found' });
    h.clock.nowMs += 5_000;
    h.source.emitSample();
    const early = h.sink.ofType('sample')[0];
    expect(early?.sessionId).toBe('S');
    expect(early?.elapsedS).toBe(5);
    expect(early?.published.pulse).toBe(false);
    expect(early?.sample.pulseBpm).toBeUndefined();
    expect(early?.sample.qualityFlags).toContain('gate_pending_pulse');

    h.clock.nowMs += 8_000; // 13 s of continuous collecting
    h.source.emitSample();
    const late = h.sink.ofType('sample')[1];
    expect(late?.elapsedS).toBe(13);
    expect(late?.published).toEqual({ pulse: true, breathing: false, hrv: false });
    expect(late?.sample.pulseBpm).toBe(72);
    expect(h.api.buffered).toBe(2); // both samples are kept (pending ones too)

    const snap = h.session.snapshot();
    expect(snap).toMatchObject({
      source: 'mock',
      scenario: 'resting',
      state: 'collecting',
      sessionId: 'S',
      pulse: 72,
      pulseConf: 0.9,
      buffered: 2,
      posted: 0,
    });
    expect(snap.breathing).toBeUndefined();
    expect(h.session.status()).toEqual({
      type: 'status',
      state: 'collecting',
      message: 'face found',
      elapsedS: 13,
      sessionId: 'S',
    });
  });

  it('forwards waveforms only while a session is active', async () => {
    const h = harness({ settings: {} });
    h.source.emitWave();
    expect(h.sink.ofType('waveform')).toHaveLength(0);
    await h.session.start('S');
    h.source.emitWave();
    expect(h.sink.ofType('waveform')).toEqual([
      { type: 'waveform', values: [0.1, 0.5, 0.9], tsUtc: '2026-10-10T12:00:00.000Z' },
    ]);
  });

  it('ignores samples outside a session', () => {
    const h = harness();
    h.source.emitSample();
    expect(h.sink.ofType('sample')).toHaveLength(0);
    expect(h.api.buffered).toBe(0);
  });

  it('stop halts the source, flushes the buffer to the API and broadcasts idle', async () => {
    const h = harness({ settings: {} });
    await h.session.start('S');
    h.source.emitStatus({ state: 'collecting' });
    h.source.emitSample();
    h.source.emitSample();
    await h.session.stop();
    expect(h.source.stops).toBe(1);
    expect(h.posts).toHaveLength(1);
    expect((h.posts[0] as { url: string }).url).toBe('http://api.test/api/v1/sessions/S/vitals');
    expect((h.posts[0] as { body: { samples: unknown[] } }).body.samples).toHaveLength(2);
    expect(h.api.stats.posted).toBe(2);
    expect(h.session.activeSessionId).toBeNull();
    expect(h.sink.ofType('status').at(-1)).toEqual({
      type: 'status',
      state: 'idle',
      elapsedS: 0,
      sessionId: null,
    });
  });

  it('a second start stops the first session (no sample leaks across sessions)', async () => {
    const h = harness({ settings: {} });
    await h.session.start('A');
    h.source.emitStatus({ state: 'collecting' });
    h.source.emitSample();
    await h.session.start('B');
    expect(h.source.stops).toBe(1);
    expect(h.posts).toHaveLength(1); // A's sample was flushed to A
    expect(h.api.activeSessionId).toBe('B');
    expect(h.api.buffered).toBe(0);
  });

  it('a source that fails to start yields an error status and an error message, not a crash', async () => {
    const h = harness({ settings: {} });
    h.source.failStart = true;
    await h.session.start('S');
    expect(h.sink.ofType('error')[0]?.message).toMatch(/failed to start: camera busy/);
    expect(h.session.status().state).toBe('error');
    await h.session.stop(); // still cleanly stoppable
    expect(h.session.status().state).toBe('idle');
  });

  it('hello carries the contract fields', () => {
    const h = harness();
    expect(h.session.hello()).toEqual({
      type: 'hello',
      source: 'mock',
      isMeasured: false,
      scenario: 'resting',
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
      version: '0.1.0',
    });
  });

  it('clears the last published values whenever the source leaves "collecting" (status line honesty)', async () => {
    const h = harness({ settings: {} });
    await h.session.start('S');
    collectFor(h, 13);
    h.source.emitSample();
    expect(h.session.snapshot().pulse).toBe(72);
    h.source.emitStatus({ state: 'error', message: 'camera stream lost' });
    const snap = h.session.snapshot();
    expect(snap.state).toBe('error');
    expect(snap.pulse).toBeUndefined();
    expect(snap.pulseConf).toBeUndefined();
    expect(snap.breathing).toBeUndefined();
    // Recovery starts a fresh gate: the first sample is gate-pending, so still nothing to quote.
    h.source.emitStatus({ state: 'collecting' });
    h.source.emitSample();
    expect(h.session.snapshot().pulse).toBeUndefined();
    collectFor(h, 12);
    h.source.emitSample();
    expect(h.session.snapshot().pulse).toBe(72);
  });

  it('concurrent stop() calls share one stop: the source halts once and the buffer is flushed once', async () => {
    const h = harness({ settings: {} });
    await h.session.start('S');
    collectFor(h, 1);
    h.source.emitSample();
    const a = h.session.stop();
    const b = h.session.stop();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(h.source.stops).toBe(1);
    expect(h.posts).toHaveLength(1);
    expect(h.session.activeSessionId).toBeNull();
  });
});

describe('BridgeSession: start is idempotent for the active session (WS reconnects)', () => {
  it('re-attaches without restarting the source, resetting the gates or touching the API batcher', async () => {
    const h = harness({ settings: { mock_scenario: 'post_exercise' } });
    await h.session.start('S');
    collectFor(h, 13);
    h.source.emitSample();
    expect(h.sink.ofType('sample').at(-1)?.published.pulse).toBe(true);
    expect(h.api.buffered).toBe(1);
    h.sink.messages.length = 0;

    // The web client reconnected and re-sent start for the same session.
    await h.session.start('S');
    expect(h.source.startedWith).toHaveLength(1); // not restarted
    expect(h.source.stops).toBe(0);
    expect(h.api.activeSessionId).toBe('S');
    expect(h.api.buffered).toBe(1); // nothing flushed or discarded
    expect(h.posts).toHaveLength(0);
    // The reconnecting kiosk gets hello + status so it can redraw.
    expect(h.sink.messages.map((m) => m.type)).toEqual(['hello', 'status']);
    expect(h.sink.ofType('status')[0]).toMatchObject({
      state: 'collecting',
      sessionId: 'S',
      elapsedS: 13,
    });
    expect(h.logLines.some((l) => /re-attaching without restarting/.test(l))).toBe(true);

    // Gate continuity: the next sample is still published (the 12 s pulse gate did not reset).
    h.clock.nowMs += 1000;
    h.source.emitSample();
    expect(h.sink.ofType('sample').at(-1)?.published.pulse).toBe(true);
    expect(h.sink.ofType('sample').at(-1)?.elapsedS).toBe(14);
  });

  it('ignores a different scenario on the re-sent start (the running one wins) and says so', async () => {
    const h = harness({ settings: {} });
    await h.session.start('S', 'tachypnea');
    collectFor(h, 1);
    await h.session.start('S', 'dropout');
    expect(h.source.startedWith).toEqual([{ scenario: 'tachypnea' }]);
    expect(h.session.currentScenario()).toBe('tachypnea');
    expect(h.logLines.some((l) => /ignoring scenario "dropout"/.test(l))).toBe(true);
  });

  it('a start for the same id after the source FAILED to start is a genuine retry', async () => {
    const h = harness({ settings: {} });
    h.source.failStart = true;
    await h.session.start('S');
    expect(h.session.status().state).toBe('error');
    h.source.failStart = false;
    await h.session.start('S');
    expect(h.source.startedWith).toHaveLength(1);
    expect(h.session.status().state).toBe('warming');
    expect(h.session.activeSessionId).toBe('S');
  });

  it('a start for a DIFFERENT session still stops the previous one', async () => {
    const h = harness({ settings: {} });
    await h.session.start('A');
    collectFor(h, 1);
    await h.session.start('B');
    expect(h.source.stops).toBe(1);
    expect(h.source.startedWith).toHaveLength(2);
    expect(h.session.activeSessionId).toBe('B');
  });
});

describe('BridgeSession: the session is announced before the settings round-trip', () => {
  it('broadcasts warming with the session id immediately, even while the API hangs', async () => {
    const h = harness({ settings: {}, deferSettings: true });
    const starting = h.session.start('S');
    // No await, no release: the GET is still pending, yet the kiosk already sees its session.
    expect(h.session.activeSessionId).toBe('S');
    expect(h.api.activeSessionId).toBe('S');
    expect(h.sink.ofType('status').at(-1)).toMatchObject({ state: 'warming', sessionId: 'S' });
    expect(h.source.startedWith).toHaveLength(0);
    h.releaseSettings();
    await starting;
    expect(h.source.startedWith).toHaveLength(1);
  });

  it('a stop that arrives during the settings GET wins: the source is never started', async () => {
    const h = harness({ settings: {}, deferSettings: true });
    const starting = h.session.start('S');
    await h.session.stop(); // the kiosk left before the API answered
    expect(h.session.activeSessionId).toBeNull();
    expect(h.sink.ofType('status').at(-1)).toEqual({
      type: 'status',
      state: 'idle',
      elapsedS: 0,
      sessionId: null,
    });
    h.releaseSettings();
    await starting;
    expect(h.source.startedWith).toHaveLength(0); // the stale start aborted
    expect(h.session.activeSessionId).toBeNull();
    expect(h.api.activeSessionId).toBeNull();
    expect(h.logLines.some((l) => /start for S superseded during settings lookup/.test(l))).toBe(
      true,
    );
    // And the source stays idle afterwards: no samples leak.
    h.source.emitStatus({ state: 'collecting' });
    h.source.emitSample();
    expect(h.sink.ofType('sample')).toHaveLength(0);
  });

  it('a newer start for another session during the GET supersedes the older one', async () => {
    const h = harness({ settings: {}, deferSettings: true });
    const first = h.session.start('A');
    const second = h.session.start('B'); // stops A (idle, nothing to flush), then claims B
    h.releaseSettings();
    await Promise.all([first, second]);
    expect(h.source.startedWith).toHaveLength(1); // only B's start reached the source
    expect(h.session.activeSessionId).toBe('B');
    expect(h.api.activeSessionId).toBe('B');
  });
});

describe('BridgeSession: thresholds come from the API unless pinned', () => {
  const apiSettings = {
    min_confidence: 0.7,
    timing_gates: { pulse_s: 5, breathing_s: 8, hrv_s: 9 },
  };

  it('adopts min_confidence and timing_gates from settings/public, logs it and re-announces hello', async () => {
    const h = harness({ settings: apiSettings });
    expect(h.session.thresholds).toEqual({
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
    });
    await h.session.start('S');
    expect(h.session.thresholds).toEqual({
      minConf: 0.7,
      gates: { pulseS: 5, breathingS: 8, hrvS: 9 },
    });
    const hello = h.sink.ofType('hello').at(-1);
    expect(hello).toMatchObject({ minConf: 0.7, gates: { pulseS: 5, breathingS: 8, hrvS: 9 } });
    expect(
      h.logLines.some((l) =>
        /adopted thresholds from API settings\/public: min_conf 0.6 → 0.7, pulse_s 12s → 5s/.test(
          l,
        ),
      ),
    ).toBe(true);

    // The adopted values govern gating: at 6 s the (5 s) pulse gate is open, and 0.65 < 0.7 is low confidence.
    collectFor(h, 6);
    h.source.emitSample({ pulseConf: 0.65 });
    const s = h.sink.ofType('sample').at(-1);
    expect(s?.sample.pulseBpm).toBe(72);
    expect(s?.sample.qualityFlags).toContain('low_conf_pulse');
    expect(s?.published.pulse).toBe(false);
    h.source.emitSample({ pulseConf: 0.7 });
    expect(h.sink.ofType('sample').at(-1)?.published.pulse).toBe(true);
  });

  it('a pinned --min-conf beats the API; pinned gates likewise', async () => {
    const h = harness({
      settings: apiSettings,
      minConf: 0.5,
      gates: { pulseS: 2, breathingS: 3, hrvS: 4 },
    });
    await h.session.start('S');
    expect(h.session.thresholds).toEqual({
      minConf: 0.5,
      gates: { pulseS: 2, breathingS: 3, hrvS: 4 },
    });
    expect(h.sink.ofType('hello')).toHaveLength(0); // nothing changed, nothing re-announced
  });

  it('ignores invalid API values with a warning and keeps the fallbacks', async () => {
    const h = harness({
      settings: {
        min_confidence: 1.7,
        timing_gates: { pulse_s: -1, breathing_s: 'soon', hrv_s: 61 },
      },
    });
    await h.session.start('S');
    expect(h.session.thresholds).toEqual({
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 61 },
    });
    expect(h.logLines.filter((l) => /invalid (min_confidence|timing_gates)/.test(l))).toHaveLength(
      3,
    );
  });

  it('keeps the fallbacks (no hello) when the API is unreachable or says nothing', async () => {
    const down = harness({ settings: new Error('ECONNREFUSED') });
    await down.session.start('S');
    expect(down.session.thresholds.minConf).toBe(0.6);
    expect(down.sink.ofType('hello')).toHaveLength(0);
    const same = harness({ settings: { min_confidence: 0.6 } });
    await same.session.start('S');
    expect(same.sink.ofType('hello')).toHaveLength(0);
  });

  it('non-mock sources adopt thresholds too (the GET happens for every source)', async () => {
    const h = harness({ name: 'presage', settings: apiSettings });
    await h.session.start('S');
    expect(h.session.thresholds.minConf).toBe(0.7);
  });
});
