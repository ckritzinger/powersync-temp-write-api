import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export default defineConfig({
  testDir: './tests',
  outputDir: '../.local/browser-results',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: 'list',
  // Traces and HAR files can contain auth tokens. Keep them disabled.
  use: { baseURL: 'http://127.0.0.1:5174', browserName: 'chromium', trace: 'off', video: 'off' },
  projects: [
    { name: 'local', testMatch: 'local.spec.ts' },
    { name: 'api', testMatch: 'api.spec.ts' },
    { name: 'recovery', testMatch: 'recovery.spec.ts' }
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --config client/vite.config.ts`,
    cwd: root,
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 30_000
  }
});
