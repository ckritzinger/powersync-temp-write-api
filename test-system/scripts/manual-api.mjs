import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { local, readEnv } from './local-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = await readEnv('runtime.env');
const base = `http://127.0.0.1:${runtime.BACKEND_PORT ?? '6061'}`;
const { privateJwk } = JSON.parse(await readFile(new URL('signing-keys.json', local), 'utf8'));
const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const content = `${encode({ alg: 'RS256', typ: 'JWT', kid: privateJwk.kid })}.${encode({
    sub: 'manual-api', iss: runtime.JWT_ISSUER, aud: runtime.POWERSYNC_URL,
    iat: now, exp: now + 300, ...overrides
  })}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), key).toString('base64url')}`;
}
const goodToken = token();
let batchMode = runtime.BATCH_ON_FATAL_ERROR ?? 'stop';
async function upload(body, bearer = goodToken) {
  const response = await fetch(`${base}/api/data`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: await response.json() };
}
const transaction = (...crud) => ({ crud });
const put = (id, name) => ({ op: 'PUT', table: 'widgets', id, op_data: { name } });
function source(query) {
  return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', 'exec', '-T', 'postgres',
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-U', 'test_admin', '-d', 'test_system', '-c', query],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function withRows(count, action) {
  const ids = Array.from({ length: count }, () => randomUUID());
  try { await action(ids); }
  finally { source(`DELETE FROM public.widgets WHERE id IN (${ids.map(id => `'${id}'`).join(',')})`); }
}
function success(response, statuses) {
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results.map(result => result.status), statuses);
}

const cases = {
  async auth() {
    const body = { transactions: [transaction()] };
    for (const bearer of ['', 'invalid', token({ exp: 1 }), token({ iss: 'wrong-issuer' }), token({ aud: 'https://wrong-audience.invalid' })]) {
      assert.equal((await upload(body, bearer)).status, 401);
    }
    success(await upload(body), ['success']);
  },
  async validation() {
    for (const body of [{}, { transactions: [] }, { transactions: [{}] },
      { transactions: [transaction({ op: 'UNKNOWN', table: 'widgets', id: randomUUID() })] },
      { transactions: Array.from({ length: 51 }, () => transaction()) }]) {
      assert.equal((await upload(body)).status, 400);
    }
    success(await upload({ transactions: Array.from({ length: 50 }, () => transaction()) }), Array(50).fill('success'));
  },
  async rollback() {
    await withRows(2, async ([first, second]) => {
      const response = await upload({ transactions: [transaction(put(first, 'rollback first'), put(second, null))] });
      success(response, ['fatal_error']);
      assert.equal(response.body.results[0].requires_client_handling, false);
      assert.equal(response.body.results[0].failed_operation.error_code, 'NOT_NULL_VIOLATION');
      assert.equal(response.body.results[0].failed_operation.operation_index, 1);
      assert.equal(source(`SELECT count(*) FROM public.widgets WHERE id IN ('${first}','${second}')`), '0');
    });
  },
  async batch() {
    const mode = batchMode;
    assert.ok(['stop', 'skip'].includes(mode));
    await withRows(3, async ([first, invalid, last]) => {
      const response = await upload({ transactions: [
        transaction(put(first, 'before failure')), transaction(put(invalid, null)), transaction(put(last, 'after failure'))
      ] });
      success(response, ['success', 'fatal_error', mode === 'skip' ? 'success' : 'not_attempted']);
      assert.equal(source(`SELECT count(*) FROM public.widgets WHERE id='${first}'`), '1');
      assert.equal(source(`SELECT count(*) FROM public.widgets WHERE id='${invalid}'`), '0');
      assert.equal(source(`SELECT count(*) FROM public.widgets WHERE id='${last}'`), mode === 'skip' ? '1' : '0');
    });
  },
  async replay() {
    await withRows(1, async ([id]) => {
      const body = { transactions: [transaction(put(id, 'replayed put'))] };
      success(await upload(body), ['success']);
      success(await upload(body), ['success']);
      assert.equal(source(`SELECT count(*) FROM public.widgets WHERE id='${id}' AND name='replayed put'`), '1');
    });
  },
  async crossUser() {
    await withRows(1, async ([id]) => {
      success(await upload({ transactions: [transaction(put(id, 'created by A'))] }, token({ sub: 'manual-A' })), ['success']);
      success(await upload({ transactions: [transaction({ op: 'PATCH', table: 'widgets', id, op_data: { name: 'updated by B' } })] }, token({ sub: 'manual-B' })), ['success']);
      assert.equal(source(`SELECT name FROM public.widgets WHERE id='${id}'`), 'updated by B');
    });
  }
};

const selected = process.argv[2] ?? 'all';
const bothModes = process.argv[3] === '--both-batch-modes';
if (process.argv.length > 4 || (process.argv[3] && !bothModes) || (selected !== 'all' && !Object.hasOwn(cases, selected))) {
  throw new Error(`Choose all or one case: ${Object.keys(cases).join(', ')}.`);
}
const results = [];
for (const [name, run] of Object.entries(cases)) {
  if (selected !== 'all' && selected !== name) continue;
  try {
    if (name === 'batch' && bothModes) {
      const override = new URL('manual-batch.compose.json', local);
      const compose = (files) => execFileSync('docker', ['compose', '--env-file', '.local/runtime.env',
        '-f', 'compose.yaml', ...files, 'up', '-d', '--wait', '--no-deps', 'backend'],
        { cwd: root, stdio: 'pipe', timeout: 120000 });
      try {
        for (const mode of ['stop', 'skip']) {
          await writeFile(override, JSON.stringify({ services: { backend: { environment: { BATCH_ON_FATAL_ERROR: mode } } } }), { mode: 0o600 });
          compose(['-f', fileURLToPath(override)]);
          batchMode = mode;
          await run();
          results.push({ name: `batch-${mode}`, status: 'passed' });
          console.log(`PASS: batch-${mode}`);
        }
      } finally {
        compose([]);
        batchMode = runtime.BATCH_ON_FATAL_ERROR ?? 'stop';
      }
    } else { await run(); results.push({ name, status: 'passed' }); console.log(`PASS: ${name}`); }
  }
  catch (error) {
    results.push({ name, status: 'failed', failure: error instanceof assert.AssertionError ? error.message : error.name });
    console.error(`FAIL: ${name}; inspect .local/manual-api-result.json and local service state, then rerun this case.`);
    process.exitCode = 1; break;
  }
}
await writeFile(new URL('manual-api-result.json', local), JSON.stringify({
  scope: 'Local API and source Postgres only; no Cloud sync acceptance',
  batchMode: runtime.BATCH_ON_FATAL_ERROR ?? 'stop',
  cases: results
}, null, 2) + '\n', { mode: 0o600 });
