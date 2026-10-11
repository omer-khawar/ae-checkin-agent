import { describe, expect, it } from 'vitest';
import {
  confidenceToUnit,
  describeValidation,
  extractLatest,
  hasValues,
  hrvRmssd,
  mapLatestToSample,
  mapPacket,
  mergeLatest,
  newestTimestamp,
  PRESAGE_WINDOW_S,
  SDK_ERROR_NAMES,
  sdkErrorToStatus,
  snakeCaseHint,
  timestampMicrosToIso,
  VALIDATION_CODE_FLAGS,
  validationCodeFlag,
  validationFlags,
} from '../src/sources/presageMap.js';

/**
 * `ValidationCode` and `SmartSpectraErrorCode` exactly as `@smartspectra/node-sdk@3.4.0`
 * `js/index.d.ts` declares them ("Integer values are stable across SDK versions"). If a future SDK
 * adds a code, add it here and to the tables in presageMap.ts in the same commit.
 */
const SDK_VALIDATION_CODES = {
  kOk: 0,
  kNoFaceFound: 1,
  kMultipleFacesFound: 2,
  kFaceNotCentered: 3,
  kFaceSizeOutOfRange: 4,
  kTooDark: 5,
  kTooBright: 6,
  kChestNotVisible: 7,
  kCameraTuning: 10,
  kFrameRateTooLow: 11,
  kExcessiveMotion: 12,
  kFaceTooClose: 13,
  kFaceTooFar: 14,
  kFaceTooHigh: 15,
  kFaceTooLow: 16,
  kFaceNotForward: 17,
} as const;

const SDK_ERROR_CODES = {
  kOk: 0,
  kInvalidState: 1,
  kAuthenticationFailed: 2,
  kConfigurationFailed: 3,
  kCreditExhausted: 4,
  kNetworkError: 5,
  kServerError: 6,
  kInputUnavailable: 7,
  kProcessingFailed: 8,
  kFrameConversionFailed: 9,
  kNonMonotonicTimestamp: 10,
  kTimestampGap: 11,
} as const;

/** Bridge clock for every test: 2026-10-10T12:00:00Z. */
const NOW_MS = Date.parse('2026-10-10T12:00:00.000Z');
/** Packet timestamps in microseconds since the epoch, as `{longs: Number}` renders them. */
const T0_MICROS = NOW_MS * 1000;

/**
 * The exact `toObject` shape from `presage-bridge/bridge.js` `simulatedMetrics()` (Omer Khawar,
 * SDK 3.4.0): one pulseRate entry and one breathing.rate entry per packet, confidence 0..100,
 * `stable` flips once the averages settle, timestamps in µs.
 */
function simulatedPacket(i: number, pulse = 76, breathing = 15) {
  const ts = T0_MICROS + i * 1e6;
  return {
    cardio: {
      pulseRate: [
        { value: pulse, confidence: Math.min(95, 30 + i * 2.5), stable: i > 4, timestamp: ts },
      ],
    },
    breathing: {
      rate: [
        {
          value: breathing,
          confidence: i < 30 ? 0 : Math.min(90, 40 + (i - 30) * 3),
          stable: i >= 30,
          timestamp: ts,
        },
      ],
    },
  };
}

describe("presageMap: packets from the teammate's simulatedMetrics shape", () => {
  it('maps pulse and breathing: value as-is, confidence ÷ 100, source presage, measured', () => {
    const { sample, tsFromSdk } = mapPacket(simulatedPacket(40, 76, 15), {
      nowMs: NOW_MS + 40_000,
    });
    expect(sample).toEqual({
      tsUtc: '2026-10-10T12:00:40.000Z',
      source: 'presage',
      isMeasured: true,
      pulseBpm: 76,
      pulseConf: 0.95, // min(95, 30 + 40·2.5) = 95 → 0.95
      breathingBpm: 15,
      breathingConf: 0.7, // min(90, 40 + 10·3) = 70 → 0.70
      windowS: PRESAGE_WINDOW_S.breathing,
      qualityFlags: [],
    });
    expect(tsFromSdk).toBe(true);
  });

  it('flags unstable_pulse / unstable_breathing while the SDK says stable: false', () => {
    const early = mapPacket(simulatedPacket(2), { nowMs: NOW_MS }).sample; // i ≤ 4: pulse unstable; i < 30: breathing unstable
    expect(early.qualityFlags).toEqual(['unstable_pulse', 'unstable_breathing']);
    expect(early.pulseConf).toBe(0.35);
    expect(early.breathingConf).toBe(0); // confidence 0 is kept as 0, not dropped
    const settled = mapPacket(simulatedPacket(31), { nowMs: NOW_MS }).sample;
    expect(settled.qualityFlags).toEqual([]);
  });

  it('a packet replayed from the real pipeline (JSON round trip) maps identically', () => {
    const packet: unknown = JSON.parse(JSON.stringify(simulatedPacket(10)));
    expect(mapPacket(packet, { nowMs: NOW_MS }).sample).toEqual(
      mapPacket(simulatedPacket(10), { nowMs: NOW_MS }).sample,
    );
  });
});

