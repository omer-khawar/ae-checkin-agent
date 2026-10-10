import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BridgeClient,
  parseBridgeMessage,
  reduceBridgeEvent,
  useBridge,
  type BridgeEvent,
  type BridgeSnapshot,
} from "../lib/bridge";
import { FakeWebSocket } from "./fakeWebSocket";

const factory = (url: string) => new FakeWebSocket(url);

describe("parseBridgeMessage", () => {
  it("parses every §3.3 message type", () => {
    expect(
      parseBridgeMessage(
        JSON.stringify({
          type: "hello",
          source: "mock",
          isMeasured: false,
          scenario: "resting",
          minConf: 0.6,
          gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
          version: "0.1.0",
        }),
      ),
    ).toEqual({
      type: "hello",
      source: "mock",
      isMeasured: false,
      scenario: "resting",
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
      version: "0.1.0",
    });

    expect(
      parseBridgeMessage({ type: "status", state: "collecting", elapsedS: 4, sessionId: "s1" }),
    ).toEqual({
      type: "status",
      state: "collecting",
      elapsedS: 4,
      sessionId: "s1",
    });

    const sample = {
      tsUtc: "2026-10-10T18:00:00.000Z",
      source: "mock",
      isMeasured: false,
      pulseBpm: 72,
      pulseConf: 0.9,
      windowS: 12,
      qualityFlags: ["gate_pending_breathing"],
    };
    expect(
      parseBridgeMessage({
        type: "sample",
        sample,
        published: { pulse: true },
        elapsedS: 13,
        sessionId: "s1",
      }),
    ).toEqual({
      type: "sample",
      sample,
      published: { pulse: true, breathing: false, hrv: false },
      elapsedS: 13,
      sessionId: "s1",
    });

    expect(parseBridgeMessage({ type: "waveform", values: [1, 2, "x", 3], tsUtc: "t" })).toEqual({
      type: "waveform",
      values: [1, 2, 3],
      tsUtc: "t",
    });

    expect(parseBridgeMessage({ type: "error", message: "boom" })).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("returns null for garbage, unknown types and malformed samples", () => {
    expect(parseBridgeMessage("not json")).toBeNull();
    expect(parseBridgeMessage("42")).toBeNull();
    expect(parseBridgeMessage({ type: "nope" })).toBeNull();
    expect(parseBridgeMessage({ type: "status", state: "flying" })).toBeNull();
    expect(parseBridgeMessage({ type: "sample", sample: { tsUtc: "t" } })).toBeNull();
    expect(parseBridgeMessage({ type: "waveform", values: "nope" })).toBeNull();
    expect(parseBridgeMessage(null)).toBeNull();
  });
});

describe("BridgeClient", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects, forwards parsed messages, and sends start/stop/set_scenario", async () => {
    const client = new BridgeClient({ url: "ws://test:8787", wsFactory: factory });
    const events: BridgeEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.connect();
    await Promise.resolve(); // open on microtask
    expect(client.connected).toBe(true);
    expect(events[0]).toEqual({ type: "open" });

    const ws = FakeWebSocket.last!;
    ws.receive({
      type: "hello",
      source: "mock",
      isMeasured: false,
      scenario: null,
      minConf: 0.6,
      gates: { pulseS: 12, breathingS: 30, hrvS: 60 },
      version: "0.1.0",
    });
    ws.receive("garbage");
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);

    expect(client.start("S1", "post_exercise")).toBe(true);
    expect(client.activeSessionId).toBe("S1");
    expect(client.setScenario("tachypnea")).toBe(true);
    expect(client.ping()).toBe(true);
    expect(ws.sentMessages).toEqual([
      { type: "start", sessionId: "S1", scenario: "post_exercise" },
      { type: "set_scenario", scenario: "tachypnea" },
      { type: "ping" },
    ]);
    client.close();
    expect(client.connected).toBe(false);
  });

  it("send() returns false when not connected", () => {
    FakeWebSocket.autoOpen = false;
    const client = new BridgeClient({ url: "ws://test:8787", wsFactory: factory });
    client.connect();
    expect(client.start("S1")).toBe(false);
    client.close();
  });

  it("delivers a start() made before the socket opened, once it opens", () => {
    FakeWebSocket.autoOpen = false;
    const client = new BridgeClient({ url: "ws://test:8787", wsFactory: factory });
    client.connect();
    expect(client.start("S1", "resting")).toBe(false);
    const ws = FakeWebSocket.last!;
    expect(ws.sentMessages).toEqual([]);
    ws.open();
    expect(ws.sentMessages).toEqual([{ type: "start", sessionId: "S1", scenario: "resting" }]);
    client.close();
  });

  it("stopAndFlush resolves true when the bridge reports idle, false on timeout", async () => {
    const client = new BridgeClient({ url: "ws://test:8787", wsFactory: factory });
    client.connect();
    await Promise.resolve();
    expect(await client.stopAndFlush(100)).toBe(true);
    expect(FakeWebSocket.last!.sentMessages).toEqual([{ type: "stop" }]);

    FakeWebSocket.autoRespond = false;
    vi.useFakeTimers();
    const p = client.stopAndFlush(2500);
    vi.advanceTimersByTime(2600);
    expect(await p).toBe(false);
    client.close();
  });

  it("stopAndFlush ignores the pre-flush idle (sessionId still set) and resolves on the post-flush idle", async () => {
    FakeWebSocket.autoRespond = false;
    const client = new BridgeClient({ url: "ws://test:8787", wsFactory: factory });
    client.connect();
    await Promise.resolve();
    const ws = FakeWebSocket.last!;
    client.start("S1");

    let settled: boolean | null = null;
    const p = client.stopAndFlush(2500).then((ok) => {
      settled = ok;
      return ok;
    });
    expect(ws.sentMessages.at(-1)).toEqual({ type: "stop" });

    // The mock source's halt() broadcasts idle while the bridge still holds the
    // session and has NOT posted the final batch yet (bridge session.ts stop()).
    ws.receive({ type: "status", state: "idle", elapsedS: 40, sessionId: "S1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeNull();

    // Only the post-flush broadcast (sessionId null) releases the kiosk.
    ws.receive({ type: "status", state: "idle", elapsedS: 0, sessionId: null });
    expect(await p).toBe(true);
    expect(client.activeSessionId).toBeNull();
    client.close();
  });

  it("isFlushedIdle is the exact predicate", () => {
    expect(
      BridgeClient.isFlushedIdle({ type: "status", state: "idle", elapsedS: 0, sessionId: null }),
    ).toBe(true);
    expect(
      BridgeClient.isFlushedIdle({ type: "status", state: "idle", elapsedS: 0, sessionId: "S1" }),
    ).toBe(false);
    expect(
      BridgeClient.isFlushedIdle({
        type: "status",
        state: "collecting",
        elapsedS: 0,
        sessionId: null,
      }),
    ).toBe(false);
  });

  it("reconnects with backoff after an unexpected close, but not after close()", async () => {
    vi.useFakeTimers();
    const client = new BridgeClient({
      url: "ws://test:8787",
      wsFactory: factory,
      initialBackoffMs: 100,
      maxBackoffMs: 400,
    });
    const events: BridgeEvent[] = [];
    client.subscribe((e) => events.push(e));
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.last!.serverClose();
    expect(events.at(-1)).toEqual({ type: "close", willReconnect: true });
    expect(client.reconnectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(client.connected).toBe(true);
    expect(client.reconnectAttempts).toBe(0);

    client.close();
    expect(events.at(-1)).toEqual({ type: "close", willReconnect: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("re-sends start for the active session on every reconnect, and not after stop()", async () => {
    vi.useFakeTimers();
    const client = new BridgeClient({
      url: "ws://test:8787",
      wsFactory: factory,
      initialBackoffMs: 100,
      maxBackoffMs: 100,
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.start("S1", "post_exercise")).toBe(true);

    // Bridge process restarts: socket drops, client reconnects, start goes out again.
    FakeWebSocket.last!.serverClose();
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last!.sentMessages).toEqual([
      { type: "start", sessionId: "S1", scenario: "post_exercise" },
    ]);

    // After stop() the session is forgotten: a further reconnect sends nothing.
    client.stop();
    expect(client.activeSessionId).toBeNull();
    FakeWebSocket.last!.serverClose();
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(FakeWebSocket.last!.sentMessages).toEqual([]);
    client.close();
  });
});

describe("useBridge", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
  });

  it("flags captureLost when the bridge stays idle after start, and clears it once it reports our session", async () => {
    FakeWebSocket.autoRespond = false;
    const { result, unmount } = renderHook(() =>
      useBridge({ url: "ws://test:8787", wsFactory: factory, startGraceMs: 30 }),
    );
    await waitFor(() => expect(result.current.connected).toBe(true));
    const ws = FakeWebSocket.last!;
    act(() => {
      ws.receive({ type: "status", state: "idle", elapsedS: 0, sessionId: null });
    });
    expect(result.current.captureLost).toBe(false);

    act(() => {
      result.current.start("S1");
    });
    expect(result.current.activeSessionId).toBe("S1");
    expect(ws.sentMessages).toEqual([{ type: "start", sessionId: "S1" }]);
    // No warming/collecting for our session within the grace period → lost.
    await waitFor(() => expect(result.current.captureLost).toBe(true));

    act(() => {
      ws.receive({ type: "status", state: "warming", elapsedS: 0, sessionId: "S1" });
    });
    expect(result.current.captureLost).toBe(false);

    // stopAndFlush forgets the session, so an idle bridge is no longer "lost".
    let flushed: Promise<boolean> | null = null;
    act(() => {
      flushed = result.current.stopAndFlush(200);
    });
    act(() => {
      ws.receive({ type: "status", state: "idle", elapsedS: 0, sessionId: null });
    });
    expect(await flushed!).toBe(true);
    expect(result.current.activeSessionId).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(result.current.captureLost).toBe(false);
    unmount();
  });
});

describe("reduceBridgeEvent", () => {
  const base: BridgeSnapshot = {
    connected: true,
    hello: null,
    status: null,
    state: "idle",
    sample: null,
    published: { pulse: false, breathing: false, hrv: false },
    elapsedS: 0,
    sessionId: null,
    waveform: [],
    lastError: null,
    reconnectAttempts: 0,
  };

  it("tracks samples, published flags, waveform window and resets on idle/error", () => {
    const sample = {
      tsUtc: "t",
      source: "mock" as const,
      isMeasured: false,
      pulseBpm: 70,
      windowS: 12,
      qualityFlags: [],
    };
    let s = reduceBridgeEvent(base, {
      type: "message",
      message: {
        type: "sample",
        sample,
        published: { pulse: true, breathing: false, hrv: false },
        elapsedS: 15,
        sessionId: "S",
      },
    });
    expect(s.sample).toBe(sample);
    expect(s.published.pulse).toBe(true);
    expect(s.elapsedS).toBe(15);

    s = reduceBridgeEvent(s, {
      type: "message",
      message: { type: "waveform", values: Array.from({ length: 150 }, (_, i) => i), tsUtc: "t" },
    });
    expect(s.waveform).toHaveLength(100);
    expect(s.waveform[0]).toBe(50);

    s = reduceBridgeEvent(s, {
      type: "message",
      message: { type: "status", state: "error", message: "lost", elapsedS: 0, sessionId: "S" },
    });
    expect(s.state).toBe("error");
    expect(s.lastError).toBe("lost");
    expect(s.published.pulse).toBe(false);

    s = reduceBridgeEvent(s, {
      type: "message",
      message: { type: "status", state: "idle", elapsedS: 0, sessionId: null },
    });
    expect(s.sample).toBeNull();
    expect(s.waveform).toEqual([]);

    s = reduceBridgeEvent(s, { type: "close", willReconnect: true });
    expect(s.connected).toBe(false);
    expect(s.state).toBe("disconnected");
  });
});
