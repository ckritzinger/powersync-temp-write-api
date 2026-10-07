import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { generateTLS } from './generate-tls.mjs';
import { issueTunnelCertificate } from './tunnel-tls.mjs';
import { root } from './phase-three.mjs';
import { local, readEnv } from './local-config.mjs';

const fixture = new URL('remote-jwks-check/', local);
const runtime = await readEnv('runtime.env');
const outage = process.argv.includes('--outage');
if (process.argv.slice(2).some(arg => arg !== '--outage')) throw new Error('Only --outage is supported.');
const fixtureIP = runtime.JWKS_FIXTURE_IP ?? (runtime.BACKEND_DB_IP ?? '172.29.77.3').replace(/\.\d+$/, '.4');
if ([runtime.BACKEND_DB_IP, runtime.POSTGRES_DB_IP ?? '172.29.77.2'].includes(fixtureIP)) throw new Error('Configure JWKS_FIXTURE_IP to a free address in the test-system subnet.');
await mkdir(fixture, { recursive: true, mode: 0o700 });
await generateTLS(fixture);
await issueTunnelCertificate('jwks-fixture', fixture);
const signing = JSON.parse(await readFile(new URL('signing-keys.json', local), 'utf8'));
await writeFile(new URL('keys.json', fixture), JSON.stringify({ keys: [signing.publicJwk] }), { mode: 0o600 });
await writeFile(new URL('auth-config.json', fixture), JSON.stringify({ config: { client_auth: { jwks_uri: 'https://jwks-fixture:8443/keys' } } }), { mode: 0o600 });
await writeFile(new URL('server.mjs', fixture), `
import https from 'node:https';
import {readFileSync,writeFileSync} from 'node:fs';
let requests=0;
https.createServer({key:readFileSync('/fixture/tls/server.key'),cert:readFileSync('/fixture/tls/server.crt')},(req,res)=>{
  if(req.url!='/keys'){res.writeHead(404);res.end();return;}
  writeFileSync('/tmp/key-fetch-count',String(++requests));
  res.setHeader('content-type','application/json');res.end(readFileSync('/fixture/keys.json'));
}).listen(8443,'0.0.0.0');
`, { mode: 0o600 });
await writeFile(new URL('compose.yaml', fixture), JSON.stringify({ services: {
  backend: {
    environment: { NODE_EXTRA_CA_CERTS: '/test-ca/ca.crt' },
    volumes: [
      { type: 'bind', source: './.local/remote-jwks-check/auth-config.json', target: '/run/secrets/auth-config.json', read_only: true },
      { type: 'bind', source: './.local/remote-jwks-check/tls/ca.crt', target: '/test-ca/ca.crt', read_only: true }
    ],
    depends_on: { 'jwks-fixture': { condition: 'service_started' } }
  },
  'jwks-fixture': {
    image: 'node:24-bookworm-slim', command: ['node', '/fixture/server.mjs'],
    networks: { default: { ipv4_address: fixtureIP } },
    volumes: [{ type: 'bind', source: './.local/remote-jwks-check', target: '/fixture', read_only: true }]
  }
} }, null, 2), { mode: 0o600 });
const overlay = args => execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', '-f', 'compose.yaml', '-f', '.local/remote-jwks-check/compose.yaml', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
const base = `http://127.0.0.1:${runtime.BACKEND_PORT ?? '6061'}`;
async function ready() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Backend restarting. */ }
    await setTimeout(200);
  }
  throw new Error('Fixture backend did not become healthy.');
}
async function transaction(token) {
  return fetch(`${base}/api/data`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ transactions: [{ crud: [] }] }), signal: AbortSignal.timeout(15000)
  });
}
try {
  overlay(['up', '-d', '--force-recreate', '--wait', 'backend', 'auth']);
  execFileSync(process.execPath, ['scripts/smoke.mjs'], { cwd: root, stdio: 'inherit' });
  const count = Number(overlay(['exec', '-T', 'jwks-fixture', 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/tmp/key-fetch-count','utf8'))"]));
  assert.ok(count > 0, 'Backend did not fetch the HTTPS JWKS.');
  console.log('PASS: the real backend fetched HTTPS JWKS with CA trust and verified a signed token through a database transaction.');
  if (outage) {
    const minted = await fetch(`${base}/api/auth/token?user_id=jwks-outage`, { signal: AbortSignal.timeout(10000) });
    assert.equal(minted.status, 200);
    const { token } = await minted.json();
    overlay(['stop', 'jwks-fixture']);
    overlay(['restart', 'backend']);
    await ready();
    const failed = await transaction(token);
    assert.equal(failed.status, 401, 'Fresh verifier must reject authentication while its remote JWKS is unavailable.');
    // Restart clears both the successful key cache and any failed-fetch cooldown.
    overlay(['up', '-d', '--wait', 'jwks-fixture']);
    overlay(['restart', 'backend']);
    await ready();
    const recovered = await transaction(token);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { results: [{ status: 'success' }] });
    const fetchedAfterRecovery = Number(overlay(['exec', '-T', 'jwks-fixture', 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/tmp/key-fetch-count','utf8'))"]));
    assert.ok(fetchedAfterRecovery > 0);
    await writeFile(new URL('jwks-outage-result.json', local), JSON.stringify({
      status: 'passed', scope: 'Isolated HTTPS fixture, actual backend and Postgres; no Cloud account or public tunnel',
      freshVerifier: true, inlineFallback: false, outageHttpStatus: failed.status,
      recoveryHttpStatus: recovered.status, sameTokenAcceptedAfterRecovery: true,
      fetchedAfterRecovery: true
    }, null, 2) + '\n', { mode: 0o600 });
    console.log('PASS: unavailable remote JWKS returned 401 with a fresh verifier; the same token succeeded after endpoint/backend recovery.');
  }
} finally {
  // Remove the overlay containers; the next base startup uses the untouched auth files.
  overlay(['down']);
}
