import { describe, expect, it } from 'vitest';
import { ArduinoVitalsSource, ARDUINO_NOT_IMPLEMENTED_MESSAGE } from '../src/sources/arduino.js';
import { createSource, SWITCH_TO_MOCK_HINT, UnknownSourceError } from '../src/sources/index.js';
import { MockVitalsSource } from '../src/sources/mock.js';
import { PresageVitalsSource, PRESAGE_NOT_IMPLEMENTED_MESSAGE } from '../src/sources/presage.js';
import { hasWaveform, isStubbed, NotImplementedError } from '../src/sources/types.js';

describe('createSource', () => {
  it('builds the mock source (with waveform support)', () => {
    const src = createSource('mock');
    expect(src).toBeInstanceOf(MockVitalsSource);
    expect(src.name).toBe('mock');
    expect(src.isMeasured).toBe(false);
    expect(hasWaveform(src)).toBe(true);
    expect(isStubbed(src)).toBe(false);
  });

  it('fails fast for presage with the exact CLAUDE.md message and a hint to switch to mock', () => {
    expect(() => createSource('presage')).toThrow(NotImplementedError);
    expect(() => createSource('presage')).toThrow(
      'Presage SDK not yet integrated; see docs/VITALS_SOURCES.md',
    );
    expect(() => createSource('presage')).toThrow(SWITCH_TO_MOCK_HINT);
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

describe('PresageVitalsSource stub', () => {
  const src = new PresageVitalsSource();

  it('exposes name and isMeasured without throwing', () => {
    expect(src.name).toBe('presage');
    expect(src.isMeasured).toBe(true);
    expect(src.implemented).toBe(false);
    expect(isStubbed(src)).toBe(true);
    expect(src.notImplementedMessage).toBe(PRESAGE_NOT_IMPLEMENTED_MESSAGE);
  });

  it('throws NotImplementedError from every method', () => {
    const expected = PRESAGE_NOT_IMPLEMENTED_MESSAGE;
    expect(() => src.start({})).toThrow(expected);
    expect(() => src.stop()).toThrow(expected);
    expect(() => src.onSample(() => undefined)).toThrow(expected);
    expect(() => src.onStatus(() => undefined)).toThrow(expected);
    expect(() => src.listCameras()).toThrow(expected);
    try {
      void src.start({});
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as Error).name).toBe('NotImplementedError');
    }
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
