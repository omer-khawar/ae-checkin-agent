/**
 * Presage SmartSpectra source: IMPLEMENTED (docs/CONTRACTS.md R2.5, docs/DECISIONS.md D-016).
 * Status: implemented, untested against a live camera (needs PRESAGE_API_KEY and a webcam).
 *
 * Ported from Omer Khawar's `presage-bridge/bridge.js` (MIT), which verified the SDK 3.4.0
 * surface this file uses: `SmartSpectraSDK`, `CameraSelection`, `breathingMetrics`,
 * `cardioMetrics`, `decodeMetrics`, `Metrics.toObject(..., {longs: Number})`, and the events
 * `metrics(buf, tsMicros)`, `validationStatus(code, ts, hint)`, `error(code, message, retryable)`.
 * The packet → VitalsSample mapping is in presageMap.ts (pure, unit-tested against fixtures in
 * the exact `toObject` shape).
 *
 * How the SDK is loaded: dynamically, inside `start()` / `preflight()` / `listCameras()`. The
 * package `@smartspectra/node-sdk` is deliberately NOT in package.json (CLAUDE.md §7.3: several
 * hundred MB of native binaries); `npm run install:presage` installs it `--no-save` on the kiosk
 * laptop. A missing module fails fast with that command and the hint to switch to `--source
 * mock`; the CLI runs `preflight()` before opening any port and exits with code 2.
 *
 * Lifecycle:
 *   start()  → wait for any in-flight stop()/fatal teardown (the SDK's native state is
 *              process-global; `destroy()` must settle before a replacement is constructed)
 *              → resolve PRESAGE_API_KEY (env or constructor) → import the SDK → pick the camera
 *              (explicit id, else the first discovered camera on Windows, else the SDK default)
 *              → construct with `enableTelemetry: false` and `logLevel: kWarning`, wire events,
 *              useCamera, start → status "warming" → 1 Hz ticker.
 *   metrics  → decode → toObject → newest entry per metric, merged into a pending slot.
 *   tick (1 Hz) → if the pending slot has a value: status "collecting" (first time / after an
 *              outage) and ONE VitalsSample (isMeasured: true, source: "presage"); packets that
 *              arrive faster than 1 Hz are coalesced (newest per metric), never emitted faster.
 *              If nothing with a value arrived for `staleAfterS` while collecting → "warming"
 *              (the bridge's timing gates reset, matching the SDK's own averaging restart).
 *   validationStatus → remembered; its integer CODE becomes qualityFlags on the next sample via
 *              the table in presageMap.ts (the free-text hint only feeds the status message and
 *              the operator log); non-zero codes are logged once per change.
 *   error    → status "error". Retryable: the SDK is left to recover (next packet → collecting).
 *              Fatal: the SDK is torn down and the source stays in "error" until stop(); the
 *              next start() constructs a fresh instance (a new kiosk session recovers).
 *   stop()   → ticker off, `await sdk.stopAsync(); await sdk.destroy();`, status "idle". Idempotent.
 *
 * Privacy: camera frames never leave the SDK's own process memory; only decoded metrics,
 * confidences and quality flags are emitted. The SDK's aggregate telemetry (on by default in
 * SmartSpectraOptions) is switched OFF (CLAUDE.md §13: no telemetry). What the SDK still does
 * talk to Presage's servers for is API-key validation and credit metering: this source needs
 * outbound HTTPS, a documented exception to CLAUDE.md §13's "no runtime network calls"
 * (docs/VITALS_SOURCES.md §5). The API key is never logged. The pleth waveform the SDK can
 * produce is not wired; the kiosk sparkline simply stays hidden for this source.
 */

