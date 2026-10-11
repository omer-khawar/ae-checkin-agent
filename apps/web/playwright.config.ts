/**
 * Minimal Playwright config for the browser walkthrough specs in `e2e/`.
 * No webServer block: each spec targets a stack started separately (see the
 * spec header for ports). Base URLs are set per spec with `test.use`.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "only-on-failure",
  },
});
