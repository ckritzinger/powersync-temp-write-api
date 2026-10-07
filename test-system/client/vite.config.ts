import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const systemRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(async () => {
  // Expose only these public settings. Never serialize env files or Cloud exports into the app.
  let backendPort = '6061';
  let cloudUrl = '';
  let source = 'postgres';
  try {
    const runtime = await readFile(new URL('../.local/runtime.env', import.meta.url), 'utf8');
    backendPort = /^BACKEND_PORT=(\d+)$/m.exec(runtime)?.[1] ?? backendPort;
    source = /^DATABASE_TYPE=(postgres|mongodb|mysql|mssql)$/m.exec(runtime)?.[1] ?? source;
    const audience = /^POWERSYNC_URL=(https:\/\/[^\r\n]+)$/m.exec(runtime)?.[1];
    if (audience && new URL(audience).hostname !== 'test-system.invalid') cloudUrl = new URL(audience).origin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const publicDefaults = { backendUrl: `http://127.0.0.1:${backendPort}`, cloudUrl, source };
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp'
  };
  return {
    root,
    plugins: [{
      name: 'test-system-public-defaults',
      configureServer(server) {
        const runtimeFile = fileURLToPath(new URL('../.local/runtime.env', import.meta.url));
        server.watcher.add(runtimeFile);
        server.watcher.on('change', changed => { if (changed === runtimeFile) void server.restart(); });
      }
    }],
    // Don't automatically load environment files, including those in the parent repository.
    envDir: false,
    define: { __TEST_SYSTEM_DEFAULTS__: JSON.stringify(publicDefaults) },
    optimizeDeps: { exclude: ['@powersync/web'] },
    worker: { format: 'es' },
    server: { host: '127.0.0.1', port: 5174, strictPort: true, headers,
      fs: { strict: true, allow: [root, fileURLToPath(new URL('../.generated/connector/', import.meta.url)), `${systemRoot}/node_modules`] } },
    preview: { host: '127.0.0.1', port: 5174, strictPort: true, headers },
    build: { outDir: `${systemRoot}/dist/client`, emptyOutDir: true }
  };
});
