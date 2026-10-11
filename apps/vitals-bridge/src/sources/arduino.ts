/**
 * Arduino serial source: STUB (CLAUDE.md §7.4). Same pattern as presage.ts: every method throws
 * NotImplementedError, the factory refuses it at startup, and `serialport` is deliberately NOT a
 * dependency yet.
 *
 * Expected wire format when implemented (also documented in docs/VITALS_SOURCES.md, Arduino):
 *
 *   Transport : USB serial, 115200 8N1, port from env SERIALPORT (e.g. COM4, /dev/ttyACM0).
 *   Framing   : newline-delimited JSON (NDJSON): one JSON object per line, "\n" terminated,
 *               no pretty-printing, one line per second from a MAX30102 (pulse/SpO2) +
 *               DS18B20 (temperature) sketch.
 *   Line      : {"pulse":74,"spo2":98,"temp_c":36.8}
 *   Fields    : pulse   number   beats/min, required
 *               spo2    number   percent, optional (no slot in VitalsSample v1; logged only)
 *               temp_c  number   degrees C, optional (no slot in VitalsSample v1; logged only)
 *               valid   boolean  optional; false when the sensor finger-detect fails
 *               ms      number   optional; sketch uptime in ms, used only to spot dropped lines
 *   Mapping   : pulseBpm = pulse; pulseConf = valid === false ? 0.0 : 1.0 (the MAX30102 library
 *               gives a validity bit, not a probability); breathing/HRV undefined; windowS = 1;
 *               source = "arduino"; isMeasured = true; qualityFlags = ["no_finger"] when
 *               valid === false, ["malformed_line"] on a JSON parse failure (line dropped).
 *   Status    : "warming" until the first parseable line, "collecting" after, "error" when the
 *               port closes or 5 s pass without a line; reopen with backoff.
 *
 * Adding spo2 / temperature to VitalsSample is a contract change (CLAUDE.md §7.1): log it in
 * docs/DECISIONS.md and update the API Pydantic alias model in the same commit.
 */
import {
  NotImplementedError,
  type SourceStatus,
  type StubMarker,
  type VitalsSample,
  type VitalsSource,
} from './types.js';

export const ARDUINO_NOT_IMPLEMENTED_MESSAGE =
  'Arduino serial source not yet integrated; see docs/VITALS_SOURCES.md';

export class ArduinoVitalsSource implements VitalsSource, StubMarker {
  readonly name = 'arduino' as const;
  /** A contact sensor on a real participant is a measurement. */
  readonly isMeasured = true as const;
  readonly implemented = false;
  readonly notImplementedMessage = ARDUINO_NOT_IMPLEMENTED_MESSAGE;

  start(_opts: { cameraId?: string; scenario?: string }): Promise<void> {
    throw new NotImplementedError(ARDUINO_NOT_IMPLEMENTED_MESSAGE);
  }

  stop(): Promise<void> {
    throw new NotImplementedError(ARDUINO_NOT_IMPLEMENTED_MESSAGE);
  }

  onSample(_cb: (s: VitalsSample) => void): void {
    throw new NotImplementedError(ARDUINO_NOT_IMPLEMENTED_MESSAGE);
  }

  onStatus(_cb: (status: SourceStatus) => void): void {
    throw new NotImplementedError(ARDUINO_NOT_IMPLEMENTED_MESSAGE);
  }
}
