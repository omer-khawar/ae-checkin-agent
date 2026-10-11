/**
 * Vite configuration for the Interim web app.
 *
 * - Dev server on :5173 (strict, so the README's URLs are always right).
 * - `/api` is proxied to the FastAPI service so the browser only ever talks to
 *   a relative `/api/v1` base (CONTRACTS.md §4). The target is
 *   `VITE_API_PROXY_TARGET` from the environment (default http://localhost:8000),
 *   so a second API on another port can sit behind a second dev server:
 *   `VITE_API_PROXY_TARGET=http://localhost:8010 npm run dev -- --port 5180`.
 *   In Docker, nginx.conf plays the same role.
 * - `@/` is an alias for `src/` (matches tsconfig "paths" and components.json).
 *   The replacement is root-relative ("/src/") so no Node path helpers are needed.
 * - Vitest runs in jsdom with a setup file that registers jest-dom matchers and
 *   a deterministic `sessionStorage` / `WebSocket` environment.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Read through globalThis so the config type-checks without @types/node.
const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@\//, replacement: "/src/" }],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: false,
    // Report chunk sizes so the "bundle size" line in the build log is honest.
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
