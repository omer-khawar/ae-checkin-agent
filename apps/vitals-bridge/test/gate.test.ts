import { describe, expect, it } from 'vitest';
import {
  applyStatus,
  DEFAULT_MIN_CONF,
  DEFAULT_TIMING_GATES,
  elapsedCollectingS,
  gateSample,
  INITIAL_GATE_STATE,
  type GateState,
} from '../src/gate.js';
import type { VitalsSample } from '../src/sources/types.js';

const T0 = Date.parse('2026-10-10T12:00:00.000Z');
const at = (s: number): number => T0 + s * 1000;

const raw = (over: Partial<VitalsSample> = {}): VitalsSample => ({
  tsUtc: '2026-10-10T12:00:00.000Z',
  source: 'mock',
  isMeasured: false,
  pulseBpm: 72,
  pulseConf: 0.9,
  breathingBpm: 14,
  breathingConf: 0.85,
  hrvRmssdMs: 40,
  hrvConf: 0.8,
  windowS: 10,
  qualityFlags: [],
  ...over,
});

const collecting = (sinceS: number): GateState =>
  applyStatus(INITIAL_GATE_STATE, { state: 'collecting' }, at(sinceS));

describe('gate: timing', () => {
  it('defaults are 12 / 30 / 60 s and min confidence 0.6', () => {
    expect(DEFAULT_TIMING_GATES).toEqual({ pulseS: 12, breathingS: 30, hrvS: 60 });
    expect(DEFAULT_MIN_CONF).toBe(0.6);
  });

  it('strips every metric while idle and flags gate_pending_*', () => {
    const g = gateSample(INITIAL_GATE_STATE, raw(), at(100));
    expect(g.sample.pulseBpm).toBeUndefined();
    expect(g.sample.pulseConf).toBeUndefined();
    expect(g.sample.breathingBpm).toBeUndefined();
    expect(g.sample.hrvRmssdMs).toBeUndefined();
    expect(g.sample.qualityFlags).toEqual([
      'gate_pending_pulse',
      'gate_pending_breathing',
      'gate_pending_hrv',
    ]);
    expect(g.published).toEqual({ pulse: false, breathing: false, hrv: false });
    expect(g.elapsedS).toBe(0);
  });

  it('opens pulse at 12 s, breathing at 30 s, HRV at 60 s of continuous collecting', () => {
    const state = collecting(0);
    const t5 = gateSample(state, raw(), at(5));
    expect(t5.published).toEqual({ pulse: false, breathing: false, hrv: false });
    expect(t5.elapsedS).toBe(5);

    const t11 = gateSample(state, raw(), at(11.9));
    expect(t11.published.pulse).toBe(false);
    expect(t11.elapsedS).toBe(11);

    const t12 = gateSample(state, raw(), at(12));
    expect(t12.published).toEqual({ pulse: true, breathing: false, hrv: false });
    expect(t12.sample.pulseBpm).toBe(72);
    expect(t12.sample.pulseConf).toBe(0.9);
    expect(t12.sample.breathingBpm).toBeUndefined();
    expect(t12.sample.qualityFlags).toEqual(['gate_pending_breathing', 'gate_pending_hrv']);

    const t30 = gateSample(state, raw(), at(30));
    expect(t30.published).toEqual({ pulse: true, breathing: true, hrv: false });
    expect(t30.sample.breathingBpm).toBe(14);
    expect(t30.sample.qualityFlags).toEqual(['gate_pending_hrv']);

    const t60 = gateSample(state, raw(), at(60));
    expect(t60.published).toEqual({ pulse: true, breathing: true, hrv: true });
    expect(t60.sample.hrvRmssdMs).toBe(40);
    expect(t60.sample.qualityFlags).toEqual([]);
  });

  it('an error status resets the clock; collecting again starts from zero', () => {
    let state = collecting(0);
    expect(elapsedCollectingS(state, at(20))).toBe(20);
    state = applyStatus(state, { state: 'error', message: 'camera lost' }, at(20));
    expect(elapsedCollectingS(state, at(24))).toBe(0);
    state = applyStatus(state, { state: 'collecting' }, at(25));
    expect(elapsedCollectingS(state, at(30))).toBe(5);
    const g = gateSample(state, raw(), at(30));
    expect(g.published.pulse).toBe(false);
    expect(g.sample.qualityFlags).toContain('gate_pending_pulse');
    expect(gateSample(state, raw(), at(37)).published.pulse).toBe(true);
  });

  it('warming and idle also break continuity', () => {
    let state = collecting(0);
    state = applyStatus(state, { state: 'warming' }, at(10));
    expect(state.collectingSinceMs).toBeNull();
    state = applyStatus(state, { state: 'collecting' }, at(11));
    expect(elapsedCollectingS(state, at(20))).toBe(9);
    state = applyStatus(state, { state: 'idle' }, at(21));
    expect(elapsedCollectingS(state, at(40))).toBe(0);
  });

  it('a repeated collecting status does not restart the clock', () => {
    const a = collecting(0);
    const b = applyStatus(a, { state: 'collecting', message: 'still going' }, at(10));
    expect(b).toBe(a);
    expect(elapsedCollectingS(b, at(12))).toBe(12);
  });

  it('honours custom gates', () => {
    const state = collecting(0);
    const g = gateSample(state, raw(), at(3), { pulseS: 2, breathingS: 4, hrvS: 6 });
    expect(g.published).toEqual({ pulse: true, breathing: false, hrv: false });
  });
});

