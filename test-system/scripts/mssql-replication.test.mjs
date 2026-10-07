import test from 'node:test';
import assert from 'node:assert/strict';
import { mssqlReplicationReady } from './mssql-replication.mjs';

const connection = (schema, done = true, errors = []) => ({ initial_replication_done: done, tables: [{ schema, name: 'widgets', errors }] });

test('SQL Server Cloud gate waits for active dbo.widgets replication', () => {
  assert.equal(mssqlReplicationReady({ active_sync_rules: { connections: [connection('dbo')] } }), true);
  assert.equal(mssqlReplicationReady({ active_sync_rules: { connections: [connection('dbo', false)] } }), false);
  assert.equal(mssqlReplicationReady({}), false);
});

test('SQL Server Cloud gate rejects leftover Postgres rules and pending deployments', () => {
  // Observed shape: Postgres rules still active after the service switched to SQL Server.
  const fatal = [{ level: 'fatal', message: "Invalid object name 'public.widgets'." }];
  assert.equal(mssqlReplicationReady({ active_sync_rules: { connections: [connection('public', true, fatal)], errors: fatal } }), false);
  assert.equal(mssqlReplicationReady({ active_sync_rules: { connections: [connection('dbo')] }, deploying_sync_rules: { connections: [connection('dbo', false)] } }), false);
  assert.equal(mssqlReplicationReady({ active_sync_rules: { connections: [connection('dbo', true, [{ level: 'fatal' }])] } }), false);
  assert.equal(mssqlReplicationReady({ active_sync_rules: { connections: [connection('dbo', true, [{ level: 'warning' }])] } }), true);
});
