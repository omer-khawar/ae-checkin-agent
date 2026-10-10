# Vitals sources: adapter contract, gating, and the Presage / Arduino slots

This document is the single reference for anyone touching `apps/vitals-bridge/src/sources/`.
It covers the plugin contract (verbatim from `CLAUDE.md` §7.1), what the bridge guarantees around
every source (timing gates, confidence flags, labelling), the fully working mock source, the
**Presage SmartSpectra** source (contactless, camera-based; implemented in §5, untested against a
live camera until someone runs it with an API key), and the deliberately unimplemented
**Arduino** slot (contact sensor over serial, §6). Implementing Presage touched exactly the two
files it was meant to: `apps/vitals-bridge/src/sources/presage.ts` (SDK lifecycle) and
`presageMap.ts` (pure packet → sample mapping).

Principles that do not change with the source:

- **Measured vs. simulated is always labelled.** Every `VitalsSample` carries `isMeasured`; the
  mock is always `false`. The kiosk badge, the dashboard and every export (`VSMETHOD`,
  `INTERIM_SOURCE`) derive from it. Nothing in the bridge ever upgrades a simulated sample.
- **Vitals are context, never advice.** They never change a provisional grade and can raise the
  escalation tier by at most one step, and only through the documented rules in
  `packages/rules/data/vitals_corroboration.json`.
- **No frames leave the bridge.** Camera frames (when a real camera is used) are processed in
  memory by the SDK; only derived metrics, confidences and quality flags are emitted. The
  Presage SDK's aggregate telemetry (on by default) is switched off; what the SDK still talks to
  Presage's servers for (API-key validation, credit metering) is disclosed in §5.
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
  source at startup (today only Arduino).
- `NotImplementedError` — thrown by stubs and by the factory.
- `Preflightable` — optional `preflight({ forListCameras? })` for a real source that depends on
  something outside the repository (a native SDK, an API key, a device). The CLI awaits it right
  after construction, before any port opens, and maps a `SourceUnavailableError` to exit code 2
  exactly like a stub. Presage implements it; the mock does not need it.
- `SourceUnavailableError` — `{ reason: "sdk_missing" | "sdk_load_failed" | "api_key_missing" |
  "no_camera" | "other" }`, always with the exact fix in the message and the switch-to-mock hint.

### Semantics every source must honour

| Aspect           | Rule                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadence          | One `VitalsSample` per second while `collecting`. Coalesce faster SDK events to 1 Hz (keep the latest per metric); never emit faster.                        |
| Timestamps       | `tsUtc` is UTC ISO-8601 with millisecond precision and a `Z` suffix: the bridge clock, or the sensor's own epoch timestamp when it is plausible (presage, §5). |
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
the source. A stub (`arduino`), an unknown name, or a real source whose preflight fails (Presage
without the SDK or without `PRESAGE_API_KEY`) makes the CLI print the message and exit with code 2
**before any port is opened**:

```
[bridge] ERROR Presage SmartSpectra SDK (@smartspectra/node-sdk@3.4.0) is not installed. Run "npm run install:presage" in apps/vitals-bridge (it is deliberately not a package.json dependency; see docs/VITALS_SOURCES.md). Switch to the mock source: --source mock (or VITALS_SOURCE=mock).
[bridge] ERROR Arduino serial source not yet integrated; see docs/VITALS_SOURCES.md. Switch to the mock source: --source mock (or VITALS_SOURCE=mock).
```

The source is fixed for the life of the process. The admin panel's `vitals_source` setting is
read from `GET /api/v1/settings/public` on every session start; if it differs from the running
source the bridge logs a warning telling the operator to restart with the other `--source`.
Hot-swapping a native SDK (and a camera) mid-session is not worth the complexity for a kiosk, so
the admin setting is informational for the bridge. This is a deliberate deviation from the
brief's "runtime override from the admin panel" (CLAUDE.md §7.1) and is recorded in
`docs/DECISIONS.md` ("No runtime vitals-source hot-swap").

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

## 5. Presage SmartSpectra source (IMPLEMENTED; untested against a live camera)