describe('gate: confidence', () => {
  const open = collecting(0);
  const later = at(60);

  it('keeps a low-confidence value but flags it and does not publish it', () => {
    const g = gateSample(open, raw({ pulseConf: 0.5, breathingConf: 0.59 }), later);
    expect(g.sample.pulseBpm).toBe(72); // kept: the raw series is never thinned
    expect(g.sample.pulseConf).toBe(0.5);
    expect(g.sample.breathingBpm).toBe(14);
    expect(g.sample.qualityFlags).toEqual(['low_conf_pulse', 'low_conf_breathing']);
    expect(g.published).toEqual({ pulse: false, breathing: false, hrv: true });
  });

  it('treats a value with no confidence as confidence 0', () => {
    const g = gateSample(open, raw({ pulseConf: undefined }), later);
    expect(g.sample.pulseBpm).toBe(72);
    expect(g.sample.qualityFlags).toEqual(['low_conf_pulse']);
    expect(g.published.pulse).toBe(false);
  });

  it('a metric the source did not provide is neither flagged nor published once its gate is open', () => {
    const g = gateSample(open, raw({ hrvRmssdMs: undefined, hrvConf: undefined }), later);
    expect(g.sample.hrvRmssdMs).toBeUndefined();
    expect(g.sample.qualityFlags).toEqual([]);
    expect(g.published).toEqual({ pulse: true, breathing: true, hrv: false });
  });

  it('exactly the threshold passes', () => {
    const g = gateSample(open, raw({ pulseConf: 0.6 }), later);
    expect(g.published.pulse).toBe(true);
    expect(g.sample.qualityFlags).toEqual([]);
  });

  it('honours a custom threshold', () => {
    const g = gateSample(open, raw({ pulseConf: 0.7 }), later, DEFAULT_TIMING_GATES, 0.8);
    expect(g.published.pulse).toBe(false);
    expect(g.sample.qualityFlags).toEqual(['low_conf_pulse']);
  });
});

describe('gate: hygiene', () => {
  it('preserves source flags first, appends gate flags, removes duplicates, never mutates input', () => {
    const input = raw({ qualityFlags: ['motion', 'gate_pending_hrv'] });
    const snapshot = JSON.stringify(input);
    const g = gateSample(collecting(0), input, at(30));
    expect(g.sample.qualityFlags).toEqual(['motion', 'gate_pending_hrv']);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(g.sample).not.toBe(input);
    expect(g.sample.qualityFlags).not.toBe(input.qualityFlags);
  });

  it('passes windowS, source, isMeasured and timestamp through untouched', () => {
    const g = gateSample(
      collecting(0),
      raw({ windowS: 7, isMeasured: true, source: 'presage' }),
      at(60),
    );
    expect(g.sample.windowS).toBe(7);
    expect(g.sample.isMeasured).toBe(true);
    expect(g.sample.source).toBe('presage');
    expect(g.sample.tsUtc).toBe('2026-10-10T12:00:00.000Z');
  });
});
