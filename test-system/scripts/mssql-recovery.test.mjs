import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { applyPatch } from './prepare-backend.mjs';

const patches = JSON.parse(await readFile(new URL('../backend/patches/mssql-recovery.json', import.meta.url)));
function load(source, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => { if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; }, console: { debug() {}, error() {} }, Error, Set });
  return exports;
}
const errors = load(await readFile(new URL('../../backend/src/errors.ts', import.meta.url), 'utf8'));
const classifier = load(await readFile(new URL('../../backend/src/persistence/mssql/mssql-errors.ts', import.meta.url), 'utf8'), { '../../errors.js': errors });
async function adapter(connect, uri) {
  let source = await readFile(new URL('../../backend/src/persistence/mssql/mssql-persistence.ts', import.meta.url), 'utf8');
  for (const patch of patches) source = applyPatch(source, patch);
  let config;
  const api = load(source, {
    '../../errors.js': errors, url: { URL }, mssql: { default: { ConnectionPool: class {
      constructor(value) { config = value; } on() {} connect() { return connect(); }
    } } }, './mssql-errors.js': classifier, '../../mapping/default.js': { defaultMapper: op => op }
  });
  await api.createMSSQLPersister(uri);
  return config;
}
test('SQL Server fixture keeps initial transient failures retryable and authentication failures fatal', async () => {
  for (const code of ['ECONNREFUSED', 'ESOCKET', 'ETIMEOUT']) {
    await assert.rejects(adapter(async () => { throw Object.assign(new Error('source unavailable'), { code }); }, 'mssql://writer:fixture@host:1433/test'), errors.RetryableError);
  }
  await assert.rejects(adapter(async () => { throw Object.assign(new Error('bad login'), { code: 'ELOGIN' }); }, 'mssql://writer:fixture@host:1433/test'), errors.FatalOperationError);
});
test('SQL Server fixture verifies certificates by default and forwards explicit TLS settings', async () => {
  const config = await adapter(async () => {}, 'mssql://writer:fixture@host:1433/test');
  assert.equal(config.options.encrypt, true); assert.equal(config.options.trustServerCertificate, false);
  const overridden = await adapter(async () => {}, 'mssql://writer:fixture@host:1433/test?encrypt=false&trustServerCertificate=true');
  assert.equal(overridden.options.encrypt, false); assert.equal(overridden.options.trustServerCertificate, true);
});
