/**
 * WebSocket client for the vitals bridge (CONTRACTS.md §3.3).
 *
 * The bridge runs on the kiosk machine and streams one `sample` per second plus
 * `status`, `hello`, `waveform` and `error` messages. The web app sends `start`
 * (with the session id) after camera consent, `stop` before `/complete`, and
 * `set_scenario` from the admin panel.
 *
 * Design:
 * - `BridgeClient` is framework-free and takes an injectable WebSocket factory so
 *   tests can drive it with a fake socket.
 * - Reconnect uses exponential backoff with jitter (0.5 s → 8 s). A deliberate
 *   `close()` disables reconnect. The active session's `start` is re-sent on
 *   every `open`, so a bridge restart mid-check-in re-attaches the session.
 * - `stopAndFlush()` waits for the bridge's *post-flush* idle (`sessionId: null`);
 *   the source's own halt also broadcasts idle but still carries the session id
 *   and must not release `/complete` before the last batch is POSTed.
 * - `parseBridgeMessage` validates incoming JSON against the §3.3 union and drops
 *   anything it does not recognise (never throws).
 * - `useBridge()` is the React hook the kiosk and admin pages use; it adds
 *   `activeSessionId` and `captureLost` (bridge up but not capturing our session).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BridgeHello,
  BridgeState,
  BridgeStatusMessage,
  BridgeToWebMessage,
  PublishedFlags,
  VitalsSample,
  WebToBridgeMessage,
} from "./types";

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

export const DEFAULT_BRIDGE_PORT = 8787;

/** `VITE_BRIDGE_WS_URL` else `ws://<hostname>:8787` (CONTRACTS.md §4). */
export function defaultBridgeUrl(): string {
  const fromEnv = import.meta.env.VITE_BRIDGE_WS_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const host =
    typeof location !== "undefined" && location.hostname ? location.hostname : "localhost";
  return `ws://${host}:${DEFAULT_BRIDGE_PORT}`;
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

const BRIDGE_STATES: readonly BridgeState[] = ["idle", "warming", "collecting", "error"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isSample(x: unknown): x is VitalsSample {
  if (!isRecord(x)) return false;
  if (typeof x.tsUtc !== "string") return false;
  if (typeof x.source !== "string") return false;
  if (typeof x.isMeasured !== "boolean") return false;
  if (!isFiniteNumber(x.windowS)) return false;
  if (!Array.isArray(x.qualityFlags)) return false;
  return true;
}

/**
 * Parse one raw WS frame. Returns `null` for anything that is not a well-formed
 * §3.3 message. Exported for unit tests.
 */
export function parseBridgeMessage(raw: unknown): BridgeToWebMessage | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(data) || typeof data.type !== "string") return null;

  switch (data.type) {
    case "hello": {
      if (typeof data.source !== "string" || typeof data.isMeasured !== "boolean") return null;
      const gates = isRecord(data.gates) ? data.gates : {};
      return {
        type: "hello",
        source: data.source as BridgeHello["source"],
        isMeasured: data.isMeasured,
        scenario: typeof data.scenario === "string" ? data.scenario : null,
        minConf: isFiniteNumber(data.minConf) ? data.minConf : 0.6,
        gates: {
          pulseS: isFiniteNumber(gates.pulseS) ? gates.pulseS : 12,
          breathingS: isFiniteNumber(gates.breathingS) ? gates.breathingS : 30,
          hrvS: isFiniteNumber(gates.hrvS) ? gates.hrvS : 60,
        },
        version: typeof data.version === "string" ? data.version : "unknown",
      };
    }
    case "status": {
      if (
        typeof data.state !== "string" ||
        !(BRIDGE_STATES as readonly string[]).includes(data.state)
      ) {
        return null;
      }
      return {
        type: "status",
        state: data.state as BridgeState,
        ...(typeof data.message === "string" ? { message: data.message } : {}),
        elapsedS: isFiniteNumber(data.elapsedS) ? data.elapsedS : 0,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      };
    }
    case "sample": {
      if (!isSample(data.sample)) return null;
      const p = isRecord(data.published) ? data.published : {};
      const published: PublishedFlags = {
        pulse: p.pulse === true,
        breathing: p.breathing === true,
        hrv: p.hrv === true,
      };
      return {
        type: "sample",
        sample: data.sample,
        published,
        elapsedS: isFiniteNumber(data.elapsedS) ? data.elapsedS : 0,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      };
    }
    case "waveform": {
      if (!Array.isArray(data.values)) return null;
      return {
        type: "waveform",
        values: data.values.filter(isFiniteNumber),
        tsUtc: typeof data.tsUtc === "string" ? data.tsUtc : "",
      };
    }
    case "error":
      return {
        type: "error",
        message: typeof data.message === "string" ? data.message : "Bridge error",
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** The subset of the WebSocket API the client needs; lets tests inject a fake. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type BridgeEvent =
  | { type: "open" }
  | { type: "close"; willReconnect: boolean }
  | { type: "message"; message: BridgeToWebMessage };

export type BridgeListener = (ev: BridgeEvent) => void;

export interface BridgeClientOptions {
  url?: string;
  wsFactory?: WebSocketFactory;
  /** Reconnect automatically after an unexpected close (default true). */
  autoReconnect?: boolean;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

const WS_OPEN = 1;

export class BridgeClient {
  readonly url: string;
  private readonly factory: WebSocketFactory;
  private readonly autoReconnect: boolean;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private ws: WebSocketLike | null = null;
  private listeners = new Set<BridgeListener>();
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private attempts = 0;
  /**
   * The session the kiosk wants captured. Set by `start()`, cleared by `stop()`
   * / `stopAndFlush()`. Re-sent on every `open` so a bridge restart (or a start
   * clicked before the socket was open) still attaches the session; the bridge's
   * `start` is idempotent (it stops any previous session first).
   */
  private active: { sessionId: string; scenario?: string } | null = null;

  constructor(opts: BridgeClientOptions = {}) {
    this.url = opts.url ?? defaultBridgeUrl();
    this.factory =
      opts.wsFactory ??
      ((url) => {
        if (typeof WebSocket === "undefined") {
          throw new Error("WebSocket is not available in this environment");
        }
        return new WebSocket(url) as unknown as WebSocketLike;
      });
    this.autoReconnect = opts.autoReconnect ?? true;
    this.initialBackoffMs = opts.initialBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 8000;
    this.backoffMs = this.initialBackoffMs;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  get reconnectAttempts(): number {
    return this.attempts;
  }

  /** The session id `start()` registered and `stop()` has not yet cleared. */
  get activeSessionId(): string | null {
    return this.active?.sessionId ?? null;
  }

  subscribe(listener: BridgeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(ev: BridgeEvent): void {
    this.listeners.forEach((l) => {
      try {
        l(ev);
      } catch (e) {
        // A listener bug must not take down the socket.
        console.error("[bridge] listener error", e);
      }
    });
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === WS_OPEN)) return;
    let ws: WebSocketLike;
    try {
      ws = this.factory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = this.initialBackoffMs;
      this.attempts = 0;
      this.emit({ type: "open" });
      // (Re)attach the kiosk's session after a reconnect or a late first open.
      if (this.active) this.sendStart(this.active.sessionId, this.active.scenario);
    };
    ws.onmessage = (ev) => {
      const msg = parseBridgeMessage(ev.data);
      if (msg) this.emit({ type: "message", message: msg });
    };
    ws.onerror = () => {
      /* the close event follows and carries the reconnect decision */
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      const willReconnect = this.autoReconnect && !this.closedByUser;
      this.emit({ type: "close", willReconnect });
      if (willReconnect) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser || !this.autoReconnect) return;
    // Full jitter keeps a room full of kiosks from reconnecting in lock-step.
    const delay = Math.round(this.backoffMs * (0.5 + Math.random() * 0.5));
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
  }

  /** Close for good (no reconnect). */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "client closed");
      } catch {
        /* ignore */
      }
    }
  }

  /** Returns false when the socket is not open; the message is NOT queued. */
  send(msg: WebToBridgeMessage): boolean {
    if (!this.connected || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private sendStart(sessionId: string, scenario?: string): boolean {
    return this.send(
      scenario ? { type: "start", sessionId, scenario } : { type: "start", sessionId },
    );
  }

  /**
   * Register `sessionId` as the session to capture and send `start`. Returns
   * whether the message went out now; if the socket is not open yet it goes out
   * on the next `open` (see `active`).
   */
  start(sessionId: string, scenario?: string): boolean {
    this.active = scenario ? { sessionId, scenario } : { sessionId };
    return this.sendStart(sessionId, scenario);
  }

  /** Send `stop` and forget the active session (no re-send on reconnect). */
  stop(): boolean {
    this.active = null;
    return this.send({ type: "stop" });
  }

  setScenario(scenario: string): boolean {
    return this.send({ type: "set_scenario", scenario });
  }

  ping(): boolean {
    return this.send({ type: "ping" });
  }

  /**
   * Resolve when a `status` message with `state` (and, if given, satisfying
   * `accept`) arrives, or after `timeoutMs`. Resolves immediately (false) when
   * not connected or on close.
   */
  waitForState(
    state: BridgeState,
    timeoutMs: number,
    accept: (status: BridgeStatusMessage) => boolean = () => true,
  ): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const unsubscribe = this.subscribe((ev) => {
        if (
          ev.type === "message" &&
          ev.message.type === "status" &&
          ev.message.state === state &&
          accept(ev.message)
        ) {
          finish(true);
        }
        if (ev.type === "close") finish(false);
      });
    });
  }

  /**
   * The bridge's post-flush idle broadcast (CONTRACTS.md §3.3 / bridge
   * `session.stop()`): `sessionId` is null only after the final sample batch
   * has been POSTed. The source's own halt also broadcasts `idle`, but with the
   * session id still attached, and that one must NOT release `/complete`.
   */
  static isFlushedIdle(status: BridgeStatusMessage): boolean {
    return status.state === "idle" && status.sessionId === null;
  }

  /**
   * `stop()` then wait for the bridge's post-flush idle (bounded, default 2.5 s
   * per CONTRACTS.md §4). Returns whether the bridge confirmed the flush; the
   * kiosk completes regardless when it times out.
   */
  async stopAndFlush(timeoutMs = 2500): Promise<boolean> {
    if (!this.connected) {
      this.active = null;
      return false;
    }
    const wait = this.waitForState("idle", timeoutMs, BridgeClient.isFlushedIdle);
    this.stop();
    return wait;
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Points kept for the pleth sparkline (~4 s at 25 points per 1 Hz batch). */
export const WAVEFORM_POINTS = 100;

export interface BridgeSnapshot {
  /** Socket open right now. */
  connected: boolean;
  hello: BridgeHello | null;
  status: BridgeStatusMessage | null;
  state: BridgeState | "disconnected";
  sample: VitalsSample | null;
  published: PublishedFlags;
  elapsedS: number;
  sessionId: string | null;
  waveform: number[];
  lastError: string | null;
  /** Number of reconnect attempts since the last successful open. */
  reconnectAttempts: number;
}

const EMPTY_PUBLISHED: PublishedFlags = { pulse: false, breathing: false, hrv: false };

const INITIAL_SNAPSHOT: BridgeSnapshot = {
  connected: false,
  hello: null,
  status: null,
  state: "disconnected",
  sample: null,
  published: EMPTY_PUBLISHED,
  elapsedS: 0,
  sessionId: null,
  waveform: [],
  lastError: null,
  reconnectAttempts: 0,
};

export interface UseBridgeOptions {
  /** Open the socket at all (default true). */
  enabled?: boolean;
  url?: string;
  /** Test seam. */
  wsFactory?: WebSocketFactory;
  /** Override `START_GRACE_MS` (tests). */
  startGraceMs?: number;
}

export interface UseBridge extends BridgeSnapshot {
  start: (sessionId: string, scenario?: string) => boolean;
  stop: () => boolean;
  stopAndFlush: (timeoutMs?: number) => Promise<boolean>;
  setScenario: (scenario: string) => boolean;
  /** The session this kiosk asked the bridge to capture (null when none). */
  activeSessionId: string | null;
  /**
   * True when a session is active but the bridge, although connected, has not
   * been capturing it for longer than `START_GRACE_MS` (e.g. the bridge was
   * restarted and lost the session). The panel then says vitals are unavailable
   * instead of "collecting…".
   */
  captureLost: boolean;
  /** The underlying client (stable for the lifetime of the component). */
  client: BridgeClient | null;
}

/**
 * How long the bridge may stay idle / on another session after `start` before
 * the kiosk treats capture as lost. Covers the bridge's `GET /settings/public`
 * on start plus source warm-up announcements.
 */
export const START_GRACE_MS = 4000;

/** Reduce one bridge event into the snapshot. Exported for tests. */
export function reduceBridgeEvent(
  prev: BridgeSnapshot,
  ev: BridgeEvent,
  client?: BridgeClient,
): BridgeSnapshot {
  switch (ev.type) {
    case "open":
      return {
        ...prev,
        connected: true,
        state: prev.status?.state ?? "idle",
        lastError: null,
        reconnectAttempts: 0,
      };
    case "close":
      return {
        ...prev,
        connected: false,
        state: "disconnected",
        published: EMPTY_PUBLISHED,
        reconnectAttempts: client?.reconnectAttempts ?? prev.reconnectAttempts,
      };
    case "message": {
      const m = ev.message;
      switch (m.type) {
        case "hello":
          return { ...prev, hello: m };
        case "status": {
          const next: BridgeSnapshot = {
            ...prev,
            status: m,
            state: m.state,
            elapsedS: m.elapsedS,
            sessionId: m.sessionId,
            lastError: m.state === "error" ? (m.message ?? "Vitals source error") : prev.lastError,
          };
          // An error resets the timing gates upstream (§3.1); mirror that here.
          if (m.state === "error" || m.state === "idle") {
            next.published = EMPTY_PUBLISHED;
            next.sample = m.state === "idle" ? null : prev.sample;
            if (m.state === "idle") next.waveform = [];
          }
          return next;
        }
        case "sample":
          return {
            ...prev,
            sample: m.sample,
            published: m.published,
            elapsedS: m.elapsedS,
            sessionId: m.sessionId,
          };
        case "waveform": {
          const merged = prev.waveform.concat(m.values);
          return {
            ...prev,
            waveform:
              merged.length > WAVEFORM_POINTS
                ? merged.slice(merged.length - WAVEFORM_POINTS)
                : merged,
          };
        }
        case "error":
          return { ...prev, lastError: m.message };
        default:
          return prev;
      }
    }
    default:
      return prev;
  }
}

export function useBridge(opts: UseBridgeOptions = {}): UseBridge {
  const { enabled = true, url, wsFactory, startGraceMs = START_GRACE_MS } = opts;
  const clientRef = useRef<BridgeClient | null>(null);
  const [snap, setSnap] = useState<BridgeSnapshot>(INITIAL_SNAPSHOT);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [captureLost, setCaptureLost] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSnap(INITIAL_SNAPSHOT);
      return;
    }
    const client = new BridgeClient({ url, wsFactory });
    clientRef.current = client;
    const unsubscribe = client.subscribe((ev) =>
      setSnap((prev) => reduceBridgeEvent(prev, ev, client)),
    );
    client.connect();
    return () => {
      unsubscribe();
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [enabled, url, wsFactory]);

  // Capture-lost detection: a session is wanted, the socket is up and not in
  // error, yet the bridge reports a different (or no) session for longer than
  // the grace period. Any matching status/sample cancels the timer.
  const bridgeOnOurSession = snap.sessionId === activeSessionId;
  useEffect(() => {
    if (
      activeSessionId === null ||
      !snap.connected ||
      snap.state === "error" ||
      snap.state === "disconnected" ||
      bridgeOnOurSession
    ) {
      setCaptureLost(false);
      return;
    }
    const t = setTimeout(() => setCaptureLost(true), startGraceMs);
    return () => clearTimeout(t);
  }, [activeSessionId, snap.connected, snap.state, bridgeOnOurSession, startGraceMs]);

  const start = useCallback((sessionId: string, scenario?: string) => {
    setActiveSessionId(sessionId);
    return clientRef.current?.start(sessionId, scenario) ?? false;
  }, []);
  const stop = useCallback(() => {
    setActiveSessionId(null);
    return clientRef.current?.stop() ?? false;
  }, []);
  const stopAndFlush = useCallback((timeoutMs?: number) => {
    setActiveSessionId(null);
    return clientRef.current?.stopAndFlush(timeoutMs) ?? Promise.resolve(false);
  }, []);
  const setScenario = useCallback(
    (scenario: string) => clientRef.current?.setScenario(scenario) ?? false,
    [],
  );

  return useMemo(
    () => ({
      ...snap,
      activeSessionId,
      captureLost,
      start,
      stop,
      stopAndFlush,
      setScenario,
      client: clientRef.current,
    }),
    [snap, activeSessionId, captureLost, start, stop, stopAndFlush, setScenario],
  );
}
