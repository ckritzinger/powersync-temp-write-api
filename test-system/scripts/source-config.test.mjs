import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceType, connectionForSource } from './source-config.mjs';
import { readFile } from 'node:fs/promises';
import { applyPatch } from './prepare-backend.mjs';

test('source selection is explicit and retains Postgres defaults', () => {
  assert.equal(sourceType({}), 'postgres');
  assert.equal(sourceType({ DATABASE_TYPE: 'mongodb' }), 'mongodb');
  assert.equal(sourceType({ DATABASE_TYPE: 'mysql' }), 'mysql');
  assert.throws(() => sourceType({ DATABASE_TYPE: 'unsupported' }));
});
test('MongoDB uses direct replica-set TLS and separate credential fields; Postgres keeps verified TLS', () => {
  const endpoint = { hostname: '1.tcp.ngrok.io', port: 12345 };
  const credentials = { REPLICATION_DB_PASSWORD: 'fixture-secret' };
  const mongo = connectionForSource('mongodb', endpoint, credentials, 'fixture CA');
  assert.ok(!mongo.uri.includes(credentials.REPLICATION_DB_PASSWORD));
  assert.match(mongo.uri, /directConnection=true/);
  assert.match(mongo.uri, /tls=true/);
  assert.equal(mongo.post_images, 'read_only');
  assert.equal(mongo.password.secret, credentials.REPLICATION_DB_PASSWORD);
  const pg = connectionForSource('postgres', endpoint, credentials, 'fixture CA');
  assert.equal(pg.sslmode, 'verify-full'); assert.equal(pg.cacert, 'fixture CA');
  assert.throws(() => connectionForSource('unknown', endpoint, credentials, 'CA'));
});
test('fixture source guard patches fail closed when parent middleware changes', async () => {
  const source = await readFile(new URL('../../backend/app.ts', import.meta.url), 'utf8');
  const patches = JSON.parse(await readFile(new URL('../backend/patches/source-guard.json', import.meta.url), 'utf8'));
  let result = source;
  for (const patch of patches) { result = applyPatch(result, patch); assert.throws(() => applyPatch('unexpected source', patch)); }
  assert.match(result, /status\(409\)/);
});

test('MySQL connection targets the binlog fixture with separate credentials', () => {
  const connection = connectionForSource('mysql', { hostname: '1.tcp.ngrok.io', port: 12345 }, { REPLICATION_DB_PASSWORD: 'test-secret' }, 'CA');
  assert.equal(connection.type, 'mysql'); assert.equal(connection.database, 'test_system');
  assert.equal(connection.password.secret, 'test-secret'); assert.equal(connection.hostname, '1.tcp.ngrok.io');
});

test('SQL Server uses its native CDC source and explicit disposable certificate trust', () => {
  const c = connectionForSource('mssql', { hostname: '1.tcp.ngrok.io', port: 12345 }, { REPLICATION_DB_PASSWORD: 'fixture-secret' }, 'CA');
  assert.equal(sourceType({ DATABASE_TYPE: 'mssql' }), 'mssql');
  assert.equal(c.type, 'mssql'); assert.equal(c.schema, 'dbo');
  assert.equal(c.password.secret, 'fixture-secret');
  assert.equal(c.additionalConfig.trustServerCertificate, true);
});
