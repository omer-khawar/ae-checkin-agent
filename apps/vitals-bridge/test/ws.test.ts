import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ApiClient, type FetchLike } from '../src/api.js';
import { silentLogger } from '../src/log.js';
import { BridgeSession } from '../src/session.js';
import { MockVitalsSource } from '../src/sources/mock.js';
import {
  BridgeWsServer,
  DEFAULT_WS_HOST,
  MAX_PAYLOAD_BYTES,
  originAllowed,
  parseWebMessage,
  type BridgeToWeb,
  type WsHandlers,
} from '../src/ws.js';

/** Collects every message from a client socket and lets tests wait for one matching a predicate. */
class Inbox {
  readonly messages: BridgeToWeb[] = [];
  private waiters: Array<{ pred: (m: BridgeToWeb) => boolean; resolve: (m: BridgeToWeb) => void }> =
    [];

  constructor(socket: WebSocket) {
    socket.on('message', (raw) => {
      const msg = JSON.parse((raw as Buffer).toString('utf8')) as BridgeToWeb;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }

  /** Resolve with the first message (past or future) matching `pred`. */
  next<T extends BridgeToWeb>(pred: (m: BridgeToWeb) => m is T, timeoutMs?: number): Promise<T>;
  next(pred: (m: BridgeToWeb) => boolean, timeoutMs?: number): Promise<BridgeToWeb>;
  next(pred: (m: BridgeToWeb) => boolean, timeoutMs = 5000): Promise<BridgeToWeb> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`timed out waiting for a message; got ${JSON.stringify(this.messages)}`),
          ),
        timeoutMs,
      );
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Forget everything received so far (so `next` only sees future messages). */
  clear(): void {
    this.messages.length = 0;
  }
}

const okFetch: FetchLike = () =>
  Promise.resolve(new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));

describe('parseWebMessage', () => {
  it('accepts the four client messages', () => {
    expect(parseWebMessage('{"type":"start","sessionId":"01ABC"}')).toEqual({
      ok: true,
      message: { type: 'start', sessionId: '01ABC' },
    });
    expect(parseWebMessage('{"type":"start","sessionId":"x","scenario":"resting"}')).toEqual({
      ok: true,
      message: { type: 'start', sessionId: 'x', scenario: 'resting' },
    });
    expect(parseWebMessage('{"type":"stop"}')).toEqual({ ok: true, message: { type: 'stop' } });
    expect(parseWebMessage('{"type":"set_scenario","scenario":"dropout"}')).toEqual({
      ok: true,
      message: { type: 'set_scenario', scenario: 'dropout' },
    });
    expect(parseWebMessage('{"type":"ping"}')).toEqual({ ok: true, message: { type: 'ping' } });
  });

  it('rejects malformed input with a reason', () => {
    expect(parseWebMessage('nope').ok).toBe(false);
    expect(parseWebMessage('[1]').ok).toBe(false);
    expect(parseWebMessage('{"type":"start"}').ok).toBe(false);
    expect(parseWebMessage('{"type":"start","sessionId":"has space"}').ok).toBe(false);
    expect(parseWebMessage('{"type":"start","sessionId":"x","scenario":3}').ok).toBe(false);
    expect(parseWebMessage('{"type":"set_scenario"}').ok).toBe(false);
    const unknown = parseWebMessage('{"type":"dance"}');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/unknown message type "dance"/);
  });
});