// ---------------------------------------------------------------------------------------------
// Vendor implementation notes, VERBATIM from CLAUDE.md §7.3 (also reproduced in
// docs/VITALS_SOURCES.md). Kept as a line-comment block rather than a /* */ block because the
// vendor snippet itself contains the sequence that closes a block comment.
// ---------------------------------------------------------------------------------------------
// > **Presage SmartSpectra SDK, Node.js path (verified from vendor docs, Oct 2026):**
// > - Package: `@smartspectra/node-sdk` (`npm install @smartspectra/node-sdk`). Node ≥ 20 (24 LTS recommended). Pulls native runtimes per platform; large install.
// > - OS: Linux x64/arm64 (glibc 2.35+, i.e. Ubuntu 22.04+), Windows x64, macOS Apple Silicon. Intel Mac not supported.
// > - API key: constructor option `apiKey`, obtained from the Presage developer portal (physiology.presagetech.com). There is also a vendor MCP server (`https://mcp.presagetech.com/mcp`) that can fetch/rotate the key, and a Claude Code skill: `npx skills add Presage-Security/SmartSpectra --skill using-smartspectra` (or `/plugin marketplace add Presage-Security/SmartSpectra` then `/plugin install smartspectra-sdk@smartspectra`). Use the skill when implementing.
// > - Minimal usage pattern from vendor quickstart:
// >   ```ts
// >   import { SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, decodeMetrics } from '@smartspectra/node-sdk';
// >   const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics: [...breathingMetrics, ...cardioMetrics] });
// >   sdk.on('metrics', (buf, tsMicros) => { const m = decodeMetrics(buf); /* map → VitalsSample */ });
// >   sdk.on('validationStatus', (code, ts, hint) => { /* map → qualityFlags */ });
// >   sdk.on('error', (code, message, retryable) => { /* → status error */ });
// >   sdk.useCamera(CameraSelection.default);   // or CameraSelection.byId(id) from SmartSpectraSDK.availableCameras()
// >   sdk.start();  /* later: await sdk.stopAsync(); await sdk.destroy(); */
// >   ```
// > - Metrics semantics per vendor docs: pulse rate is a 12-second average (valid 40–110 BPM) with confidence; breathing rate a 30-second average (valid 5–40) with confidence; HRV (Mean NN, RMSSD, SDNN, Baevsky) needs 60 s; waveforms available (pleth, upper/lower breathing); face analysis (blink, talking, expressions). **Exact decoded field names were not verified; read `smartspectra.presagetech.com/docs/nodejs/metrics/` when implementing.**
// > - Capture conditions: face and upper chest visible and well lit; stable camera for breathing; subject still and not talking (talking degrades breathing); avoid dark clothing / fine stripes.
// > - Windows: `CameraSelection.front/back` fail; select by discovered id.
// > - Vendor disclaimer: the SDK metrics are "for general wellness and informational use only" except the FDA-cleared iOS/Android pulse+breathing monitor (510(k) K254169). Our product never claims clearance; the UI footer covers this.
// > - Mapping: `isMeasured = true`, `source = "presage"`, `windowS` from the metric (12/30/60), `qualityFlags` from validationStatus hints, confidences passed through unchanged.
// ---------------------------------------------------------------------------------------------
// End of verbatim vendor notes.
// ---------------------------------------------------------------------------------------------

import { type Logger, silentLogger } from '../log.js';
import {
  describeValidation,
  extractLatest,
  hasValues,
  mapLatestToSample,
  mergeLatest,
  sdkErrorToStatus,
  type LatestMetrics,
  type ValidationState,
} from './presageMap.js';
import {
  SourceUnavailableError,
  SWITCH_TO_MOCK_HINT,
  type Preflightable,
  type SourceState,
  type SourceStatus,
  type VitalsSample,
  type VitalsSource,
} from './types.js';

// ---- constants -------------------------------------------------------------------------------

export const PRESAGE_SDK_PACKAGE = '@smartspectra/node-sdk';
/** Pinned to the version the teammate's bridge.js was verified against. */
export const PRESAGE_SDK_VERSION = '3.4.0';
/** The package.json script that installs the SDK without touching package.json / the lockfile. */
export const PRESAGE_INSTALL_COMMAND = 'npm run install:presage';
export const PRESAGE_PORTAL_URL = 'https://physiology.presagetech.com';
export const PRESAGE_API_KEY_ENV = 'PRESAGE_API_KEY';
/** Optional: pin the camera by the id `--list-cameras` prints (Windows needs an id; see vendor notes). */
export const PRESAGE_CAMERA_ID_ENV = 'PRESAGE_CAMERA_ID';

export const PRESAGE_SDK_MISSING_MESSAGE =
  `Presage SmartSpectra SDK (${PRESAGE_SDK_PACKAGE}@${PRESAGE_SDK_VERSION}) is not installed. ` +
  `Run "${PRESAGE_INSTALL_COMMAND}" in apps/vitals-bridge (it is deliberately not a package.json ` +
  `dependency; see docs/VITALS_SOURCES.md). ${SWITCH_TO_MOCK_HINT}`;

