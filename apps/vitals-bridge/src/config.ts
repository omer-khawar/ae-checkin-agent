/**
 * CLI argument parsing with environment fallbacks (docs/CONTRACTS.md §3.4).
 *
 *   npm run bridge -- --source mock --scenario resting --api http://localhost:8000 --ws-port 8787
 *                     [--list-cameras] [--min-conf 0.6] [--token ...] [--session <id>]
 *
 * Precedence: explicit flag > environment variable > built-in default. The bridge does not read
 * `.env` files itself (no dotenv dependency): `make dev` / docker compose pass the environment.
 *
 * Pure (no process access) so it is unit-testable: pass `process.argv.slice(2)` and `process.env`.
 */
import { isScenarioName, SCENARIO_NAMES } from './sources/scenarios.js';

export interface BridgeConfig {
  source: string;
  scenario: string;
  apiBase: string;
  wsPort: number;
  wsHost: string;
  minConf: number;
  /**
   * True when `--min-conf` / `VITALS_MIN_CONF` was given. A pinned threshold beats the API's
   * `settings/public.min_confidence`; otherwise the bridge adopts the API's value on start so the
   * rules tables stay the single source of truth.
   */
  minConfExplicit: boolean;
  token: string | undefined;
  /**
   * Browser origins allowed to open the WebSocket (`--allowed-origins` / `BRIDGE_ALLOWED_ORIGINS`,
   * comma-separated). Empty = any origin. Clients that send no Origin header (non-browser tools,
   * tests) are always accepted; the check only defends against a hostile web page in the kiosk's
   * own browser hijacking the local control channel.
   */
  allowedOrigins: string[];
  listCameras: boolean;
  /** Start capturing for this session id immediately (headless/dev use); null = wait for WS start. */
  session: string | null;
  help: boolean;
  version: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const DEFAULTS = {
  source: 'mock',
  scenario: 'resting',
  apiBase: 'http://localhost:8000',
  wsPort: 8787,
  /**
   * Loopback by default: the control channel (start/stop/set_scenario) is unauthenticated, and
   * the kiosk browser normally runs on the same laptop as the bridge. Docker/LAN deployments set
   * BRIDGE_WS_HOST=0.0.0.0 deliberately (the Dockerfile does).
   */
  wsHost: '127.0.0.1',
  /** Source: CLAUDE.md §7.1 (`VITALS_MIN_CONF=0.6`); the API's settings/public value is adopted unless pinned. */
  minConf: 0.6,
} as const;

export const ENV_VARS = {
  source: 'VITALS_SOURCE',
  scenario: 'VITALS_SCENARIO',
  apiBase: 'BRIDGE_API_URL',
  wsPort: 'BRIDGE_WS_PORT',
  wsHost: 'BRIDGE_WS_HOST',
  minConf: 'VITALS_MIN_CONF',
  token: 'BRIDGE_TOKEN',
  allowedOrigins: 'BRIDGE_ALLOWED_ORIGINS',
} as const;

export const USAGE = `Usage: npm run bridge -- [options]

Options (flag > env var > default):
  --source <mock|presage|arduino>   vitals source            (${ENV_VARS.source}, default ${DEFAULTS.source})
                                    mock = simulated; presage = real camera (MEASURED); arduino = stub
  --scenario <name>                 mock scenario            (${ENV_VARS.scenario}, default ${DEFAULTS.scenario})
                                    one of: ${SCENARIO_NAMES.join(', ')}
  --api <url>                       Interim API base URL     (${ENV_VARS.apiBase}, default ${DEFAULTS.apiBase})
  --ws-port <port>                  WebSocket port for kiosk (${ENV_VARS.wsPort}, default ${DEFAULTS.wsPort})
  --ws-host <host>                  WebSocket bind address   (${ENV_VARS.wsHost}, default ${DEFAULTS.wsHost};
                                    use 0.0.0.0 for Docker or a kiosk on another device)
  --min-conf <0..1>                 confidence threshold     (${ENV_VARS.minConf}; unset = adopt the API's
                                    settings/public.min_confidence, built-in fallback ${DEFAULTS.minConf})
  --token <secret>                  X-Bridge-Token header    (${ENV_VARS.token}, default none)
  --allowed-origins <a,b>           browser Origins allowed on the WebSocket (${ENV_VARS.allowedOrigins}, default any)
  --session <id>                    start capture now for this session id (headless/dev use)
  --list-cameras                    print the cameras the source can see, then exit
  --help, -h                        this text
  --version, -V                     print the bridge version

Presage source: needs the SDK (npm run install:presage) and PRESAGE_API_KEY in the environment;
  optional PRESAGE_CAMERA_ID pins the camera (use an id from --list-cameras; Windows picks the
  first discovered camera when unset).

Exit codes: 0 ok, 1 fatal (e.g. port in use), 2 source unavailable (arduino stub, Presage SDK or
  PRESAGE_API_KEY missing, unknown source).`;

const VALUE_FLAGS = new Set([
  'source',
  'scenario',
  'api',
  'ws-port',
  'ws-host',
  'min-conf',
  'token',
  'allowed-origins',
  'session',
]);

/** Split a comma-separated origin list; blanks dropped, trailing slashes stripped, lower-cased. */
export function parseOriginList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
    .filter((o) => o.length > 0);
}
const BOOLEAN_FLAGS = new Set(['list-cameras', 'help', 'version']);
const SHORT_FLAGS: Record<string, string> = { '-h': 'help', '-V': 'version' };

