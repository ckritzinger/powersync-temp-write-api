import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

// Read only this system's configuration, never a parent .env.
const config = await readFile(new URL('../.local/runtime.env', import.meta.url), 'utf8');
const port = /^BACKEND_PORT=(\d+)$/m.exec(config)?.[1] ?? '6061';
const base = `http://127.0.0.1:${port}`;
async function request(route, options) {
  return fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
}
const health = await request('/');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { message: 'backend' });
const jwks = await request('/api/auth/keys');
assert.equal(jwks.status, 200);
const { keys } = await jwks.json();
assert.equal(keys.length, 1);
assert.equal(keys[0].alg, 'RS256');
for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) assert.equal(keys[0][field], undefined);
const stored = JSON.parse(await readFile(new URL('../.local/signing-keys.json', import.meta.url), 'utf8'));
assert.deepEqual(keys[0], stored.publicJwk);
const tokenResponse = await request('/api/auth/token?user_id=phase-one');
assert.equal(tokenResponse.status, 200);
const { token } = await tokenResponse.json();
assert.equal(typeof token, 'string');
if (process.argv.includes('--restart')) {
  execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', 'restart', 'backend'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit'
  });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { ready = (await request('/')).ok; } catch { /* Wait for this restart. */ }
    if (ready) break;
    await setTimeout(500);
  }
  assert.ok(ready, 'Backend failed to become ready after restart');
  console.log('Backend restarted; verifying the previously issued token.');
}
const body = JSON.stringify({ transactions: [{ crud: [] }] });
for (const bearer of [undefined, 'invalid']) {
  const response = await request('/api/data', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }
  });
  assert.equal(response.status, 401);
}
const response = await request('/api/data', {
  method: 'POST', body,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }
});
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { results: [{ status: 'success' }] });
console.log('PASS: health, public JWKS, persistent key, missing/invalid token rejection, and authenticated database transaction.');
if (process.argv.includes('--widgets')) {
  const id = randomUUID();
  async function upload(op, op_data) {
    const response = await request('/api/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ transactions: [{ crud: [{ op, table: 'widgets', id, ...(op_data ? { op_data } : {}) }] }] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [{ status: 'success' }] });
  }
  function source(query) {
    return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', 'exec', '-T', 'postgres',
      'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-U', 'test_admin', '-d', 'test_system', '-c', query], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8'
    }).trim();
  }
  try {
    await upload('PUT', { name: 'phase two API insert' });
    assert.equal(source(`SELECT name FROM public.widgets WHERE id='${id}'`), 'phase two API insert');
    await upload('PATCH', { name: 'phase two API update' });
    assert.equal(source(`SELECT name FROM public.widgets WHERE id='${id}'`), 'phase two API update');
    await upload('DELETE');
    assert.equal(source(`SELECT count(*) FROM public.widgets WHERE id='${id}'`), '0');
    console.log('PASS: real API PUT/PATCH/DELETE with the restricted writer role, confirmed in source Postgres.');
  } finally {
    source(`DELETE FROM public.widgets WHERE id='${id}'`);
  }
}
