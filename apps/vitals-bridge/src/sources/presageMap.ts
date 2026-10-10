/**
 * Pure mapping from a decoded Presage SmartSpectra `Metrics` packet to the bridge's `VitalsSample`
 * (docs/CONTRACTS.md R2.5). No I/O, no SDK import, no timers: everything here is a function of
 * its arguments so it can be unit-tested against fixtures in CI, where the SDK is never installed.
 *
 * Input shape, verified against the SDK's own shipped declarations (`@smartspectra/node-sdk@3.4.0`
 * `js/messages/generated.d.ts`, obtainable with `npm pack`, no native binaries) and exercised by
 * Omer Khawar's `presage-bridge/bridge.js` against a webcam:
 *
 *   Metrics.toObject(decodeMetrics(buf), { longs: Number }) →
 *     {
 *       cardio:    { pulseRate: IMeasurementWithConfidence[], hrv: IHrv[] },
 *       breathing: { rate:      IMeasurementWithConfidence[] },
 *     }
 *
 *   IMeasurementWithConfidence { value, stable, confidence, timestamp }
 *   IHrv { rmssd, meanNn, sdnn, baevsky, timestamp, confidence, stable }
 *
 *   value       number   beats/min (pulse) or breaths/min (breathing)
 *   rmssd       number   ms (HRV)
 *   confidence  number   "percentage in the range [0.0, 100.0]" (the contract wants 0..1 → ÷ 100)
 *   stable      boolean  the SDK's own "at or above the minimum accepted accuracy" flag
 *   timestamp   number   "microseconds since Linux epoch" (a plain Number thanks to {longs: Number})
 *
 * Mapping rules (R2.5):
 *  - one sample per packet; within a packet the LAST entry of each array is the newest average;
 *  - pulseBpm / pulseConf = value / confidence÷100 of that entry; breathing likewise;
 *  - hrvRmssdMs = the hrv entry's `rmssd`; hrvConf = its confidence÷100;
 *  - windowS = the longest averaging window among the metrics present (pulse 12 s, breathing
 *    30 s, HRV 60 s; the vendor's documented windows, also the bridge's timing gates);
 *  - qualityFlags = the latest non-zero `validationStatus` CODE mapped through the
 *    `VALIDATION_CODE_FLAGS` table below (the integer codes are a stable part of the SDK's public
 *    surface; the free-text hint is not), plus `unstable_<metric>` whenever the SDK reports
 *    `stable: false`. A code the table does not know becomes `sdk_validation_<code>` plus the
 *    snake_cased hint, so nothing the SDK said is lost;
 *  - isMeasured: true, source: "presage";
 *  - tsUtc from the packet's newest timestamp (µs → ISO) when it is a plausible epoch time, else
 *    the bridge clock (an SDK build that reports monotonic or millisecond timestamps must not
 *    produce 1970 eSource records).
 *
 * Nothing clinical is decided here: no thresholds, no plausibility checks. gate.ts applies the
 * timing/confidence gates and the rules engine applies its own tables.
 */
import { clamp, round } from './noise.js';
import type { SourceStatus, VitalsSample } from './types.js';

// ---- input shapes ----------------------------------------------------------------------------

/** One `cardio.pulseRate[]` / `breathing.rate[]` entry (`IMeasurementWithConfidence`) as `toObject` renders it. */
export interface MeasurementEntry {
  value?: number;
  /** 0..100 */
  confidence?: number;
  stable?: boolean;
  /** Microseconds since the Unix epoch. */
  timestamp?: number;
}

/** One `cardio.hrv[]` entry (`IHrv` in the SDK's generated.d.ts). Only `rmssd` is mapped. */
export interface HrvEntry {
  /** Root mean square of successive differences, ms. */
  rmssd?: number;
  meanNn?: number;
  sdnn?: number;
  baevsky?: number;
  /** 0..100 */
  confidence?: number;
  stable?: boolean;
  /** Microseconds since the Unix epoch. */
  timestamp?: number;
}

/** The subset of the decoded `Metrics` object this mapping reads. Extra fields are ignored. */
export interface MetricsObject {
  cardio?: { pulseRate?: MeasurementEntry[]; hrv?: HrvEntry[] };
  breathing?: { rate?: MeasurementEntry[] };
}

/** The newest entry per metric, extracted from one or more packets. */
export interface LatestMetrics {
  pulse?: MeasurementEntry;
  breathing?: MeasurementEntry;
  hrv?: HrvEntry;
}

/** The last `validationStatus` event the SDK emitted (`code === 0` means "all good"). */
export interface ValidationState {
  code: number;
  hint: string;
}

export interface MapContext {
  /** Bridge clock, ms since epoch: the fallback for `tsUtc` and the sanity bound for SDK timestamps. */
  nowMs: number;
  /** Latest validation status, if any. */
  validation?: ValidationState | null;
}

