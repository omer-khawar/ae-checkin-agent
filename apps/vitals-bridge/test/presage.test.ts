import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiClient, type FetchLike } from '../src/api.js';
import { silentLogger } from '../src/log.js';
import { BridgeSession, type BroadcastSink } from '../src/session.js';
import {
  loadPresageSdk,
  normalizeCameras,
  PRESAGE_API_KEY_MISSING_MESSAGE,
  PRESAGE_INSTALL_COMMAND,
  PRESAGE_SDK_MISSING_MESSAGE,
  PresageVitalsSource,
  sdkLogLevelOption,
  type PresageSdk,
  type PresageSdkLoader,
  type SmartSpectraSdkLike,
  type SmartSpectraSdkOptions,
} from '../src/sources/presage.js';
import {
  hasPreflight,
  isStubbed,
  SourceUnavailableError,
  type SourceStatus,
  type VitalsSample,
} from '../src/sources/types.js';
import type { BridgeToWeb } from '../src/ws.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NOW_MS = Date.parse('2026-10-10T12:00:00.000Z');
const T0_MICROS = NOW_MS * 1000;

// ---- a fake SmartSpectra SDK in the exact shape presage.ts consumes --------------------------

type Listener = (...args: unknown[]) => void;

class FakeSdk implements SmartSpectraSdkLike {
  static instances: FakeSdk[] = [];
  /** When true, the next constructed instance's start() throws (models "camera in use"). */
  static failNextStart = false;
  readonly listeners = new Map<string, Listener[]>();
  readonly opts: SmartSpectraSdkOptions;
  camera: unknown = null;
  started = 0;
  stopAsyncCalls = 0;
  destroyCalls = 0;
  readonly failStart: boolean;

  constructor(opts: SmartSpectraSdkOptions) {
    this.opts = opts;
    this.failStart = FakeSdk.failNextStart;
    FakeSdk.instances.push(this);
  }
  // `never[]` keeps this assignable to the interface's typed overloads; the fake forwards
  // whatever `emit` was given.
  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener);
    this.listeners.set(event, list);
    return this;
  }
  useCamera(selection: unknown): unknown {
    this.camera = selection;
    return undefined;
  }
  start(): unknown {
    if (this.failStart) throw new Error('camera is in use by another application');
    this.started += 1;
    return undefined;
  }
  stopAsync(): Promise<unknown> {
    this.stopAsyncCalls += 1;
    return Promise.resolve();
  }
  destroy(): Promise<unknown> {
    this.destroyCalls += 1;
    return Promise.resolve();
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  /** The real SDK hands a protobuf buffer to `metrics`; the fake encodes the packet as JSON bytes. */
  emitMetrics(packet: unknown, tsMicros?: number): void {
    this.emit('metrics', new TextEncoder().encode(JSON.stringify(packet)), tsMicros);
  }
}

/** `SmartSpectraLogLevel` exactly as SDK 3.4.0 `js/index.d.ts` declares it. */
const SDK_LOG_LEVELS = { kDebug: 0, kInfo: 1, kWarning: 2, kError: 3, kNone: 4 } as const;

/** A discovery failure as the real SDK throws it (ffi.js `makeFfiError`: plain Error + code + retryable). */
function discoveryError(): Error {
  const e = new Error('camera discovery is not supported on this platform') as Error & {
    code: number;
    retryable: boolean;
  };
  e.code = 7;
  e.retryable = false;
  return e;
}

function fakeModules(
  over: {
    cameras?: unknown;
    noAvailableCameras?: boolean;
    /** availableCameras() throws synchronously, as the real static does. */
    camerasThrow?: boolean;
    /** Model an SDK build without the `SmartSpectraLogLevel` export. */
    noLogLevel?: boolean;
  } = {},
): PresageSdk {
  const SmartSpectraSDK = FakeSdk as unknown as PresageSdk['sdk']['SmartSpectraSDK'];
  const statics = SmartSpectraSDK as { availableCameras?: unknown };
  if (over.noAvailableCameras) {
    statics.availableCameras = undefined;
  } else if (over.camerasThrow) {
    statics.availableCameras = () => {
      throw discoveryError();
    };
  } else {
    // SDK 3.4.0: a synchronous static returning CameraInfo[] ({ id, name, facing, lensType }).
    statics.availableCameras = () =>
      over.cameras ?? [
        { id: 'cam-1', name: 'Integrated Webcam', facing: 'front', lensType: 'unknown' },
      ];
  }
  return {
    sdk: {
      SmartSpectraSDK,
      CameraSelection: { default: 'DEFAULT', byId: (id: string) => ({ byId: id }) },
      breathingMetrics: ['BREATHING_RATE'],
      cardioMetrics: ['PULSE_RATE', 'HRV'],
      // decodeMetrics → "protobuf message"; Metrics.toObject → plain object. The fake keeps the
      // JSON bytes as the message and parses them in toObject, mirroring the two-step real path.
      decodeMetrics: (buf: Uint8Array) => ({ bytes: buf }),
      ...(over.noLogLevel ? {} : { SmartSpectraLogLevel: SDK_LOG_LEVELS }),
    },
    messages: {
      Metrics: {
        toObject: (message: unknown) =>
          JSON.parse(new TextDecoder().decode((message as { bytes: Uint8Array }).bytes)) as unknown,
      },
    },
  };
}

