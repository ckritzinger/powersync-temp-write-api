import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicit, because without a config here vitest walks up and finds the repo root's, whose
    // include pattern points at the topology suite and hides every test in this package.
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000
  }
});
