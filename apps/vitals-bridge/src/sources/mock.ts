/**
 * Mock vitals source (CLAUDE.md §7.2): scenario-driven synthetic pulse / breathing / HRV at 1 Hz,
 * plus a synthetic pleth waveform for the kiosk sparkline.
 *
 * Properties the rest of the system relies on:
 *  - Every sample is `isMeasured: false`, `source: "mock"`. Nothing here is a measurement.
 *  - Deterministic: the series is a pure function of (scenario, seed). The default seed is derived
 *    from the scenario name, so two laptops running `--scenario resting` show the same numbers.
 *  - One sample per simulated second. `intervalMs` only changes wall-clock pacing (tests use a
 *    small value); each `tick()` is always one simulated second.
 *  - Status transitions: start() → "warming"; first collecting tick → "collecting"; the dropout
 *    scenario goes "error" for a while and comes back "collecting"; stop() → "idle".
 *  - No clinical constants in this file: all shape parameters come from scenarios.ts.
 *
 * The timing gates (pulse 12 s / breathing 30 s / HRV 60 s) are NOT applied here; gate.ts applies
 * them to every source uniformly, so the mock emits raw values from its first collecting second.
 */
import { AR1, clamp, hashSeed, mulberry32, round, type Rng } from './noise.js';
import {
  DEFAULT_SCENARIO,
  isScenarioName,
  MOCK_SCENARIOS,
  SCENARIO_NAMES,
  type ScenarioName,
  type ScenarioSpec,
} from './scenarios.js';
import type {
  SourceState,
  SourceStatus,
  VitalsSample,
  VitalsSource,
  WaveformBatch,
  WaveformCapable,
} from './types.js';

export interface MockOptions {
  /** Seed for the PRNG. A string is hashed. Default: hash of the scenario name. */
  seed?: number | string;
  /** Wall-clock milliseconds between ticks. Default 1000 (1 Hz). Each tick is one simulated second. */
  intervalMs?: number;
  /** Clock used for `tsUtc`; injectable for tests. */
  now?: () => Date;
  /** Points per waveform batch (one batch per tick). Default 25. */
  waveformPoints?: number;
}

export const DEFAULT_WAVEFORM_POINTS = 25;

interface NoiseBank {
  pulse: AR1;
  breathing: AR1;
  hrv: AR1 | null;
  conf: AR1;
}

export class MockVitalsSource implements VitalsSource, WaveformCapable {
  readonly name = 'mock' as const;
  readonly isMeasured = false as const;

  private readonly sampleCbs: Array<(s: VitalsSample) => void> = [];
  private readonly statusCbs: Array<(s: SourceStatus) => void> = [];
  private readonly waveformCbs: Array<(w: WaveformBatch) => void> = [];

  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly waveformPoints: number;
  private readonly seedOption: number | string | undefined;

  private spec: ScenarioSpec = MOCK_SCENARIOS[DEFAULT_SCENARIO];
  private timer: NodeJS.Timeout | null = null;
  private state: SourceState = 'idle';
  /** Simulated seconds since start(). */
  private t = 0;
  /** Tick at which the current collecting stretch began (null while not collecting). */
  private collectStartT: number | null = null;
  private rng: Rng = mulberry32(0);
  private noise: NoiseBank | null = null;
  /** Pleth phase in radians, carried across batches so the waveform is continuous. */
  private phase = 0;

  constructor(opts: MockOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.now = opts.now ?? (() => new Date());
    this.waveformPoints = opts.waveformPoints ?? DEFAULT_WAVEFORM_POINTS;
    this.seedOption = opts.seed;
  }

  /** Scenario currently loaded (the last one passed to start(), or the default). */
  get scenario(): ScenarioName {
    return this.spec.name;
  }

  get currentState(): SourceState {
    return this.state;
  }

  /** Simulated seconds since start(). */
  get elapsedS(): number {
    return this.t;
  }

  /** Scenarios this source understands (for admin UIs and CLI validation). */
  static scenarios(): readonly ScenarioName[] {
    return SCENARIO_NAMES;
  }

  onSample(cb: (s: VitalsSample) => void): void {
    this.sampleCbs.push(cb);
  }

  onStatus(cb: (status: SourceStatus) => void): void {
    this.statusCbs.push(cb);
  }

  onWaveform(cb: (w: WaveformBatch) => void): void {
    this.waveformCbs.push(cb);
  }

  /** The mock "camera" is a single simulated device; listed so `--list-cameras` has something to show. */
  listCameras(): Promise<{ id: string; label: string }[]> {
    return Promise.resolve([{ id: 'mock-0', label: 'Simulated camera (mock source, no video)' }]);
  }

  start(opts: { cameraId?: string; scenario?: string } = {}): Promise<void> {
    const name = opts.scenario ?? this.spec.name;
    if (!isScenarioName(name)) {
      return Promise.reject(
        new Error(`unknown mock scenario "${name}" (known: ${SCENARIO_NAMES.join(', ')})`),
      );
    }
    this.halt();
    this.spec = MOCK_SCENARIOS[name];
    this.t = 0;
    this.collectStartT = null;
    this.phase = 0;
    const seed =
      typeof this.seedOption === 'string'
        ? hashSeed(this.seedOption)
        : (this.seedOption ?? hashSeed(name));
    this.rng = mulberry32(seed);
    this.noise = this.makeNoise();
    this.setState('warming', `simulated camera warming up (scenario "${name}")`);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.halt();
    return Promise.resolve();
  }

