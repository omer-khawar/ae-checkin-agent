import { describe, expect, it } from 'vitest';
import { ArduinoVitalsSource, ARDUINO_NOT_IMPLEMENTED_MESSAGE } from '../src/sources/arduino.js';
import { createSource, SWITCH_TO_MOCK_HINT, UnknownSourceError } from '../src/sources/index.js';
import { MockVitalsSource } from '../src/sources/mock.js';
import { PresageVitalsSource } from '../src/sources/presage.js';
import {
  hasPreflight,
  hasWaveform,
  isStubbed,
  NotImplementedError,
  SourceUnavailableError,
} from '../src/sources/types.js';

describe('createSource', () => {
  it('builds the mock source (with waveform support)', () => {
    const src = createSource('mock');
    expect(src).toBeInstanceOf(MockVitalsSource);
    expect(src.name).toBe('mock');
    expect(src.isMeasured).toBe(false);
    expect(hasWaveform(src)).toBe(true);
    expect(isStubbed(src)).toBe(false);
    expect(hasPreflight(src)).toBe(false);
  });

  it('builds the presage source as a real, preflightable source without touching the SDK', () => {
    const src = createSource('presage', { presage: { env: {} } });
    expect(src).toBeInstanceOf(PresageVitalsSource);
    expect(src.name).toBe('presage');
    expect(src.isMeasured).toBe(true);
    expect(isStubbed(src)).toBe(false);
    expect(hasPreflight(src)).toBe(true);
    expect(hasWaveform(src)).toBe(false); // the SDK's pleth waveform is not wired (unverified fields)
  });

  it('presage preflight fails with the install command when the SDK is absent (CI)', async () => {
    const src = createSource('presage', { presage: { env: { PRESAGE_API_KEY: 'k' } } });
    expect(hasPreflight(src)).toBe(true);
    if (!hasPreflight(src)) return;
    await expect(src.preflight()).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(src.preflight()).rejects.toThrow('npm run install:presage');
    await expect(src.preflight()).rejects.toThrow(SWITCH_TO_MOCK_HINT);
  });

  it('fails fast for arduino', () => {
    expect(() => createSource('arduino')).toThrow(NotImplementedError);
    expect(() => createSource('arduino')).toThrow(ARDUINO_NOT_IMPLEMENTED_MESSAGE);
    expect(() => createSource('arduino')).toThrow(SWITCH_TO_MOCK_HINT);
  });

  it('fails fast for an unknown name', () => {
    expect(() => createSource('webcam')).toThrow(UnknownSourceError);
    expect(() => createSource('webcam')).toThrow(/unknown vitals source "webcam"/);
    expect(() => createSource('webcam')).toThrow(SWITCH_TO_MOCK_HINT);
  });
});

describe('ArduinoVitalsSource stub', () => {
  const src = new ArduinoVitalsSource();

  it('exposes name and isMeasured without throwing', () => {
    expect(src.name).toBe('arduino');
    expect(src.isMeasured).toBe(true);
    expect(isStubbed(src)).toBe(true);
  });

  it('throws NotImplementedError from every method', () => {
    expect(() => src.start({})).toThrow(NotImplementedError);
    expect(() => src.stop()).toThrow(NotImplementedError);
    expect(() => src.onSample(() => undefined)).toThrow(NotImplementedError);
    expect(() => src.onStatus(() => undefined)).toThrow(NotImplementedError);
    expect(hasWaveform(src)).toBe(false);
  });
});