**Status: implemented, untested against a live camera (needs `PRESAGE_API_KEY` and a webcam).**
`src/sources/presage.ts` is a real `VitalsSource` (SDK lifecycle, camera selection, status) and
`src/sources/presageMap.ts` is the pure packet → `VitalsSample` mapping, unit-tested against
fixtures in the exact decoded shape. The SDK is loaded dynamically at `start()` / `preflight()`
and is **not** a `package.json` dependency (CLAUDE.md §7.3; decision D-016): CI never installs it,
and the Docker image never contains it. Ported from Omer Khawar's `presage-bridge/bridge.js`
(MIT), which exercised SDK 3.4.0 against a real camera and verified the surface this port uses;
credit is in the module header. Tracked as issue #14 in `docs/ISSUES.md`. Until the live test
below has been run once, the kiosk badge **MEASURED** `presage` has never been seen on a real
participant; say so if asked.

### Install (on the kiosk laptop, never in Docker)

1. Check the platform matrix in the vendor notes below (Linux x64/arm64 with glibc 2.35+, Windows
   x64, macOS Apple Silicon; Intel Mac is not supported). Node ≥ 20 (24 LTS recommended).
2. `cd apps/vitals-bridge && npm install && npm run install:presage`. The second command runs
   `npm install --no-save @smartspectra/node-sdk@3.4.0`: several hundred MB of native binaries
   land in `node_modules/`, while `package.json` and `package-lock.json` stay untouched. A later
   plain `npm install` or `npm ci` prunes the SDK again (npm removes extraneous packages); just
   re-run `npm run install:presage`. The version is pinned to the one the teammate's bridge was
   verified against.
3. Get an API key from https://physiology.presagetech.com and put it in the bridge's environment:
   `PRESAGE_API_KEY=...` in `.env` (read by `make dev` / `npm run dev`) or exported in the shell.
   Never commit it; the bridge never logs it or sends it anywhere but the SDK constructor.
4. `npm run bridge -- --source presage --list-cameras` prints `id<TAB>label` per camera (no key
   needed). On Windows the SDK cannot open the "default" camera, so the bridge selects the **first
   discovered id** automatically. That first id can be an IR or virtual device on some laptops,
   so run `--list-cameras` once and pin the real webcam with `PRESAGE_CAMERA_ID=<id>` (camera ids
   are "opaque and platform-local; rediscover before reuse", per the SDK).
5. `npm run bridge -- --source presage --api http://localhost:8000 --ws-port 8787` (or
   `VITALS_SOURCE=presage` with `make bridge`). The banner reads
   `source=presage (MEASURED sensor values)`; the camera opens only when the kiosk starts a session.

**Network and telemetry (read before a site deployment).** The Presage source is the one
documented exception to CLAUDE.md §13's "no network calls at runtime": the SDK authenticates the
API key against Presage's servers ("server-validated auth") and meters usage against the
account's credits, so the kiosk needs outbound HTTPS to Presage and a funded account. The SDK's
error codes `kAuthenticationFailed` (2), `kCreditExhausted` (4), `kNetworkError` (5) and
`kServerError` (6) are exactly these failures; the bridge names them in the status message. The
bridge cannot check the key before a session (the SDK validates it on `start()`), so a wrong key,
an exhausted balance or a locked-down network surfaces as a **fatal** status during the first
participant's session, after `warming`: the kiosk card shows the error, the check-in continues
without vitals (`vitals_status: "unavailable"`), and the next session constructs a fresh SDK, so
the fix is "correct the key / credits / network, then start a new session", never "restart the
bridge". Run step 2 of the live checklist below before the first real participant. The SDK's
**aggregate telemetry is switched off** (`enableTelemetry: false`; it defaults to on in
`SmartSpectraOptions`) and its log level is pinned to warnings and errors; no camera frame, no
sample and no identifier leaves the bridge except through the SDK's own authentication and
metering calls. This is recorded as a decision for `docs/DECISIONS.md` (D-016 amendment) and
belongs in `docs/WHAT_IT_GETS_WRONG.md`.