const loaderFor =
  (mods: PresageSdk): PresageSdkLoader =>
  () =>
    Promise.resolve(mods);

function simulatedPacket(i: number, pulse = 76, breathing = 15) {
  const ts = T0_MICROS + i * 1e6;
  return {
    cardio: {
      pulseRate: [
        { value: pulse, confidence: Math.min(95, 30 + i * 2.5), stable: i > 4, timestamp: ts },
      ],
    },
    breathing: {
      rate: [{ value: breathing, confidence: i < 30 ? 0 : 80, stable: i >= 30, timestamp: ts }],
    },
  };
}

interface Rig {
  source: PresageVitalsSource;
  samples: VitalsSample[];
  statuses: SourceStatus[];
  clock: { nowMs: number };
  logLines: string[];
  sdk: () => FakeSdk;
}

function rig(
  opts: {
    mods?: PresageSdk;
    env?: Record<string, string | undefined>;
    platform?: string;
    apiKey?: string;
    cameraId?: string;
    loadSdk?: PresageSdkLoader;
  } = {},
): Rig {
  FakeSdk.instances = [];
  const clock = { nowMs: NOW_MS };
  const logLines: string[] = [];
  const source = new PresageVitalsSource({
    env: opts.env ?? { PRESAGE_API_KEY: 'test-key' },
    platform: opts.platform ?? 'linux',
    loadSdk: opts.loadSdk ?? loaderFor(opts.mods ?? fakeModules()),
    now: () => new Date(clock.nowMs),
    emitIntervalMs: 3_600_000, // the interval timer is irrelevant: tests call tick()
    staleAfterS: 5,
    log: {
      debug: (m) => logLines.push(`DEBUG ${m}`),
      info: (m) => logLines.push(`INFO ${m}`),
      warn: (m) => logLines.push(`WARN ${m}`),
      error: (m) => logLines.push(`ERROR ${m}`),
    },
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.cameraId !== undefined ? { cameraId: opts.cameraId } : {}),
  });
  const samples: VitalsSample[] = [];
  const statuses: SourceStatus[] = [];
  source.onSample((s) => samples.push(s));
  source.onStatus((s) => statuses.push(s));
  return {
    source,
    samples,
    statuses,
    clock,
    logLines,
    sdk: () => {
      const inst = FakeSdk.instances.at(-1);
      if (!inst) throw new Error('no FakeSdk constructed yet');
      return inst;
    },
  };
}

// ---- tests ------------------------------------------------------------------------------------

describe('PresageVitalsSource: identity', () => {
  it('is a real, preflightable, measured source (no stub marker)', () => {
    const src = new PresageVitalsSource({ env: {} });
    expect(src.name).toBe('presage');
    expect(src.isMeasured).toBe(true);
    expect(isStubbed(src)).toBe(false);
    expect(hasPreflight(src)).toBe(true);
    expect(src.currentState).toBe('idle');
    expect(src.running).toBe(false);
    expect(() => src.onSample(() => undefined)).not.toThrow();
    expect(() => src.onStatus(() => undefined)).not.toThrow();
  });
});

describe('PresageVitalsSource: SDK absent (the CI situation; the real loader is used)', () => {
  it('start() reports the install command through onStatus and rejects with the mock hint', async () => {
    const r = rig({ loadSdk: loadPresageSdk });
    await expect(r.source.start({})).rejects.toBeInstanceOf(SourceUnavailableError);
    await r.source.start({}).catch((err: unknown) => {
      expect((err as SourceUnavailableError).reason).toBe('sdk_missing');
      expect((err as Error).message).toContain('--source mock');
      expect((err as Error).message).toContain(PRESAGE_INSTALL_COMMAND);
    });
    const last = r.statuses.at(-1);
    expect(last?.state).toBe('error');
    expect(last?.message).toContain('npm run install:presage');
    expect(last?.message).toBe(PRESAGE_SDK_MISSING_MESSAGE);
    expect(r.source.running).toBe(false);
  });

  it('preflight() rejects the same way, and listCameras() too', async () => {
    const r = rig({ loadSdk: loadPresageSdk });
    await expect(r.source.preflight()).rejects.toThrow(PRESAGE_INSTALL_COMMAND);
    await expect(r.source.preflight({ forListCameras: true })).rejects.toThrow(
      PRESAGE_INSTALL_COMMAND,
    );
    await expect(r.source.listCameras()).rejects.toThrow(PRESAGE_INSTALL_COMMAND);
  });

  it('the real loader itself rejects with sdk_missing', async () => {
    await expect(loadPresageSdk()).rejects.toMatchObject({
      name: 'SourceUnavailableError',
      reason: 'sdk_missing',
    });
  });
});