describe('presageMap: extraction', () => {
  it('uses the LAST entry of each array (the newest average in the packet)', () => {
    const packet = {
      cardio: {
        pulseRate: [
          { value: 70, confidence: 50, stable: true, timestamp: T0_MICROS },
          { value: 74, confidence: 80, stable: true, timestamp: T0_MICROS + 500_000 },
        ],
      },
      breathing: { rate: [{ value: 13, confidence: 60, stable: true, timestamp: T0_MICROS }] },
    };
    const latest = extractLatest(packet);
    expect(latest.pulse?.value).toBe(74);
    expect(latest.breathing?.value).toBe(13);
    expect(latest.hrv).toBeUndefined();
  });

  it('tolerates junk: non-objects, missing groups, empty arrays, non-object entries', () => {
    expect(extractLatest(null)).toEqual({});
    expect(extractLatest('metrics')).toEqual({});
    expect(extractLatest({})).toEqual({});
    expect(extractLatest({ cardio: {}, breathing: { rate: [] } })).toEqual({});
    expect(extractLatest({ cardio: { pulseRate: [null, 5, 'x'] } })).toEqual({});
    expect(extractLatest({ cardio: { pulseRate: [{ value: 70 }, null] } }).pulse?.value).toBe(70);
  });

  it('hasValues needs at least one finite metric value', () => {
    expect(hasValues({})).toBe(false);
    expect(hasValues({ pulse: { confidence: 90, stable: true } })).toBe(false);
    expect(hasValues({ pulse: { value: Number.NaN } })).toBe(false);
    expect(hasValues({ pulse: { value: 72 } })).toBe(true);
    expect(hasValues({ hrv: { rmssd: 40 } })).toBe(true);
    expect(hasValues({ hrv: { sdnn: 50, meanNn: 800 } })).toBe(false); // only rmssd counts as a value
  });

  it('mergeLatest keeps the newer entry per metric and fills gaps from either side', () => {
    const a = {
      pulse: { value: 70, timestamp: T0_MICROS + 2_000_000 },
      breathing: { value: 14, timestamp: T0_MICROS },
    };
    const b = { pulse: { value: 71, timestamp: T0_MICROS + 1_000_000 }, hrv: { rmssd: 40 } };
    const merged = mergeLatest(a, b);
    expect(merged.pulse?.value).toBe(70); // a's pulse is newer than b's
    expect(merged.breathing?.value).toBe(14);
    expect(merged.hrv?.rmssd).toBe(40);
    // Without timestamps the later packet wins.
    expect(mergeLatest({ pulse: { value: 1 } }, { pulse: { value: 2 } }).pulse?.value).toBe(2);
    expect(mergeLatest({}, {})).toEqual({});
  });

  it('newestTimestamp picks the max finite timestamp across metrics', () => {
    expect(newestTimestamp({})).toBeUndefined();
    expect(
      newestTimestamp({
        pulse: { value: 1, timestamp: 5 },
        breathing: { value: 1, timestamp: 9 },
        hrv: { timestamp: 7 },
      }),
    ).toBe(9);
  });
});