describe('BridgeWsServer protocol (real sockets on an ephemeral port)', () => {
  let server: BridgeWsServer;
  let session: BridgeSession;
  let source: MockVitalsSource;
  let api: ApiClient;
  let port: number;
  let client: WebSocket;
  let inbox: Inbox;

  beforeEach(async () => {
    source = new MockVitalsSource({ intervalMs: 20, seed: 7 });
    api = new ApiClient({
      apiBase: 'http://api.test',
      fetchImpl: okFetch,
      log: silentLogger,
      flushIntervalMs: 60_000,
    });
    session = new BridgeSession({
      source,
      api,
      defaultScenario: 'resting',
      log: silentLogger,
      version: '9.9.9-test',
    });
    server = new BridgeWsServer(
      {
        hello: () => session.hello(),
        status: () => session.status(),
        start: (id, sc) => session.start(id, sc),
        stop: () => session.stop(),
        setScenario: (sc) => session.setScenario(sc),
      },
      silentLogger,
    );
    session.attachSink(server);
    port = await server.listen(0, '127.0.0.1');
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    inbox = new Inbox(client);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
  });

  afterEach(async () => {
    client.close();
    await session.stop();
    await server.close();
  });

  it('greets with hello (contract fields) followed by the current idle status', async () => {
    const hello = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'hello' }> => m.type === 'hello',
    );
    expect(hello).toEqual({
      type: 'hello',
      source: 'mock',
      isMeasured: false,
      scenario: 'resting',
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
      version: '9.9.9-test',
    });
    const status = await inbox.next((m) => m.type === 'status');
    expect(status).toEqual({ type: 'status', state: 'idle', elapsedS: 0, sessionId: null });
    expect(inbox.messages[0]?.type).toBe('hello');
    expect(inbox.messages[1]?.type).toBe('status');
  });

  it('start → status warming/collecting, gated samples and waveforms tagged with the session; stop → idle', async () => {
    await inbox.next((m) => m.type === 'status');
    inbox.clear();
    client.send(
      JSON.stringify({ type: 'start', sessionId: '01TESTSESSION', scenario: 'tachypnea' }),
    );

    const warming = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'status' }> =>
        m.type === 'status' && m.state === 'warming',
    );
    expect(warming.sessionId).toBe('01TESTSESSION');
    const collecting = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'status' }> =>
        m.type === 'status' && m.state === 'collecting',
    );
    expect(collecting.sessionId).toBe('01TESTSESSION');

    const sample = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'sample' }> => m.type === 'sample',
    );
    expect(sample.sessionId).toBe('01TESTSESSION');
    expect(sample.sample.source).toBe('mock');
    expect(sample.sample.isMeasured).toBe(false);
    // Wall-clock elapsed is far below 12 s here, so every metric is gate-pending and unpublished.
    expect(sample.published).toEqual({ pulse: false, breathing: false, hrv: false });
    expect(sample.sample.qualityFlags).toEqual(
      expect.arrayContaining(['gate_pending_pulse', 'gate_pending_breathing', 'gate_pending_hrv']),
    );
    expect(sample.sample.pulseBpm).toBeUndefined();
    expect(sample.elapsedS).toBe(0);

    const wave = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'waveform' }> => m.type === 'waveform',
    );
    expect(wave.values).toHaveLength(25);
    expect(wave.tsUtc).toMatch(/Z$/);

    expect(session.activeSessionId).toBe('01TESTSESSION');
    expect(source.scenario).toBe('tachypnea');
    expect(api.activeSessionId).toBe('01TESTSESSION');

    inbox.clear();
    client.send(JSON.stringify({ type: 'stop' }));
    const idle = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'status' }> =>
        m.type === 'status' && m.state === 'idle' && m.sessionId === null,
    );
    expect(idle.elapsedS).toBe(0);
    expect(session.activeSessionId).toBeNull();
    expect(api.activeSessionId).toBeNull();
    expect(api.stats.posted).toBeGreaterThan(0); // stop flushed the buffer
  });

  it('ping is answered with a status message', async () => {
    await inbox.next((m) => m.type === 'status');
    inbox.clear();
    client.send(JSON.stringify({ type: 'ping' }));
    const status = await inbox.next((m) => m.type === 'status');
    expect(status).toMatchObject({ type: 'status', state: 'idle', sessionId: null });
  });

  it('set_scenario applies on the next start and is acknowledged with a status', async () => {
    await inbox.next((m) => m.type === 'status');
    inbox.clear();
    client.send(JSON.stringify({ type: 'set_scenario', scenario: 'dropout' }));
    await inbox.next((m) => m.type === 'status');
    expect(session.currentScenario()).toBe('dropout');
    client.send(JSON.stringify({ type: 'start', sessionId: 'S2' }));
    await inbox.next((m) => m.type === 'sample');
    expect(source.scenario).toBe('dropout');
  });

  it('answers bad input with an error message instead of dying', async () => {
    await inbox.next((m) => m.type === 'status');
    inbox.clear();
    client.send('this is not json');
    const e1 = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'error' }> => m.type === 'error',
    );
    expect(e1.message).toMatch(/not valid JSON/);
    inbox.clear();
    client.send(JSON.stringify({ type: 'set_scenario', scenario: 'sprinting' }));
    const e2 = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'error' }> => m.type === 'error',
    );
    expect(e2.message).toMatch(/unknown scenario "sprinting"/);
    inbox.clear();
    client.send(JSON.stringify({ type: 'start', sessionId: 'S3', scenario: 'bogus' }));
    // An unknown scenario on start is ignored (logged) and the default is used; capture still starts.
    await inbox.next((m) => m.type === 'sample');
    expect(source.scenario).toBe('resting');
    expect(server.clientCount).toBe(1);
  });

  it('broadcasts to every connected client', async () => {
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox2 = new Inbox(second);
    await new Promise<void>((resolve) => second.once('open', () => resolve()));
    await inbox2.next((m) => m.type === 'hello');
    expect(server.clientCount).toBe(2);
    client.send(JSON.stringify({ type: 'start', sessionId: 'S4' }));
    await inbox.next((m) => m.type === 'sample');
    await inbox2.next((m) => m.type === 'sample');
    second.close();
  });

  it('a re-sent start for the running session (client reconnect) does not restart capture', async () => {
    await inbox.next((m) => m.type === 'status');
    client.send(JSON.stringify({ type: 'start', sessionId: 'S5', scenario: 'tachypnea' }));
    await inbox.next((m) => m.type === 'sample');
    const elapsedBefore = source.elapsedS;
    inbox.clear();
    client.send(JSON.stringify({ type: 'start', sessionId: 'S5' }));
    const hello = await inbox.next((m) => m.type === 'hello');
    expect(hello.type).toBe('hello');
    const status = await inbox.next(
      (m): m is Extract<BridgeToWeb, { type: 'status' }> => m.type === 'status',
    );
    expect(status.sessionId).toBe('S5');
    expect(status.state).toBe('collecting');
    await inbox.next((m) => m.type === 'sample');
    expect(source.elapsedS).toBeGreaterThanOrEqual(elapsedBefore); // the mock clock did not restart
    expect(source.scenario).toBe('tachypnea');
  });
});