describe('PresageVitalsSource: configuration', () => {
  it('fails fast without PRESAGE_API_KEY, before loading the SDK', async () => {
    let loads = 0;
    const r = rig({
      env: {},
      loadSdk: () => {
        loads += 1;
        return Promise.resolve(fakeModules());
      },
    });
    await expect(r.source.start({})).rejects.toThrow(PRESAGE_API_KEY_MISSING_MESSAGE);
    await expect(r.source.preflight()).rejects.toMatchObject({ reason: 'api_key_missing' });
    expect(loads).toBe(1); // preflight loaded the SDK before checking the key; start() did not
    expect(r.statuses.at(-1)).toEqual({ state: 'error', message: PRESAGE_API_KEY_MISSING_MESSAGE });
    expect(r.statuses.at(-1)?.message).toContain('--source mock');
  });

  it('preflight for --list-cameras does not need the key; a blank key counts as missing', async () => {
    const r = rig({ env: { PRESAGE_API_KEY: '   ' } });
    await expect(r.source.preflight({ forListCameras: true })).resolves.toBeUndefined();
    await expect(r.source.preflight()).rejects.toMatchObject({ reason: 'api_key_missing' });
  });

  it('the constructor key beats the environment and is passed to the SDK, never logged', async () => {
    const r = rig({ env: { PRESAGE_API_KEY: 'env-key' }, apiKey: 'ctor-key' });
    await r.source.start({});
    expect(r.sdk().opts.apiKey).toBe('ctor-key');
    expect(r.sdk().opts.requestedMetrics).toEqual(['BREATHING_RATE', 'PULSE_RATE', 'HRV']);
    expect(r.logLines.join('\n')).not.toContain('ctor-key');
    expect(r.statuses.map((s) => s.message ?? '').join('\n')).not.toContain('ctor-key');
    await r.source.stop();
  });

  it('constructs the SDK with telemetry OFF (CLAUDE.md §13) and the log level pinned to kWarning', async () => {
    const r = rig();
    await r.source.start({});
    expect(r.sdk().opts.enableTelemetry).toBe(false);
    expect(r.sdk().opts.logLevel).toBe(SDK_LOG_LEVELS.kWarning);
    expect(r.sdk().opts).toEqual({
      apiKey: 'test-key',
      requestedMetrics: ['BREATHING_RATE', 'PULSE_RATE', 'HRV'],
      enableTelemetry: false,
      logLevel: 2,
    });
    await r.source.stop();
  });

  it('omits logLevel (SDK default) when the build does not export SmartSpectraLogLevel; telemetry stays off', async () => {
    const mods = fakeModules({ noLogLevel: true });
    expect(sdkLogLevelOption(mods)).toEqual({});
    expect(sdkLogLevelOption(fakeModules())).toEqual({ logLevel: 2 });
    const r = rig({ mods });
    await r.source.start({});
    expect(r.sdk().opts.enableTelemetry).toBe(false);
    expect('logLevel' in r.sdk().opts).toBe(false);
    await r.source.stop();
  });

  it('a loader that throws something else is reported as sdk_load_failed with the install hint', async () => {
    const r = rig({
      loadSdk: () => Promise.reject(new Error('libSmartSpectra.so: wrong ELF class')),
    });
    await r.source.start({}).catch((err: unknown) => {
      expect(err).toBeInstanceOf(SourceUnavailableError);
      expect((err as SourceUnavailableError).reason).toBe('sdk_load_failed');
      expect((err as Error).message).toContain('wrong ELF class');
      expect((err as Error).message).toContain(PRESAGE_INSTALL_COMMAND);
    });
    expect(r.statuses.at(-1)?.state).toBe('error');
  });
});

