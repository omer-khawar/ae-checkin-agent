import { describe, expect, it } from 'vitest';
import { MockVitalsSource } from '../src/sources/mock.js';
import { MOCK_SCENARIOS, SCENARIO_NAMES, type ScenarioName } from '../src/sources/scenarios.js';
import type { SourceStatus, VitalsSample, WaveformBatch } from '../src/sources/types.js';

interface Run {
  samples: VitalsSample[];
  /** Simulated tick (1-based) at which each sample was emitted. */
  tickOf: number[];
  statuses: SourceStatus[];
  waves: WaveformBatch[];
}

/** Drive the mock by calling tick() directly: no timers, fully deterministic. */
async function run(scenario: ScenarioName, ticks: number, seed?: number): Promise<Run> {
  const src = new MockVitalsSource({
    intervalMs: 3_600_000, // the interval timer is irrelevant here; stop() clears it
    seed,
    now: () => new Date('2026-10-10T12:00:00.000Z'),
  });
  const out: Run = { samples: [], tickOf: [], statuses: [], waves: [] };
  src.onSample((s) => {
    out.samples.push(s);
    out.tickOf.push(src.elapsedS);
  });
  src.onStatus((s) => out.statuses.push(s));
  src.onWaveform((w) => out.waves.push(w));
  await src.start({ scenario });
  for (let i = 0; i < ticks; i++) src.tick();
  await src.stop();
  return out;
}

const defined = (xs: Array<number | undefined>): number[] =>
  xs.filter((x): x is number => typeof x === 'number');

function maxStep(xs: number[]): number {
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.abs((xs[i] ?? 0) - (xs[i - 1] ?? 0)));
  return m;
}

/** Lag-1 Pearson autocorrelation: ~0 for white noise, high for a drifting physiological signal. */
function lag1Autocorrelation(xs: number[]): number {
  const n = xs.length - 1;
  const a = xs.slice(0, n);
  const b = xs.slice(1);
  const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db);
}

