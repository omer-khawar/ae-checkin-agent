/**
 * Vitest setup: jest-dom matchers, DOM cleanup, and a clean sessionStorage per test.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { resetAuthCache } from "../lib/auth";
import { FakeWebSocket } from "./fakeWebSocket";

beforeEach(() => {
  sessionStorage.clear();
  resetAuthCache();
  FakeWebSocket.reset();
  // The kiosk opens a bridge socket on mount; route it to the fake in every test.
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  cleanup();
});