describe('PresageVitalsSource: cameras', () => {
  it('listCameras() normalises whatever availableCameras() returns', async () => {
    const r = rig({
      mods: fakeModules({
        cameras: ['usb-0', { id: 7, name: 'Logitech C920' }, { deviceId: 'd1' }, 42, null],
      }),
    });
    await expect(r.source.listCameras()).resolves.toEqual([
      { id: 'usb-0', label: 'usb-0' },
      { id: '7', label: 'Logitech C920' },
      { id: 'd1', label: 'camera d1' },
      { id: '42', label: 'camera 42' },
    ]);
    expect(normalizeCameras('nope')).toEqual([]);
    expect(normalizeCameras([{}])).toEqual([{ id: '0', label: 'camera 0' }]);
  });

  it('listCameras() without availableCameras() in the SDK build fails with a clear message', async () => {
    const r = rig({ mods: fakeModules({ noAvailableCameras: true }) });
    await expect(r.source.listCameras()).rejects.toMatchObject({ reason: 'no_camera' });
  });

  it('availableCameras() throwing (discovery unsupported) is a SourceUnavailableError, not a stack trace', async () => {
    // --list-cameras path: the CLI maps SourceUnavailableError to exit 2.
    const r = rig({ mods: fakeModules({ camerasThrow: true }) });
    const err = await r.source.listCameras().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as SourceUnavailableError).reason).toBe('no_camera');
    expect((err as Error).message).toContain('camera discovery is not supported on this platform');
    expect((err as Error).message).toContain('PRESAGE_CAMERA_ID');
    expect((err as Error).message).toContain('--source mock');
    // Windows auto-selection path: start() rejects the same way and constructs no SDK.
    const w = rig({ platform: 'win32', mods: fakeModules({ camerasThrow: true }) });
    await expect(w.source.start({})).rejects.toMatchObject({
      name: 'SourceUnavailableError',
      reason: 'no_camera',
    });
    expect(w.source.running).toBe(false);
    expect(FakeSdk.instances).toHaveLength(0);
    // An explicit id never touches discovery, so it still works where discovery throws.
    const pinned = rig({
      platform: 'win32',
      mods: fakeModules({ camerasThrow: true }),
      env: { PRESAGE_API_KEY: 'k', PRESAGE_CAMERA_ID: 'pinned' },
    });
    await pinned.source.start({});
    expect(pinned.sdk().camera).toEqual({ byId: 'pinned' });
    await pinned.source.stop();
  });

  it('non-Windows without an id uses CameraSelection.default', async () => {
    const r = rig({ platform: 'darwin' });
    await r.source.start({});
    expect(r.sdk().camera).toBe('DEFAULT');
    expect(r.statuses.at(-1)).toEqual({
      state: 'warming',
      message: 'opening default camera; waiting for the first SmartSpectra metrics',
    });
    await r.source.stop();
  });

  it('Windows without an id selects the first discovered camera by id (vendor note)', async () => {
    const r = rig({ platform: 'win32' });
    await r.source.start({});
    expect(r.sdk().camera).toEqual({ byId: 'cam-1' });
    expect(r.logLines.some((l) => l.includes('first discovered camera cam-1'))).toBe(true);
    await r.source.stop();
  });

  it('Windows with no camera at all fails fast', async () => {
    const r = rig({ platform: 'win32', mods: fakeModules({ cameras: [] }) });
    await expect(r.source.start({})).rejects.toMatchObject({ reason: 'no_camera' });
    expect(r.source.running).toBe(false);
  });

  it('an explicit id (start opts > constructor > env) always wins', async () => {
    const a = rig({
      platform: 'win32',
      cameraId: 'ctor-cam',
      env: { PRESAGE_API_KEY: 'k', PRESAGE_CAMERA_ID: 'env-cam' },
    });
    await a.source.start({ cameraId: 'opts-cam' });
    expect(a.sdk().camera).toEqual({ byId: 'opts-cam' });
    await a.source.stop();
    const b = rig({
      platform: 'win32',
      cameraId: 'ctor-cam',
      env: { PRESAGE_API_KEY: 'k', PRESAGE_CAMERA_ID: 'env-cam' },
    });
    await b.source.start({});
    expect(b.sdk().camera).toEqual({ byId: 'ctor-cam' });
    await b.source.stop();
    const c = rig({
      platform: 'linux',
      env: { PRESAGE_API_KEY: 'k', PRESAGE_CAMERA_ID: 'env-cam' },
    });
    await c.source.start({});
    expect(c.sdk().camera).toEqual({ byId: 'env-cam' });
    await c.source.stop();
  });
});

