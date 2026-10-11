#!/usr/bin/env node
/**
 * Interim vitals bridge CLI (CLAUDE.md §7.5, docs/CONTRACTS.md §3.4).
 *
 *   npm run bridge -- --source mock --scenario resting --api http://localhost:8000 --ws-port 8787
 *
 * Lifecycle:
 *   parse args → build the source (fail fast with exit 2 for the arduino stub or an unknown name)
 *   → preflight a real source (exit 2 when the Presage SDK is not installed or PRESAGE_API_KEY is
 *   unset; all of this BEFORE any port is opened) → optional --list-cameras → open the WebSocket
 *   server → idle
 *   until the kiosk sends {type:"start"} (or --session <id> starts immediately) → print one status
 *   line every 5 s → SIGINT/SIGTERM: stop the session (flushes the API buffer with a short
 *   timeout, bounded by SHUTDOWN_DEADLINE_MS overall), close the server, exit 0. A second signal
 *   exits immediately with code 130 without flushing.
 */
import process from 'node:process';
import { ApiClient } from './api.js';
import { ConfigError, parseArgs, USAGE, type BridgeConfig } from './config.js';
import { withDeadline } from './deadline.js';
import { createLogger } from './log.js';
import { BridgeSession } from './session.js';
import { createSource, UnknownSourceError } from './sources/index.js';
import {
  hasPreflight,
  NotImplementedError,
  SourceUnavailableError,
  type VitalsSource,
} from './sources/types.js';
import { formatStatusLine } from './status_line.js';
import { BRIDGE_VERSION } from './version.js';
import { BridgeWsServer } from './ws.js';

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_SOURCE_UNAVAILABLE = 2;

const STATUS_LINE_INTERVAL_MS = 5_000;
/**
 * Longest a Ctrl-C waits for the final flush. The flush itself is bounded at ~3.25 s with the API
 * down (two 1.5 s attempts + 250 ms); this covers the rarer case of a periodic POST that was
 * already mid-retry with the 5 s steady-state timeout when the signal arrived.
 */
