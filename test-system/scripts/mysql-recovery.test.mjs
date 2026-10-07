import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { applyPatch } from './prepare-backend.mjs';

const patches = JSON.parse(await readFile(new URL('../backend/patches/mysql-recovery.json', import.meta.url)));
function load(source, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => { if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; }, console: { debug() {} }, Error, Set });
  return exports;
}
const errors = load(await readFile(new URL('../../backend/src/errors.ts', import.meta.url), 'utf8'));
async function patched(file) {
  let source = await readFile(new URL(`../../backend/${file}`, import.meta.url), 'utf8');
  for (const patch of patches.filter(p => p.file === file)) source = applyPatch(source, patch);
  return source;
}
const classifier = load(await patched('src/persistence/mysql/mysql-errors.ts'), { '../../errors.js': errors });
function adapter(pool) {
  return patched('src/persistence/mysql/mysql-persistence.ts').then(source => load(source, {
    '../../errors.js': errors, 'mysql2/promise': { default: { createPool: () => pool } },
    './mysql-errors.js': classifier, '../../mapping/default.js': { defaultMapper: op => ({ ...op, data: op.op_data ?? {} }) }
  }).createMySQLPersister('fixture://unused'));
}

test('MySQL fixture classifies pool acquisition failures without completing the queue', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const persister = await adapter({ getConnection: async () => { throw Object.assign(new Error('source unavailable'), { code }); } });
    await assert.rejects(persister.updateBatch([], {}), errors.RetryableError);
  }
  assert.ok(classifier.classifyMySQLError({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, message: 'bad auth' }) instanceof errors.FatalOperationError);
});

test('MySQL sparse required-field rejection rolls back and retains the failing operation index', async () => {
  let operations = 0, rolledBack = false, released = false, committed = false;
  const connection = { beginTransaction: async () => {}, execute: async () => {
    if (++operations === 2) throw Object.assign(new Error("Field 'name' doesn't have a default value"), { errno: 1364, sqlState: 'HY000' });
  }, rollback: async () => { rolledBack = true; }, release: () => { released = true; }, commit: async () => { committed = true; } };
  const persister = await adapter({ getConnection: async () => connection });
  await assert.rejects(persister.updateBatch([
    { op: 'PUT', table: 'widgets', id: 'first', op_data: { name: 'valid' } },
    { op: 'PUT', table: 'widgets', id: 'second', op_data: {} }
  ], {}), error => error instanceof errors.FatalOperationError && error.errorCode === 'NOT_NULL_VIOLATION' && error.operationIndex === 1);
  assert.equal(rolledBack, true); assert.equal(released, true); assert.equal(committed, false);
});