describe('PresageVitalsSource: metrics → samples', () => {
  it('warming on start, collecting + one mapped sample on the first valued packet', async () => {
    const r = rig();
    await r.source.start({});
    expect(r.source.running).toBe(true);
    expect(r.sdk().started).toBe(1);
    expect(r.statuses.at(-1)?.state).toBe('warming');

    r.sdk().emitMetrics(simulatedPacket(0));
    expect(r.samples).toHaveLength(0); // nothing until the 1 Hz tick
    r.source.tick();
    expect(r.statuses.at(-1)).toEqual({ state: 'collecting', message: 'face found; collecting' });
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toEqual({
      tsUtc: '2026-10-10T12:00:00.000Z',
      source: 'presage',
      isMeasured: true,
      pulseBpm: 76,
      pulseConf: 0.3,
      breathingBpm: 15,
      breathingConf: 0,
      windowS: 30,
      qualityFlags: ['unstable_pulse', 'unstable_breathing'],
    });
    await r.source.stop();
  });

  it('a tick with nothing new emits nothing; packets faster than 1 Hz coalesce to the newest per metric', async () => {
    const r = rig();
    await r.source.start({});
    r.source.tick();
    expect(r.samples).toHaveLength(0);

    r.sdk().emitMetrics({
      cardio: { pulseRate: [{ value: 70, confidence: 90, stable: true, timestamp: T0_MICROS }] },
    });
    r.sdk().emitMetrics({
      breathing: {
        rate: [{ value: 14, confidence: 80, stable: true, timestamp: T0_MICROS + 200_000 }],
      },
    });
    r.sdk().emitMetrics({
      cardio: {
        pulseRate: [{ value: 71, confidence: 91, stable: true, timestamp: T0_MICROS + 400_000 }],
      },
    });
    r.source.tick();
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0]).toMatchObject({
      pulseBpm: 71,
      pulseConf: 0.91,
      breathingBpm: 14,
      windowS: 30,
    });
    expect(r.samples[0]?.tsUtc).toBe('2026-10-10T12:00:00.400Z');
    r.source.tick();
    expect(r.samples).toHaveLength(1); // nothing new → nothing emitted (no stale value re-sent)
    await r.source.stop();
  });

  it('packets without any value produce no sample but keep the stream alive for their hint', async () => {
    const r = rig();
    await r.source.start({});
    r.sdk().emit('validationStatus', 3, T0_MICROS, 'face not centered');
    r.sdk().emitMetrics({ cardio: { pulseRate: [] }, breathing: {} });
    r.source.tick();
    expect(r.samples).toHaveLength(0);
    expect(r.statuses.at(-1)).toEqual({ state: 'warming', message: 'camera: face not centered' });
    await r.source.stop();
  });

  it('validation CODES become quality flags on the next sample; the hint feeds the status message', async () => {
    const r = rig();
    await r.source.start({});
    r.sdk().emitMetrics(simulatedPacket(40));
    r.source.tick();
    expect(r.samples[0]?.qualityFlags).toEqual([]);

    // kTooDark = 5. Whatever the (unpublished) hint wording is, the flag is the table token.
    r.sdk().emit('validationStatus', 5, T0_MICROS, 'Lighting is too dim');
    expect(r.statuses.at(-1)).toEqual({
      state: 'collecting',
      message: 'camera: Lighting is too dim',
    });
    r.sdk().emit('validationStatus', 5, T0_MICROS, 'Lighting is too dim'); // unchanged: no repeat status
    expect(r.statuses.filter((s) => s.message === 'camera: Lighting is too dim')).toHaveLength(1);
    r.sdk().emitMetrics(simulatedPacket(41));
    r.source.tick();
    expect(r.samples[1]?.qualityFlags).toEqual(['low_light']);

    // kNoFaceFound = 1 with an empty hint: the token is spelled out for the operator.
    r.sdk().emit('validationStatus', 1, T0_MICROS, '');
    expect(r.statuses.at(-1)).toEqual({ state: 'collecting', message: 'camera: face not found' });
    r.sdk().emitMetrics(simulatedPacket(42));
    r.source.tick();
    expect(r.samples[2]?.qualityFlags).toEqual(['face_not_found']);

    // A code this SDK version does not publish: nothing the SDK said is lost.
    r.sdk().emit('validationStatus', 99, T0_MICROS, 'Lens smudged');
    r.sdk().emitMetrics(simulatedPacket(43));
    r.source.tick();
    expect(r.samples[3]?.qualityFlags).toEqual(['sdk_validation_99', 'lens_smudged']);

    r.sdk().emit('validationStatus', 0, T0_MICROS, '');
    expect(r.statuses.at(-1)).toEqual({ state: 'collecting', message: 'signal ok' });
    r.sdk().emitMetrics(simulatedPacket(44));
    r.source.tick();
    expect(r.samples[4]?.qualityFlags).toEqual([]);
    expect(r.logLines).toContain('INFO presage: camera: Lighting is too dim');
    expect(r.logLines).toContain('INFO presage: camera: face not found');
    await r.source.stop();
  });

  it('an undecodable packet is counted and logged, never thrown', async () => {
    const r = rig();
    await r.source.start({});
    r.sdk().emit('metrics', new TextEncoder().encode('not json'), T0_MICROS);
    r.source.tick();
    expect(r.samples).toHaveLength(0);
    expect(r.logLines.some((l) => l.startsWith('WARN presage: could not decode'))).toBe(true);
    await r.source.stop();
  });

  it('implausible SDK timestamps fall back to the bridge clock with one warning', async () => {
    const r = rig();
    await r.source.start({});
    r.clock.nowMs = NOW_MS + 5_000;
    r.sdk().emitMetrics({
      cardio: { pulseRate: [{ value: 70, confidence: 90, stable: true, timestamp: 123 }] },
    });
    r.source.tick();
    r.sdk().emitMetrics({
      cardio: { pulseRate: [{ value: 70, confidence: 90, stable: true, timestamp: 456 }] },
    });
    r.source.tick();
    expect(r.samples.map((s) => s.tsUtc)).toEqual([
      '2026-10-10T12:00:05.000Z',
      '2026-10-10T12:00:05.000Z',
    ]);
    expect(r.logLines.filter((l) => l.includes('not plausible epoch microseconds'))).toHaveLength(
      1,
    );
    await r.source.stop();
  });

  it('a stale stream (no valued packet for > 5 s) drops back to warming so the gates reset', async () => {
    const r = rig();
    await r.source.start({});
    r.sdk().emitMetrics(simulatedPacket(10));
    r.source.tick();
    expect(r.source.currentState).toBe('collecting');
    r.clock.nowMs += 4_000;
    r.source.tick();
    expect(r.source.currentState).toBe('collecting');
    r.clock.nowMs += 2_000;
    r.source.tick();
    expect(r.statuses.at(-1)).toEqual({
      state: 'warming',
      message:
        'no metrics from SmartSpectra for 5 s (face lost or poor signal); timing gates reset',
    });
    r.sdk().emitMetrics(simulatedPacket(20));
    r.source.tick();
    expect(r.statuses.at(-1)?.state).toBe('collecting');
    await r.source.stop();
  });
});