describe('MockVitalsSource: contract', () => {
  it('every scenario emits source=mock, isMeasured=false, ISO timestamps and a 1-based window', async () => {
    for (const scenario of SCENARIO_NAMES) {
      const { samples } = await run(scenario, 90);
      expect(samples.length).toBeGreaterThan(40);
      for (const s of samples) {
        expect(s.source).toBe('mock');
        expect(s.isMeasured).toBe(false);
        expect(s.tsUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(s.windowS).toBeGreaterThanOrEqual(1);
        expect(s.windowS).toBeLessThanOrEqual(MOCK_SCENARIOS[scenario].windowCapS);
        expect(Array.isArray(s.qualityFlags)).toBe(true);
      }
    }
  });

  it('goes warming → collecting on start and idle on stop', async () => {
    const { statuses } = await run('resting', 5);
    expect(statuses.map((s) => s.state)).toEqual(['warming', 'collecting', 'idle']);
    expect(statuses[0]?.message).toMatch(/simulated/i);
  });

  it('is deterministic for a given seed and differs across seeds', async () => {
    const a = await run('resting', 60, 42);
    const b = await run('resting', 60, 42);
    const c = await run('resting', 60, 43);
    expect(a.samples).toEqual(b.samples);
    expect(a.waves).toEqual(b.waves);
    expect(a.samples.map((s) => s.pulseBpm)).not.toEqual(c.samples.map((s) => s.pulseBpm));
  });

  it('defaults the seed to the scenario name (same output on every laptop)', async () => {
    const a = await run('tachypnea', 30);
    const b = await run('tachypnea', 30);
    expect(a.samples).toEqual(b.samples);
  });

  it('rejects an unknown scenario', async () => {
    const src = new MockVitalsSource();
    await expect(src.start({ scenario: 'sprinting' })).rejects.toThrow(/unknown mock scenario/);
    expect(src.currentState).toBe('idle');
  });

  it('lists one simulated camera', async () => {
    const cams = await new MockVitalsSource().listCameras();
    expect(cams).toHaveLength(1);
    expect(cams[0]?.label).toMatch(/simulated/i);
  });

  it('windowS grows with the collecting stretch and caps at the table value', async () => {
    const { samples } = await run('resting', 40);
    expect(samples.slice(0, 5).map((s) => s.windowS)).toEqual([1, 2, 3, 4, 5]);
    expect(samples[39]?.windowS).toBe(MOCK_SCENARIOS.resting.windowCapS);
  });

  it('emits one waveform batch of 25 points in 0..1 per sample', async () => {
    const { samples, waves } = await run('resting', 30);
    expect(waves).toHaveLength(samples.length);
    for (const w of waves) {
      expect(w.values).toHaveLength(25);
      for (const v of w.values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    // A pulse-shaped waveform has real amplitude, not a flat line.
    const flat = waves[20]?.values ?? [];
    expect(Math.max(...flat) - Math.min(...flat)).toBeGreaterThan(0.5);
  });

  it('ticks on the wall-clock interval when started with a timer', async () => {
    const src = new MockVitalsSource({ intervalMs: 10 });
    let n = 0;
    src.onSample(() => n++);
    await src.start({ scenario: 'resting' });
    await new Promise((r) => setTimeout(r, 150));
    await src.stop();
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe('MockVitalsSource: resting', () => {
  it('stays in a resting physiological range and is smooth (autocorrelated, no white-noise jumps)', async () => {
    const { samples } = await run('resting', 120);
    const pulse = defined(samples.map((s) => s.pulseBpm));
    const breathing = defined(samples.map((s) => s.breathingBpm));
    const hrv = defined(samples.map((s) => s.hrvRmssdMs));
    expect(pulse).toHaveLength(120);
    expect(Math.min(...pulse)).toBeGreaterThanOrEqual(58);
    expect(Math.max(...pulse)).toBeLessThanOrEqual(86);
    expect(Math.min(...breathing)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...breathing)).toBeLessThanOrEqual(18);
    expect(Math.min(...hrv)).toBeGreaterThanOrEqual(25);
    expect(maxStep(pulse)).toBeLessThanOrEqual(6);
    expect(maxStep(breathing)).toBeLessThanOrEqual(2.5);
    expect(lag1Autocorrelation(pulse)).toBeGreaterThan(0.6);
  });

  it('ramps confidence from ~0.3 to ≥0.9 over the first 15 s', async () => {
    const { samples } = await run('resting', 30);
    expect(samples[0]?.pulseConf).toBeLessThanOrEqual(0.4);
    expect(samples[7]?.pulseConf).toBeGreaterThan(0.45);
    expect(samples[7]?.pulseConf).toBeLessThan(0.85);
    for (const s of samples.slice(15)) expect(s.pulseConf).toBeGreaterThanOrEqual(0.9);
    // Longer-window metrics are the less certain ones.
    const late = samples[25];
    expect(late?.breathingConf).toBeLessThanOrEqual(late?.pulseConf ?? 0);
    expect(late?.hrvConf).toBeLessThanOrEqual(late?.breathingConf ?? 0);
  });
});

describe('MockVitalsSource: post_exercise', () => {
  it('starts high (fires the corroboration thresholds) and decays toward rest within 90 s', async () => {
    const { samples } = await run('post_exercise', 90);
    const pulse = defined(samples.map((s) => s.pulseBpm));
    const breathing = defined(samples.map((s) => s.breathingBpm));
    expect(pulse[0]).toBeGreaterThanOrEqual(120);
    expect(breathing[0]).toBeGreaterThanOrEqual(24);
    // The rules engine corroborates on the MAX eligible value, and the bridge only lets a metric
    // through after its timing gate (pulse 12 s, breathing 30 s). What the rules can see must
    // still clear the vitals_corroboration thresholds (110 / 24), or the demo tier bump never fires.
    expect(Math.max(...pulse.slice(12, 40))).toBeGreaterThanOrEqual(110);
    expect(Math.max(...breathing.slice(30, 60))).toBeGreaterThanOrEqual(24);
    for (const p of pulse.slice(0, 5)) expect(p).toBeGreaterThanOrEqual(115);
    // ...and it does recover: by 90 s pulse is back near rest and breathing is clearly falling.
    expect(pulse[89]).toBeLessThanOrEqual(102);
    expect(pulse[89]).toBeGreaterThanOrEqual(86);
    expect(breathing[89]).toBeLessThanOrEqual(25);
    expect(breathing[89]).toBeLessThan(breathing[0] ?? 0);
    // Always inside plausibility bounds (35–180 / 5–45): the demo is a tier bump, not an implausible flag.
    expect(Math.max(...pulse)).toBeLessThan(180);
    expect(Math.max(...breathing)).toBeLessThan(45);
    expect(maxStep(pulse)).toBeLessThanOrEqual(6);
    expect(maxStep(breathing)).toBeLessThanOrEqual(2.5);
  });
});

describe('MockVitalsSource: tachypnea', () => {
  it('holds breathing ~26 and pulse ~98 with confidence ~0.9 from the first sample', async () => {
    const { samples } = await run('tachypnea', 60);
    for (const s of samples) {
      expect(s.breathingBpm).toBeGreaterThanOrEqual(23);
      expect(s.breathingBpm).toBeLessThanOrEqual(29);
      expect(s.pulseBpm).toBeGreaterThanOrEqual(91);
      expect(s.pulseBpm).toBeLessThanOrEqual(105);
      expect(s.pulseConf).toBeGreaterThanOrEqual(0.85);
    }
  });
});

describe('MockVitalsSource: low_quality', () => {
  it('never reaches confidence 0.5 and flags face_not_found / low_light intermittently', async () => {
    const { samples } = await run('low_quality', 120);
    const flags = new Set(samples.flatMap((s) => s.qualityFlags));
    expect(flags.has('face_not_found')).toBe(true);
    expect(flags.has('low_light')).toBe(true);
    let withValues = 0;
    for (const s of samples) {
      if (s.pulseConf !== undefined) expect(s.pulseConf).toBeLessThan(0.5);
      if (s.breathingConf !== undefined) expect(s.breathingConf).toBeLessThan(0.5);
      if (s.qualityFlags.includes('face_not_found')) {
        expect(s.pulseBpm).toBeUndefined();
        expect(s.breathingBpm).toBeUndefined();
      } else {
        withValues++;
        expect(s.pulseBpm).toBeDefined();
      }
      expect(s.hrvRmssdMs).toBeUndefined(); // scenario simulates no HRV at all
    }
    expect(withValues).toBeGreaterThan(40);
    // Flags are intermittent, not constant.
    expect(samples.filter((s) => s.qualityFlags.length === 0).length).toBeGreaterThan(20);
  });
});

describe('MockVitalsSource: dropout', () => {
  it('is good for 20 s, errors for 10 s with no samples, then recovers with a fresh ramp', async () => {
    const { samples, tickOf, statuses } = await run('dropout', 60);
    expect(statuses.map((s) => s.state)).toEqual([
      'warming',
      'collecting',
      'error',
      'collecting',
      'idle',
    ]);
    expect(statuses[2]?.message).toMatch(/simulated/i);
    expect(tickOf.filter((t) => t >= 21 && t <= 30)).toHaveLength(0);
    expect(tickOf.filter((t) => t <= 20)).toHaveLength(20);
    expect(tickOf.filter((t) => t >= 31)).toHaveLength(30);
    expect(samples).toHaveLength(50);
    // Recovery restarts the confidence ramp and the window.
    const first = samples[20];
    expect(first?.windowS).toBe(1);
    expect(first?.pulseConf).toBeLessThan(0.7);
    expect(samples[30]?.pulseConf).toBeGreaterThanOrEqual(0.9);
  });
});