What fails fast, **before any port opens**, with exit code 2 and the fix in the message: SDK not
installed (`npm run install:presage`), SDK installed but not loadable on this platform, SDK
exports not the ones this bridge was written against, `PRESAGE_API_KEY` unset (not required for
`--list-cameras`), camera discovery unsupported or no camera found on Windows (`--list-cameras`
takes the same path: a discovery failure is reported with the `PRESAGE_CAMERA_ID` hint, never as a
stack trace). Every message ends with the switch-to-mock hint.

### How it works (`presage.ts`)

| Step | What happens |
| --- | --- |
| `preflight()` | `import("@smartspectra/node-sdk")` and `import(".../messages")` inside try/catch, then a structural check of the exports used; then the API key (unless listing cameras). The CLI runs this first. |
| `start()` | Wait for any in-flight `stop()` or fatal-error teardown (the SDK says to await `destroy()` before constructing a replacement: native state is process-global). Resolve the key (constructor option > `PRESAGE_API_KEY`), load the SDK, choose the camera (`start` opts > constructor > `PRESAGE_CAMERA_ID` > Windows: first discovered id > `CameraSelection.default`), `new SmartSpectraSDK({ apiKey, requestedMetrics: [...breathingMetrics, ...cardioMetrics], enableTelemetry: false, logLevel: SmartSpectraLogLevel.kWarning })`, wire the three events (the SDK keeps one callback per event; `on()` replaces, so each is registered exactly once per instance), `useCamera`, `start()`, status `warming`, start a 1 Hz ticker. A constructor or `start()` failure destroys the instance and rejects with the SDK's message plus the mock hint. |
| `metrics(buf)` | `Metrics.toObject(decodeMetrics(buf), { longs: Number })` → newest entry per metric (`extractLatest`) merged into a pending slot (`mergeLatest`, newest timestamp wins). An undecodable packet is counted and logged, never thrown. |
| tick (1 Hz) | If the pending slot has at least one value: status `collecting` (first time, or "recovered" after an error) and **one** `VitalsSample`. Packets arriving faster than 1 Hz are coalesced, never emitted faster; a tick with nothing new emits nothing (no stale value is re-sent). If nothing with a value arrived for 5 s while collecting → status `warming` ("timing gates reset"), because the SDK's own 12/30/60 s averages restart when the face is re-acquired. |
| `validationStatus(code, ts, hint)` | Remembered. Its integer **code** becomes `qualityFlags` on the next sample through the `VALIDATION_CODE_FLAGS` table (§7); the free-text hint only re-announces the current status as `camera: <hint>` (a repeated `collecting` status does not reset the gate clock) and goes to the log, once per change. |
| `error(code, message, retryable)` | Status `error` naming the code (`SDK_ERROR_NAMES` table) and the vendor text. Retryable: the SDK keeps running and the next packet brings `collecting` back. Fatal: the SDK is stopped and destroyed; the source stays in `error` until `stop()`; the message says "capture stopped for this session. Fix: …, then start a new session", because the next `start()` builds a fresh instance. |
| `stop()` | Ticker off, `await sdk.stopAsync(); await sdk.destroy();` (each failure logged, never thrown), status `idle`. Idempotent; late events from the old instance are ignored via a generation counter, and a `start()` that arrives during the teardown waits for it (so the old teardown's `idle` can never overwrite the new session's `warming`). |
| `listCameras()` | `SmartSpectraSDK.availableCameras()` (a synchronous static: `CameraInfo[]` = `{ id, name: string \| null, facing, lensType }`) normalised to `{ id, label }[]` with `label` = `name` or `camera <id>`. A throw ("discovery unsupported") becomes `SourceUnavailableError('no_camera')` with the `PRESAGE_CAMERA_ID` hint. |

The gates in `gate.ts` apply unchanged: pulse appears on the kiosk after 12 s of continuous
`collecting`, breathing after 30 s, HRV after 60 s, and only when the SDK's confidence (÷ 100)
meets the threshold from the rules tables. The pleth waveform the SDK can produce is **not**
wired (deliberately: it is cosmetic, and the kiosk sparkline simply stays hidden for this
source). No camera frame ever leaves the SDK's memory; only the decoded metrics do.

