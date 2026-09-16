import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only this repo's own topology tests. The backend and frontend own their suites, and the
    // backend's must stay runnable on a machine with no Docker.
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000
  }
});