describe('BridgeWsServer hardening', () => {
  const idleHandlers: WsHandlers = {
    hello: () => ({
      type: 'hello',
      source: 'mock',
      isMeasured: false,
      scenario: null,
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
      version: 't',
    }),
    status: () => ({ type: 'status', state: 'idle', elapsedS: 0, sessionId: null }),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    setScenario: () => undefined,
  };

  function connect(port: number, headers: Record<string, string> = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    return new Promise<{ ws: WebSocket; opened: boolean; code?: number; status?: number }>(
      (resolve) => {
        ws.once('open', () => resolve({ ws, opened: true }));
        ws.once('unexpected-response', (_req, res) => {
          resolve({ ws, opened: false, status: res.statusCode });
          res.resume();
        });
        ws.once('error', () => resolve({ ws, opened: false }));
      },
    );
  }

  it('defaults to loopback and a 16 KiB frame cap', () => {
    expect(DEFAULT_WS_HOST).toBe('127.0.0.1');
    expect(MAX_PAYLOAD_BYTES).toBe(16 * 1024);
  });

  it('closes a client that sends an oversize frame with 1009 instead of parsing it', async () => {
    const server = new BridgeWsServer(idleHandlers, silentLogger, { maxPayload: 1024 });
    const port = await server.listen(0, '127.0.0.1');
    try {
      const { ws } = await connect(port);
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      ws.send('x'.repeat(2048));
      expect(await closed).toBe(1009);
    } finally {
      await server.close();
    }
  });

  it('originAllowed: empty list or no header → allowed; otherwise exact (normalised) match', () => {
    expect(originAllowed(undefined, [])).toBe(true);
    expect(originAllowed('http://evil.example', [])).toBe(true);
    expect(originAllowed(undefined, ['http://localhost:5173'])).toBe(true);
    expect(originAllowed('http://localhost:5173', ['http://localhost:5173'])).toBe(true);
    expect(originAllowed('HTTP://LOCALHOST:5173/', ['http://localhost:5173'])).toBe(true);
    expect(originAllowed('http://evil.example', ['http://localhost:5173'])).toBe(false);
  });

  it('rejects the upgrade (401) for a browser origin outside the allow-list, accepts listed and header-less clients', async () => {
    const server = new BridgeWsServer(idleHandlers, silentLogger, {
      allowedOrigins: ['http://localhost:5173'],
    });
    const port = await server.listen(0, '127.0.0.1');
    try {
      const bad = await connect(port, { origin: 'http://evil.example' });
      expect(bad.opened).toBe(false);
      expect(bad.status).toBe(401);

      const good = await connect(port, { origin: 'http://localhost:5173' });
      expect(good.opened).toBe(true);
      good.ws.close();

      const tool = await connect(port);
      expect(tool.opened).toBe(true);
      tool.ws.close();
    } finally {
      await server.close();
    }
  });
});
