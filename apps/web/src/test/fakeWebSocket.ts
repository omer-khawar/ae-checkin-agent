/**
 * Minimal in-memory WebSocket for tests. Records what the app sends and lets a
 * test push bridge messages. By default it opens on the next microtask and
 * answers `start` with `status: collecting` and `stop` with `status: idle`, which
 * is what the real bridge does (CONTRACTS.md §3.3).
 */
import type { BridgeToWebMessage, WebToBridgeMessage } from "../lib/types";

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static autoOpen = true;
  static autoRespond = true;

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = true;
    FakeWebSocket.autoRespond = true;
  }

  static get last(): FakeWebSocket | undefined {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  readonly url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.open());
  }

  /** Simulate the server accepting the connection. */
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("InvalidStateError: socket not open");
    this.sent.push(data);
    if (!FakeWebSocket.autoRespond) return;
    const msg = JSON.parse(data) as WebToBridgeMessage;
    if (msg.type === "start") {
      this.receive({ type: "status", state: "collecting", elapsedS: 0, sessionId: msg.sessionId });
    } else if (msg.type === "stop") {
      this.receive({ type: "status", state: "idle", elapsedS: 0, sessionId: null });
    }
  }

  /** Push a message from the "bridge" to the app. */
  receive(msg: BridgeToWebMessage | Record<string, unknown> | string): void {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.onmessage?.({ data });
  }

  /** Client-initiated close. */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  /** Server-initiated close (e.g. bridge process died). */
  serverClose(): void {
    this.close();
  }

  get sentMessages(): WebToBridgeMessage[] {
    return this.sent.map((s) => JSON.parse(s) as WebToBridgeMessage);
  }
}