export const PRESAGE_API_KEY_MISSING_MESSAGE =
  `${PRESAGE_API_KEY_ENV} is not set. Get a key at ${PRESAGE_PORTAL_URL} and export it in the ` +
  `bridge's environment (never commit it). ${SWITCH_TO_MOCK_HINT}`;

/** Sample cadence: one VitalsSample per second at most (docs/VITALS_SOURCES.md §1, "Cadence"). */
export const DEFAULT_EMIT_INTERVAL_MS = 1000;
/**
 * Seconds without a valued metrics packet before a collecting source reports "warming" again.
 * The SDK stops producing averages when it loses the face; the bridge's gates should reset then,
 * as the SDK's own 12/30/60 s windows restart once the face is re-acquired.
 */
export const DEFAULT_STALE_AFTER_S = 5;

// ---- the slice of the SDK surface this file uses (no @types dependency) ----------------------

export interface SmartSpectraSdkLike {
  on(event: 'metrics', listener: (buf: Uint8Array, tsMicros?: number) => void): unknown;
  on(
    event: 'validationStatus',
    listener: (code: number, ts?: number, hint?: string) => void,
  ): unknown;
  on(
    event: 'error',
    listener: (code: number, message?: string, retryable?: boolean) => void,
  ): unknown;
  useCamera(selection: unknown): unknown;
  start(): unknown;
  stopAsync(): Promise<unknown>;
  destroy(): Promise<unknown>;
}

/** The `SmartSpectraOptions` fields this bridge sets (SDK 3.4.0 `js/index.d.ts`). */
export interface SmartSpectraSdkOptions {
  apiKey: string;
  requestedMetrics: unknown[];
  /** "Aggregate SDK telemetry. Defaults to `true`; set `false` to opt out." Always false here. */
  enableTelemetry: boolean;
  /** A `SmartSpectraLogLevel` value; omitted only when the SDK build does not export the table. */
  logLevel?: number;
}

export interface SmartSpectraSdkModule {
  SmartSpectraSDK: {
    new (opts: SmartSpectraSdkOptions): SmartSpectraSdkLike;
    /**
     * Synchronous static (SDK 3.4.0: `static availableCameras(): CameraInfo[]`, "throws when
     * discovery is unsupported"). Awaited through Promise.resolve so a future async build also
     * works; the result is normalised by `normalizeCameras`.
     */
    availableCameras?: () => unknown;
  };
  CameraSelection: { default: unknown; byId: (id: string) => unknown };
  breathingMetrics: unknown[];
  cardioMetrics: unknown[];
  decodeMetrics: (buf: Uint8Array) => unknown;
  /** `{ kDebug: 0, kInfo: 1, kWarning: 2, kError: 3, kNone: 4 }` in 3.4.0; optional for older builds. */
  SmartSpectraLogLevel?: Readonly<Record<string, number>>;
}

export interface SmartSpectraMessagesModule {
  Metrics: { toObject: (message: unknown, opts: { longs: NumberConstructor }) => unknown };
}

export interface PresageSdk {
  sdk: SmartSpectraSdkModule;
  messages: SmartSpectraMessagesModule;
}

/** Loads both SDK modules; injectable so tests run a fake SDK and CI never needs the real one. */
export type PresageSdkLoader = () => Promise<PresageSdk>;

// ---- default loader --------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isFn(x: unknown): x is (...args: unknown[]) => unknown {
  return typeof x === 'function';
}

const NOT_FOUND_RE =
  /cannot find (module|package)|ERR_MODULE_NOT_FOUND|failed to (load|resolve)|not found/i;

/** Import a module that may legitimately be absent, mapping the failure to SourceUnavailableError. */
async function importOptional(specifier: string): Promise<unknown> {
  try {
    // A variable specifier keeps TypeScript (and bundlers) from resolving the package at build
    // time: it is not installed in CI and must not be a declared dependency.
    const loaded: unknown = await import(specifier);
    return loaded;
  } catch (err) {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : '';
    const message = err instanceof Error ? err.message : String(err);
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      NOT_FOUND_RE.test(message)
    ) {
      throw new SourceUnavailableError(PRESAGE_SDK_MISSING_MESSAGE, 'sdk_missing');
    }
    throw new SourceUnavailableError(
      `Presage SmartSpectra SDK is installed but failed to load (${specifier}): ${message}. ` +
        `Check the platform matrix in docs/VITALS_SOURCES.md (Linux x64/arm64 glibc 2.35+, Windows x64, ` +
        `macOS Apple Silicon; no Intel Mac) and re-run "${PRESAGE_INSTALL_COMMAND}". ${SWITCH_TO_MOCK_HINT}`,
      'sdk_load_failed',
    );
  }
}

