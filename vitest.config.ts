import { defineConfig } from 'vitest/config';

// Unit tests for engine-free code (simulation, networking, perf stats).
// Kept separate from vite.config.ts so the IWSDK dev plugin doesn't start.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
