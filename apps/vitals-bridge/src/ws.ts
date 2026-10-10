/**
 * WebSocket server for the kiosk's live vitals panel (docs/CONTRACTS.md §3.3).
 *
 * Bridge → web: hello (on connect), status, sample, waveform, error.
 * Web → bridge: start, stop, set_scenario, ping.
 *
 * Design notes:
 *  - The server owns no vitals state; it validates incoming JSON, hands intents to `WsHandlers`
 *    (implemented by BridgeSession) and fans outgoing messages to every client.
 *  - On connect a client receives `hello` followed immediately by the current `status`, so a kiosk
 *    page that reloads mid-session knows where things stand without waiting for the next sample.
 *  - `ping` is answered with the current `status` message: it stays inside the contract's
 *    bridge → web union and doubles as a liveness check for the web client.
 *  - Bad input never crashes the bridge: it is answered with `{type: "error"}` on that socket.
 *
 * Hardening (the control channel is unauthenticated; CLAUDE.md §1 asks for basic security):
 *  - The server binds loopback unless told otherwise (see config.ts DEFAULTS.wsHost).
 *  - Frames are capped at `MAX_PAYLOAD_BYTES` (16 KiB): the largest legitimate client message is
 *    a `start` with a 128-char session id, so ws's 100 MiB default would only let a stranger make
 *    the kiosk JSON.parse a huge buffer. Oversize frames close the socket with code 1009.
 *  - An optional Origin allow-list (`allowedOrigins`) rejects browser pages that are not the
 *    kiosk's own app; clients without an Origin header (non-browser tools) are not affected.
 */
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Published } from './gate.js';
import { type Logger, silentLogger } from './log.js';
import type { SourceName, SourceState, VitalsSample } from './sources/types.js';

// ---- bridge → web ---------------------------------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  source: SourceName;
  isMeasured: boolean;
  scenario: string | null;
  minConf: number;
  gates: { pulseS: number; breathingS: number; hrvS: number };
  version: string;
}

export interface StatusMessage {
  type: 'status';
  state: SourceState;
  message?: string;
  elapsedS: number;
  sessionId: string | null;
}

export interface SampleMessage {
  type: 'sample';
  sample: VitalsSample;
  published: Published;
  elapsedS: number;
  sessionId: string | null;
}

export interface WaveformMessage {
  type: 'waveform';
  values: number[];
  tsUtc: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type BridgeToWeb =
  | HelloMessage
  | StatusMessage
  | SampleMessage
  | WaveformMessage
  | ErrorMessage;

// ---- web → bridge ---------------------------------------------------------------------------

export interface StartMessage {
  type: 'start';
  sessionId: string;
  scenario?: string;
}
export interface StopMessage {
  type: 'stop';
}
export interface SetScenarioMessage {
  type: 'set_scenario';
  scenario: string;
}
export interface PingMessage {
  type: 'ping';
}
export type WebToBridge = StartMessage | StopMessage | SetScenarioMessage | PingMessage;

export type ParseResult = { ok: true; message: WebToBridge } | { ok: false; error: string };

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Validate one incoming frame. Pure; exported for tests. */
export function parseWebMessage(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'message is not valid JSON' };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'message must be a JSON object with a "type" field' };
  }
  const obj = data as Record<string, unknown>;
  switch (obj.type) {
    case 'start': {
      const sessionId = obj.sessionId;
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        return { ok: false, error: 'start requires a sessionId (1-128 chars, [A-Za-z0-9._:-])' };
      }
      if (obj.scenario !== undefined && typeof obj.scenario !== 'string') {
        return { ok: false, error: 'start.scenario must be a string when present' };
      }
      return {
        ok: true,
        message:
          typeof obj.scenario === 'string'
            ? { type: 'start', sessionId, scenario: obj.scenario }
            : { type: 'start', sessionId },
      };
    }
    case 'stop':
      return { ok: true, message: { type: 'stop' } };
    case 'set_scenario':
      if (typeof obj.scenario !== 'string' || obj.scenario.length === 0) {
        return { ok: false, error: 'set_scenario requires a non-empty scenario string' };
      }
      return { ok: true, message: { type: 'set_scenario', scenario: obj.scenario } };
    case 'ping':
      return { ok: true, message: { type: 'ping' } };
    default:
      return {
        ok: false,
        error: `unknown message type ${JSON.stringify(obj.type)} (expected start | stop | set_scenario | ping)`,
      };
  }
}

/** What the server needs from the session layer. */
export interface WsHandlers {
  hello(): HelloMessage;
  status(): StatusMessage;
  start(sessionId: string, scenario?: string): Promise<void>;
  stop(): Promise<void>;
  setScenario(scenario: string): void;
}

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw as ArrayBuffer).toString('utf8');
}