describe('PresageVitalsSource: SDK errors', () => {
  it('a retryable error reports error and the next packet recovers to collecting', async () => {
    const r = rig();
    await r.source.start({});
    r.sdk().emitMetrics(simulatedPacket(10));
    r.source.tick();
    r.sdk().emit('error', 12, 'frame dropped', true);
    expect(r.statuses.at(-1)).toEqual({
      state: 'error',
      message: 'SmartSpectra error 12: frame dropped (retryable; waiting for the SDK to recover)',
    });
    expect(r.sdk().stopAsyncCalls).toBe(0); // the SDK keeps running
    r.sdk().emitMetrics(simulatedPacket(11));
    r.source.tick();
    expect(r.statuses.at(-1)).toEqual({
      state: 'collecting',
      message: 'SmartSpectra recovered; collecting',
    });
    expect(r.samples).toHaveLength(2);
    await r.source.stop();
  });

  it('a fatal error tears the SDK down, stays in error, ignores late packets, and stop() → idle', async () => {
    const r = rig();
    await r.source.start({});
    const sdk = r.sdk();
    sdk.emit('error', 2, 'invalid API key', false); // kAuthenticationFailed
    expect(r.statuses.at(-1)?.state).toBe('error');
    expect(r.statuses.at(-1)?.message).toBe(
      'SmartSpectra error 2 (authentication failed): invalid API key (fatal; capture stopped for ' +
        'this session. Fix: check PRESAGE_API_KEY, then start a new session)',
    );
    expect(r.statuses.at(-1)?.message).not.toContain('restart the bridge');
    await Promise.resolve(); // let the teardown promise run
    expect(sdk.stopAsyncCalls).toBe(1);
    expect(sdk.destroyCalls).toBe(1);
    sdk.emitMetrics(simulatedPacket(10));
    r.source.tick();
    expect(r.samples).toHaveLength(0);
    expect(r.source.running).toBe(false);
    await r.source.stop();
    expect(r.statuses.at(-1)).toEqual({ state: 'idle' });
    expect(sdk.destroyCalls).toBe(1); // not torn down twice
  });

  it('after a fatal error, the next start() waits for the old destroy() and runs a fresh instance', async () => {
    const r = rig();
    await r.source.start({});
    const first = r.sdk();
    let releaseDestroy: () => void = () => undefined;
    first.destroy = () => {
      first.destroyCalls += 1;
      return new Promise<void>((resolve) => {
        releaseDestroy = resolve;
      });
    };
    first.emit('error', 4, 'no credits left', false); // kCreditExhausted
    expect(r.statuses.at(-1)?.message).toContain('credits exhausted');
    expect(r.statuses.at(-1)?.message).toContain('top up the account');

    // A new kiosk session starts while the fatal teardown is still destroying the old SDK.
    let started = false;
    const starting = r.source.start({}).then(() => {
      started = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(false); // blocked on the in-flight destroy()
    expect(FakeSdk.instances).toHaveLength(1); // no second SDK against process-global state yet
    releaseDestroy();
    await starting;
    expect(FakeSdk.instances).toHaveLength(2);
    expect(r.source.running).toBe(true);
    expect(r.source.currentState).toBe('warming');
    r.sdk().emitMetrics(simulatedPacket(10));
    r.source.tick();
    expect(r.samples).toHaveLength(1); // the replacement works: fatal flag cleared
    await r.source.stop();
  });

  it('sdk.start() throwing rejects start(), destroys the instance and reports error', async () => {
    const r = rig();
    FakeSdk.failNextStart = true;
    try {
      await expect(r.source.start({})).rejects.toThrow(
        /could not start on default camera.*camera is in use.*--source mock/s,
      );
    } finally {
      FakeSdk.failNextStart = false;
    }
    expect(r.sdk().started).toBe(0);
    expect(r.sdk().stopAsyncCalls).toBe(1);
    expect(r.sdk().destroyCalls).toBe(1);
    expect(r.statuses.at(-1)?.state).toBe('error');
    expect(r.statuses.at(-1)?.message).toContain('camera is in use');
    expect(r.source.running).toBe(false);
    // Late events from the abandoned instance are ignored.
    r.sdk().emitMetrics(simulatedPacket(10));
    r.source.tick();
    expect(r.samples).toHaveLength(0);
  });
});

describe('PresageVitalsSource: stop()', () => {
  it('stops and destroys the SDK once, reports idle, is idempotent, and ignores late events', async () => {
    const r = rig();
    await r.source.start({});
    const sdk = r.sdk();
    r.sdk().emitMetrics(simulatedPacket(10));
    await Promise.all([r.source.stop(), r.source.stop()]);
    await r.source.stop();
    expect(sdk.stopAsyncCalls).toBe(1);
    expect(sdk.destroyCalls).toBe(1);
    expect(r.statuses.at(-1)).toEqual({ state: 'idle' });
    expect(r.statuses.filter((s) => s.state === 'idle')).toHaveLength(1);
    sdk.emitMetrics(simulatedPacket(11));
    sdk.emit('error', 1, 'late', true);
    r.source.tick();
    expect(r.samples).toHaveLength(0);
    expect(r.statuses.at(-1)).toEqual({ state: 'idle' });
  });

  it('stop() on an idle source is a no-op; start() twice restarts cleanly', async () => {
    const r = rig();
    await r.source.stop();
    expect(r.statuses).toHaveLength(0);
    await r.source.start({});
    const first = r.sdk();
    await r.source.start({});
    expect(first.destroyCalls).toBe(1);
    expect(FakeSdk.instances).toHaveLength(2);
    await r.source.stop();
  });

  it('start() during an in-flight stop() waits for the teardown; the late idle never overwrites warming', async () => {
    const r = rig();
    await r.source.start({});
    const first = r.sdk();
    let releaseStop: () => void = () => undefined;
    first.stopAsync = () => {
      first.stopAsyncCalls += 1;
      return new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    };
    const stopping = r.source.stop(); // not awaited: models a WS "stop" immediately followed by "start"
    let started = false;
    const starting = r.source.start({}).then(() => {
      started = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(false);
    expect(FakeSdk.instances).toHaveLength(1); // the replacement is not constructed yet
    expect(r.source.currentState).toBe('warming'); // still the first session's state (stop pending)

    releaseStop();
    await stopping;
    await starting;
    expect(first.destroyCalls).toBe(1);
    expect(FakeSdk.instances).toHaveLength(2);
    expect(r.source.running).toBe(true);
    expect(r.source.currentState).toBe('warming');
    // Status order: warming (1st start) → idle (stop) → warming (2nd start); never idle last.
    expect(r.statuses.map((s) => s.state)).toEqual(['warming', 'idle', 'warming']);
    // The new instance is live.
    r.sdk().emitMetrics(simulatedPacket(10));
    r.source.tick();
    expect(r.samples).toHaveLength(1);
    expect(r.source.currentState).toBe('collecting');
    await r.source.stop();
    expect(r.statuses.at(-1)).toEqual({ state: 'idle' });
  });

  it('stop() tolerates an SDK whose stopAsync/destroy reject, logging a warning', async () => {
    const r = rig();
    await r.source.start({});
    r.sdk().stopAsync = () => Promise.reject(new Error('already stopped'));
    r.sdk().destroy = () => Promise.reject(new Error('native crash'));
    await expect(r.source.stop()).resolves.toBeUndefined();
    expect(r.logLines).toContain('WARN presage: sdk.stopAsync() failed: already stopped');
    expect(r.logLines).toContain('WARN presage: sdk.destroy() failed: native crash');
    expect(r.statuses.at(-1)).toEqual({ state: 'idle' });
  });
});

// ---- gate interaction through the real BridgeSession ----------------------------------------

class FakeSink implements BroadcastSink {
  readonly messages: BridgeToWeb[] = [];
  broadcast(msg: BridgeToWeb): void {
    this.messages.push(msg);
  }
  ofType<T extends BridgeToWeb['type']>(type: T): Array<Extract<BridgeToWeb, { type: T }>> {
    return this.messages.filter((m): m is Extract<BridgeToWeb, { type: T }> => m.type === type);
  }
}

describe('PresageVitalsSource through BridgeSession: timing gates apply unchanged', () => {
  it('pulse is published after 12 s of continuous collecting, breathing after 30 s, badge MEASURED', async () => {
    const r = rig();
    const posts: unknown[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith('/settings/public')) {
        return Promise.resolve(
          new Response(JSON.stringify({ vitals_source: 'presage' }), { status: 200 }),
        );
      }
      posts.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'));
      return Promise.resolve(new Response('{"accepted":1}', { status: 200 }));
    };
    const api = new ApiClient({
      apiBase: 'http://api.test',
      fetchImpl,
      log: silentLogger,
      flushIntervalMs: 60_000,
    });
    const session = new BridgeSession({
      source: r.source,
      api,
      log: silentLogger,
      now: () => r.clock.nowMs,
      version: '0.1.0',
    });
    const sink = new FakeSink();
    session.attachSink(sink);

    await session.start('S-presage');
    expect(session.hello()).toMatchObject({ source: 'presage', isMeasured: true, scenario: null });
    expect(r.sdk().started).toBe(1);

    // t = 0: first valued packet → collecting; the sample itself is gated (pulse pending).
    r.sdk().emitMetrics(simulatedPacket(0));
    r.source.tick();
    const first = sink.ofType('sample')[0];
    expect(first?.published).toEqual({ pulse: false, breathing: false, hrv: false });
    expect(first?.sample.pulseBpm).toBeUndefined();
    expect(first?.sample.qualityFlags).toEqual([
      'unstable_pulse',
      'unstable_breathing',
      'gate_pending_pulse',
      'gate_pending_breathing',
      'gate_pending_hrv',
    ]);

    // t = 12 s: pulse gate open; confidence 0.6 meets the default threshold exactly.
    r.clock.nowMs = NOW_MS + 12_000;
    r.sdk().emitMetrics(simulatedPacket(12));
    r.source.tick();
    const at12 = sink.ofType('sample')[1];
    expect(at12?.elapsedS).toBe(12);
    expect(at12?.published).toEqual({ pulse: true, breathing: false, hrv: false });
    expect(at12?.sample).toMatchObject({
      source: 'presage',
      isMeasured: true,
      pulseBpm: 76,
      pulseConf: 0.6,
    });
    expect(at12?.sample.breathingBpm).toBeUndefined();

    // t = 30 s: breathing gate open.
    r.clock.nowMs = NOW_MS + 30_000;
    r.sdk().emitMetrics(simulatedPacket(30));
    r.source.tick();
    const at30 = sink.ofType('sample')[2];
    expect(at30?.published).toEqual({ pulse: true, breathing: true, hrv: false });
    expect(at30?.sample).toMatchObject({ breathingBpm: 15, breathingConf: 0.8, windowS: 30 });
    expect(session.snapshot()).toMatchObject({
      source: 'presage',
      scenario: null,
      state: 'collecting',
      pulse: 76,
      breathing: 15,
    });

    // A retryable SDK error resets the gate clock, exactly as for the mock's dropout scenario.
    r.sdk().emit('error', 7, 'frame dropped', true);
    r.clock.nowMs = NOW_MS + 31_000;
    r.sdk().emitMetrics(simulatedPacket(31));
    r.source.tick();
    const afterError = sink.ofType('sample')[3];
    expect(afterError?.published.pulse).toBe(false);
    expect(afterError?.sample.qualityFlags).toContain('gate_pending_pulse');

    await session.stop();
    expect(r.sdk().destroyCalls).toBe(1);
    expect(posts).toHaveLength(1);
    const body = posts[0] as { samples: VitalsSample[] };
    expect(body.samples).toHaveLength(4);
    expect(body.samples.every((s) => s.source === 'presage' && s.isMeasured)).toBe(true);
    expect(sink.ofType('status').at(-1)).toEqual({
      type: 'status',
      state: 'idle',
      elapsedS: 0,
      sessionId: null,
    });
  });
});

// ---- the SDK must never become a declared dependency ----------------------------------------

describe('package.json: the Presage SDK is installed on demand, never declared', () => {
  const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  it('has no @smartspectra entry in any dependency block', () => {
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = pkg[block];
      const names = deps && typeof deps === 'object' ? Object.keys(deps) : [];
      expect(
        names.filter((n) => n.startsWith('@smartspectra')),
        block,
      ).toEqual([]);
    }
    expect(pkg.optionalDependencies ?? {}).toEqual({});
  });

  it('exposes the exact install:presage script the error messages point at', () => {
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts['install:presage']).toBe('npm install --no-save @smartspectra/node-sdk@3.4.0');
    expect(PRESAGE_INSTALL_COMMAND).toBe('npm run install:presage');
  });

  it('the lockfile does not pin the SDK either', () => {
    const lock = readFileSync(path.join(appDir, 'package-lock.json'), 'utf8');
    expect(lock).not.toContain('@smartspectra');
  });
});
