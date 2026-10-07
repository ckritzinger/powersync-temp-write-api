import { defineConfig } from '@playwright/test';
import config from './playwright.config';

export default defineConfig({
  ...config,
  webServer: {
    ...(config.webServer as object),
    command: `"${process.execPath}" node_modules/vite/bin/vite.js preview --config client/vite.config.ts`
  }
});