// ---- constants (sensor properties, not clinical thresholds) ---------------------------------

/**
 * Averaging windows of the SmartSpectra metrics, from the vendor docs quoted in CLAUDE.md §7.3:
 * pulse rate is a 12-second average, breathing rate a 30-second average, HRV needs 60 s. These
 * are properties of the sensor, reported in `windowS` so the rules engine can check its own
 * `min_window_s` table; they are the same numbers the bridge's timing gates default to.
 */
export const PRESAGE_WINDOW_S = { pulse: 12, breathing: 30, hrv: 60 } as const;

/** Earliest epoch time an SDK timestamp may claim and still be used as `tsUtc` (2020-01-01T00:00:00Z). */
export const EARLIEST_PLAUSIBLE_TS_MS = Date.UTC(2020, 0, 1);
/** Latest an SDK timestamp may run ahead of the bridge clock and still be used (clock skew allowance). */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Longest `qualityFlags` token derived from a hint; vendor hints are short sentences. */
const MAX_FLAG_LENGTH = 48;

/**
 * `validationStatus` code → `qualityFlags` token. A sensor-property table (like the scenario
 * table in scenarios.ts), kept in TypeScript for compile-time shape checking; it carries
 * `source` / `rationale` like every table in this repository.
 *
 * The four tokens the web app treats as "signal degraded" (`face_not_found`, `low_light`,
 * `motion`; see apps/web/src/lib/vitals.ts DEGRADED_FLAGS and docs/VITALS_SOURCES.md §7) are
 * produced from the codes that mean exactly that. `talking` is NOT produced by this source:
 * the SDK reports talking as a `faceMetrics` metric (`MetricType.TALKING`), which the bridge
 * does not request; the vendor's "do not talk" guidance is a capture condition, not a flag.
 */
export const VALIDATION_CODE_FLAGS: Readonly<{
  source: string;
  rationale: string;
  codes: Readonly<Record<number, string>>;
}> = {
  source:
    '@smartspectra/node-sdk@3.4.0 js/index.d.ts `ValidationCode` ("Measurement-readiness codes delivered via the validationStatus event")',
  rationale:
    'Map by the integer code, which the SDK publishes as a typed constant table, not by the free-text hint, whose wording is unpublished and may change. Tokens are lower_snake_case per CLAUDE.md §7.1; the canonical ones (face_not_found, low_light, motion) match the web app vocabulary.',
  codes: {
    1: 'face_not_found', // kNoFaceFound
    2: 'multiple_faces', // kMultipleFacesFound
    3: 'face_not_centered', // kFaceNotCentered
    4: 'face_size_out_of_range', // kFaceSizeOutOfRange (deprecated in the SDK, still emitted by older builds)
    5: 'low_light', // kTooDark
    6: 'too_bright', // kTooBright
    7: 'chest_not_visible', // kChestNotVisible
    10: 'camera_tuning', // kCameraTuning
    11: 'frame_rate_too_low', // kFrameRateTooLow
    12: 'motion', // kExcessiveMotion
    13: 'face_too_close', // kFaceTooClose
    14: 'face_too_far', // kFaceTooFar
    15: 'face_too_high', // kFaceTooHigh
    16: 'face_too_low', // kFaceTooLow
    17: 'face_not_forward', // kFaceNotForward
  },
};

/**
 * `error(code, message, retryable)` code → short operator-facing name and, where the fix is
 * known, what to do. Same provenance as above (`SmartSpectraErrorCode`). Codes 2, 4, 5 and 6 are
 * the SDK talking to Presage's servers: the Presage source needs outbound HTTPS (documented in
 * docs/VITALS_SOURCES.md §5 as a deliberate runtime-network exception).
 */
export const SDK_ERROR_NAMES: Readonly<{
  source: string;
  codes: Readonly<Record<number, { name: string; fix?: string }>>;
}> = {
  source: '@smartspectra/node-sdk@3.4.0 js/index.d.ts `SmartSpectraErrorCode`',
  codes: {
    1: { name: 'invalid state' },
    2: { name: 'authentication failed', fix: 'check PRESAGE_API_KEY' },
    3: { name: 'configuration failed' },
    4: { name: 'credits exhausted', fix: 'top up the account at the Presage portal' },
    5: { name: 'network error', fix: 'the SDK needs outbound HTTPS to Presage' },
    6: { name: 'Presage server error' },
    7: { name: 'input unavailable', fix: 'check the camera' },
    8: { name: 'processing failed' },
    9: { name: 'frame conversion failed' },
    10: { name: 'non-monotonic timestamp' },
    11: { name: 'timestamp gap' },
  },
};

// ---- small helpers ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Last element of an array of objects (the newest average in a packet); undefined when absent. */
function lastEntry<T>(value: unknown): T | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let i = value.length - 1; i >= 0; i--) {
    const entry: unknown = value[i];
    if (isRecord(entry)) return entry as T;
  }
  return undefined;
}

