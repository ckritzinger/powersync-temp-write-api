import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { applyPatch, applyRecoveryPatch } from './prepare-backend.mjs';

const parent = new URL('../../backend/', import.meta.url);
const patches = JSON.parse(await readFile(new URL('../backend/patches/postgres-recovery.json', import.meta.url), 'utf8'));
const moduleUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
).toString('base64');
const errorsUrl = moduleUrl(await readFile(new URL('src/errors.ts', parent), 'utf8'));
const errors = await import(errorsUrl);
async function prepared(file) {
  let source = await readFile(new URL(file, parent), 'utf8');
  for (const patch of patches.filter(patch => patch.file === file)) source = applyRecoveryPatch(source, patch);
  return source.replaceAll("'../../errors.js'", JSON.stringify(errorsUrl));
}
const classifierUrl = moduleUrl(await prepared('src/persistence/postgres/postgres-errors.ts'));
const { classifyPostgresError } = await import(classifierUrl);

test('recovery patches fail closed if upstream no longer matches', () => {
  for (const patch of patches) {
    assert.throws(() => applyPatch('changed upstream', patch), /exactly one/);
    assert.throws(() => applyPatch(patch.before.repeat(2), patch), /exactly one/);
    assert.equal(applyRecoveryPatch(patch.after, patch), patch.after);
    assert.equal(applyRecoveryPatch(patch.before, patch), patch.after);
    assert.throws(() => applyRecoveryPatch(patch.after.repeat(2), patch), /exactly one/);
  }
});

test('transient transport failures retry while credential and constraint failures remain fatal', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', '08006', '40001', '57P01']) {
    assert.ok(classifyPostgresError({ code, message: 'transport fixture' }) instanceof errors.RetryableError, code);
  }
  for (const [code, expected] of [['23502', 'NOT_NULL_VIOLATION'], ['23505', 'UNIQUE_VIOLATION'], ['42501', 'SCHEMA_MISMATCH'], ['28P01', 'UNCLASSIFIED_ERROR'], ['UNKNOWN_DRIVER_ERROR', 'UNCLASSIFIED_ERROR']]) {
    const result = classifyPostgresError({ code, message: 'permanent fixture' });
    assert.ok(result instanceof errors.FatalOperationError, code);
    assert.equal(result.errorCode, expected);
  }
});

test('connection acquisition is classified and transaction cleanup remains intact', async () => {
  // Run the patched adapter itself with an injected pg pool; no source or env files are written.
  const pgUrl = moduleUrl('export default { Pool: class { constructor() { return globalThis.__testSystemRecoveryPool; } } };');
  const mapperUrl = moduleUrl('export const defaultMapper = (op) => op;');
  const adapterSource = (await prepared('src/persistence/postgres/postgres-persistence.ts'))
    .replace("'pg'", JSON.stringify(pgUrl))
    .replace("'./postgres-errors.js'", JSON.stringify(classifierUrl))
    .replace("'../../mapping/default.js'", JSON.stringify(mapperUrl));
  const { createPostgresPersister } = await import(moduleUrl(adapterSource));
  let releases = 0;
  const queries = [];
  const client = { query: async (sql) => { queries.push(sql); }, release: () => { releases++; } };
  let connect = async () => { throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }); };
  globalThis.__testSystemRecoveryPool = { on() {}, connect: () => connect() };
  try {
    const adapter = createPostgresPersister('postgres://fixture:fixture@localhost/fixture');
    await assert.rejects(adapter.updateBatch([], { sub: 'fixture' }), errors.RetryableError);
    assert.equal(releases, 0);
    assert.deepEqual(queries, []);
    connect = async () => { throw Object.assign(new Error('bad password'), { code: '28P01' }); };
    await assert.rejects(adapter.updateBatch([], { sub: 'fixture' }), errors.FatalOperationError);
    connect = async () => client;
    await adapter.updateBatch([], { sub: 'fixture' });
    assert.equal(queries[0], 'BEGIN');
    assert.equal(queries.at(-1), 'COMMIT');
    assert.equal(releases, 1);
    client.query = async (sql) => {
      queries.push(sql);
      if (sql === 'COMMIT') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    };
    await assert.rejects(adapter.updateBatch([], { sub: 'fixture' }), errors.RetryableError);
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.equal(releases, 2);
  } finally { delete globalThis.__testSystemRecoveryPool; }
});
