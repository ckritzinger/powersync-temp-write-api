import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { local, readEnv } from './local-config.mjs';
import { compose, saveJSON } from './phase-three.mjs';
import { mssqlDocument, mssqlCount, mssqlDelete, mssqlQuery } from './mssql-source.mjs';

const runtime = await readEnv('runtime.env');
assert.equal(runtime.DATABASE_TYPE, 'mssql', 'Select SQL Server first.');
const backend = `http://127.0.0.1:${runtime.BACKEND_PORT ?? '6061'}`;
const { token } = await (await fetch(`${backend}/api/auth/token?user_id=mssql-local`)).json();
const ids = new Set();
const id = () => { const value = randomUUID(); ids.add(value); return value; };
const put = (id, name) => ({ op: 'PUT', table: 'widgets', id, op_data: { name } });
const transaction = (...crud) => ({ crud });
async function post(transactions, source = 'mssql') {
  const response = await fetch(`${backend}/api/data`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-test-system-source': source
  }, body: JSON.stringify({ transactions }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}
const document = mssqlDocument;
const observations = [];
assert.equal(mssqlQuery("SELECT is_cdc_enabled FROM sys.databases WHERE name='test_system';"), '1');
assert.equal(mssqlQuery("SELECT COUNT(*) FROM cdc.change_tables WHERE source_object_id IN (OBJECT_ID('dbo.widgets'),OBJECT_ID('dbo._powersync_checkpoints'));"), '2');
const tls = JSON.parse(compose(['exec', '-T', 'backend', 'node', '-e',
  "const sql=require('/app/node_modules/mssql'); const u=new URL(process.env.DATABASE_URI); (async()=>{const c=await sql.connect({user:u.username,password:u.password,server:u.hostname,port:Number(u.port),database:u.pathname.slice(1),options:{encrypt:true,trustServerCertificate:false}});await c.query('SELECT 1'); console.log(JSON.stringify({encrypted:c.config.options.encrypt,verified:c.config.options.trustServerCertificate===false}));await c.close();})().catch(()=>{console.error('Writer TLS verification probe failed');process.exit(1)});"], { stdio: 'pipe' }));
assert.equal(tls.encrypted, true); assert.equal(tls.verified, true);
try {
  const widget = id();
  assert.equal((await post([transaction(put(widget, 'mssql local'))])).body.results[0].status, 'success');
  assert.equal(document(widget).name, 'mssql local');
  assert.equal((await post([transaction(put(widget, 'mssql local'))])).body.results[0].status, 'success');
  assert.equal(mssqlCount(widget), 1);
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
    await writeFile(new URL('mssql-batch.compose.json', local), JSON.stringify({ services: { backend: { environment: { BATCH_ON_FATAL_ERROR: mode } } } }), { mode: 0o600 });
    compose(['-f', 'compose.yaml', '-f', 'compose.mssql.yaml', '-f', '.local/mssql-batch.compose.json', 'up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
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
  await saveJSON('mssql-local-result.json', { status: 'passed', verifiedAt: new Date().toISOString(), source: 'mssql',
    scope: 'Actual write API and authenticated SQL Server source with verified writer TLS; no Cloud sync claim',
    crudAndReplay: true, sourceMismatchRejected: true, writerTLSVerified: true, nativeCheckpointCDC: true, mssqlRecoveryFix: "test-patch", sparseRequiredFieldRejected: true, cdcTables: 2, observations });
  console.log('SQL Server local API CRUD, replay, source isolation, validation and stop/skip rollback passed.');
} finally {
  compose(['up', '-d', '--wait', '--no-deps', 'backend'], { stdio: 'pipe' });
  mssqlDelete([...ids]);
}
