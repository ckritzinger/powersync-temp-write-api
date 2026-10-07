import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { local, readEnv } from './local-config.mjs';
import { names, root, discoverTunnels, saveJSON } from './phase-three.mjs';

const command = process.argv[2];
const runtime = await readEnv('runtime.env');
if (command === 'configure') {
  const index = process.argv.indexOf('--account-config');
  if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw new Error('Supply an explicit ngrok account config path.');
  const accountPath = index >= 0 ? path.resolve(process.argv[index + 1] ?? '') : null;
  if (accountPath?.includes(',')) throw new Error('ngrok account config path cannot contain commas.');
  let token;
  if (!accountPath) {
    token = process.env.NGROK_AUTHTOKEN ?? await readFile(new URL('ngrok-authtoken.txt', local), 'utf8').catch(() => {
      throw new Error('Put your test authtoken in .local/ngrok-authtoken.txt, set NGROK_AUTHTOKEN, or explicitly pass --account-config /path/to/your/ngrok.yml.');
    });
    token = token.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid ngrok authtoken format.');
  }
  for (const key of ['BACKEND_PORT', 'POSTGRES_PORT']) if (!/^\d+$/.test(runtime[key])) throw new Error(`Invalid ${key}.`);
  const template = await readFile(new URL('../tunnels/ngrok.example.yml', import.meta.url), 'utf8');
  const text = template.replace(/^#.*\n/m, '').replace('authtoken: REPLACE_WITH_YOUR_TEST_NGROK_AUTHTOKEN\n', token ? `authtoken: ${token}\n` : '')
    .replace('127.0.0.1:6061', `127.0.0.1:${runtime.BACKEND_PORT}`).replace('127.0.0.1:5433', `127.0.0.1:${runtime.POSTGRES_PORT}`);
  await writeFile(new URL('ngrok.yml', local), text, { mode: 0o600 });
  await saveJSON('ngrok-account.json', { configPath: accountPath });
  try { execFileSync('ngrok', ['config', 'check', '--config', fileURLToPath(new URL('ngrok.yml', local))], { stdio: 'pipe' }); }
  catch { throw new Error('ngrok configuration validation failed. Check the installed ngrok version.'); }
  console.log('Configured only the test-system HTTPS/TCP tunnels; ngrok request inspection is disabled.');
} else if (command === 'start') {
  // This port belongs to this agent; do not attach to an unrelated running ngrok process.
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Port 4041 is occupied; stop the previous test-system tunnel agent first.')));
    server.listen(4041, '127.0.0.1', () => server.close(resolve));
  });
  const account = JSON.parse(await readFile(new URL('ngrok-account.json', local), 'utf8'));
  const configs = [account.configPath, fileURLToPath(new URL('ngrok.yml', local))].filter(Boolean);
  const child = spawn('ngrok', ['start', names.api, names.database, '--config', configs.join(',')], { cwd: root, stdio: 'inherit' });
  child.once('error', () => { console.error('Cannot start ngrok; check installation.'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else if (command === 'capture') {
  const response = await fetch('http://127.0.0.1:4041/api/tunnels', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Cannot list test-system tunnels.');
  const endpoints = discoverTunnels(await response.json(), runtime);
  await saveJSON('tunnel-endpoints.json', { ...endpoints, capturedAt: new Date().toISOString() });
  console.log('Captured test-system endpoint addresses in .local/tunnel-endpoints.json.');
} else throw new Error('Use configure, start, or capture.');