### Mapping (`presageMap.ts`, pure)

| `VitalsSample` field | From | Notes |
| --- | --- | --- |
| `source` / `isMeasured` | constant | `"presage"` / `true`: a camera-based measurement of a real participant. |
| `pulseBpm`, `pulseConf` | last `cardio.pulseRate[]` entry: `value`, `confidence ÷ 100` | value rounded to 0.1; confidence clamped to 0..1. A missing confidence stays missing (the gate treats it as 0). |
| `breathingBpm`, `breathingConf` | last `breathing.rate[]` entry | likewise |
| `hrvRmssdMs`, `hrvConf` | last `cardio.hrv[]` entry: `rmssd` (ms), `confidence ÷ 100` | the `IHrv` message is `{ rmssd, meanNn, sdnn, baevsky, timestamp, confidence, stable }` (SDK `generated.d.ts`); only RMSSD is mapped (the contract has no slot for the others). Omitted when `rmssd` is absent or not finite. |
| `windowS` | longest window among the metrics present: pulse 12, breathing 30, HRV 60 | the vendor's documented averaging windows (sensor properties, not clinical thresholds); the rules engine checks them against its `min_window_s` table. |
| `qualityFlags` | latest non-zero `validationStatus` **code** → one token from the `VALIDATION_CODE_FLAGS` table in `presageMap.ts` (full list in §7); plus `unstable_pulse` / `unstable_breathing` / `unstable_hrv` when the entry's `stable` is `false` | the integer codes are a typed, stable part of the SDK's public surface (`ValidationCode` in `index.d.ts`); the hint's wording is not published, so it is never parsed into flags. A code the table does not know yields `sdk_validation_<code>` plus the snake_cased hint, so nothing the SDK said is lost. `kNoFaceFound` → `face_not_found`, `kTooDark` → `low_light`, `kExcessiveMotion` → `motion`: the tokens the kiosk's "signal is weak" logic (`DEGRADED_FLAGS`) knows. |
| `tsUtc` | newest entry `timestamp` (µs since epoch → ISO, ms precision) | used only when plausible (after 2020-01-01 and at most 24 h ahead of the bridge clock); otherwise the bridge clock, with one warning. An SDK build that reports monotonic or millisecond timestamps must not produce 1970 eSource records. |

Nothing clinical is decided in the mapping: no thresholds, no plausibility checks on the values
themselves; `gate.ts` and the rules engine do that.

### Verified vs. unverified

Two sources of evidence: (a) the teammate's `presage-bridge/bridge.js`, which ran SDK 3.4.0
against a webcam; (b) the SDK package's own shipped TypeScript declarations (`js/index.d.ts`,
`js/messages/generated.d.ts`), which anyone can read without the native binaries:
`npm pack @smartspectra/node-sdk@3.4.0` (about 125 KB) and open the tarball.