function requireExports(mod: unknown, specifier: string, names: string[]): Record<string, unknown> {
  // ESM interop: a CommonJS package arrives as its namespace, possibly with the exports on `default`.
  const ns = isRecord(mod) ? mod : {};
  const candidate = names.every((n) => n in ns) ? ns : isRecord(ns.default) ? ns.default : ns;
  const missing = names.filter((n) => !(n in candidate));
  if (missing.length > 0) {
    throw new SourceUnavailableError(
      `Presage SmartSpectra SDK module ${specifier} does not export ${missing.join(', ')}; ` +
        `this bridge was written against ${PRESAGE_SDK_PACKAGE}@${PRESAGE_SDK_VERSION} ` +
        `(run "${PRESAGE_INSTALL_COMMAND}" to pin it). ${SWITCH_TO_MOCK_HINT}`,
      'sdk_load_failed',
    );
  }
  return candidate;
}

/**
 * The production loader: `import("@smartspectra/node-sdk")` + `import("@smartspectra/node-sdk/messages")`
 * with a structural check of the exports this file relies on.
 */
export async function loadPresageSdk(): Promise<PresageSdk> {
  const sdkRaw = await importOptional(PRESAGE_SDK_PACKAGE);
  const sdkNs = requireExports(sdkRaw, PRESAGE_SDK_PACKAGE, [
    'SmartSpectraSDK',
    'CameraSelection',
    'breathingMetrics',
    'cardioMetrics',
    'decodeMetrics',
  ]);
  const messagesSpecifier = `${PRESAGE_SDK_PACKAGE}/messages`;
  const msgRaw = await importOptional(messagesSpecifier);
  const msgNs = requireExports(msgRaw, messagesSpecifier, ['Metrics']);
  const metrics = msgNs.Metrics;
  if (
    !isFn(sdkNs.SmartSpectraSDK) ||
    !isFn(sdkNs.decodeMetrics) ||
    !isRecord(metrics) ||
    !isFn(metrics.toObject)
  ) {
    throw new SourceUnavailableError(
      `Presage SmartSpectra SDK exports have an unexpected shape; this bridge was written against ` +
        `${PRESAGE_SDK_PACKAGE}@${PRESAGE_SDK_VERSION}. ${SWITCH_TO_MOCK_HINT}`,
      'sdk_load_failed',
    );
  }
  // The structural checks above are what make these casts safe.
  return {
    sdk: sdkNs as unknown as SmartSpectraSdkModule,
    messages: msgNs as unknown as SmartSpectraMessagesModule,
  };
}

/** The SDK log level this bridge pins: `SmartSpectraLogLevel.kWarning` (warnings and errors only). */
export const PRESAGE_SDK_LOG_LEVEL = 'kWarning';

/** `{ logLevel }` when the loaded SDK exports the level table, else `{}` (the SDK default is the same level). */
export function sdkLogLevelOption(mods: PresageSdk): { logLevel?: number } {
  const level = mods.sdk.SmartSpectraLogLevel?.[PRESAGE_SDK_LOG_LEVEL];
  return typeof level === 'number' && Number.isFinite(level) ? { logLevel: level } : {};
}

// ---- camera list normalisation ---------------------------------------------------------------

export interface CameraInfo {
  id: string;
  label: string;
}

/**
 * `SmartSpectraSDK.availableCameras()` → `{id, label}[]`. Verified shape (SDK 3.4.0
 * `js/index.d.ts` `CameraInfo`): `{ id: string, name: string | null, facing, lensType }`, with
 * "IDs are opaque and platform-local; rediscover before reuse". `label` is `name`, or
 * `camera <id>` when the platform reports no name. Strings and objects with `deviceId` / `index`
 * and `label` / `friendlyName` are still accepted so a future build cannot blank the list.
 */
