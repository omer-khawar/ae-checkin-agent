import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The ws/cli tests do real socket I/O and process spawns; give them headroom on slow laptops.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
