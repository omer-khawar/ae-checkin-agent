/**
 * Vite configuration for the Interim web app.
 *
 * - Dev server on :5173 (strict, so the README's URLs are always right).
 * - `/api` is proxied to the FastAPI service on :8000 so the browser only ever
 *   talks to a relative `/api/v1` base (CONTRACTS.md §4). In Docker, nginx.conf
 *   plays the same role.
 * - Vitest runs in jsdom with a setup file that registers jest-dom matchers and
 *   a deterministic `sessionStorage` / `WebSocket` environment.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
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