| Item | Status | Evidence |
| --- | --- | --- |
| Package `@smartspectra/node-sdk@3.4.0`; exports `SmartSpectraSDK`, `CameraSelection`, `breathingMetrics`, `cardioMetrics`, `decodeMetrics`, `SmartSpectraLogLevel`, `ValidationCode`, `SmartSpectraErrorCode`; `@smartspectra/node-sdk/messages` export `Metrics` | **verified** | (a) + (b) `index.d.ts`, `index.js` |
| Decode path `Metrics.toObject(decodeMetrics(buf), { longs: Number })` | **verified** | (a); (b) `index.js` registers the bundled `Metrics` class so `decodeMetrics` returns a protobufjs message |
| `cardio.pulseRate[{ value, confidence 0–100, stable, timestamp µs }]`, `breathing.rate[...]` | **verified** | (a) `simulatedMetrics` round-trips this shape; (b) `IMeasurementWithConfidence` in `generated.d.ts`: confidence "percentage in the range [0.0, 100.0]", timestamp "microseconds since Linux epoch" |
| `cardio.hrv[]` = `IHrv { rmssd, meanNn, sdnn, baevsky, timestamp, confidence, stable }` | **verified** | (b) `generated.d.ts`; `hrvRmssd()` reads `rmssd` directly. Not yet seen on a live packet (the SDK says HRV needs 60 s) |
| Events `metrics(buf, tsMicros)`, `validationStatus(code, ts, hint)`, `error(code, message, retryable)`; `useCamera`, `start`, `stopAsync`, `destroy`; `on()` keeps one callback per event (re-registration replaces) | **verified** | (a); (b) `index.d.ts` event table |
| `ValidationCode` integer table (1 no face … 17 face not forward) and `SmartSpectraErrorCode` (1 invalid state … 11 timestamp gap); "integer values are stable across SDK versions" | **verified** | (b) `index.d.ts`; mirrored in `presageMap.ts` tables and asserted complete by `test/presageMap.test.ts` |
| `SmartSpectraOptions.enableTelemetry` defaults to `true`; `logLevel` defaults to warning | **verified** | (b) `index.d.ts`, `ffi.js` (`disable_telemetry: cfg.enableTelemetry === false ? 1 : 0`); the bridge passes `false` and `kWarning` |
| `static availableCameras(): CameraInfo[]` is synchronous, needs no instance / key / capture, "throws when discovery is unsupported" with a plain `Error` carrying `code` and `retryable`; `CameraInfo = { id, name: string \| null, facing, lensType }` | **verified** | (b) `index.d.ts`, `ffi.js` `makeFfiError` |
| `apiKey` is "server-validated auth"; credits are metered (`kCreditExhausted`) | **verified** | (b) `index.d.ts`; hence the network paragraph above |
| `timestamp` is epoch microseconds | **verified** by declaration, **not yet observed** live | (b) field doc; plausibility guard + bridge-clock fallback stays, in case a build reports monotonic time |
| Metrics packet cadence ≈ 1 Hz | **assumed** | coalesced to ≤ 1 Hz either way |
| `CameraSelection.default` fails on Windows | **vendor note** | the bridge selects by discovered id there |
| Exact wording of validation hints | **unpublished** | never parsed; the code is used instead |
| Pleth / breathing waveform | not wired (deliberate) | kiosk sparkline hidden for this source |

The vendor notes block at the end of this section still says "Exact decoded field names were not
verified": that sentence is the brief's own text, reproduced verbatim on purpose (it is checked
byte-for-byte against `CLAUDE.md` and `presage.ts`); the table above is where the verification
status actually lives.

### Capture conditions (vendor guidance)

Face and upper chest visible and well lit from the front; a stable camera (breathing rate needs a
still frame); the participant sitting still and not talking (talking degrades breathing); avoid
dark clothing and fine stripes; do not open the camera in a browser tab at the same time. Pulse
is a 12-second average (vendor validity 40–110 BPM), breathing a 30-second average (5–40), HRV
needs 60 s.

### Live test checklist (do this once, then update the status line above and issue #14)

1. **Cameras.** `npm run bridge -- --source presage --list-cameras` exits 0 and lists at least one
   camera. Without the SDK it must exit 2 quoting `npm run install:presage`.
2. **Banner and key.** With `PRESAGE_API_KEY` set, `npm run bridge -- --source presage` prints
   `source=presage (MEASURED sensor values)` and then idle status lines; nothing opens the camera
   yet. Without the key it must exit 2 naming `PRESAGE_API_KEY`. Then run one throwaway kiosk
   session **before the first participant**: a wrong key, an exhausted balance or a blocked
   network shows up only now, as `SmartSpectra error 2 (authentication failed)` / `4 (credits
   exhausted)` / `5 (network error)` in the bridge log and on the kiosk card.
3. **Kiosk session.** Start a check-in with camera consent. Expected in the bridge log within a few
   seconds: `source status warming → collecting: face found; collecting`; the status line shows
   `pulse=NN(0.xx)` from ~12 s and `breathing=NN(0.xx)` from ~30 s; the kiosk card's badge reads
   **MEASURED** `presage` and the pulse appears when the gate opens. Note the first
   `camera: <hint>` lines (these are the vendor's validation hints; the flags on the samples come
   from the codes, not the words) and whether an HRV value appears after 60 s (`hrvRmssdMs` on
   the samples, `HRV_RMSSD` in the VS draft).
