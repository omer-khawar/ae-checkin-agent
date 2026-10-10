# Interim vitals bridge (`apps/vitals-bridge`)

The bridge is the small Node service that runs on the kiosk laptop (where the webcam is). It
turns a pluggable **vitals source** into two streams:

- a live WebSocket feed for the kiosk's vitals panel (`ws://<host>:8787`), and
- batched `VitalsSample` POSTs to the Interim API, which stores them as eSource with full
  provenance (`POST /api/v1/sessions/{id}/vitals` every 2 s).

Today the only working source is the **mock** (scenario-driven synthetic signals, every sample
labelled `isMeasured: false` / **SIMULATED**). The **Presage SmartSpectra** and **Arduino**
sources are documented stubs that fail fast; implementing Presage is a one-file job described in
[`docs/VITALS_SOURCES.md`](../../docs/VITALS_SOURCES.md).

> Interim is a research data-capture tool. It is not a medical device and does not provide
> medical advice. The bridge never stores camera frames; only derived metrics (pulse, breathing,
> HRV, confidence, quality flags) ever leave it.

## Quickstart

```bash
cd apps/vitals-bridge
npm install
npm run bridge -- --source mock --scenario resting --api http://localhost:8000 --ws-port 8787
```

The bridge then waits for the kiosk to send `{"type":"start","sessionId":"..."}` over the
WebSocket. For a headless check (no kiosk, no API) start a session straight away:

```bash
npm run bridge -- --source mock --scenario post_exercise --api http://127.0.0.1:9 --session demo
```

With the API unreachable the bridge keeps running, retries each batch once, keeps up to 120
samples buffered, and says so politely in the log. Stop it with Ctrl-C: the session is stopped,
the buffer flushed, the socket closed, exit code 0. The final flush uses a short timeout, so with
the API down Ctrl-C returns in about 3 s (never more than 5 s); the unposted samples of that
session are then reported and lost. A second Ctrl-C exits immediately with code 130 and skips
the flush.

Other entry points: `--list-cameras` (sources that implement `listCameras`), `--help`,
`--version`. From the repo root `make bridge` / `npm run bridge` call the same command.

### Options

Precedence: flag > environment variable > default. The bridge reads no `.env` file itself.

| Flag                               | Env               | Default                 | Meaning                                                   |
| ---------------------------------- | ----------------- | ----------------------- | --------------------------------------------------------- |
| `--source mock\|presage\|arduino`  | `VITALS_SOURCE`   | `mock`                  | Which plugin to run. Stubs exit with code 2.              |
| `--scenario <name>`                | `VITALS_SCENARIO` | `resting`               | Mock scenario (see below). Ignored by other sources.      |
| `--api <url>`                      | `BRIDGE_API_URL`  | `http://localhost:8000` | Interim API base URL.                                     |
| `--ws-port <port>`                 | `BRIDGE_WS_PORT`  | `8787`                  | WebSocket port for the kiosk (0 = ephemeral).             |
| `--ws-host <host>`                 | `BRIDGE_WS_HOST`  | `127.0.0.1`             | Bind address. Loopback by default; `0.0.0.0` for Docker or a kiosk on another device. |
| `--min-conf <0..1>`                | `VITALS_MIN_CONF` | adopted from API        | Confidence threshold for `low_conf_*` flags. Unset = adopt `settings/public.min_confidence` on start (built-in fallback 0.6); set = pinned. |
| `--token <secret>`                 | `BRIDGE_TOKEN`    | none                    | Sent as `X-Bridge-Token` on every POST.                   |
| `--allowed-origins <a,b>`          | `BRIDGE_ALLOWED_ORIGINS` | any              | Browser `Origin`s allowed to open the WebSocket (comma-separated). |
| `--session <id>`                   | —                 | —                       | Start capturing for this session immediately (dev/CI).    |
| `--list-cameras`                   | —                 | —                       | Print the source's cameras and exit.                      |

Exit codes: `0` ok, `1` fatal (port in use, unsupported `--list-cameras`), `2` source unavailable
(presage/arduino stubs, unknown source, bad options).