/** Largest frame accepted from a web client. See the module comment. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Bind address when none is given: loopback (config.ts DEFAULTS.wsHost says why). */
export const DEFAULT_WS_HOST = '127.0.0.1';

export interface BridgeWsServerOptions {
  /** Lower-cased origins (scheme://host[:port]) allowed to connect; empty = any. */
  allowedOrigins?: readonly string[];
  /** Override for tests. */
  maxPayload?: number;
}

/** Normalise an Origin header value the way the allow-list is normalised (config.ts). */
function normaliseOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Decide whether a connection with this Origin header may proceed. Pure; exported for tests.
 * No header (non-browser client) → allowed. Empty allow-list → allowed.
 */
export function originAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (allowedOrigins.length === 0 || origin === undefined) return true;
  return allowedOrigins.includes(normaliseOrigin(origin));
}

export class BridgeWsServer {
  private wss: WebSocketServer | null = null;
  private boundPort: number | null = null;
  private readonly allowedOrigins: readonly string[];
  private readonly maxPayload: number;

  constructor(
    private readonly handlers: WsHandlers,
    private readonly log: Logger = silentLogger,
    opts: BridgeWsServerOptions = {},
  ) {
    this.allowedOrigins = opts.allowedOrigins ?? [];
    this.maxPayload = opts.maxPayload ?? MAX_PAYLOAD_BYTES;
  }

  /** Port actually bound (useful when listening on 0). */
  get port(): number | null {
    return this.boundPort;
  }

  get clientCount(): number {
    return this.wss ? this.wss.clients.size : 0;
  }

  /** Start listening; resolves with the bound port. */
  listen(port: number, host: string = DEFAULT_WS_HOST): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port,
        host,
        maxPayload: this.maxPayload,
        verifyClient: (info: { origin: string; req: { socket: { remoteAddress?: string } } }) => {
          // ws passes the Origin header through as-is (undefined when the client sent none).
          const origin: string | undefined = info.origin;
          if (originAllowed(origin, this.allowedOrigins)) return true;
          this.log.warn(
            `rejected web client from ${info.req.socket.remoteAddress ?? '?'}: origin ${JSON.stringify(origin)} is not in the allowed list (${this.allowedOrigins.join(', ')})`,
          );
          return false;
        },
      });
      wss.on('error', (err) => {
        if (this.wss === null) reject(err);
        else this.log.error(`websocket server error: ${err.message}`);
      });
      wss.once('listening', () => {
        this.wss = wss;
        this.boundPort = (wss.address() as AddressInfo).port;
        wss.on('connection', (socket, req) => {
          const remote = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
          this.onConnection(socket, remote);
        });
        resolve(this.boundPort);
      });
    });
  }

  /** Send a message to every connected client. */
  broadcast(msg: BridgeToWeb): void {
    if (!this.wss) return;
    const text = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  }

  /** Close all clients and the listener. */
  close(): Promise<void> {
    const wss = this.wss;
    if (!wss) return Promise.resolve();
    this.wss = null;
    this.boundPort = null;
    for (const client of wss.clients) client.terminate();
    return new Promise((resolve) => {
      wss.close(() => resolve());
    });
  }

  // ---- internals ---------------------------------------------------------------------------

  private onConnection(socket: WebSocket, remote: string): void {
    this.log.info(`web client connected from ${remote} (${this.clientCount} connected)`);
    this.send(socket, this.handlers.hello());
    this.send(socket, this.handlers.status());

    socket.on('message', (raw) => {
      const parsed = parseWebMessage(rawToString(raw));
      if (!parsed.ok) {
        this.send(socket, { type: 'error', message: parsed.error });
        return;
      }
      void this.dispatch(socket, parsed.message);
    });
    socket.on('close', () => {
      this.log.info(`web client ${remote} disconnected (${this.clientCount} connected)`);
    });
    socket.on('error', (err) => {
      this.log.warn(`web client ${remote} socket error: ${err.message}`);
    });
  }

  private async dispatch(socket: WebSocket, msg: WebToBridge): Promise<void> {
    try {
      switch (msg.type) {
        case 'start':
          await this.handlers.start(msg.sessionId, msg.scenario);
          break;
        case 'stop':
          await this.handlers.stop();
          break;
        case 'set_scenario':
          this.handlers.setScenario(msg.scenario);
          this.send(socket, this.handlers.status());
          break;
        case 'ping':
          this.send(socket, this.handlers.status());
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`"${msg.type}" rejected: ${message}`);
      this.send(socket, { type: 'error', message });
    }
  }

  private send(socket: WebSocket, msg: BridgeToWeb): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }
}