function pick(flag: string | undefined, envValue: string | undefined, fallback: string): string {
  if (flag !== undefined) return flag;
  if (envValue !== undefined && envValue.trim() !== '') return envValue.trim();
  return fallback;
}

export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): BridgeConfig {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const short = SHORT_FLAGS[arg];
    if (short !== undefined) {
      flags.set(short, true);
      continue;
    }
    if (!arg.startsWith('--')) throw new ConfigError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, true);
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new ConfigError(`unknown option --${key}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) {
      throw new ConfigError(`--${key} needs a value`);
    }
    flags.set(key, value);
  }
  const str = (key: string): string | undefined => {
    const v = flags.get(key);
    return typeof v === 'string' ? v : undefined;
  };

  const source = pick(str('source'), env[ENV_VARS.source], DEFAULTS.source).toLowerCase();
  const scenario = pick(str('scenario'), env[ENV_VARS.scenario], DEFAULTS.scenario);
  if (source === 'mock' && !isScenarioName(scenario)) {
    throw new ConfigError(`unknown scenario "${scenario}" (known: ${SCENARIO_NAMES.join(', ')})`);
  }

  const apiRaw = pick(str('api'), env[ENV_VARS.apiBase], DEFAULTS.apiBase);
  if (!/^https?:\/\/\S+$/.test(apiRaw)) {
    throw new ConfigError(`--api must be an http(s) URL, got "${apiRaw}"`);
  }
  const apiBase = apiRaw.replace(/\/+$/, '');

  const portRaw = pick(str('ws-port'), env[ENV_VARS.wsPort], String(DEFAULTS.wsPort));
  const wsPort = Number(portRaw);
  if (!Number.isInteger(wsPort) || wsPort < 0 || wsPort > 65535) {
    throw new ConfigError(`--ws-port must be an integer 0..65535, got "${portRaw}"`);
  }

  const wsHost = pick(str('ws-host'), env[ENV_VARS.wsHost], DEFAULTS.wsHost);

  const confEnv = env[ENV_VARS.minConf];
  const minConfExplicit =
    str('min-conf') !== undefined || (confEnv !== undefined && confEnv.trim() !== '');
  const confRaw = pick(str('min-conf'), confEnv, String(DEFAULTS.minConf));
  const minConf = Number(confRaw);
  if (!Number.isFinite(minConf) || minConf < 0 || minConf > 1) {
    throw new ConfigError(`--min-conf must be a number in 0..1, got "${confRaw}"`);
  }

  const tokenRaw = pick(str('token'), env[ENV_VARS.token], '');
  const token = tokenRaw === '' ? undefined : tokenRaw;

  const allowedOrigins = parseOriginList(
    pick(str('allowed-origins'), env[ENV_VARS.allowedOrigins], ''),
  );

  const sessionRaw = str('session');
  const session = sessionRaw !== undefined && sessionRaw.trim() !== '' ? sessionRaw.trim() : null;

  return {
    source,
    scenario,
    apiBase,
    wsPort,
    wsHost,
    minConf,
    minConfExplicit,
    token,
    allowedOrigins,
    listCameras: flags.get('list-cameras') === true,
    session,
    help: flags.get('help') === true,
    version: flags.get('version') === true,
  };
}
