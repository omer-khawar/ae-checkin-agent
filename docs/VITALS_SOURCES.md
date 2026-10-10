# Vitals sources: adapter contract, gating, and the Presage / Arduino slots

This document is the single reference for anyone touching `apps/vitals-bridge/src/sources/`.
It covers the plugin contract (verbatim from `CLAUDE.md` §7.1), what the bridge guarantees around
every source (timing gates, confidence flags, labelling), the fully working mock source, and the
two deliberately unimplemented slots: **Presage SmartSpectra** (contactless, camera-based) and
**Arduino** (contact sensor over serial). Implementing Presage should touch exactly one file:
`apps/vitals-bridge/src/sources/presage.ts`.

Principles that do not change with the source:

- **Measured vs. simulated is always labelled.** Every `VitalsSample` carries `isMeasured`; the
  mock is always `false`. The kiosk badge, the dashboard and every export (`VSMETHOD`,
  `INTERIM_SOURCE`) derive from it. Nothing in the bridge ever upgrades a simulated sample.
- **Vitals are context, never advice.** They never change a provisional grade and can raise the
  escalation tier by at most one step, and only through the documented rules in
  `packages/rules/data/vitals_corroboration.json`.
- **No frames leave the bridge.** Camera frames (when a real camera is used) are processed in
  memory by the SDK; only derived metrics, confidences and quality flags are emitted.
- **The raw series is never thinned.** Low-confidence values are flagged, not dropped; the rules
  engine applies its own threshold with a logged reason.

## 1. The contract (`apps/vitals-bridge/src/sources/types.ts`)

Reproduced verbatim from `CLAUDE.md` §7.1. The API accepts this shape in camelCase on
`POST /api/v1/sessions/{id}/vitals` and the web app's WS types mirror it.

```ts
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
export interface VitalsSource {
  readonly name: "mock" | "presage" | "arduino";
  readonly isMeasured: boolean;
  start(opts: { cameraId?: string; scenario?: string }): Promise<void>;
  stop(): Promise<void>;
  onSample(cb: (s: VitalsSample) => void): void;
  onStatus(cb: (status: { state: "idle"|"warming"|"collecting"|"error"; message?: string }) => void): void;
  listCameras?(): Promise<{ id: string; label: string }[]>;
}
```

Bridge-side additions (same file, not part of the verbatim block):

- `SourceStatus` — the named form of the `onStatus` argument; `SourceState` its `state` union.
- `WaveformCapable` — optional `onWaveform(cb)` for sources that can produce a pleth trace
  (~25 points per second, values 0..1). The mock does; Presage can; Arduino cannot.
- `StubMarker` — `{ implemented: false, notImplementedMessage }`; the factory refuses such a
  source at startup.
- `NotImplementedError` — thrown by stubs and by the factory.

### Semantics every source must honour

