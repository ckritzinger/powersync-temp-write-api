import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { local, readEnv } from './local-config.mjs';
import { target, compose } from './phase-three.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Select Node 24.');
for (const [tool, args] of [['openssl', ['version']], ['ngrok', ['version']], ['powersync', ['--version']]]) {
  try { execFileSync(tool, args, { stdio: 'pipe', timeout: 10000 }); }
  catch { throw new Error(`Required tool unavailable: ${tool}.`); }
}
await readEnv('runtime.env');
await readEnv('database.env');
for (const file of ['signing-keys.json', 'auth-config.json', 'tls/server.crt', 'tls/server.key', 'tls/ca.crt']) {
  await access(new URL(file, local));
}
compose(['config', '--quiet'], { stdio: 'pipe' });
execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: 10000 });
if (process.argv.includes('--cloud')) {
  await target();
  await access(new URL('ngrok.yml', local));
  console.log('PASS: local prerequisites, Cloud target IDs, and project tunnel configuration. Cloud account permissions and endpoint reachability are verified by fetch/validate/live checks.');
} else console.log('PASS: Node 24, OpenSSL, ngrok, PowerSync CLI, Docker, local configuration, and Compose syntax.');
