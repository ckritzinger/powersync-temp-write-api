import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { local, readEnv } from './local-config.mjs';
import { compose, saveJSON } from './phase-three.mjs';
import { mongoSource } from './mongo-source.mjs';

const runtime = await readEnv('runtime.env');
assert.equal(runtime.DATABASE_TYPE, 'mongodb', 'Select MongoDB first.');
const backend = `http://127.0.0.1:${runtime.BACKEND_PORT ?? '6061'}`;
const { token } = await (await fetch(`${backend}/api/auth/token?user_id=mongodb-local`)).json();
const ids = new Set();
const id = () => { const value = randomUUID(); ids.add(value); return value; };
const put = (id, name) => ({ op: 'PUT', table: 'widgets', id, op_data: { name } });
const transaction = (...crud) => ({ crud });
async function post(transactions, source = 'mongodb') {
  const response = await fetch(`${backend}/api/data`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-test-system-source': source
  }, body: JSON.stringify({ transactions }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}
const document = id => mongoSource(`source.widgets.findOne({_id:${JSON.stringify(id)}})`);
const observations = [];
try {
  const widget = id();
  assert.equal((await post([transaction(put(widget, 'mongo local'))])).body.results[0].status, 'success');
  assert.equal(document(widget).name, 'mongo local');
  assert.equal((await post([transaction(put(widget, 'mongo local'))])).body.results[0].status, 'success');
  assert.equal(mongoSource(`source.widgets.countDocuments({_id:${JSON.stringify(widget)}})`), 1);
  assert.equal((await post([transaction({ op: 'PATCH', table: 'widgets', id: widget, op_data: { name: 'renamed' } })])).body.results[0].status, 'success');
  assert.equal(document(widget).name, 'renamed');
  assert.equal((await post([transaction({ op: 'DELETE', table: 'widgets', id: widget })])).body.results[0].status, 'success');
  assert.equal(document(widget), null);
  const wrongSource = id();
  assert.equal((await post([transaction(put(wrongSource, 'wrong source'))], 'postgres')).status, 409);
  assert.equal(document(wrongSource), null);
  for (const mode of ['stop', 'skip']) {
    await writeFile(new URL('mongo-batch.compose.json', local), JSON.stringify({ services: { backend: { environment: { BATCH_ON_FATAL_ERROR: mode } } } }), { mode: 0o600 });
    compose(['-f', 'compose.yaml', '-f', 'compose.mongodb.yaml', '-f', '.local/mongo-batch.compose.json', 'up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
    const first = id(), valid = id(), invalid = id(), last = id();
    const result = await post([transaction(put(first, 'first')), transaction(put(valid, 'rollback'), put(invalid, null)), transaction(put(last, 'last'))]);
    assert.equal(result.status, 200);
    const results = result.body.results;
    assert.deepEqual(results.map(r => r.status), ['success', 'fatal_error', mode === 'stop' ? 'not_attempted' : 'success']);
    assert.equal(results[1].failed_operation.error_code, 'DOCUMENT_VALIDATION_FAILURE');
    assert.equal(results[1].failed_operation.operation_index, 1);
    assert.equal(results[1].requires_client_handling, false);
    assert.equal(document(valid), null); assert.equal(document(invalid), null);
    assert.equal(document(first).name, 'first');
    assert.equal(document(last)?.name ?? null, mode === 'skip' ? 'last' : null);
    observations.push({ mode, statuses: results.map(r => r.status), failedOperation: 1, rollbackDocuments: 0 });
  }
  await saveJSON('mongodb-local-result.json', { status: 'passed', verifiedAt: new Date().toISOString(), source: 'mongodb',
    scope: 'Actual write API and authenticated TLS replica-set source; no Cloud sync claim',
    crudAndReplay: true, sourceMismatchRejected: true, observations });
  console.log('MongoDB local API CRUD, replay, source isolation, validation and stop/skip rollback passed.');
} finally {
  compose(['up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
  mongoSource(`source.widgets.deleteMany({_id:{$in:${JSON.stringify([...ids])}}})`);
}