| Aspect           | Rule                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadence          | One `VitalsSample` per second while `collecting`. Coalesce faster SDK events to 1 Hz (keep the latest per metric); never emit faster.                        |
| Timestamps       | `tsUtc` is the bridge clock in UTC ISO-8601 with millisecond precision and a `Z` suffix.                                                                     |
| Missing metrics  | Omit the field (undefined), do not send `null` or `0`. A metric without a confidence is treated as confidence 0 downstream.                                   |
| Confidence       | Pass the SDK's 0..1 confidence through unchanged. Do not rescale, smooth or threshold it in the source.                                                        |
| `windowS`        | The averaging window the source actually used, in seconds (≥ 1). One value per sample: report the window of the longest-window metric present.                 |
| `qualityFlags`   | Lower-snake-case tokens from the vocabulary in §6. Sources add observational flags; the bridge adds `gate_pending_*` and `low_conf_*`.                        |
| Status lifecycle | `start()` → `warming` (device opening / face search) → `collecting` (values flowing) → optional `error` (with a message) → `collecting` again → `stop()` → `idle`. |
| Gating           | Do **not** apply timing gates or confidence thresholds in the source; `gate.ts` does it uniformly.                                                            |
| Threading        | Callbacks are invoked on the Node event loop; a source must never block it (native SDK work stays in the SDK's own threads).                                   |

## 2. Gating semantics (bridge-enforced, `src/gate.ts`)

| Metric    | Gate | Why                                                        |
| --------- | ---- | ---------------------------------------------------------- |
| pulse     | 12 s | Presage pulse rate is a 12-second average                  |
| breathing | 30 s | Presage breathing rate is a 30-second average              |
| HRV       | 60 s | Presage HRV (RMSSD and friends) needs 60 s                 |

- The clock counts seconds of **continuous** `collecting` status. Any other status (`error`,
  `warming`, `idle`) resets it to zero; the metric reappears only after a full new gate period.
- Before a gate elapses the metric **and its confidence are removed** from the emitted sample and
  `gate_pending_<pulse|breathing|hrv>` is appended to `qualityFlags`. The sample is still
  broadcast and still posted to the API: the raw series stays complete and auditable.
- After the gate, a value whose confidence is below the threshold is **kept** and flagged
  `low_conf_<metric>`. The UI hides it; the rules engine ignores it with a logged reason
  (`vitals.low_quality`).
- **One source of truth for the threshold and the gates.** On every session start the bridge
  GETs `/api/v1/settings/public` and adopts `min_confidence` (from
  `packages/rules/data/vitals_corroboration.json`) and `timing_gates`, so the "safe to show"
  verdict on the kiosk and the rules engine's own eligibility test cannot drift apart. The
  bridge's built-in 0.6 / 12-30-60 s are offline fallbacks only. `--min-conf` / `VITALS_MIN_CONF`
  pins the threshold on purpose (shown as `(pinned)` in the banner); the gates cannot be pinned
  from the CLI. Invalid API values (a confidence outside 0..1, a gate that is not a positive
  number of seconds) are ignored with a warning.
- The WS `sample` message carries `published: { pulse, breathing, hrv }`: `true` only when the
  gate has elapsed, the value is present and the confidence meets the threshold. That is the
  kiosk's "safe to show" verdict; before it the panel shows "collecting…".
- The mock honours the same gates, so demo timing matches what a real sensor will do.

## 3. Selecting a source

`VITALS_SOURCE=mock|presage|arduino` or `--source`; the factory in `src/sources/index.ts` builds
the source. A stub or an unknown name makes the CLI print the message and exit with code 2
**before any port is opened**:

```
[bridge] ERROR Presage SDK not yet integrated; see docs/VITALS_SOURCES.md. Switch to the mock source: --source mock (or VITALS_SOURCE=mock).
```

The source is fixed for the life of the process. The admin panel's `vitals_source` setting is
read from `GET /api/v1/settings/public` on every session start; if it differs from the running
source the bridge logs a warning telling the operator to restart with the other `--source`.
Hot-swapping a native SDK mid-session is not worth the complexity for a kiosk, and today both
alternatives are stubs, so the admin setting is informational for the bridge. This is a
deliberate deviation from the brief's "runtime override from the admin panel" (CLAUDE.md §7.1)
and is recorded in `docs/DECISIONS.md` ("No runtime vitals-source hot-swap").

## 4. Mock source (implemented)

`src/sources/mock.ts` reads the scenario table in `src/sources/scenarios.ts`; every parameter
has a `rationale`. Signal model per metric: `target + (start − target)·exp(−t/τ) + AR(1) noise`
with `t` counted from the start of the current collecting stretch. Confidence ramps linearly to
its end value and is clamped to a scenario-specific maximum. The PRNG is seeded from the scenario
name by default, so two laptops show the same numbers; tests pass a seed.

| Scenario        | Pulse                | Breathing            | Confidence           | Extras                                          |
| --------------- | -------------------- | -------------------- | -------------------- | ----------------------------------------------- |
| `resting`       | 72 ± 3               | 14 ± 1               | 0.3 → 0.95 over 15 s | HRV 42 ± 4 ms                                   |
| `post_exercise` | 128 → 90 (τ 45 s)    | 27 → 18 (τ 150 s)    | 0.3 → 0.85 over 10 s | occasional `motion`                             |
| `tachypnea`     | 98 ± 2               | 26 ± 0.8             | 0.9 steady           |                                                 |
| `low_quality`   | 75 ± 8               | 15 ± 3               | < 0.5 always         | `face_not_found` (no values) / `low_light`      |
| `dropout`       | 74 ± 3               | 15 ± 1               | 0.5 → 0.95 over 5 s  | `error` for ticks 21–30, then recovery          |

Why `post_exercise` decays slowly: the bridge nulls breathing until the 30 s gate, so the number
the rules engine sees is the value *at 30 s*. With τ = 150 s that is ~25 breaths/min, above the
24 threshold in `vitals_corroboration.json`; pulse at the 12 s gate is ~119, above 110. Both
corroboration rules fire, the tier bumps by one, the grade does not change. That is the demo.
The price is that breathing is still ~23 at 90 s rather than the ~18 CLAUDE.md §7.2 sketches;
with τ tuned to reach 18 by 90 s the gated value would be ~22.6 and the tachypnea rule would not
fire. The deviation is recorded in `docs/DECISIONS.md` ("post_exercise decay constants").

The scenario table is a typed TypeScript module rather than a JSON file. CLAUDE.md §13 puts
*rules and thresholds* in JSON tables under `packages/rules/data/`; the scenario parameters are
simulation shapes, not clinical rules, and the only clinical thresholds the bridge acts on (the
confidence threshold and the timing gates) are adopted from the rules' JSON through the API (§2).
Keeping the table in TS gives it compile-time shape checking, which a hand-edited JSON would not
have; every entry still carries a `rationale`. Also recorded in `docs/DECISIONS.md`.

The mock also emits a synthetic photoplethysmogram (systolic upstroke + dicrotic bump at the
current pulse frequency, 25 points per second) through `onWaveform`, so the kiosk sparkline has
something to draw; it is cosmetic and is not persisted.

## 5. Presage SmartSpectra source (STUB — the hole to fill)

Status: `src/sources/presage.ts` exports `PresageVitalsSource implements VitalsSource` where
every method throws `NotImplementedError("Presage SDK not yet integrated; see docs/VITALS_SOURCES.md")`
except `name` (`"presage"`) and `isMeasured` (`true`). The SDK dependency is intentionally **not**
in `package.json` (it pulls several hundred MB of native binaries). Tracked as issue #11 in
`docs/ISSUES.md`.

### Vendor notes (verbatim from `CLAUDE.md` §7.3; the same block heads `presage.ts`)

> **Presage SmartSpectra SDK, Node.js path (verified from vendor docs, Oct 2026):**
> - Package: `@smartspectra/node-sdk` (`npm install @smartspectra/node-sdk`). Node ≥ 20 (24 LTS recommended). Pulls native runtimes per platform; large install.
> - OS: Linux x64/arm64 (glibc 2.35+, i.e. Ubuntu 22.04+), Windows x64, macOS Apple Silicon. Intel Mac not supported.
> - API key: constructor option `apiKey`, obtained from the Presage developer portal (physiology.presagetech.com). There is also a vendor MCP server (`https://mcp.presagetech.com/mcp`) that can fetch/rotate the key, and a Claude Code skill: `npx skills add Presage-Security/SmartSpectra --skill using-smartspectra` (or `/plugin marketplace add Presage-Security/SmartSpectra` then `/plugin install smartspectra-sdk@smartspectra`). Use the skill when implementing.
> - Minimal usage pattern from vendor quickstart:
>   ```ts
>   import { SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, decodeMetrics } from '@smartspectra/node-sdk';
>   const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics: [...breathingMetrics, ...cardioMetrics] });
>   sdk.on('metrics', (buf, tsMicros) => { const m = decodeMetrics(buf); /* map → VitalsSample */ });
>   sdk.on('validationStatus', (code, ts, hint) => { /* map → qualityFlags */ });
>   sdk.on('error', (code, message, retryable) => { /* → status error */ });
>   sdk.useCamera(CameraSelection.default);   // or CameraSelection.byId(id) from SmartSpectraSDK.availableCameras()
>   sdk.start();  /* later: await sdk.stopAsync(); await sdk.destroy(); */
>   ```
> - Metrics semantics per vendor docs: pulse rate is a 12-second average (valid 40–110 BPM) with confidence; breathing rate a 30-second average (valid 5–40) with confidence; HRV (Mean NN, RMSSD, SDNN, Baevsky) needs 60 s; waveforms available (pleth, upper/lower breathing); face analysis (blink, talking, expressions). **Exact decoded field names were not verified; read `smartspectra.presagetech.com/docs/nodejs/metrics/` when implementing.**
> - Capture conditions: face and upper chest visible and well lit; stable camera for breathing; subject still and not talking (talking degrades breathing); avoid dark clothing / fine stripes.
> - Windows: `CameraSelection.front/back` fail; select by discovered id.
> - Vendor disclaimer: the SDK metrics are "for general wellness and informational use only" except the FDA-cleared iOS/Android pulse+breathing monitor (510(k) K254169). Our product never claims clearance; the UI footer covers this.
> - Mapping: `isMeasured = true`, `source = "presage"`, `windowS` from the metric (12/30/60), `qualityFlags` from validationStatus hints, confidences passed through unchanged.

### How to implement Presage in one file

Everything outside `presage.ts` already treats a Presage sample like a mock sample with
`isMeasured: true`; the kiosk badge flips to **MEASURED** on its own.

1. **Install the SDK, pinned.** In `apps/vitals-bridge`: `npm install @smartspectra/node-sdk@<exact version>`.
   Check the platform matrix in the notes above (no Intel Mac). Expect a large install; keep the
   Docker image mock-only or add a separate build stage, since the bridge normally runs on the
   kiosk laptop, not in compose.
2. **API key.** Read `PRESAGE_API_KEY` (already in `.env.example`) in the constructor or
   `start()`. If it is missing, throw a clear error before touching the camera. Never log the key.
3. **Construct and wire the SDK in `start()`** following the vendor snippet: `requestedMetrics:
   [...breathingMetrics, ...cardioMetrics]`, `useCamera(CameraSelection.byId(opts.cameraId))` when
   a camera id is given, else `CameraSelection.default` (on Windows, always select by discovered
   id). Emit `warming` immediately, `collecting` on the first `metrics` event.
4. **Map `metrics` → `VitalsSample`.** `decodeMetrics(buf)` gives the latest pulse / breathing /
   HRV with confidences (**verify the decoded field names against
   `smartspectra.presagetech.com/docs/nodejs/metrics/`; they were not verified when this was
   written**). Keep the latest value per metric and emit one sample per second from a 1 s timer:
   `source: "presage"`, `isMeasured: true`, confidences unchanged, `windowS` = the window of the
   longest-window metric present (12 / 30 / 60), `tsUtc` = bridge clock. Omit a metric the SDK has
   not produced yet (undefined, never 0).
5. **Map `validationStatus` → `qualityFlags`** using the vocabulary in §6 (face not found →
   `face_not_found`, lighting → `low_light`, motion → `motion`, talking → `talking`; anything else
   → `sdk_<code>` so nothing is silently lost). The hint text can go into the `warming`/`error`
   status message.
6. **Map `error` → status.** `retryable === true`: emit `{state: "error", message}` and let the SDK
   recover (it will emit `metrics` again; then emit `collecting`). Non-retryable: emit `error`,
   stop the SDK, stay in `error` until `stop()`.
7. **`stop()`**: clear the 1 s timer, `await sdk.stopAsync(); await sdk.destroy();`, emit `idle`.
   Make it idempotent (the session layer may call it twice).
8. **`listCameras()`**: `SmartSpectraSDK.availableCameras()` → `{ id, label }[]`.
9. **Optional waveform**: implement `WaveformCapable` from the SDK's pleth waveform, normalised to
   0..1, ~25 points per second, `tsUtc` of the accompanying sample. The kiosk draws it if present.
10. **Flip the marker**: set `implemented = true` (or drop the `StubMarker` fields). The factory
    will then hand the source out; `--source presage` starts normally.
11. **Tests**: add `test/presage.test.ts` driving the class with a fake SDK injected through a
    constructor option (`sdkFactory`), covering the metric mapping, flag mapping, retryable vs.
    fatal errors, 1 Hz coalescing and `stop()`; update the fail-fast expectations in
    `test/sources.test.ts` and `test/cli.test.ts` (presage now starts; missing key still exits 2).
12. **Verify end to end**: `npm run lint && npm run typecheck && npm test`, then
    `npm run bridge -- --source presage --list-cameras`, then a live kiosk session: the status
    line should show real values after 12 s / 30 s and the kiosk badge should read **MEASURED**.
    Do jumping jacks and watch the corroboration rule fire on the dashboard.
13. **Docs**: update the status lines in this file and `docs/ISSUES.md` #11; log the `windowS`
    choice and any contract touch in `docs/DECISIONS.md`.

Reminder from the vendor disclaimer: the Node SDK metrics are for general wellness and
informational use; Interim never claims FDA clearance and the UI footer says so.

## 6. Arduino serial source (STUB)

Status: `src/sources/arduino.ts` is a stub with the same fail-fast behaviour
(`"Arduino serial source not yet integrated; see docs/VITALS_SOURCES.md"`). `serialport` is
intentionally not a dependency yet. Tracked as issue #12.

### Expected wire format

A MAX30102 (pulse / SpO2) + DS18B20 (temperature) sketch writes **newline-delimited JSON**
(NDJSON) at 115200 baud, 8N1, one object per line, one line per second, on the port named by the
`SERIALPORT` environment variable (e.g. `COM4`, `/dev/ttyACM0`):

```
{"pulse":74,"spo2":98,"temp_c":36.8}
```

| Field    | Type    | Required | Meaning                                                                  |
| -------- | ------- | -------- | ------------------------------------------------------------------------ |
| `pulse`  | number  | yes      | beats/min                                                                |
| `spo2`   | number  | no       | percent. No slot in `VitalsSample` v1: logged only (see note below).     |
| `temp_c` | number  | no       | degrees Celsius. No slot in `VitalsSample` v1: logged only.              |
| `valid`  | boolean | no       | `false` when the sensor's finger-detect fails                            |
| `ms`     | number  | no       | sketch uptime in ms; used only to notice dropped lines                   |

Mapping to `VitalsSample`: `pulseBpm = pulse`; `pulseConf = valid === false ? 0 : 1` (the
MAX30102 library yields a validity bit, not a probability); breathing / HRV undefined;
`windowS = 1`; `source = "arduino"`; `isMeasured = true`; `qualityFlags = ["no_finger"]` when
`valid === false`; a line that fails to parse is dropped and the next sample carries
`"malformed_line"`. Status: `warming` until the first parseable line, `collecting` after, `error`
when the port closes or no line arrives for 5 s (reopen with backoff), `idle` after `stop()`.

Adding `spo2` / temperature to `VitalsSample` is a contract change (`CLAUDE.md` §7.1): log it in
`docs/DECISIONS.md` and update the API's Pydantic alias model and the web types in the same
commit. Implementation checklist: add `serialport` (pinned), parse with a line splitter, inject
the port through a constructor option for tests, flip `implemented = true`, add
`test/arduino.test.ts`.

## 7. Quality flag vocabulary

| Flag                      | Added by | Meaning                                                         |
| ------------------------- | -------- | --------------------------------------------------------------- |
| `face_not_found`          | source   | No face in frame; optical metrics unavailable this second.      |
| `low_light`               | source   | Illumination too low for a reliable optical signal.             |
| `motion`                  | source   | Subject or camera movement degrading the signal.                |
| `talking`                 | source   | Speech detected; breathing estimate degraded.                   |
| `no_finger`               | arduino  | Contact sensor sees no finger.                                  |
| `malformed_line`          | arduino  | A serial line could not be parsed (dropped).                    |
| `sdk_<code>`              | presage  | Any vendor validation code without a mapping above.             |
| `gate_pending_<metric>`   | bridge   | Timing gate for that metric not yet elapsed; value removed.     |
| `low_conf_<metric>`       | bridge   | Confidence below threshold; value kept, hidden in UI, ignored by rules. |

## 8. Where things are

- Contract types: `apps/vitals-bridge/src/sources/types.ts`
- Factory / fail-fast: `apps/vitals-bridge/src/sources/index.ts`
- Mock + scenario table: `apps/vitals-bridge/src/sources/mock.ts`, `scenarios.ts`, `noise.ts`
- Presage stub (the one file to implement): `apps/vitals-bridge/src/sources/presage.ts`
- Arduino stub: `apps/vitals-bridge/src/sources/arduino.ts`
- Gates: `apps/vitals-bridge/src/gate.ts`
- Bridge README (CLI, WS protocol, HTTP batching): `apps/vitals-bridge/README.md`
- Interface contracts for the whole system: `docs/CONTRACTS.md` §3
