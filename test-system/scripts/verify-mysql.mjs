import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { local, readEnv } from './local-config.mjs';
import { compose, saveJSON } from './phase-three.mjs';
import { mysqlDocument, mysqlCount, mysqlDelete, mysqlQuery } from './mysql-source.mjs';

const runtime = await readEnv('runtime.env');
assert.equal(runtime.DATABASE_TYPE, 'mysql', 'Select MySQL first.');
const backend = `http://127.0.0.1:${runtime.BACKEND_PORT ?? '6061'}`;
const { token } = await (await fetch(`${backend}/api/auth/token?user_id=mysql-local`)).json();
const ids = new Set();
const id = () => { const value = randomUUID(); ids.add(value); return value; };
const put = (id, name) => ({ op: 'PUT', table: 'widgets', id, op_data: { name } });
const transaction = (...crud) => ({ crud });
async function post(transactions, source = 'mysql') {
  const response = await fetch(`${backend}/api/data`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-test-system-source': source
  }, body: JSON.stringify({ transactions }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}
const document = mysqlDocument;
const observations = [];
const settings = mysqlQuery("SELECT @@gtid_mode,@@log_bin,@@binlog_format,@@binlog_row_image;");
assert.equal(settings, 'ON\t1\tROW\tFULL');
assert.equal(mysqlQuery('SELECT @@event_scheduler;'), 'ON');
const heartbeat = Number(mysqlQuery('SELECT seq FROM powersync_fixture_heartbeat WHERE id=1;'));
await new Promise(resolve => setTimeout(resolve, 2500));
assert.ok(Number(mysqlQuery('SELECT seq FROM powersync_fixture_heartbeat WHERE id=1;')) > heartbeat, 'Fixture heartbeat must advance the binlog.');
const tls = JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e',
  "const mysql=require('/app/node_modules/mysql2/promise'); (async()=>{const c=await mysql.createConnection(process.env.DATABASE_URI);const [rows]=await c.query(\"SHOW SESSION STATUS LIKE 'Ssl_cipher'\");console.log(JSON.stringify({cipher:rows[0].Value,verified:c.config.ssl.rejectUnauthorized!==false,hasCA:!!c.config.ssl.ca}));await c.end();})().catch(()=>{console.error('Writer TLS verification probe failed');process.exit(1)});"], { stdio: 'pipe' }));
assert.ok(tls.cipher); assert.equal(tls.verified, true); assert.equal(tls.hasCA, true);
try {
  const widget = id();
  assert.equal((await post([transaction(put(widget, 'mysql local'))])).body.results[0].status, 'success');
  assert.equal(document(widget).name, 'mysql local');
  assert.equal((await post([transaction(put(widget, 'mysql local'))])).body.results[0].status, 'success');
  assert.equal(mysqlCount(widget), 1);
  assert.equal((await post([transaction({ op: 'PATCH', table: 'widgets', id: widget, op_data: { name: 'renamed' } })])).body.results[0].status, 'success');
  assert.equal(document(widget).name, 'renamed');
  assert.equal((await post([transaction({ op: 'DELETE', table: 'widgets', id: widget })])).body.results[0].status, 'success');
  assert.equal(document(widget), null);
  const missingName = id();
  const missing = await post([transaction({ op: 'PUT', table: 'widgets', id: missingName, op_data: {} })]);
  assert.equal(missing.body.results[0].failed_operation.error_code, 'NOT_NULL_VIOLATION');
  assert.equal(missing.body.results[0].failed_operation.operation_index, 0);
  assert.equal(document(missingName), null);
  const wrongSource = id();
  assert.equal((await post([transaction(put(wrongSource, 'wrong source'))], 'postgres')).status, 409);
  assert.equal(document(wrongSource), null);
  for (const mode of ['stop', 'skip']) {
    await writeFile(new URL('mysql-batch.compose.json', local), JSON.stringify({ services: { backend: { environment: { BATCH_ON_FATAL_ERROR: mode } } } }), { mode: 0o600 });
    compose(['-f', 'compose.yaml', '-f', 'compose.mysql.yaml', '-f', '.local/mysql-batch.compose.json', 'up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
    const first = id(), valid = id(), invalid = id(), last = id();
    const result = await post([transaction(put(first, 'first')), transaction(put(valid, 'rollback'), put(invalid, null)), transaction(put(last, 'last'))]);
    assert.equal(result.status, 200);
    const results = result.body.results;
    assert.deepEqual(results.map(r => r.status), ['success', 'fatal_error', mode === 'stop' ? 'not_attempted' : 'success']);
    assert.equal(results[1].failed_operation.error_code, 'NOT_NULL_VIOLATION');
    assert.equal(results[1].failed_operation.operation_index, 1);
    assert.equal(results[1].requires_client_handling, false);
    assert.equal(document(valid), null); assert.equal(document(invalid), null);
    assert.equal(document(first).name, 'first');
    assert.equal(document(last)?.name ?? null, mode === 'skip' ? 'last' : null);
    observations.push({ mode, statuses: results.map(r => r.status), failedOperation: 1, rollbackDocuments: 0 });
  }
  await saveJSON('mysql-local-result.json', { status: 'passed', verifiedAt: new Date().toISOString(), source: 'mysql',
    scope: 'Actual write API and authenticated MySQL source with verified writer TLS; no Cloud sync claim',
    crudAndReplay: true, sourceMismatchRejected: true, writerTLSVerified: true, heartbeatObserved: true, mysqlRecoveryFix: "test-patch", sparseRequiredFieldRejected: true, binlog: { gtid: true, format: "ROW", rowImage: "FULL" }, observations });
  console.log('MySQL local API CRUD, replay, source isolation, validation and stop/skip rollback passed.');
} finally {
  compose(['up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
  mysqlDelete([...ids]);
}
