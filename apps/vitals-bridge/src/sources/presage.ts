/**
 * Presage SmartSpectra source: STUB (CLAUDE.md §7.3). This is the one file that needs real work
 * when the team says "implement Presage". Everything else in the bridge (gates, WS protocol,
 * batching, CLI) already treats a Presage sample exactly like a mock sample, except that
 * `isMeasured` is true and the UI badge reads MEASURED.
 *
 * Contract: every method throws NotImplementedError except `name` / `isMeasured`. The factory in
 * index.ts sees `implemented === false` and refuses the source at startup, so `--source presage`
 * exits with code 2 and the message below before any port is opened.
 *
 * The SDK dependency (`@smartspectra/node-sdk`) is deliberately NOT in package.json yet: it pulls
 * several hundred MB of native binaries. Add it when implementing.
 *
 * Implementation checklist: docs/VITALS_SOURCES.md, section "How to implement Presage in one file".
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

import {
  NotImplementedError,
  type SourceStatus,
  type StubMarker,
  type VitalsSample,
  type VitalsSource,
} from './types.js';

/** Exact message required by CLAUDE.md §7.3; the CLI prints it and exits 2. */
export const PRESAGE_NOT_IMPLEMENTED_MESSAGE =
  'Presage SDK not yet integrated; see docs/VITALS_SOURCES.md';

export class PresageVitalsSource implements VitalsSource, StubMarker {
  readonly name = 'presage' as const;
  /** Presage is a real optical sensor: its samples are measured, never simulated. */
  readonly isMeasured = true as const;
  /** Flip to true (or delete the StubMarker fields) once the SDK is wired in. */
  readonly implemented = false;
  readonly notImplementedMessage = PRESAGE_NOT_IMPLEMENTED_MESSAGE;

  start(_opts: { cameraId?: string; scenario?: string }): Promise<void> {
    throw new NotImplementedError(PRESAGE_NOT_IMPLEMENTED_MESSAGE);
  }

  stop(): Promise<void> {
    throw new NotImplementedError(PRESAGE_NOT_IMPLEMENTED_MESSAGE);
  }

  onSample(_cb: (s: VitalsSample) => void): void {
    throw new NotImplementedError(PRESAGE_NOT_IMPLEMENTED_MESSAGE);
  }

  onStatus(_cb: (status: SourceStatus) => void): void {
    throw new NotImplementedError(PRESAGE_NOT_IMPLEMENTED_MESSAGE);
  }

  listCameras(): Promise<{ id: string; label: string }[]> {
    throw new NotImplementedError(PRESAGE_NOT_IMPLEMENTED_MESSAGE);
  }
}