describe('presageMap: HRV (IHrv.rmssd, verified in the SDK generated.d.ts)', () => {
  it('reads `rmssd` directly and omits HRV when it is absent or not a finite number', () => {
    // The full IHrv shape from generated.d.ts: rmssd, meanNn, sdnn, baevsky, timestamp, confidence, stable.
    expect(
      hrvRmssd({
        rmssd: 42.3,
        meanNn: 812,
        sdnn: 51,
        baevsky: 80,
        timestamp: T0_MICROS,
        confidence: 70,
        stable: true,
      }),
    ).toBe(42.3);
    expect(hrvRmssd({ sdnn: 50, meanNn: 800, confidence: 70 })).toBeUndefined();
    expect(hrvRmssd({ rmssd: Number.NaN })).toBeUndefined();
    expect(hrvRmssd({ rmssd: 'n/a' as unknown as number })).toBeUndefined();
    expect(hrvRmssd(undefined)).toBeUndefined();
    // No name probing any more: a differently spelled field is not RMSSD.
    expect(hrvRmssd({ rmssdMs: 41 } as unknown as { rmssd?: number })).toBeUndefined();
  });

  it('maps hrvRmssdMs + hrvConf and raises windowS to 60 s', () => {
    const { sample } = mapLatestToSample(
      {
        pulse: { value: 72, confidence: 90, stable: true, timestamp: T0_MICROS },
        hrv: { rmssd: 38.26, confidence: 65, stable: false, timestamp: T0_MICROS },
      },
      { nowMs: NOW_MS },
    );
    expect(sample.hrvRmssdMs).toBe(38.3);
    expect(sample.hrvConf).toBe(0.65);
    expect(sample.windowS).toBe(60);
    expect(sample.qualityFlags).toEqual(['unstable_hrv']);
  });

  it('an hrv entry without rmssd contributes nothing (no hrvConf, no window bump)', () => {
    const { sample } = mapLatestToSample(
      { pulse: { value: 72, confidence: 90 }, hrv: { sdnn: 50, confidence: 65 } },
      { nowMs: NOW_MS },
    );
    expect(sample.hrvRmssdMs).toBeUndefined();
    expect(sample.hrvConf).toBeUndefined();
    expect(sample.windowS).toBe(12);
  });
});

describe('presageMap: windowS is the longest window among the metrics present', () => {
  it('pulse only → 12, + breathing → 30, + hrv → 60, nothing → 0', () => {
    const at = (latest: Parameters<typeof mapLatestToSample>[0]) =>
      mapLatestToSample(latest, { nowMs: NOW_MS }).sample.windowS;
    expect(at({ pulse: { value: 70 } })).toBe(12);
    expect(at({ breathing: { value: 14 } })).toBe(30);
    expect(at({ pulse: { value: 70 }, breathing: { value: 14 } })).toBe(30);
    expect(at({ hrv: { rmssd: 40 } })).toBe(60);
    expect(at({})).toBe(0);
  });
});

describe('presageMap: timestamps', () => {
  it('converts plausible epoch microseconds to ISO with millisecond precision', () => {
    expect(timestampMicrosToIso(T0_MICROS + 1_234_567, NOW_MS + 60_000)).toEqual({
      tsUtc: '2026-10-10T12:00:01.235Z',
      fromSdk: true,
    });
  });

  it('falls back to the bridge clock for monotonic / millisecond / missing / future timestamps', () => {
    const fallback = { tsUtc: '2026-10-10T12:00:00.000Z', fromSdk: false };
    expect(timestampMicrosToIso(123_456, NOW_MS)).toEqual(fallback); // µs since SDK start
    expect(timestampMicrosToIso(NOW_MS, NOW_MS)).toEqual(fallback); // milliseconds, not µs
    expect(timestampMicrosToIso(undefined, NOW_MS)).toEqual(fallback);
    expect(timestampMicrosToIso(Number.NaN, NOW_MS)).toEqual(fallback);
    expect(timestampMicrosToIso(-5, NOW_MS)).toEqual(fallback);
    expect(timestampMicrosToIso((NOW_MS + 2 * 86_400_000) * 1000, NOW_MS)).toEqual(fallback); // 2 days ahead
  });

  it('the sample uses the newest metric timestamp', () => {
    const { sample } = mapLatestToSample(
      {
        pulse: { value: 72, timestamp: T0_MICROS },
        breathing: { value: 14, timestamp: T0_MICROS + 3_000_000 },
      },
      { nowMs: NOW_MS + 10_000 },
    );
    expect(sample.tsUtc).toBe('2026-10-10T12:00:03.000Z');
  });
});