export function normalizeCameras(raw: unknown): CameraInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: CameraInfo[] = [];
  raw.forEach((entry: unknown, index) => {
    if (typeof entry === 'string') {
      out.push({ id: entry, label: entry });
      return;
    }
    if (typeof entry === 'number') {
      out.push({ id: String(entry), label: `camera ${entry}` });
      return;
    }
    if (!isRecord(entry)) return;
    const idRaw = entry.id ?? entry.deviceId ?? entry.index ?? index;
    const id =
      typeof idRaw === 'string' || typeof idRaw === 'number' ? String(idRaw) : String(index);
    const labelRaw = entry.label ?? entry.name ?? entry.friendlyName ?? entry.description;
    const label =
      typeof labelRaw === 'string' && labelRaw.trim() !== '' ? labelRaw : `camera ${id}`;
    out.push({ id, label });
  });
  return out;
}

// ---- the source ------------------------------------------------------------------------------

export interface PresageOptions {
  /** API key; falls back to env PRESAGE_API_KEY. */
  apiKey?: string;
  /** Camera id from `--list-cameras`; falls back to env PRESAGE_CAMERA_ID, then auto-selection. */
  cameraId?: string;
  /** Environment to read the key / camera id from. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** `process.platform` equivalent; Windows selects the first discovered camera by id. */
  platform?: string;
  /** SDK loader; default imports the real package. Tests inject a fake. */
  loadSdk?: PresageSdkLoader;
  /** Clock for `tsUtc` fallbacks and staleness; injectable for tests. */
  now?: () => Date;
  /** Sample cadence. Default 1000 ms. */
  emitIntervalMs?: number;
  /** Seconds without valued metrics before "warming" is reported again. Default 5. */
  staleAfterS?: number;
  log?: Logger;
}

export class PresageVitalsSource implements VitalsSource, Preflightable {
  readonly name = 'presage' as const;
  /** A camera-based optical measurement of a real participant: measured, never simulated. */
  readonly isMeasured = true as const;

  private readonly sampleCbs: Array<(s: VitalsSample) => void> = [];
  private readonly statusCbs: Array<(s: SourceStatus) => void> = [];

  private readonly apiKeyOption: string | undefined;
  private readonly cameraIdOption: string | undefined;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly platform: string;
  private readonly loadSdk: PresageSdkLoader;
  private readonly now: () => Date;
  private readonly emitIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly log: Logger;

  private modules: PresageSdk | null = null;
  private sdk: SmartSpectraSdkLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: SourceState = 'idle';
  /** Bumped by every start/stop so callbacks from a torn-down SDK instance are ignored. */
  private generation = 0;
  private fatal = false;

  private pending: LatestMetrics = {};
  private pendingHasValues = false;
  private validation: ValidationState | null = null;
  private lastValuedPacketMs: number | null = null;
  private lastEmittedStatusMessage: string | undefined;
  private warnedTimestampFallback = false;
  private decodeFailures = 0;
  /** The in-flight stop(), if any; start() waits for it (native SDK state is process-global). */
  private stopping: Promise<void> | null = null;
  /** The in-flight teardown after a fatal SDK error, if any; start() and stop() wait for it. */
  private fatalTeardown: Promise<void> | null = null;

  constructor(opts: PresageOptions = {}) {
    this.apiKeyOption = opts.apiKey;
    this.cameraIdOption = opts.cameraId;
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.loadSdk = opts.loadSdk ?? loadPresageSdk;
    this.now = opts.now ?? (() => new Date());
    this.emitIntervalMs = opts.emitIntervalMs ?? DEFAULT_EMIT_INTERVAL_MS;
    this.staleAfterMs = (opts.staleAfterS ?? DEFAULT_STALE_AFTER_S) * 1000;
    this.log = opts.log ?? silentLogger;
  }

  get currentState(): SourceState {
    return this.state;
  }

  /** True once the SDK instance exists (between a successful start() and stop()). */
  get running(): boolean {
    return this.sdk !== null;
  }

  onSample(cb: (s: VitalsSample) => void): void {
    this.sampleCbs.push(cb);
  }

  onStatus(cb: (status: SourceStatus) => void): void {
    this.statusCbs.push(cb);
  }

  // ---- preflight / configuration -------------------------------------------------------------