export const SHUTDOWN_DEADLINE_MS = 5_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let cfg: BridgeConfig;
  try {
    cfg = parseArgs(argv, env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[bridge] ERROR ${err.message}\n\n${USAGE}`);
      return EXIT_SOURCE_UNAVAILABLE;
    }
    throw err;
  }
  if (cfg.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (cfg.version) {
    console.log(BRIDGE_VERSION);
    return EXIT_OK;
  }

  const log = createLogger();

  // 1. Source. Stubs and unknown names stop us here, before any socket exists.
  let source: VitalsSource;
  try {
    source = createSource(cfg.source, { presage: { log } });
  } catch (err) {
    if (err instanceof NotImplementedError || err instanceof UnknownSourceError) {
      log.error(err.message);
      return EXIT_SOURCE_UNAVAILABLE;
    }
    throw err;
  }

  // 1b. Preflight. A real source verifies its SDK / key / device now, so a laptop without the
  // Presage SDK exits with the install command instead of failing at the first check-in.
  if (hasPreflight(source)) {
    try {
      await source.preflight({ forListCameras: cfg.listCameras });
    } catch (err) {
      if (err instanceof SourceUnavailableError) {
        log.error(err.message);
        return EXIT_SOURCE_UNAVAILABLE;
      }
      throw err;
    }
  }

  // 2. --list-cameras: only sources that implement listCameras can answer.
  if (cfg.listCameras) {
    if (!source.listCameras) {
      log.error(`source "${source.name}" does not implement listCameras`);
      return EXIT_FATAL;
    }
    let cameras: { id: string; label: string }[];
    try {
      cameras = await source.listCameras();
    } catch (err) {
      if (err instanceof SourceUnavailableError) {
        log.error(err.message);
        return EXIT_SOURCE_UNAVAILABLE;
      }
      throw err;
    }
    if (cameras.length === 0) console.log('(no cameras found)');
    for (const cam of cameras) console.log(`${cam.id}\t${cam.label}`);
    return EXIT_OK;
  }

  // 3. Wire source → session → ws + api.
  const api = new ApiClient({ apiBase: cfg.apiBase, token: cfg.token, log });
  const session = new BridgeSession({
    source,
    api,
    // A pinned --min-conf beats the API; otherwise settings/public.min_confidence is adopted on
    // start. Timing gates are never pinned from the CLI: the rules tables own them.
    ...(cfg.minConfExplicit ? { minConf: cfg.minConf } : {}),
    defaultScenario: source.name === 'mock' ? cfg.scenario : null,
    log,
    version: BRIDGE_VERSION,
  });
  const server = new BridgeWsServer(
    {
      hello: () => session.hello(),
      status: () => session.status(),
      start: (id, scenario) => session.start(id, scenario),
      stop: () => session.stop(),
      setScenario: (scenario) => session.setScenario(scenario),
    },
    log,
    { allowedOrigins: cfg.allowedOrigins },
  );
  session.attachSink(server);

  let port: number;
  try {
    port = await server.listen(cfg.wsPort, cfg.wsHost);
  } catch (err) {
    log.error(
      `cannot listen on ws://${cfg.wsHost}:${cfg.wsPort}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT_FATAL;
  }

  const { minConf, gates } = session.thresholds;
  log.info(`interim-vitals-bridge v${BRIDGE_VERSION}`);
  log.info(
    `source=${source.name} (${source.isMeasured ? 'MEASURED sensor values' : 'SIMULATED values, isMeasured=false'})` +
      (source.name === 'mock' ? ` scenario=${cfg.scenario}` : ''),
  );
  if (source.name === 'presage') {
    log.info(
      'presage: SDK loaded and PRESAGE_API_KEY set; the camera opens when the kiosk starts a session. ' +
        'Capture conditions: face and upper chest visible, well lit, still, not talking.',
    );
  }
  log.info(
    `ws://${cfg.wsHost}:${port}  api=${cfg.apiBase}  token=${cfg.token ? 'set' : 'none'}  ` +
      `origins=${cfg.allowedOrigins.length > 0 ? cfg.allowedOrigins.join(',') : 'any'}  ` +
      `min_conf=${minConf}${cfg.minConfExplicit ? ' (pinned)' : ' (API value adopted on start)'}  ` +
      `gates pulse=${gates.pulseS}s breathing=${gates.breathingS}s hrv=${gates.hrvS}s (API value adopted on start)`,
  );
  if (LOOPBACK_HOSTS.has(cfg.wsHost)) {
    log.info(
      'bound to loopback: only a browser on this machine can reach the bridge; pass --ws-host 0.0.0.0 (or BRIDGE_WS_HOST) for Docker or a kiosk on another device',
    );
  }
  if (cfg.session) {
    log.info(`--session given: starting capture for ${cfg.session} now`);
    await session.start(cfg.session);
  } else {
    log.info('idle: waiting for {type:"start"} from the kiosk (or pass --session <id>)');
  }

  // 4. Heartbeat line, then block until a signal asks us to stop.
  const statusTimer = setInterval(() => {
    console.log(formatStatusLine(session.snapshot()));
  }, STATUS_LINE_INTERVAL_MS);

  return new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) {
        log.warn(`${signal} received again; exiting without flushing`);
        resolve(130);
        return;
      }
      shuttingDown = true;
      clearInterval(statusTimer);
      log.info(
        `${signal} received: stopping session, flushing API buffer (up to ${SHUTDOWN_DEADLINE_MS / 1000} s), closing WebSocket; press again to exit at once`,
      );
      void (async () => {
        try {
          const stopped = await withDeadline(session.stop(), SHUTDOWN_DEADLINE_MS);
          if (stopped.timedOut) {
            log.warn(
              `final flush did not finish within ${SHUTDOWN_DEADLINE_MS / 1000} s (API unreachable?); exiting without it. Unposted samples of this session are lost.`,
            );
          }
          await server.close();
          log.info('bye');
          resolve(EXIT_OK);
        } catch (err) {
          log.error(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
          resolve(EXIT_FATAL);
        }
      })();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

main(process.argv.slice(2), process.env)
  .then((code) => {
    process.exitCode = code;
    // Let stdio drain naturally; if something unexpected keeps the loop alive, leave anyway.
    setTimeout(() => process.exit(code), 1_500).unref();
  })
  .catch((err: unknown) => {
    console.error(
      `[bridge] ERROR fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    process.exitCode = EXIT_FATAL;
  });