/** `"Face not centered"` → `"face_not_centered"`; empty when nothing alphanumeric survives. */
export function snakeCaseHint(hint: string): string {
  const token = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token.slice(0, MAX_FLAG_LENGTH).replace(/_+$/g, '');
}

/** The table token for a validation code, or undefined for 0 / unknown codes. */
export function validationCodeFlag(code: number): string | undefined {
  return VALIDATION_CODE_FLAGS.codes[code];
}

/**
 * Flags for the latest validation status. A known code yields exactly its table token; an
 * unknown non-zero code yields `sdk_validation_<code>` plus the snake_cased hint (if any).
 */
export function validationFlags(validation: ValidationState | null | undefined): string[] {
  if (!validation || validation.code === 0) return [];
  const known = validationCodeFlag(validation.code);
  if (known !== undefined) return [known];
  const flags = [`sdk_validation_${validation.code}`];
  const raw = snakeCaseHint(validation.hint);
  if (raw !== '' && !flags.includes(raw)) flags.push(raw);
  return flags;
}

/** The entry's `confidence` (0..100) as the contract's 0..1, clamped; undefined when absent. */
export function confidenceToUnit(confidence: unknown): number | undefined {
  if (!isFiniteNumber(confidence)) return undefined;
  return round(clamp(confidence / 100, 0, 1), 4);
}

/**
 * The RMSSD value of an HRV entry (`IHrv.rmssd`, verified in the SDK's generated.d.ts).
 * Undefined when the field is absent or not a finite number, so HRV is simply omitted.
 */
export function hrvRmssd(entry: HrvEntry | undefined): number | undefined {
  if (!entry) return undefined;
  return isFiniteNumber(entry.rmssd) ? entry.rmssd : undefined;
}

/**
 * µs since epoch → ISO-8601 with millisecond precision, when plausible; otherwise the bridge
 * clock. `plausible` is reported so callers can log the first fallback once.
 */
export function timestampMicrosToIso(
  micros: unknown,
  nowMs: number,
): { tsUtc: string; fromSdk: boolean } {
  if (isFiniteNumber(micros) && micros > 0) {
    const ms = Math.round(micros / 1000);
    if (ms >= EARLIEST_PLAUSIBLE_TS_MS && ms <= nowMs + MAX_FUTURE_SKEW_MS) {
      return { tsUtc: new Date(ms).toISOString(), fromSdk: true };
    }
  }
  return { tsUtc: new Date(nowMs).toISOString(), fromSdk: false };
}

// ---- packet → latest entries ---------------------------------------------------------------

/**
 * The newest entry per metric in one decoded packet. Tolerates any shape: a packet that is not
 * an object, or has no recognised metric, yields `{}`.
 */
export function extractLatest(packet: unknown): LatestMetrics {
  const out: LatestMetrics = {};
  if (!isRecord(packet)) return out;
  const cardio = isRecord(packet.cardio) ? packet.cardio : undefined;
  const breathing = isRecord(packet.breathing) ? packet.breathing : undefined;
  const pulse = lastEntry<MeasurementEntry>(cardio?.pulseRate);
  const hrv = lastEntry<HrvEntry>(cardio?.hrv);
  const rate = lastEntry<MeasurementEntry>(breathing?.rate);
  if (pulse) out.pulse = pulse;
  if (rate) out.breathing = rate;
  if (hrv) out.hrv = hrv;
  return out;
}

/**
 * Merge two extractions, keeping the newer entry per metric. `later` wins unless both carry
 * timestamps and `earlier`'s is newer (packets are not guaranteed to arrive in order). Used by
 * the source to coalesce packets that arrive faster than 1 Hz into one sample per second.
 */
export function mergeLatest(earlier: LatestMetrics, later: LatestMetrics): LatestMetrics {
  const pick = <T extends { timestamp?: number }>(a: T | undefined, b: T | undefined) => {
    if (!b) return a;
    if (!a) return b;
    if (isFiniteNumber(a.timestamp) && isFiniteNumber(b.timestamp) && a.timestamp > b.timestamp) {
      return a;
    }
    return b;
  };
  const out: LatestMetrics = {};
  const pulse = pick(earlier.pulse, later.pulse);
  const breathing = pick(earlier.breathing, later.breathing);
  const hrv = pick(earlier.hrv, later.hrv);
  if (pulse) out.pulse = pulse;
  if (breathing) out.breathing = breathing;
  if (hrv) out.hrv = hrv;
  return out;
}

/** True when at least one metric carries a finite value (the source emits nothing otherwise). */
export function hasValues(latest: LatestMetrics): boolean {
  return (
    isFiniteNumber(latest.pulse?.value) ||
    isFiniteNumber(latest.breathing?.value) ||
    hrvRmssd(latest.hrv) !== undefined
  );
}