  /**
   * Verify the SDK is importable and (unless listing cameras) the API key is set. Throws
   * SourceUnavailableError with the exact fix; the CLI turns that into exit code 2 before any
   * port is opened. Also reports the failure through onStatus for callers that wired it.
   */
  async preflight(opts: { forListCameras?: boolean } = {}): Promise<void> {
    await this.ensureModules();
    if (!opts.forListCameras) this.resolveApiKey();
  }

  private resolveApiKey(): string {
    const key = (this.apiKeyOption ?? this.env[PRESAGE_API_KEY_ENV] ?? '').trim();
    if (key === '') {
      const err = new SourceUnavailableError(PRESAGE_API_KEY_MISSING_MESSAGE, 'api_key_missing');
      this.setState('error', err.message);
      throw err;
    }
    return key;
  }

  private async ensureModules(): Promise<PresageSdk> {
    if (this.modules) return this.modules;
    try {
      this.modules = await this.loadSdk();
      return this.modules;
    } catch (err) {
      const unavailable =
        err instanceof SourceUnavailableError
          ? err
          : new SourceUnavailableError(
              `Presage SmartSpectra SDK failed to load: ${err instanceof Error ? err.message : String(err)}. ` +
                `Run "${PRESAGE_INSTALL_COMMAND}" in apps/vitals-bridge. ${SWITCH_TO_MOCK_HINT}`,
              'sdk_load_failed',
            );
      this.setState('error', unavailable.message);
      throw unavailable;
    }
  }

  // ---- cameras --------------------------------------------------------------------------------

  async listCameras(): Promise<CameraInfo[]> {
    const mods = await this.ensureModules();
    return this.listCamerasWith(mods);
  }

  private async listCamerasWith(mods: PresageSdk): Promise<CameraInfo[]> {
    const fn = mods.sdk.SmartSpectraSDK.availableCameras;
    if (!isFn(fn)) {
      throw new SourceUnavailableError(
        `this ${PRESAGE_SDK_PACKAGE} build exposes no SmartSpectraSDK.availableCameras(); pass a camera id ` +
          `via ${PRESAGE_CAMERA_ID_ENV} instead`,
        'no_camera',
      );
    }
    let raw: unknown;
    try {
      raw = await Promise.resolve(fn.call(mods.sdk.SmartSpectraSDK));
    } catch (err) {
      // SDK 3.4.0: "Throws when discovery is unsupported", a plain Error with numeric `code` and
      // boolean `retryable`. Translate it so --list-cameras and the Windows auto-selection take
      // the same exit-2 "source unavailable" path as every other missing prerequisite.
      const message = err instanceof Error ? err.message : String(err);
      throw new SourceUnavailableError(
        `SmartSpectraSDK.availableCameras() failed: ${message}. Camera discovery is unsupported ` +
          `or no camera could be enumerated on this machine; plug one in, or pass its id via ` +
          `${PRESAGE_CAMERA_ID_ENV} if you know it. ${SWITCH_TO_MOCK_HINT}`,
        'no_camera',
      );
    }
    return normalizeCameras(raw);
  }