The timing gates (pulse 12 s, breathing 30 s, HRV 60 s) have no flag: they belong to the rules
tables and are adopted from `GET /api/v1/settings/public.timing_gates` on every start, with the
built-in values as the offline fallback. Leave `VITALS_MIN_CONF` unset in `.env` unless you mean
to override the rules engine's threshold on purpose; a pinned value is marked `(pinned)` in the
startup banner.

### Mock scenarios

Parameters and the rationale for every number live in
[`src/sources/scenarios.ts`](src/sources/scenarios.ts) (a typed data table, not code).

| Scenario        | What it simulates                                                        | What it demonstrates                                                         |
| --------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `resting`       | pulse ~72±3, breathing ~14±1, confidence ramps 0.3→0.95 over 15 s        | The demo baseline. No corroboration rule can fire.                           |
| `post_exercise` | pulse 128→90, breathing 27→18 over ~90 s (the "jumping jacks" demo)      | Tachycardia + tachypnea corroboration → tier +1; the grade does not change.  |
| `tachypnea`     | pulse ~98, breathing ~26, confidence 0.9 from the first second           | Exactly one corroboration rule (breathing ≥ 24) and the +1 cap.              |
| `low_quality`   | confidence < 0.5 throughout; `face_not_found` / `low_light` intermittent | `low_conf_*` flags → UI hides values, rules ignore them, status low_quality. |
| `dropout`       | good for 20 s, source `error` for 10 s, then recovery                    | An error status resets the timing gates; pulse reappears 12 s after recovery. |

Signals are deterministic for a given seed (default: a hash of the scenario name), use
autocorrelated AR(1) noise (physiological drift, not white noise), and come with a synthetic
pleth waveform (25 points per second) for the kiosk sparkline.

## How it fits together

```
 VitalsSource plugin ──samples/status──▶ gate.ts ──▶ BridgeSession ──┬──▶ ws.ts   ──▶ kiosk panel (live)
 (mock | presage | arduino)             (12/30/60 s,                 └──▶ api.ts  ──▶ POST /sessions/{id}/vitals (2 s batches)
                                         min confidence)
```