4. **eSource.** `GET /api/v1/checkins/<session id>`: every `vitals.samples[]` row has
   `source: "presage"`, `is_measured: true`, `window_s` 12/30/60, the flags you saw; `vitals.status`
   is `ok`; the VS drafts carry `VSMETHOD = "Contactless optical, camera-based"` and
   `INTERIM_SOURCE = "presage"`. Nothing should say "simulated".
5. **Loss and corroboration.** Cover the camera for ~10 s: a hint flag appears, after 5 s the
   status drops to `warming` ("timing gates reset"), uncover it: `collecting` again and the pulse
   returns 12 s later. Then do 30 s of jumping jacks, sit down, and complete a check-in with
   shortness of breath "Moderate": the dashboard's Why panel shows the corroboration rule firing
   on **measured** vitals (no "treat simulated as measured" toggle involved), the tier bumps by
   one, the grade does not change. Record OS, SDK version, camera and the HRV field name in
   `docs/ISSUES.md` #14.

Reminder from the vendor disclaimer: the Node SDK metrics are for general wellness and
informational use; Interim never claims FDA clearance and the UI footer says so.

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
| `face_not_found`          | mock, presage (`kNoFaceFound` = 1) | No face in frame; optical metrics unavailable this second. |
| `low_light`               | mock, presage (`kTooDark` = 5)     | Illumination too low for a reliable optical signal.        |
| `motion`                  | mock, presage (`kExcessiveMotion` = 12) | Subject or camera movement degrading the signal.      |
| `talking`                 | mock only | Speech detected; breathing estimate degraded. The Presage source does not produce it: the SDK reports talking as a `faceMetrics` metric (`MetricType.TALKING`) that the bridge does not request; "do not talk" stays a capture condition. |
| `no_finger`               | arduino  | Contact sensor sees no finger.                                  |
| `malformed_line`          | arduino  | A serial line could not be parsed (dropped).                    |
| `multiple_faces`, `face_not_centered`, `face_size_out_of_range`, `too_bright`, `chest_not_visible`, `camera_tuning`, `frame_rate_too_low`, `face_too_close`, `face_too_far`, `face_too_high`, `face_too_low`, `face_not_forward` | presage | The remaining `ValidationCode` values (2, 3, 4, 6, 7, 10, 11, 13–17), one token each, from the `VALIDATION_CODE_FLAGS` table in `presageMap.ts`. Observational; the kiosk shows them as "signal is weak" only through the confidence, the rules ignore them. |
| `sdk_validation_<code>`   | presage  | A non-zero validation code the table does not know (a newer SDK); accompanied by the hint snake_cased (e.g. `lens_smudged`) when one was given. |
| `unstable_<metric>`       | presage  | The SDK's `stable` flag is false for that metric's average.     |
| `gate_pending_<metric>`   | bridge   | Timing gate for that metric not yet elapsed; value removed.     |
| `low_conf_<metric>`       | bridge   | Confidence below threshold; value kept, hidden in UI, ignored by rules. |

## 8. Where things are

- Contract types: `apps/vitals-bridge/src/sources/types.ts`
- Factory / fail-fast: `apps/vitals-bridge/src/sources/index.ts`
- Mock + scenario table: `apps/vitals-bridge/src/sources/mock.ts`, `scenarios.ts`, `noise.ts`
- Presage source (implemented): `apps/vitals-bridge/src/sources/presage.ts` (SDK lifecycle) and
  `presageMap.ts` (pure mapping); tests `test/presage.test.ts`, `test/presageMap.test.ts`
- Arduino stub: `apps/vitals-bridge/src/sources/arduino.ts`
- Gates: `apps/vitals-bridge/src/gate.ts`
- Bridge README (CLI, WS protocol, HTTP batching): `apps/vitals-bridge/README.md`
- Interface contracts for the whole system: `docs/CONTRACTS.md` §3