  /** Explicit id (start opts, constructor, env) → Windows: first discovered id → SDK default. */
  private async selectCamera(
    mods: PresageSdk,
    requested: string | undefined,
  ): Promise<{ selection: unknown; label: string }> {
    const explicit = (
      requested ??
      this.cameraIdOption ??
      this.env[PRESAGE_CAMERA_ID_ENV] ??
      ''
    ).trim();
    if (explicit !== '') {
      return { selection: mods.sdk.CameraSelection.byId(explicit), label: `camera id ${explicit}` };
    }
    if (this.platform === 'win32') {
      // Vendor notes: on Windows the default/front/back selections fail; select by discovered id.
      const cameras = await this.listCamerasWith(mods);
      const first = cameras[0];
      if (!first) {
        throw new SourceUnavailableError(
          `no camera found by SmartSpectraSDK.availableCameras(); plug one in or set ${PRESAGE_CAMERA_ID_ENV}. ${SWITCH_TO_MOCK_HINT}`,
          'no_camera',
        );
      }
      this.log.info(
        `presage: Windows needs a camera id; using the first discovered camera ${first.id} (${first.label})`,
      );
      return {
        selection: mods.sdk.CameraSelection.byId(first.id),
        label: `camera ${first.id} (${first.label})`,
      };
    }
    return { selection: mods.sdk.CameraSelection.default, label: 'default camera' };
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async start(opts: { cameraId?: string; scenario?: string } = {}): Promise<void> {
    // Never construct a second SmartSpectraSDK while a previous one is still being destroyed:
    // the SDK's native state is process-global ("await destroy() before constructing a
    // replacement"), and a late `idle` from that teardown must not overwrite our `warming`.
    await this.awaitTeardowns();
    if (this.sdk) await this.stop();
    this.fatal = false;
    this.decodeFailures = 0;
    this.pending = {};
    this.pendingHasValues = false;
    this.validation = null;
    this.lastValuedPacketMs = null;
    this.lastEmittedStatusMessage = undefined;

    // 1. Configuration and SDK availability (both fail fast with the exact fix).
    const apiKey = this.resolveApiKey();
    const mods = await this.ensureModules();

    // 2. Camera.
    const camera = await this.selectCamera(mods, opts.cameraId);

    // 3. SDK instance.
    const generation = ++this.generation;
    let sdk: SmartSpectraSdkLike;
    try {
      sdk = new mods.sdk.SmartSpectraSDK({
        apiKey,
        requestedMetrics: [...mods.sdk.breathingMetrics, ...mods.sdk.cardioMetrics],
        // CLAUDE.md §13 "no telemetry": the SDK's aggregate telemetry defaults to ON; opt out.
        enableTelemetry: false,
        // Explicit: the SDK's own log goes to the process stderr at warnings and errors only.
        ...sdkLogLevelOption(mods),
      });
    } catch (err) {
      const message = `SmartSpectraSDK constructor failed: ${err instanceof Error ? err.message : String(err)}`;
      this.setState('error', message);
      throw new Error(`${message}. ${SWITCH_TO_MOCK_HINT}`);
    }

    sdk.on('metrics', (buf, tsMicros) => {
      if (generation === this.generation) this.handleMetrics(mods, buf, tsMicros);
    });
    sdk.on('validationStatus', (code, _ts, hint) => {
      if (generation === this.generation) this.handleValidation(code, hint ?? '');
    });
    sdk.on('error', (code, message, retryable) => {
      if (generation === this.generation) this.handleError(code, message ?? '', retryable === true);
    });

    try {
      sdk.useCamera(camera.selection);
      sdk.start();
    } catch (err) {
      const message = `SmartSpectra could not start on ${camera.label}: ${err instanceof Error ? err.message : String(err)}`;
      this.generation += 1; // detach the listeners above
      await PresageVitalsSource.teardown(sdk, this.log);
      this.setState('error', message);
      throw new Error(`${message}. ${SWITCH_TO_MOCK_HINT}`);
    }

    this.sdk = sdk;
    this.setState('warming', `opening ${camera.label}; waiting for the first SmartSpectra metrics`);
    this.timer = setInterval(() => this.tick(), this.emitIntervalMs);
  }

  /** Stop capture: ticker off, SDK stopped and destroyed, status idle. Safe to call repeatedly. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.doStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.clearTimer();
    const generation = ++this.generation;
    const sdk = this.sdk;
    this.sdk = null;
    this.pending = {};
    this.pendingHasValues = false;
    this.lastValuedPacketMs = null;
    if (sdk) await PresageVitalsSource.teardown(sdk, this.log);
    if (this.fatalTeardown) await this.fatalTeardown;
    // A start() that began after this stop (it awaits `stopping` first, so only possible once
    // the teardown above has settled and start() has bumped the generation) owns the status now.
    if (generation === this.generation && this.state !== 'idle') this.setState('idle');
  }

  /** Resolve once no stop() and no fatal-error teardown is in flight. */
  private async awaitTeardowns(): Promise<void> {
    // Loop: a stop() may be queued while a fatal teardown settles, and vice versa. Each promise
    // clears its own slot in `finally`, so the loop terminates.
    while (this.stopping || this.fatalTeardown) {
      await (this.stopping ?? this.fatalTeardown);
    }
  }

  private static async teardown(sdk: SmartSpectraSdkLike, log: Logger): Promise<void> {
    try {
      await sdk.stopAsync();
    } catch (err) {
      log.warn(
        `presage: sdk.stopAsync() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await sdk.destroy();
    } catch (err) {
      log.warn(
        `presage: sdk.destroy() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---- SDK event handlers ---------------------------------------------------------------------

  private handleMetrics(mods: PresageSdk, buf: Uint8Array, _tsMicros?: number): void {
    let packet: unknown;
    try {
      packet = mods.messages.Metrics.toObject(mods.sdk.decodeMetrics(buf), { longs: Number });
    } catch (err) {
      this.decodeFailures += 1;
      if (this.decodeFailures === 1 || this.decodeFailures % 100 === 0) {
        this.log.warn(
          `presage: could not decode a metrics packet (${this.decodeFailures} so far): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    const latest = extractLatest(packet);
    this.pending = mergeLatest(this.pending, latest);
    if (hasValues(latest)) {
      this.pendingHasValues = true;
      this.lastValuedPacketMs = this.now().getTime();
    }
  }

  private handleValidation(code: number, hint: string): void {
    const next: ValidationState = { code: Number.isFinite(code) ? code : -1, hint };
    const changed =
      this.validation === null ||
      this.validation.code !== next.code ||
      this.validation.hint !== next.hint;
    this.validation = next;
    if (!changed) return;
    const line = describeValidation(next);
    if (line) this.log.info(`presage: ${line}`);
    // Re-announce the current state with the hint so the kiosk can show "face not centered"
    // while it waits; a repeated "collecting" status does not reset the bridge's gate clock.
    if (this.state === 'warming' || this.state === 'collecting') {
      this.setState(
        this.state,
        line ?? (this.state === 'warming' ? 'waiting for metrics' : 'signal ok'),
      );
    }
  }

  private handleError(code: number, message: string, retryable: boolean): void {
    const status = sdkErrorToStatus(code, message, retryable);
    this.log.warn(`presage: ${status.message ?? 'error'}`);
    if (retryable) {
      // Leave the SDK running: its next metrics packet brings us back to collecting.
      this.pending = {};
      this.pendingHasValues = false;
      this.setState('error', status.message);
      return;
    }
    this.fatal = true;
    this.clearTimer();
    const sdk = this.sdk;
    this.sdk = null;
    this.generation += 1;
    this.setState('error', status.message);
    if (sdk) {
      // Tracked (not fire-and-forget) so a start() for the next session waits for destroy().
      this.fatalTeardown = PresageVitalsSource.teardown(sdk, this.log).finally(() => {
        this.fatalTeardown = null;
      });
    }
  }

  // ---- 1 Hz ticker ----------------------------------------------------------------------------

  /**
   * Emit at most one sample for the packets received since the last tick, and detect a stale
   * stream. Public so tests can drive the source without timers; the interval calls exactly this.
   */
  tick(): void {
    if (this.fatal || (this.sdk === null && this.timer === null)) return;
    const nowMs = this.now().getTime();

    if (this.pendingHasValues) {
      const latest = this.pending;
      this.pending = {};
      this.pendingHasValues = false;
      if (this.state !== 'collecting') {
        this.setState(
          'collecting',
          this.state === 'error' ? 'SmartSpectra recovered; collecting' : 'face found; collecting',
        );
      }
      const { sample, tsFromSdk } = mapLatestToSample(latest, {
        nowMs,
        validation: this.validation,
      });
      if (!tsFromSdk && !this.warnedTimestampFallback) {
        this.warnedTimestampFallback = true;
        this.log.warn(
          'presage: SDK packet timestamps are not plausible epoch microseconds; using the bridge clock for tsUtc',
        );
      }
      for (const cb of this.sampleCbs) cb(sample);
      return;
    }

    if (
      this.state === 'collecting' &&
      this.lastValuedPacketMs !== null &&
      nowMs - this.lastValuedPacketMs > this.staleAfterMs
    ) {
      const hint = describeValidation(this.validation);
      this.setState(
        'warming',
        `no metrics from SmartSpectra for ${Math.round(this.staleAfterMs / 1000)} s` +
          (hint ? ` (${hint})` : ' (face lost or poor signal)') +
          '; timing gates reset',
      );
    }
  }

  // ---- status ---------------------------------------------------------------------------------

  private setState(state: SourceState, message?: string): void {
    const unchanged = state === this.state && message === this.lastEmittedStatusMessage;
    this.state = state;
    this.lastEmittedStatusMessage = message;
    if (unchanged) return;
    const status: SourceStatus = message === undefined ? { state } : { state, message };
    for (const cb of this.statusCbs) cb(status);
  }
}
