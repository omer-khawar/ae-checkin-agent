/**
 * Session orchestrator: source → gate → (WS broadcast + API batching).
 *
 * One BridgeSession lives for the life of the process and tracks at most one active check-in
 * session. It is idle until a `start` arrives (from the kiosk over WS, or from `--session` on the
 * CLI); `stop` halts the source, flushes the API buffer and returns to idle.
 *
 * Start sequence (docs/CONTRACTS.md §3.3):
 *   1. A `start` for the session that is ALREADY running is idempotent: the web client re-sends
 *      `start` on every WebSocket (re)open, and a transient socket drop mid-check-in must not
 *      restart the source (which would reset the timing gates and the mock's curve). The bridge
 *      logs "re-attach", re-broadcasts hello + status and touches nothing else.
 *   2. Otherwise the session id is claimed and `{state: "warming", sessionId}` is broadcast
 *      BEFORE any network round-trip, so the kiosk sees its session within milliseconds (its
 *      capture-lost grace is 4 s) and a `stop` arriving during the start is honoured.
 *   3. `GET /api/v1/settings/public` (bounded by the API client's short timeout) supplies the
 *      admin panel's `mock_scenario` and, unless the operator pinned them on the CLI/env, the
 *      `min_confidence` and `timing_gates` from the rules tables. The bridge adopts those so the
 *      "safe to show" threshold has one source of truth (CLAUDE.md §13: code reads tables).
 *   4. The source starts. If a `stop` (or a start for another session) arrived during steps 2-3,
 *      the stale start aborts and leaves the source alone.
 *
 * Scenario resolution on start (mock source only; other sources ignore scenarios):
 *   1. the `start` message's own `scenario`,
 *   2. a scenario queued by `set_scenario` (consumed by this start),
 *   3. `mock_scenario` from the API settings (the admin panel),
 *   4. the CLI/env default.
 * Each step is validated; an unknown name is logged and the next candidate is used, so a typo in
 * the admin panel cannot stop a check-in.
 *
 * The clock is injectable (`now`) so gating can be tested deterministically.
 */
import type { ApiClient, PublicSettings } from './api.js';
import {
  applyStatus,
  DEFAULT_MIN_CONF,
  DEFAULT_TIMING_GATES,
  elapsedCollectingS,
  gateSample,
  INITIAL_GATE_STATE,
  type GateState,
  type TimingGates,
} from './gate.js';
import { type Logger, silentLogger } from './log.js';
import { DEFAULT_SCENARIO, isScenarioName, SCENARIO_NAMES } from './sources/scenarios.js';
import {
  hasWaveform,
  type SourceStatus,
  type VitalsSample,
  type VitalsSource,
} from './sources/types.js';
import type { StatusSnapshot } from './status_line.js';
import type { BridgeToWeb, HelloMessage, StatusMessage } from './ws.js';

/** Anything that can fan a message out to the web clients (BridgeWsServer in production). */
export interface BroadcastSink {
  broadcast(msg: BridgeToWeb): void;
}

export interface BridgeSessionOptions {
  source: VitalsSource;
  api: ApiClient;
  /**
   * Timing gates pinned by the operator. When omitted the built-in defaults (12/30/60 s) apply
   * until the API's `settings/public.timing_gates` is adopted on the first start.
   */
  gates?: TimingGates;
  /**
   * Confidence threshold pinned by the operator (`--min-conf` / `VITALS_MIN_CONF`). When omitted
   * the built-in default (0.6) applies until the API's `settings/public.min_confidence` is adopted.
   */
  minConf?: number;
  /** CLI/env scenario; only meaningful for the mock source. */
  defaultScenario?: string | null;
  log?: Logger;
  /** Millisecond clock; default Date.now. */
  now?: () => number;
  version?: string;
}

interface LastValues {
  pulse?: number;
  pulseConf?: number;
  breathing?: number;
  breathingConf?: number;
}

const NOOP_SINK: BroadcastSink = { broadcast: () => undefined };

/** Sanity bounds for gates adopted from the API: a positive number of seconds, at most 10 minutes. */
const MAX_GATE_S = 600;

function validGateSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_GATE_S;
}

function validConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export class BridgeSession {
  private readonly source: VitalsSource;
  private readonly api: ApiClient;
  private readonly defaultScenario: string | null;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly version: string;

  private gates: TimingGates;
  private minConf: number;
  private readonly gatesPinned: boolean;
  private readonly minConfPinned: boolean;

  private sink: BroadcastSink = NOOP_SINK;
  private gate: GateState = INITIAL_GATE_STATE;
  private sessionId: string | null = null;
  private activeScenario: string | null = null;
  private pendingScenario: string | null = null;
  private lastStatus: SourceStatus = { state: 'idle' };
  private last: LastValues = {};
  /** True once `source.start()` has resolved for the active session; false after stop/failure. */
  private sourceRunning = false;
  /** Incremented by every start and stop; an awaited step compares it to detect supersession. */
  private epoch = 0;
  /** Shared by concurrent stop() callers so the final flush runs once. */
  private stopping: Promise<void> | null = null;

  constructor(opts: BridgeSessionOptions) {
    this.source = opts.source;
    this.api = opts.api;
    this.gatesPinned = opts.gates !== undefined;
    this.gates = { ...(opts.gates ?? DEFAULT_TIMING_GATES) };
    this.minConfPinned = opts.minConf !== undefined;
    this.minConf = opts.minConf ?? DEFAULT_MIN_CONF;
    this.defaultScenario = opts.defaultScenario ?? null;
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? (() => Date.now());
    this.version = opts.version ?? '0.0.0';

    this.source.onStatus((status) => this.handleStatus(status));
    this.source.onSample((sample) => this.handleSample(sample));
    if (hasWaveform(this.source)) {
      this.source.onWaveform((w) => {
        if (this.sessionId !== null) {
          this.sink.broadcast({ type: 'waveform', values: w.values, tsUtc: w.tsUtc });
        }
      });
    }
  }

  /** Attach the WS server (or a test double) after construction to break the ws ↔ session cycle. */
  attachSink(sink: BroadcastSink): void {
    this.sink = sink;
  }

  get supportsScenarios(): boolean {
    return this.source.name === 'mock';
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  /** Threshold and gates currently in force (built-in, pinned, or adopted from the API). */
  get thresholds(): { minConf: number; gates: TimingGates } {
    return { minConf: this.minConf, gates: { ...this.gates } };
  }

  /** Scenario that is running, or would run on the next start. Null for non-mock sources. */
  currentScenario(): string | null {
    if (!this.supportsScenarios) return null;
    return this.activeScenario ?? this.pendingScenario ?? this.defaultScenario ?? DEFAULT_SCENARIO;
  }

  elapsedS(): number {
    return elapsedCollectingS(this.gate, this.now());
  }

  hello(): HelloMessage {
    return {
      type: 'hello',
      source: this.source.name,
      isMeasured: this.source.isMeasured,
      scenario: this.currentScenario(),
      minConf: this.minConf,
      gates: { ...this.gates },
      version: this.version,
    };
  }

  status(): StatusMessage {
    const msg: StatusMessage = {
      type: 'status',
      state: this.lastStatus.state,
      elapsedS: Math.floor(this.elapsedS()),
      sessionId: this.sessionId,
    };
    if (this.lastStatus.message !== undefined) msg.message = this.lastStatus.message;
    return msg;
  }

  snapshot(): StatusSnapshot {
    return {
      source: this.source.name,
      scenario: this.currentScenario(),
      state: this.lastStatus.state,
      sessionId: this.sessionId,
      elapsedS: this.elapsedS(),
      pulse: this.last.pulse,
      pulseConf: this.last.pulseConf,
      breathing: this.last.breathing,
      breathingConf: this.last.breathingConf,
      buffered: this.api.buffered,
      posted: this.api.stats.posted,
    };
  }

  /** Queue a scenario for the next start (mock only). Throws on an unknown name. */
  setScenario(scenario: string): void {
    if (!this.supportsScenarios) {
      throw new Error(
        `source "${this.source.name}" has no scenarios; set_scenario applies to the mock source only`,
      );
    }
    if (!isScenarioName(scenario)) {
      throw new Error(`unknown scenario "${scenario}" (known: ${SCENARIO_NAMES.join(', ')})`);
    }
    this.pendingScenario = scenario;
    this.log.info(`scenario "${scenario}" queued; it applies on the next start`);
  }

  /** Begin capture + batching for a check-in session. */
  async start(sessionId: string, scenario?: string): Promise<void> {
    if (this.sessionId === sessionId && this.sourceRunning) {
      // The web client re-sends start on every socket open; a reconnect must not restart capture.
      this.log.info(
        `start for ${sessionId} received while it is already active; re-attaching without restarting the source` +
          (scenario !== undefined && scenario !== this.activeScenario
            ? ` (ignoring scenario "${scenario}"; "${this.activeScenario ?? '-'}" is running)`
            : ''),
      );
      this.sink.broadcast(this.hello());
      this.sink.broadcast(this.status());
      return;
    }
    if (this.sessionId !== null) {
      this.log.info(
        `start requested for ${sessionId} while ${this.sessionId} is active; stopping the previous session first`,
      );
      await this.stop();
    }

    // Claim the session and announce it before any network round-trip.
    const epoch = ++this.epoch;
    this.sessionId = sessionId;
    this.activeScenario = null;
    this.sourceRunning = false;
    this.last = {};
    this.gate = INITIAL_GATE_STATE;
    this.api.startBatching(sessionId);
    this.handleStatus({ state: 'warming', message: `starting ${this.source.name} source` });

    const settings = await this.api.getPublicSettings();
    if (!this.isCurrent(epoch, sessionId, 'settings lookup')) return;
    this.adoptSettings(settings);
    const resolved = this.resolveScenario(scenario, settings);
    this.activeScenario = resolved;
    this.log.info(
      `session ${sessionId} started: source=${this.source.name} (${this.source.isMeasured ? 'MEASURED' : 'SIMULATED'})` +
        (resolved ? ` scenario=${resolved}` : ''),
    );

    try {
      await this.source.start(resolved ? { scenario: resolved } : {});
    } catch (err) {
      const message = `source "${this.source.name}" failed to start: ${err instanceof Error ? err.message : String(err)}`;
      this.log.error(message);
      if (this.isCurrent(epoch, sessionId, 'source start')) {
        this.handleStatus({ state: 'error', message });
        this.sink.broadcast({ type: 'error', message });
      }
      return;
    }
    if (!this.isCurrent(epoch, sessionId, 'source start')) {
      // A stop ran while the source was opening; make sure it does not keep capturing.
      await this.source.stop().catch(() => undefined);
      return;
    }
    this.sourceRunning = true;
  }

  /** Stop capture, flush the API buffer, return to idle. Safe to call when idle; concurrent calls share one stop. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.sessionId === null) {
      this.sink.broadcast(this.status());
      return Promise.resolve();
    }
    this.stopping = this.doStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  // ---- internals ---------------------------------------------------------------------------

  private async doStop(): Promise<void> {
    const sessionId = this.sessionId as string;
    this.epoch += 1; // invalidates any start still awaiting a step
    this.sourceRunning = false;
    try {
      await this.source.stop();
    } catch (err) {
      this.log.warn(`source stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const flush = await this.api.stopBatching();
    this.sessionId = null;
    this.activeScenario = null;
    this.gate = INITIAL_GATE_STATE;
    this.lastStatus = { state: 'idle' };
    this.last = {};
    this.log.info(
      `session ${sessionId} stopped; final flush posted ${flush?.posted ?? 0} sample(s)` +
        (flush && !flush.ok ? ` (${flush.reason ?? 'failed'})` : ''),
    );
    this.sink.broadcast(this.status());
  }

  /** False (and a log line) when a stop or a newer start superseded the start that awaited `step`. */
  private isCurrent(epoch: number, sessionId: string, step: string): boolean {
    if (epoch === this.epoch && this.sessionId === sessionId) return true;
    this.log.info(`start for ${sessionId} superseded during ${step}; not starting capture for it`);
    return false;
  }

  /**
   * Adopt `min_confidence` / `timing_gates` from the API unless the operator pinned them. Values
   * are validated (a broken table must not silently open every gate). A change is logged and
   * re-announced with a fresh `hello` so connected kiosks display the thresholds in force.
   */
  private adoptSettings(settings: PublicSettings | null): void {
    if (!settings) return;
    const changes: string[] = [];

    if (!this.minConfPinned && settings.min_confidence !== undefined) {
      if (validConfidence(settings.min_confidence)) {
        if (settings.min_confidence !== this.minConf) {
          changes.push(`min_conf ${this.minConf} → ${settings.min_confidence}`);
          this.minConf = settings.min_confidence;
        }
      } else {
        this.log.warn(
          `API settings carry an invalid min_confidence ${JSON.stringify(settings.min_confidence)}; keeping ${this.minConf}`,
        );
      }
    }

    if (!this.gatesPinned && settings.timing_gates !== undefined) {
      const tg = settings.timing_gates;
      const next: TimingGates = { ...this.gates };
      const pairs: Array<[keyof TimingGates, unknown, string]> = [
        ['pulseS', tg.pulse_s, 'pulse_s'],
        ['breathingS', tg.breathing_s, 'breathing_s'],
        ['hrvS', tg.hrv_s, 'hrv_s'],
      ];
      for (const [key, value, name] of pairs) {
        if (value === undefined) continue;
        if (!validGateSeconds(value)) {
          this.log.warn(
            `API settings carry an invalid timing_gates.${name} ${JSON.stringify(value)}; keeping ${this.gates[key]}s`,
          );
          continue;
        }
        if (value !== next[key]) {
          changes.push(`${name} ${this.gates[key]}s → ${value}s`);
          next[key] = value;
        }
      }
      this.gates = next;
    }

    if (changes.length > 0) {
      this.log.info(`adopted thresholds from API settings/public: ${changes.join(', ')}`);
      this.sink.broadcast(this.hello());
    }
  }

  private resolveScenario(
    fromStart: string | undefined,
    settings: PublicSettings | null,
  ): string | null {
    if (!this.supportsScenarios) {
      this.warnIfSourceMismatch(settings);
      return null;
    }

    const queued = this.pendingScenario;
    this.pendingScenario = null; // consumed (or overridden) by this start

    if (fromStart !== undefined) {
      if (isScenarioName(fromStart)) return fromStart;
      this.log.warn(`start message carried unknown scenario "${fromStart}"; ignoring it`);
    }
    if (queued !== null) {
      this.log.info(`using queued scenario "${queued}" from set_scenario`);
      return queued;
    }

    if (settings) {
      this.warnIfSourceMismatch(settings);
      if (typeof settings.mock_scenario === 'string') {
        if (isScenarioName(settings.mock_scenario)) {
          this.log.info(`using mock_scenario "${settings.mock_scenario}" from API settings`);
          return settings.mock_scenario;
        }
        this.log.warn(
          `API settings carry unknown mock_scenario "${settings.mock_scenario}"; falling back to the CLI/env scenario`,
        );
      }
    }

    if (this.defaultScenario !== null && isScenarioName(this.defaultScenario)) {
      return this.defaultScenario;
    }
    if (this.defaultScenario !== null) {
      this.log.warn(
        `unknown default scenario "${this.defaultScenario}"; using "${DEFAULT_SCENARIO}"`,
      );
    }
    return DEFAULT_SCENARIO;
  }

  /** The source is fixed for the life of the process (no hot-swap); tell the operator when the admin panel disagrees. */
  private warnIfSourceMismatch(settings: PublicSettings | null): void {
    if (
      settings &&
      typeof settings.vitals_source === 'string' &&
      settings.vitals_source !== this.source.name
    ) {
      this.log.warn(
        `API settings say vitals_source=${settings.vitals_source} but this bridge runs "${this.source.name}"; restart the bridge with --source ${settings.vitals_source} to switch`,
      );
    }
  }

  private handleStatus(status: SourceStatus): void {
    const prev = this.lastStatus.state;
    this.lastStatus = status;
    this.gate = applyStatus(this.gate, status, this.now());
    // Outside "collecting" there is no current value: the gates reset and the kiosk shows none,
    // so the operator status line must not keep quoting the last published pulse either.
    if (status.state !== 'collecting') this.last = {};
    if (status.state !== prev) {
      const line = `source status ${prev} → ${status.state}${status.message ? `: ${status.message}` : ''}`;
      if (status.state === 'error') this.log.warn(line);
      else this.log.info(line);
    }
    this.sink.broadcast(this.status());
  }

  private handleSample(raw: VitalsSample): void {
    if (this.sessionId === null) return; // stray sample outside a session (e.g. after stop)
    const gated = gateSample(this.gate, raw, this.now(), this.gates, this.minConf);
    this.last = {
      pulse: gated.sample.pulseBpm,
      pulseConf: gated.sample.pulseConf,
      breathing: gated.sample.breathingBpm,
      breathingConf: gated.sample.breathingConf,
    };
    this.sink.broadcast({
      type: 'sample',
      sample: gated.sample,
      published: gated.published,
      elapsedS: gated.elapsedS,
      sessionId: this.sessionId,
    });
    this.api.enqueue(gated.sample);
  }
}
