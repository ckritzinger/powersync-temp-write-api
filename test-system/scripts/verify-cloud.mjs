import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readEnv, local } from './local-config.mjs';
import { target, readJSON, readEndpoints, origin, tcpEndpoint, discoverTunnels, saveJSON, compose } from './phase-three.mjs';
import { syncRequest, waitForWidget } from './sync-probe.mjs';

const config = await target();
const endpoints = await readEndpoints();
const runtime = await readEnv('runtime.env');
assert.equal(runtime.DATABASE_TYPE ?? 'postgres', 'postgres', 'Use the selected source acceptance command for non-Postgres live verification.');
const agentResponse = await fetch('http://127.0.0.1:4041/api/tunnels', { signal: AbortSignal.timeout(5000) });
assert.ok(agentResponse.ok, 'The test-system ngrok agent is unavailable.');
const current = discoverTunnels(await agentResponse.json(), runtime);
assert.equal(current.apiOrigin, endpoints.apiOrigin, 'HTTPS endpoint changed. Capture and update Cloud configuration.');
assert.equal(current.database.url, endpoints.database.url, 'TCP endpoint changed. Capture and update Cloud configuration.');
const publicAPI = origin(endpoints.apiOrigin);
const database = tcpEndpoint(endpoints.database.url);
const localAPI = `http://127.0.0.1:${runtime.BACKEND_PORT ?? '6061'}`;
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`Expected public JSON without a tunnel interstitial (HTTP ${response.status}).`);
  }
  return response.json();
}
const jwks = await json(`${publicAPI}/api/auth/keys`, { headers: { accept: 'application/json' } });
const stored = await readJSON('signing-keys.json');
assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0);
for (const key of jwks.keys) for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
  assert.equal(key[field], undefined, 'Public JWKS exposed private signing material.');
}
assert.ok(jwks.keys.some(key => key.kid === stored.publicJwk.kid && key.n === stored.publicJwk.n && key.e === stored.publicJwk.e));
console.log('PASS: public HTTPS JWKS returns the expected public signing key without bypass headers.');
execFileSync('openssl', ['s_client', '-starttls', 'postgres', '-connect', `${database.hostname}:${database.port}`,
  '-servername', database.hostname, '-CAfile', fileURLToPath(new URL('tls/ca.crt', local)),
  '-verify_hostname', database.hostname, '-verify_return_error'], { input: '', stdio: 'pipe', timeout: 15000 });
const sql = `set -eu\nPGPASSWORD="$REPLICATION_DB_PASSWORD" psql -X -v ON_ERROR_STOP=1 -At "host=${database.hostname} port=${database.port} dbname=test_system user=powersync_role sslmode=verify-full sslrootcert=/test-tls/ca.crt" -c "SELECT current_user, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"\n`;
const replica = compose(['exec', '-T', 'postgres', 'sh', '-s'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
assert.equal(replica, 'powersync_role|t');
console.log('PASS: public TCP tunnel verifies the certificate hostname and authenticates the replication role over TLS.');
const { token, powersync_url } = await json(`${localAPI}/api/auth/token?user_id=phase-three`);
assert.equal(powersync_url, config.instanceUrl);
const invalid = await fetch(`${config.instanceUrl}/sync/stream`, syncRequest('invalid', AbortSignal.timeout(15000)));
assert.equal(invalid.status, 401, 'Cloud should reject an invalid token.');
await invalid.body?.cancel();
const id = randomUUID();
const name = `phase-three-${id}`;
async function upload(op, data) {
  const result = await json(`${publicAPI}/api/data`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ transactions: [{ crud: [{ op, table: 'widgets', id, ...(data ? { op_data: data } : {}) }] }] })
  });
  assert.deepEqual(result, { results: [{ status: 'success' }] });
}
try {
  await upload('PUT', { name });
  const response = await fetch(`${config.instanceUrl}/sync/stream`, syncRequest(token, AbortSignal.timeout(45000)));
  await waitForWidget(response, id, name);
  console.log('PASS: Cloud accepts the test-provider JWT and syncs the uploaded widget through a completed checkpoint.');
} finally { await upload('DELETE'); }
const auth = await readJSON('auth-state.json');
const exported = await readJSON('auth-config.json');
assert.equal(auth.kind, 'cloud-export', 'Install the real Cloud export before marking Phase 3 accepted.');
assert.equal(auth.instanceId, config.instanceId);
assert.equal(exported.config?.client_auth?.jwks_uri, `${publicAPI}/api/auth/keys`);
await saveJSON('phase-three-result.json', { verifiedAt: new Date().toISOString(), checks: ['public-jwks', 'public-postgres-verify-full', 'replication-login', 'invalid-token-rejection', 'cloud-widget-checkpoint', 'cloud-export-installed'] });
console.log('Phase 3 live verification passed; test row deleted. Sanitized receipt saved in .local/phase-three-result.json.');
