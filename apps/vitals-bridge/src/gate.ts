/**
 * Timing gates and confidence flagging (CLAUDE.md §3.3 / §7.1, docs/CONTRACTS.md §3.1).
 *
 * Pure functions over an explicit clock so they are trivially unit-testable and the same for
 * every source. The bridge applies them to every raw sample before it is broadcast or posted:
 *
 *  - Timing gate: a metric is published only after N seconds of CONTINUOUS "collecting" state
 *    (pulse 12 s, breathing 30 s, HRV 60 s). Before that the metric and its confidence are
 *    removed from the emitted sample and `gate_pending_<metric>` is added to qualityFlags. Leaving
 *    the collecting state (error, idle, warming) resets the clock.
 *  - Confidence flag: a metric whose confidence is below `minConf` is KEPT (the raw series is never
 *    averaged or thinned by the bridge; CLAUDE.md §3.3) but flagged `low_conf_<metric>`. The UI
 *    hides it; the rules engine ignores it with a logged reason. A value with no confidence at all
 *    is treated as confidence 0.
 *  - `published.<metric>` is the UI-facing verdict: true only when the gate has elapsed, the value
 *    is present and the confidence meets the threshold. "Shown only after the source reports
 *    confidence above threshold and at least 12 s of capture."
 *
 * Why 12/30/60: they are the averaging windows of the Presage SmartSpectra metrics (pulse 12 s,
 * breathing 30 s, HRV 60 s; see docs/VITALS_SOURCES.md). The mock honours the same gates so the
 * demo timing matches what the real sensor will do.
 */
import type { SourceState, SourceStatus, VitalsSample } from './sources/types.js';

export interface TimingGates {
  pulseS: number;
  breathingS: number;
  hrvS: number;
}

/**
 * Offline fallback only. Source: Presage SmartSpectra metric windows (CLAUDE.md §7.1, §7.3). The
 * values in force come from `GET /api/v1/settings/public.timing_gates` (the rules tables) and are
 * adopted by BridgeSession on every start; these constants apply when the API cannot be reached.
 */
export const DEFAULT_TIMING_GATES: Readonly<TimingGates> = { pulseS: 12, breathingS: 30, hrvS: 60 };

/**
 * Offline fallback only. Source: CLAUDE.md §7.1 (`VITALS_MIN_CONF=0.6`). The value in force is
 * `settings/public.min_confidence` from `packages/rules/data/vitals_corroboration.json`, adopted
 * on start unless the operator pinned `--min-conf`; this constant applies when the API is down.
 */
export const DEFAULT_MIN_CONF = 0.6;

export type Metric = 'pulse' | 'breathing' | 'hrv';
export const METRICS: readonly Metric[] = ['pulse', 'breathing', 'hrv'] as const;

export interface GateState {
  readonly state: SourceState;
  /** Wall-clock ms at which the current continuous collecting stretch began; null otherwise. */
  readonly collectingSinceMs: number | null;
}

export const INITIAL_GATE_STATE: GateState = { state: 'idle', collectingSinceMs: null };

/** Fold a source status into the gate state. Only an unbroken run of "collecting" keeps the clock. */
export function applyStatus(prev: GateState, status: SourceStatus, nowMs: number): GateState {
  if (status.state === 'collecting') {
    return prev.state === 'collecting' && prev.collectingSinceMs !== null
      ? prev
      : { state: 'collecting', collectingSinceMs: nowMs };
  }
  return { state: status.state, collectingSinceMs: null };
}

/** Seconds of continuous collecting so far (fractional); 0 when not collecting. */
export function elapsedCollectingS(state: GateState, nowMs: number): number {
  if (state.state !== 'collecting' || state.collectingSinceMs === null) return 0;
  return Math.max(0, (nowMs - state.collectingSinceMs) / 1000);
}

export interface Published {
  pulse: boolean;
  breathing: boolean;
  hrv: boolean;
}

export interface GatedSample {
  sample: VitalsSample;
  published: Published;
  /** Whole seconds of continuous collecting at the time of this sample. */
  elapsedS: number;
}

type NumericField =
  | 'pulseBpm'
  | 'pulseConf'
  | 'breathingBpm'
  | 'breathingConf'
  | 'hrvRmssdMs'
  | 'hrvConf';

const FIELDS: Record<Metric, { value: NumericField; conf: NumericField; gate: keyof TimingGates }> =
  {
    pulse: { value: 'pulseBpm', conf: 'pulseConf', gate: 'pulseS' },
    breathing: { value: 'breathingBpm', conf: 'breathingConf', gate: 'breathingS' },
    hrv: { value: 'hrvRmssdMs', conf: 'hrvConf', gate: 'hrvS' },
  };

/**
 * Apply the gates and confidence policy to one raw sample. Returns a NEW sample; the input is not
 * mutated. Source-provided quality flags are preserved (first), gate flags appended, duplicates
 * removed.
 */
export function gateSample(
  state: GateState,
  raw: VitalsSample,
  nowMs: number,
  gates: TimingGates = DEFAULT_TIMING_GATES,
  minConf: number = DEFAULT_MIN_CONF,
): GatedSample {
  const elapsed = elapsedCollectingS(state, nowMs);
  const sample: VitalsSample = { ...raw, qualityFlags: [...raw.qualityFlags] };
  const published: Published = { pulse: false, breathing: false, hrv: false };
  const flags = new Set<string>(sample.qualityFlags);

  for (const metric of METRICS) {
    const f = FIELDS[metric];
    if (elapsed < gates[f.gate]) {
      // Gate not yet elapsed: strip the metric entirely and say why.
      delete sample[f.value];
      delete sample[f.conf];
      flags.add(`gate_pending_${metric}`);
      continue;
    }
    const value = raw[f.value];
    if (typeof value !== 'number') continue; // source had nothing for this metric; its own flags explain
    const conf = raw[f.conf] ?? 0;
    if (conf < minConf) {
      flags.add(`low_conf_${metric}`);
    } else {
      published[metric] = true;
    }
  }

  sample.qualityFlags = [...flags];
  return { sample, published, elapsedS: Math.floor(elapsed) };
}