  /**
   * Advance one simulated second and emit whatever that second produces. Public so tests can drive
   * the source without timers; the interval timer calls exactly this.
   */
  tick(): void {
    this.t += 1;
    const dropout = this.spec.dropout;
    if (dropout && this.t >= dropout.errorAtS && this.t < dropout.errorAtS + dropout.errorForS) {
      // A dead camera produces no samples, only an error status (emitted once per outage).
      if (this.state !== 'error') {
        this.collectStartT = null;
        this.setState('error', dropout.message);
      }
      return;
    }
    if (this.t < this.spec.warmupS) return; // no face lock yet: nothing to report

    if (this.state !== 'collecting') {
      const recovered = this.state === 'error';
      this.collectStartT = this.t;
      this.noise = this.makeNoise(); // fresh ramp after warm-up or recovery
      this.setState(
        'collecting',
        recovered ? 'simulated camera recovered' : 'face found (simulated); collecting',
      );
    }

    const tc = this.t - (this.collectStartT ?? this.t);
    const sample = this.buildSample(tc);
    for (const cb of this.sampleCbs) cb(sample);
    const wave = this.buildWaveform(sample.pulseBpm, sample.tsUtc);
    for (const cb of this.waveformCbs) cb(wave);
  }

  // ---- internals ---------------------------------------------------------------------------

  private halt(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.collectStartT = null;
    if (this.state !== 'idle') this.setState('idle');
  }

  private setState(state: SourceState, message?: string): void {
    this.state = state;
    const status: SourceStatus = message === undefined ? { state } : { state, message };
    for (const cb of this.statusCbs) cb(status);
  }

  private makeNoise(): NoiseBank {
    const s = this.spec;
    return {
      pulse: new AR1(s.pulse.phi, s.pulse.sd, this.rng),
      breathing: new AR1(s.breathing.phi, s.breathing.sd, this.rng),
      hrv: s.hrv ? new AR1(s.hrv.phi, s.hrv.sd, this.rng) : null,
      conf: new AR1(0.7, s.conf.jitterSd, this.rng),
    };
  }

  /** Deterministic curve value before noise: target + (start - target) * exp(-t / tau). */
  private static curve(m: { start: number; target: number; tauS: number }, tc: number): number {
    if (m.start === m.target) return m.target;
    return m.target + (m.start - m.target) * Math.exp(-tc / Math.max(m.tauS, 1e-6));
  }

  private buildSample(tc: number): VitalsSample {
    const s = this.spec;
    const noise = this.noise ?? this.makeNoise();

    const flags: string[] = [];
    if (s.flags && this.rng() < s.flags.perSecondProbability) {
      const idx = Math.floor(this.rng() * s.flags.candidates.length);
      flags.push(s.flags.candidates[idx] ?? s.flags.candidates[0] ?? 'low_light');
    }

    const confBase =
      s.conf.rampS > 0
        ? s.conf.start + (s.conf.end - s.conf.start) * Math.min(1, tc / s.conf.rampS)
        : s.conf.end;
    const conf = clamp(confBase + noise.conf.next(), 0.02, s.conf.max);

    const sample: VitalsSample = {
      tsUtc: this.now().toISOString(),
      source: 'mock',
      isMeasured: false,
      windowS: Math.min(tc + 1, s.windowCapS),
      qualityFlags: flags,
    };

    // Advance the noise processes every second even when the face is lost, so the series stays
    // continuous across a flagged second.
    const pulseNoise = noise.pulse.next();
    const breathingNoise = noise.breathing.next();
    const hrvNoise = noise.hrv ? noise.hrv.next() : 0;

    if (flags.includes('face_not_found')) {
      // No face, no values: the sample still carries its timestamp, window and flags.
      return sample;
    }

    sample.pulseBpm = round(MockVitalsSource.curve(s.pulse, tc) + pulseNoise, 1);
    sample.pulseConf = round(conf, 2);
    sample.breathingBpm = round(MockVitalsSource.curve(s.breathing, tc) + breathingNoise, 1);
    sample.breathingConf = round(clamp(conf * 0.95, 0.02, s.conf.max), 2);
    if (s.hrv) {
      sample.hrvRmssdMs = round(MockVitalsSource.curve(s.hrv, tc) + hrvNoise, 1);
      sample.hrvConf = round(clamp(conf * 0.9, 0.02, s.conf.max), 2);
    }
    return sample;
  }

  /**
   * Synthetic photoplethysmogram: a sharp systolic upstroke followed by a smaller dicrotic bump,
   * advanced at the current pulse frequency. Values in 0..1. When no pulse is available (face
   * lost) the batch is flat low-amplitude noise so the sparkline visibly shows "no signal".
   */
  private buildWaveform(pulseBpm: number | undefined, tsUtc: string): WaveformBatch {
    const n = this.waveformPoints;
    const values: number[] = [];
    if (pulseBpm === undefined) {
      for (let i = 0; i < n; i++) values.push(round(0.5 + 0.02 * (this.rng() - 0.5), 3));
      return { values, tsUtc };
    }
    const dPhase = (2 * Math.PI * (pulseBpm / 60)) / n;
    for (let i = 0; i < n; i++) {
      this.phase = (this.phase + dPhase) % (2 * Math.PI);
      const u = this.phase / (2 * Math.PI);
      const systolic = Math.exp(-(((u - 0.18) / 0.07) ** 2));
      const dicrotic = 0.45 * Math.exp(-(((u - 0.48) / 0.13) ** 2));
      const y = systolic + dicrotic + 0.02 * (this.rng() - 0.5);
      values.push(round(clamp(y, 0, 1), 3));
    }
    return { values, tsUtc };
  }
}
