/**
 * Vitals adapter contract.
 *
 * The two interfaces below are reproduced VERBATIM from CLAUDE.md §7.1 (the product brief) and
 * docs/CONTRACTS.md §3. They are the only coupling between a vitals source plugin and the rest of
 * the bridge. Do not edit them here without logging the change in docs/DECISIONS.md: the API's
 * Pydantic model for `POST /sessions/{id}/vitals` and the web app's WS types mirror them field by
 * field (camelCase on the wire, as written here).
 *
 * The `prettier-ignore` markers keep the brief's formatting intact so a reviewer can diff the two
 * by eye.
 */

// prettier-ignore
export interface VitalsSample {
  tsUtc: string;                 // ISO-8601
  source: "mock" | "presage" | "arduino";
  isMeasured: boolean;           // false for mock, true for real sensors
  pulseBpm?: number;  pulseConf?: number;        // 0..1
  breathingBpm?: number; breathingConf?: number; // 0..1
  hrvRmssdMs?: number; hrvConf?: number;
  windowS: number;               // averaging window the source used
  qualityFlags: string[];        // e.g. "face_not_found", "low_light", "motion", "talking"
}

// prettier-ignore
export interface VitalsSource {
  readonly name: "mock" | "presage" | "arduino";
  readonly isMeasured: boolean;
  start(opts: { cameraId?: string; scenario?: string }): Promise<void>;
  stop(): Promise<void>;
  onSample(cb: (s: VitalsSample) => void): void;
  onStatus(cb: (status: { state: "idle"|"warming"|"collecting"|"error"; message?: string }) => void): void;
  listCameras?(): Promise<{ id: string; label: string }[]>;
}

// ---------------------------------------------------------------------------------------------
// Bridge-side helpers derived from the contract (not part of the verbatim block).
// ---------------------------------------------------------------------------------------------

/** The three source names the contract allows. */
export type SourceName = VitalsSource['name'];

export const SOURCE_NAMES: readonly SourceName[] = ['mock', 'presage', 'arduino'] as const;

export function isSourceName(value: string): value is SourceName {
  return (SOURCE_NAMES as readonly string[]).includes(value);
}

/** Lifecycle state a source reports through `onStatus`. */
export type SourceState = 'idle' | 'warming' | 'collecting' | 'error';

/** The status object a source passes to its `onStatus` callback (named form of the inline type). */
export interface SourceStatus {
  state: SourceState;
  message?: string;
}

/** One second's worth of synthetic/real photoplethysmography points for the kiosk sparkline. */
export interface WaveformBatch {
  /** ~25 points, each in 0..1, oldest first. */
  values: number[];
  /** Timestamp of the sample this batch accompanies. */
  tsUtc: string;
}

/**
 * Optional extension a source may implement when it can produce a pleth waveform. The mock does;
 * Presage can (the SDK exposes pleth + breathing waveforms); Arduino cannot. The bridge detects it
 * with `hasWaveform()` and forwards batches as `{type: "waveform"}` WS messages.
 */
export interface WaveformCapable {
  onWaveform(cb: (w: WaveformBatch) => void): void;
}

export function hasWaveform(source: VitalsSource): source is VitalsSource & WaveformCapable {
  return typeof (source as Partial<WaveformCapable>).onWaveform === 'function';
}

/**
 * Optional marker for sources whose implementation is a documented stub. The factory in
 * `index.ts` refuses to hand out a source with `implemented === false`, so selecting it fails
 * fast at startup with the stub's message (CLAUDE.md §7.4). Today only the Arduino source is a
 * stub; Presage is implemented (presage.ts) and uses `Preflightable` below instead.
 */
export interface StubMarker {
  readonly implemented: boolean;
  readonly notImplementedMessage: string;
}

export function isStubbed(source: VitalsSource): source is VitalsSource & StubMarker {
  return (source as Partial<StubMarker>).implemented === false;
}

/** Thrown by stubbed sources and by the factory when a stub is selected. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  constructor(message: string) {
    super(message);
    // Restore the prototype chain for `instanceof` under ES5-style targets/transpilers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The hint every fail-fast message ends with (CLAUDE.md §7.3: "tell the operator to switch to mock"). */
export const SWITCH_TO_MOCK_HINT =
  'Switch to the mock source: --source mock (or VITALS_SOURCE=mock).';

/** Why a real source cannot run on this machine right now. */
export type SourceUnavailableReason =
  | 'sdk_missing' // the native SDK package is not installed (it is never a package.json dependency)
  | 'sdk_load_failed' // installed, but importing it failed (unsupported platform, broken native build)
  | 'api_key_missing' // the vendor API key is not configured
  | 'no_camera' // the SDK found no camera to open
  | 'other';

/**
 * Thrown by a real (non-stub) source when something outside the repository is missing: the
 * vendor SDK, an API key, a camera, a serial device. The CLI maps it to exit code 2, exactly like
 * a stub, so "source unavailable" means the same thing whichever source was selected.
 */
export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
  readonly reason: SourceUnavailableReason;
  constructor(message: string, reason: SourceUnavailableReason = 'other') {
    super(message);
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Optional capability: a source backed by a native SDK, an API key or a device can verify those
 * BEFORE the bridge opens any port, so `--source presage` on a laptop without the SDK exits with
 * code 2 and the install command instead of failing at the first participant's check-in. The CLI
 * calls it right after construction and expects a `SourceUnavailableError` on failure.
 * `forListCameras` relaxes checks that `--list-cameras` does not need (the API key).
 */
export interface Preflightable {
  preflight(opts?: { forListCameras?: boolean }): Promise<void>;
}

export function hasPreflight(source: VitalsSource): source is VitalsSource & Preflightable {
  return typeof (source as Partial<Preflightable>).preflight === 'function';
}