/** Newest timestamp among the entries present (µs), or undefined. */
export function newestTimestamp(latest: LatestMetrics): number | undefined {
  let newest: number | undefined;
  for (const entry of [latest.pulse, latest.breathing, latest.hrv]) {
    const ts = entry?.timestamp;
    if (isFiniteNumber(ts) && (newest === undefined || ts > newest)) newest = ts;
  }
  return newest;
}

// ---- latest entries → VitalsSample ---------------------------------------------------------

export interface MappedSample {
  sample: VitalsSample;
  /** False when `tsUtc` fell back to the bridge clock because the SDK timestamp was implausible. */
  tsFromSdk: boolean;
}

/**
 * Build the contract sample. Always returns a sample (possibly without any metric value and with
 * `windowS: 0`); callers use `hasValues()` to decide whether to emit it.
 */
export function mapLatestToSample(latest: LatestMetrics, ctx: MapContext): MappedSample {
  const { tsUtc, fromSdk } = timestampMicrosToIso(newestTimestamp(latest), ctx.nowMs);
  const flags = validationFlags(ctx.validation);
  let windowS = 0;

  const sample: VitalsSample = {
    tsUtc,
    source: 'presage',
    isMeasured: true,
    windowS,
    qualityFlags: flags,
  };

  const pulse = latest.pulse;
  if (pulse && isFiniteNumber(pulse.value)) {
    sample.pulseBpm = round(pulse.value, 1);
    const conf = confidenceToUnit(pulse.confidence);
    if (conf !== undefined) sample.pulseConf = conf;
    if (pulse.stable === false) flags.push('unstable_pulse');
    windowS = Math.max(windowS, PRESAGE_WINDOW_S.pulse);
  }

  const breathing = latest.breathing;
  if (breathing && isFiniteNumber(breathing.value)) {
    sample.breathingBpm = round(breathing.value, 1);
    const conf = confidenceToUnit(breathing.confidence);
    if (conf !== undefined) sample.breathingConf = conf;
    if (breathing.stable === false) flags.push('unstable_breathing');
    windowS = Math.max(windowS, PRESAGE_WINDOW_S.breathing);
  }

  const rmssd = hrvRmssd(latest.hrv);
  if (rmssd !== undefined) {
    sample.hrvRmssdMs = round(rmssd, 1);
    const conf = confidenceToUnit(latest.hrv?.confidence);
    if (conf !== undefined) sample.hrvConf = conf;
    if (latest.hrv?.stable === false) flags.push('unstable_hrv');
    windowS = Math.max(windowS, PRESAGE_WINDOW_S.hrv);
  }

  sample.windowS = windowS;
  sample.qualityFlags = [...new Set(flags)];
  return { sample, tsFromSdk: fromSdk };
}

/** Convenience: packet → sample in one call (what a per-packet caller uses). */
export function mapPacket(packet: unknown, ctx: MapContext): MappedSample {
  return mapLatestToSample(extractLatest(packet), ctx);
}

// ---- SDK events → SourceStatus -------------------------------------------------------------

/**
 * `error(code, message, retryable)` → status. Retryable errors are reported and the SDK is left
 * to recover (the next metrics packet brings the source back to `collecting`). A fatal error
 * ends capture for the current session only: the source constructs a fresh SDK instance on the
 * next `start()`, so the fix is "correct the cause and start a new session", not "restart the
 * bridge".
 */
export function sdkErrorToStatus(code: number, message: string, retryable: boolean): SourceStatus {
  const text = message.trim() === '' ? 'no details from the SDK' : message.trim();
  const known = SDK_ERROR_NAMES.codes[code];
  const label = known ? `SmartSpectra error ${code} (${known.name})` : `SmartSpectra error ${code}`;
  if (retryable) {
    return {
      state: 'error',
      message: `${label}: ${text} (retryable; waiting for the SDK to recover)`,
    };
  }
  const fix = known?.fix ? `${known.fix}, then start a new session` : 'start a new session';
  return {
    state: 'error',
    message: `${label}: ${text} (fatal; capture stopped for this session. Fix: ${fix})`,
  };
}

/**
 * A human-readable line for a validation status, for status messages and the operator log. The
 * vendor's hint is preferred because it is written for a person; without one, the table token
 * is spelled out; an unknown code without a hint falls back to its number.
 */
export function describeValidation(validation: ValidationState | null | undefined): string | null {
  if (!validation || validation.code === 0) return null;
  const hint = validation.hint.trim();
  if (hint !== '') return `camera: ${hint}`;
  const known = validationCodeFlag(validation.code);
  return known !== undefined
    ? `camera: ${known.replace(/_/g, ' ')}`
    : `camera validation code ${validation.code}`;
}
