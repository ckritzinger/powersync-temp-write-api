import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './tests',
  outputDir: '../.local/browser-cloud-results',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5174', browserName: 'chromium', trace: 'off', video: 'off' },
  projects: [
    { name: 'cloud', testMatch: 'cloud.spec.ts' },
    { name: 'cloud-recovery', testMatch: 'cloud-recovery.spec.ts' },
    { name: 'mongodb', testMatch: 'mongodb.spec.ts' },
    { name: 'mysql', testMatch: 'mysql.spec.ts' },
    { name: 'mssql', testMatch: 'mssql.spec.ts' }
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --config client/vite.config.ts`,
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 30_000
  }
});