- `src/sources/types.ts` — the plugin contract, verbatim from CLAUDE.md §7.1.
- `src/sources/mock.ts`, `scenarios.ts`, `noise.ts` — the mock source and its data table.
- `src/sources/presage.ts`, `arduino.ts` — documented stubs; `index.ts` is the factory.
- `src/gate.ts` — timing gates + confidence flags (pure functions).
- `src/session.ts` — orchestration: idle until `start`, stop flushes.
- `src/ws.ts` — WebSocket protocol; `src/api.ts` — batching, retry, bounded buffer.
- `src/config.ts`, `src/cli.ts`, `src/status_line.ts`, `src/deadline.ts` — CLI and its bounded shutdown.
- `Dockerfile`, `.dockerignore` — the mock-only image compose uses (see [Docker](#docker)).

### Gating (enforced here, for every source)

A metric is emitted only after N seconds of **continuous** `collecting` status: pulse 12 s,
breathing 30 s, HRV 60 s (the Presage averaging windows). Before that the metric and its
confidence are removed from the sample and `gate_pending_<metric>` is added to `qualityFlags`.
Any status other than `collecting` resets the clock. A metric whose confidence is below the
threshold is **kept** (the raw series is never thinned) but flagged `low_conf_<metric>`; the UI
hides it and the rules engine ignores it with a logged reason. `published.<metric>` in the WS
sample message is `true` only when the gate has elapsed, the value is present, and the confidence
meets the threshold — i.e. "safe to show".

### WebSocket protocol (`docs/CONTRACTS.md` §3.3)

Bridge → web: on connect a client gets `hello` then the current `status`.

```ts
{ type: "hello", source, isMeasured, scenario: string|null, minConf, gates: { pulseS, breathingS, hrvS }, version }
{ type: "status", state: "idle"|"warming"|"collecting"|"error", message?, elapsedS, sessionId }
{ type: "sample", sample: VitalsSample, published: { pulse, breathing, hrv }, elapsedS, sessionId }
{ type: "waveform", values: number[], tsUtc }
{ type: "error", message }
```

Web → bridge:

```ts
{ type: "start", sessionId, scenario? }   // begin capture + batching; scenario (mock) overrides everything
{ type: "stop" }                           // stop capture, flush the buffer, back to idle
{ type: "set_scenario", scenario }         // mock only; applies to the next start; acknowledged with a status
{ type: "ping" }                           // answered with the current status (liveness check)
```

What `start` does, in order: (1) if the session id is the one already running, nothing — the
web client re-sends `start` on every socket (re)open, so a transient WebSocket drop must not
restart the source, reset the timing gates or re-run the mock curve; the bridge logs
"re-attaching", re-sends `hello` + `status`, and ignores any scenario on the re-sent message.
(2) Otherwise the session id is claimed and `{state: "warming", sessionId}` is broadcast
**before** any network round-trip, so the kiosk sees its session within milliseconds and a
`stop` that arrives while the API is slow still wins (the stale start aborts). (3) The bridge
GETs `/api/v1/settings/public` (1.5 s timeout) and adopts `min_confidence` / `timing_gates`
unless pinned, re-announcing `hello` when they changed. (4) The source starts.

Scenario precedence on `start` (mock only): the `start` message → a queued `set_scenario` →
`mock_scenario` from the API settings (the admin panel) → the CLI/env default. Each candidate is
validated; an unknown name is logged and the next one is used, so a typo can never stop a
check-in. If the API's `vitals_source` differs from the running source the bridge logs a
warning: switching sources requires a restart (there is no hot-swap; see `docs/DECISIONS.md`).

### HTTP to the API (`docs/CONTRACTS.md` §3.2)

Every 2 s while a session is active: `POST {api}/api/v1/sessions/{sessionId}/vitals` with
`{"samples": [VitalsSample, ...]}` in camelCase exactly as the contract, plus `X-Bridge-Token`
when configured and an `X-Bridge-Batch-Id` ULID.

- **Retryable failure** (5xx, 408, 429, 401/403, network error, timeout): the batch is retried
  once after 250 ms, then kept at the front of a bounded buffer (120 samples, oldest dropped) for
  the next flush. The log says so once, then every fifth failure.
- **Terminal rejection** (400, 404, 413, 415, 422): re-sending the same bytes cannot succeed (the
  session was reset by `POST /admin/reset`, or the payload is malformed), so the batch is dropped
  after one attempt with a single WARN quoting the status and the API's body. Counted in
  `stats.rejected`. This narrows the contract's "retry once, then keep buffering" to the errors
  where buffering can help; logged in `docs/DECISIONS.md`.
- **`stop`** delivers everything: it waits for a POST that is in flight, then flushes again until
  the buffer is empty or a flush fails, so the last 1-2 s of eSource that arrived during that POST
  are never silently lost while the API is healthy. The final flush uses a 1.5 s per-request
  timeout (one retry), matching the kiosk's 2.5 s post-flush wait. Only what a failed flush left
  behind is discarded, with the real reason in the log (the bridge is stateless beyond the
  current session; the API flags the check-in's vitals as unavailable/partial).
- A batch that fails after its session ended (another session started while it was in flight) is
  dropped, never requeued into the new session's buffer.

### Status line

One line every 5 s, format pinned by the contract:

```
[bridge] source=mock scenario=resting state=collecting session=01J... elapsed=42s pulse=72(0.93) breathing=14(0.88) buffered=3 posted=40
```

`pulse` / `breathing` show `-` whenever the source is not `collecting` (warming, error, idle):
the gates have reset and the kiosk shows no value, so the terminal does not keep quoting a stale
one either.

## Docker

`Dockerfile` builds a small **mock-only** image (multi-stage: `npm ci` + `tsc`, then `dist/` with
production `node_modules` on `node:20-alpine`, running as the unprivileged `node` user). It sets
`BRIDGE_WS_HOST=0.0.0.0`, `BRIDGE_API_URL=http://api:8000` and `VITALS_SOURCE=mock`, so in
compose it needs only a service entry and a published port:

```yaml
bridge:
  build: ./apps/vitals-bridge
  init: true # Node is PID 1; let tini reap, Node handles SIGTERM (graceful stop + flush)
  ports:
    - "8787:8787" # the kiosk browser connects to ws://<docker host>:8787 directly
  environment:
    BRIDGE_TOKEN: ${BRIDGE_TOKEN:-}
    VITALS_SCENARIO: ${VITALS_SCENARIO:-resting}
  depends_on: [api]
```

Two things to know:

- The web app does **not** proxy the WebSocket (nginx only proxies `/api/`); the browser opens
  `ws://<hostname of the page>:8787` (or `VITE_BRIDGE_WS_URL`). The published port is therefore
  required, and the hostname the kiosk page is opened on must reach the Docker host.
- A container has no webcam and the Presage SDK is not a dependency, so the image can only run
  the mock. Real sensors run the bridge on the kiosk laptop (`npm run bridge`), pointed at the
  API with `--api`. `--source presage` inside the container exits with code 2 like anywhere else.

Build and run it by hand: `docker build -t interim-bridge apps/vitals-bridge` then
`docker run --rm -p 8787:8787 -e BRIDGE_API_URL=http://host.docker.internal:8000 interim-bridge`.

## Security notes

The WebSocket control channel (`start` / `stop` / `set_scenario`) carries no authentication: a
client that reaches it can stop a check-in's capture. The defaults keep it unreachable from
anyone but the kiosk's own browser; relax them deliberately.

- **Loopback bind by default** (`--ws-host 127.0.0.1`). Set `0.0.0.0` only for Docker or when
  the kiosk page runs on another device, and then on a network you trust.
- **16 KiB frame cap** (`ws` defaults to 100 MiB). The largest legitimate client message is a
  `start` with a 128-character session id; an oversize frame closes the socket with code 1009
  before anything is parsed.
- **Optional Origin allow-list** (`--allowed-origins http://localhost:5173,http://kiosk.local`).
  Rejects the upgrade (HTTP 401) for a browser page that is not the kiosk app, which closes the
  "any website open in the kiosk browser can talk to `ws://localhost:8787`" hole. Clients without
  an `Origin` header (non-browser tools, the tests) are unaffected. Off by default so a cold-start
  demo on an unknown port still works.
- **`X-Bridge-Token`** authenticates the bridge *to the API* (`BRIDGE_TOKEN`), not the kiosk to
  the bridge. A shared kiosk→bridge token is the obvious next step and is listed in
  `docs/NOT_BUILT.md` territory, not here.
- The bridge never stores camera frames and never logs the bridge token.

## Adding a source

1. Create `src/sources/<name>.ts` exporting a class that `implements VitalsSource` (and
   optionally `WaveformCapable`). Emit one `VitalsSample` per second with `source: "<name>"`,
   `isMeasured: true` for a real sensor, confidences passed through unchanged, and `qualityFlags`
   from the vocabulary in `docs/VITALS_SOURCES.md`. Report `warming` → `collecting` → (`error`) →
   `idle` through `onStatus`.
2. Add the name to the `source` union in `types.ts` only if it is genuinely new (the contract
   allows `mock | presage | arduino`; a new name is a contract change logged in
   `docs/DECISIONS.md` and mirrored in the API's Pydantic model and the web types).
3. Register it in `src/sources/index.ts`. If it is a stub, implement `StubMarker` so the factory
   refuses it with a clear message.
4. Do not apply timing gates or confidence thresholds inside the source; `gate.ts` does that for
   everyone.
5. Add `test/<name>.test.ts` with a fake SDK/port injected through the constructor.

## Development

```bash
npm run lint        # eslint (type-checked rules)
npm run typecheck   # tsc --noEmit (src + tests)
npm test            # vitest (unit + real-socket protocol tests + CLI spawn tests)
npm run build       # tsc -> dist/ ; then: npm start -- --source mock
npm run format      # prettier
```

Tests cover: physiological ranges and smoothness of every mock scenario (lag-1 autocorrelation,
bounded second-to-second steps), the confidence ramp, dropout error/recovery, every gate and flag
in `gate.ts`, API batching with a scripted `fetch` (retry-once, bounded buffer, token header,
tolerant settings fetch, the stop-during-POST race, terminal 4xx handling, the bounded final
flush, no cross-session requeue), the WebSocket protocol on an ephemeral port (including the
frame cap and the Origin allow-list), scenario precedence, start idempotence on reconnect,
stop-during-start, threshold adoption from the API and the status-line reset in the session,
CLI argument parsing, the shutdown deadline helper, and the fail-fast exit code 2 for `presage` /
`arduino` by spawning the real CLI.