describe('presageMap: validation CODES → qualityFlags (the hint wording is unpublished)', () => {
  it('snake_cases a hint (used only for unknown codes)', () => {
    expect(snakeCaseHint('Face not centered')).toBe('face_not_centered');
    expect(snakeCaseHint('  Too  dark!! ')).toBe('too_dark');
    expect(snakeCaseHint('***')).toBe('');
    expect(snakeCaseHint('x'.repeat(100)).length).toBe(48);
  });

  it('code 0 (or no status) yields no flags', () => {
    expect(validationFlags(null)).toEqual([]);
    expect(validationFlags(undefined)).toEqual([]);
    expect(validationFlags({ code: 0, hint: 'ok' })).toEqual([]);
    expect(validationCodeFlag(0)).toBeUndefined();
  });

  it('covers every non-zero ValidationCode the SDK declares, with a lower_snake_case token each', () => {
    const declared = Object.entries(SDK_VALIDATION_CODES)
      .filter(([, code]) => code !== 0)
      .map(([, code]) => code as number);
    expect(
      Object.keys(VALIDATION_CODE_FLAGS.codes)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(declared.sort((a, b) => a - b));
    for (const token of Object.values(VALIDATION_CODE_FLAGS.codes)) {
      expect(token).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(VALIDATION_CODE_FLAGS.source).toContain('ValidationCode');
    expect(VALIDATION_CODE_FLAGS.rationale.length).toBeGreaterThan(20);
  });

  it('maps the codes that mean a canonical web-app token (DEGRADED_FLAGS) to exactly that token, whatever the hint says', () => {
    const { kNoFaceFound, kTooDark, kExcessiveMotion } = SDK_VALIDATION_CODES;
    // Three plausible wordings for the same code: the flag never depends on them.
    for (const hint of ['No face detected', 'Position your face in the frame', '']) {
      expect(validationFlags({ code: kNoFaceFound, hint })).toEqual(['face_not_found']);
    }
    expect(validationFlags({ code: kTooDark, hint: 'Lighting is too dim' })).toEqual(['low_light']);
    expect(validationFlags({ code: kExcessiveMotion, hint: 'Please hold still' })).toEqual([
      'motion',
    ]);
  });

  it('maps every other code to its own descriptive token', () => {
    const c = SDK_VALIDATION_CODES;
    const expectFlag = (code: number, flag: string) =>
      expect(validationFlags({ code, hint: 'whatever the SDK says' })).toEqual([flag]);
    expectFlag(c.kMultipleFacesFound, 'multiple_faces');
    expectFlag(c.kFaceNotCentered, 'face_not_centered');
    expectFlag(c.kFaceSizeOutOfRange, 'face_size_out_of_range');
    expectFlag(c.kTooBright, 'too_bright');
    expectFlag(c.kChestNotVisible, 'chest_not_visible');
    expectFlag(c.kCameraTuning, 'camera_tuning');
    expectFlag(c.kFrameRateTooLow, 'frame_rate_too_low');
    expectFlag(c.kFaceTooClose, 'face_too_close');
    expectFlag(c.kFaceTooFar, 'face_too_far');
    expectFlag(c.kFaceTooHigh, 'face_too_high');
    expectFlag(c.kFaceTooLow, 'face_too_low');
    expectFlag(c.kFaceNotForward, 'face_not_forward');
  });

  it('never produces `talking`: TALKING is a faceMetrics metric the bridge does not request', () => {
    expect(Object.values(VALIDATION_CODE_FLAGS.codes)).not.toContain('talking');
    expect(validationFlags({ code: 99, hint: 'Talking detected' })).not.toContain('talking');
  });

  it('an unknown non-zero code keeps everything: sdk_validation_<code> plus the snake_cased hint', () => {
    expect(validationFlags({ code: 99, hint: '' })).toEqual(['sdk_validation_99']);
    expect(validationFlags({ code: 99, hint: '   ' })).toEqual(['sdk_validation_99']);
    expect(validationFlags({ code: 99, hint: 'Lens smudged' })).toEqual([
      'sdk_validation_99',
      'lens_smudged',
    ]);
    expect(validationFlags({ code: -1, hint: 'x' })).toEqual(['sdk_validation_-1', 'x']);
  });

  it('the sample carries the code flag plus unstable_* flags, de-duplicated', () => {
    const { sample } = mapLatestToSample(
      { pulse: { value: 70, confidence: 40, stable: false } },
      { nowMs: NOW_MS, validation: { code: SDK_VALIDATION_CODES.kFaceNotCentered, hint: 'x' } },
    );
    expect(sample.qualityFlags).toEqual(['face_not_centered', 'unstable_pulse']);
  });

  it('describeValidation gives the operator line: the hint, else the token spelled out, else the number', () => {
    expect(describeValidation(null)).toBeNull();
    expect(describeValidation({ code: 0, hint: 'fine' })).toBeNull();
    expect(describeValidation({ code: 3, hint: 'face not centered' })).toBe(
      'camera: face not centered',
    );
    expect(describeValidation({ code: 3, hint: '' })).toBe('camera: face not centered');
    expect(describeValidation({ code: 1, hint: '  ' })).toBe('camera: face not found');
    expect(describeValidation({ code: 99, hint: '' })).toBe('camera validation code 99');
  });
});

describe('presageMap: values and confidences', () => {
  it('confidence 0..100 → 0..1, clamped, 4 decimals; absent stays absent (gate treats as 0)', () => {
    expect(confidenceToUnit(95)).toBe(0.95);
    expect(confidenceToUnit(33.333)).toBe(0.3333);
    expect(confidenceToUnit(120)).toBe(1);
    expect(confidenceToUnit(-3)).toBe(0);
    expect(confidenceToUnit(undefined)).toBeUndefined();
    expect(confidenceToUnit('90')).toBeUndefined();
    const { sample } = mapLatestToSample({ pulse: { value: 70 } }, { nowMs: NOW_MS });
    expect(sample.pulseBpm).toBe(70);
    expect(sample.pulseConf).toBeUndefined();
  });

  it('non-finite values are omitted rather than emitted as 0 or null', () => {
    const { sample } = mapLatestToSample(
      { pulse: { value: Number.NaN, confidence: 90 }, breathing: { value: 14.26, confidence: 80 } },
      { nowMs: NOW_MS },
    );
    expect(sample.pulseBpm).toBeUndefined();
    expect(sample.pulseConf).toBeUndefined();
    expect(sample.breathingBpm).toBe(14.3);
    expect(sample.windowS).toBe(30);
  });

  it('never mutates its input', () => {
    const packet = simulatedPacket(3);
    const snapshot = JSON.stringify(packet);
    mapPacket(packet, { nowMs: NOW_MS, validation: { code: 1, hint: 'too dark' } });
    expect(JSON.stringify(packet)).toBe(snapshot);
  });
});

describe('presageMap: SDK errors → status', () => {
  it('names every SmartSpectraErrorCode the SDK declares', () => {
    const declared = Object.values(SDK_ERROR_CODES).filter((c) => c !== 0);
    expect(
      Object.keys(SDK_ERROR_NAMES.codes)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([...declared].sort((a, b) => a - b));
  });

  it('retryable: reported, SDK left to recover', () => {
    expect(sdkErrorToStatus(SDK_ERROR_CODES.kInputUnavailable, 'camera busy', true)).toEqual({
      state: 'error',
      message:
        'SmartSpectra error 7 (input unavailable): camera busy (retryable; waiting for the SDK to recover)',
    });
    expect(sdkErrorToStatus(99, 'odd', true).message).toBe(
      'SmartSpectra error 99: odd (retryable; waiting for the SDK to recover)',
    );
  });

  it('fatal: capture stops for THIS session and the fix is named; never "restart the bridge"', () => {
    const auth = sdkErrorToStatus(SDK_ERROR_CODES.kAuthenticationFailed, 'invalid api key', false);
    expect(auth).toEqual({
      state: 'error',
      message:
        'SmartSpectra error 2 (authentication failed): invalid api key (fatal; capture stopped for ' +
        'this session. Fix: check PRESAGE_API_KEY, then start a new session)',
    });
    expect(
      sdkErrorToStatus(SDK_ERROR_CODES.kCreditExhausted, 'no credits', false).message,
    ).toContain('top up the account at the Presage portal, then start a new session');
    expect(sdkErrorToStatus(SDK_ERROR_CODES.kNetworkError, 'ECONNRESET', false).message).toContain(
      'the SDK needs outbound HTTPS to Presage, then start a new session',
    );
    // A code without a documented fix, and an unknown code, still say what to do next.
    expect(sdkErrorToStatus(SDK_ERROR_CODES.kProcessingFailed, 'x', false).message).toContain(
      '(fatal; capture stopped for this session. Fix: start a new session)',
    );
    expect(sdkErrorToStatus(401, 'x', false).message).toBe(
      'SmartSpectra error 401: x (fatal; capture stopped for this session. Fix: start a new session)',
    );
    expect(sdkErrorToStatus(1, '  ', false).message).toContain('no details from the SDK');
    for (const code of Object.values(SDK_ERROR_CODES)) {
      expect(sdkErrorToStatus(code, 'm', false).message).not.toContain('restart the bridge');
    }
  });
});
