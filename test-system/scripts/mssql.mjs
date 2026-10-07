import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { local, readEnv } from './local-config.mjs';
import { setupMSSQL } from './mssql-setup.mjs';
import { mssqlReplicationReady } from './mssql-replication.mjs';
import { prepareBackend } from './prepare-backend.mjs';
import { root, compose, cli, target, readEndpoints, readJSON, saveJSON, updateRuntime } from './phase-three.mjs';

function run(script, args = []) {
  execFileSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, stdio: 'inherit', timeout: 600000 });
}
async function snapshotCloud() {
  const currentTarget = await target();
  let previous;
  try {
    previous = await readJSON('mssql-cloud-restore.json');
    if (JSON.stringify(previous.target) !== JSON.stringify(currentTarget)) throw new Error('Saved restore configuration belongs to another Cloud instance.');
    if ((await readEnv('runtime.env')).DATABASE_TYPE === 'mssql') return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const exported = JSON.parse(await cli(['fetch', 'config', '--output=json']));
  if (exported.config?.replication?.connections?.[0]?.type !== 'postgresql' || typeof exported.syncRules !== 'string') {
    throw new Error('The first source switch must save a complete working Postgres Cloud configuration.');
  }
  if (previous) {
    await mkdir(new URL('mssql-restore-history/', local), { recursive: true, mode: 0o700 });
    await saveJSON(`mssql-restore-history/restore-${Date.now()}.json`, previous);
  }
  await saveJSON('mssql-cloud-restore.json', { target: currentTarget, exported, capturedAt: new Date().toISOString() });
  console.log('Saved private Postgres Cloud restore configuration; auth keys and source data preserved.');
}
async function probe() {
  if ((await readEnv('runtime.env')).DATABASE_TYPE !== 'postgres') throw new Error('Run the independent startup probe with Postgres selected.');
  await setupMSSQL();
  const files = ['-f', 'compose.yaml', '-f', 'compose.mssql.yaml'];
  compose([...files, 'up', '-d', '--wait', 'mssql'], { env: { ...process.env, MSSQL_PORT: '5434' }, stdio: 'inherit' });
  compose([...files, 'exec', '-T', 'mssql', 'sh', '/fixture/init.sh'], { stdio: 'pipe' });
  const id = randomUUID();
  const sql = `SET NOCOUNT ON;
SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128));
SELECT status_desc FROM sys.dm_server_services WHERE servicename LIKE 'SQL Server Agent%';
INSERT INTO dbo.widgets(id,name) VALUES('${id}','CDC startup probe');
WAITFOR DELAY '00:00:08';
SELECT COUNT(*) FROM cdc.dbo_widgets_CT WHERE id='${id}';
DELETE FROM dbo.widgets WHERE id='${id}';
GO`;
  const result = compose([...files, 'exec', '-T', 'mssql', 'sh', '-c', 'SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" exec /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -d test_system -b -y 0 -w 65535'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim().split(/\r?\n/).map(s => s.trim());
  if (result[1] !== 'Running' || Number(result[2]) < 1) throw new Error('SQL Server Agent/CDC startup gate failed; Postgres remains selected.');
  await saveJSON('mssql-startup-result.json', { status: 'passed', verifiedAt: new Date().toISOString(), version: result[0], hostArchitecture: process.arch, containerPlatform: 'linux/amd64', emulated: process.arch === 'arm64', microsoftSupportedHost: process.arch !== 'arm64', agentRunning: true, cdcChangeObserved: true, cloudChanged: false });
  console.log('SQL Server startup and CDC capture passed before source switching.');
}
async function mssqlUp() {
  const runtime = await readEnv('runtime.env');
  if ((runtime.DATABASE_TYPE ?? 'postgres') === 'postgres') await probe();
  if ((runtime.DATABASE_TYPE ?? 'postgres') === 'postgres') await saveJSON('mssql-runtime-restore.json', {
    DATABASE_TYPE: 'postgres', DATABASE_URI: runtime.DATABASE_URI
  });
  if (!['postgres', 'mssql'].includes(runtime.DATABASE_TYPE ?? 'postgres')) throw new Error('Restore Postgres before switching to SQL Server.');
  await setupMSSQL();
  if (runtime.DATABASE_TYPE !== 'mssql') {
    compose(['stop', 'backend', 'auth', 'postgres'], { stdio: 'inherit' });
    const credentials = await readEnv('mssql.env');
    await updateRuntime({ DATABASE_TYPE: 'mssql', DATABASE_URI: `mssql://test_writer:${credentials.WRITE_DB_PASSWORD}@mssql:1433/test_system?encrypt=true&trustServerCertificate=false` });
  }
  await updateRuntime({ MSSQL_PORT: runtime.POSTGRES_PORT ?? '5433' });
  compose(['up', '-d', '--wait', 'mssql'], { stdio: 'inherit' });
  compose(['exec', '-T', 'mssql', 'sh', '/fixture/init.sh'], { stdio: 'pipe' });
  await prepareBackend();
  compose(['up', '-d', '--build', '--force-recreate', '--wait', 'backend', 'auth'], { stdio: 'inherit' });
}
async function awaitMSSQLReplication(timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = JSON.parse(await cli(['status', '--output=json']));
    if (mssqlReplicationReady(status)) {
      console.log('Cloud active sync rules replicate dbo.widgets with initial replication complete.');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  await writeFile(new URL('cloud/status.json', local), JSON.stringify(status, null, 2), { mode: 0o600 });
  // Table names and error levels only; messages can echo connection details.
  const summary = ['active_sync_rules', 'deploying_sync_rules'].map(key => `${key}: ${status?.[key]?.connections?.map(c =>
    `${c.tables?.map(t => `${t.schema}.${t.name}`).join(',')} done=${c.initial_replication_done}`).join('; ') ?? 'none'}`);
  throw new Error(`Cloud did not replicate dbo.widgets within ${timeoutMs / 1000}s (${summary.join(' | ')}). Status saved privately to .local/cloud/status.json.`);
}
async function mssqlCloud() {
  await snapshotCloud();
  if ((await readEnv('runtime.env')).DATABASE_TYPE !== 'mssql') throw new Error('Start the SQL Server fixture before changing Cloud.');
  try {
    run('cloud', ['prepare']); run('cloud', ['deploy-service']); run('cloud', ['validate']); run('cloud', ['deploy-sync']);
    run('cloud', ['fetch']); run('cloud', ['install-export']); run('cloud', ['status']);
    await awaitMSSQLReplication();
  } catch (error) {
    // Capture source diagnostics before finally switches the TCP endpoint back to Postgres.
    try { run('cloud', ['status']); } catch {}
    throw error;
  }
}
async function restore() {
  const snapshot = await readJSON('mssql-cloud-restore.json');
  if (JSON.stringify(snapshot.target) !== JSON.stringify(await target())) throw new Error('Cloud target changed; refusing restore to another instance.');
  if ((await readEnv('runtime.env')).DATABASE_TYPE === 'mssql') compose(['stop', 'backend', 'auth', 'mssql'], { stdio: 'inherit' });
  await updateRuntime(await readJSON('mssql-runtime-restore.json'));
  compose(['up', '-d', '--wait', 'postgres'], { stdio: 'inherit' });
  await prepareBackend();
  compose(['up', '-d', '--build', '--force-recreate', '--wait', 'backend', 'auth'], { stdio: 'inherit' });
  const endpoints = await readEndpoints();
  const service = structuredClone(snapshot.exported.config);
  // Restore the writer-known replication credential rather than a secret_ref potentially
  // changed by the intervening deployment. This is this fixture's own database user.
  service.replication.connections[0].password = { secret: (await readEnv('database.env')).REPLICATION_DB_PASSWORD };
  service.replication.connections[0].hostname = endpoints.database.hostname;
  service.replication.connections[0].port = endpoints.database.port;
  service.replication.connections[0].cacert = await readFile(new URL('tls/ca.crt', local), 'utf8');
  await writeFile(new URL('cloud/service.yaml', local), JSON.stringify(service, null, 2) + '\n', { mode: 0o600 });
  await writeFile(new URL('cloud/sync-config.yaml', local), snapshot.exported.syncRules, { mode: 0o600 });
  await saveJSON('cloud/prepared-target.json', { ...snapshot.target, endpoints, source: 'postgres' });
  run('cloud', ['deploy-service']); run('cloud', ['validate']); run('cloud', ['deploy-sync']); run('cloud', ['fetch']); run('cloud', ['install-export']);
  run('verify-cloud');
  console.log('Restored and verified Postgres on the same Cloud instance; SQL Server data retained.');
}
const command = process.argv[2];
if (command === 'setup') { await setupMSSQL(); console.log('SQL Server fixture material ready.'); }
else if (command === 'probe') await probe();
else if (command === 'up') { await snapshotCloud(); await mssqlUp(); }
else if (command === 'cloud') await mssqlCloud();
else if (command === 'restore') await restore();
else if (command === 'acceptance') {
  await snapshotCloud();
  await saveJSON('mssql-acceptance-result.json', { status: 'running', startedAt: new Date().toISOString(), source: 'mssql', restoredSource: null });
  try {
    await mssqlUp(); run('verify-mssql'); await mssqlCloud();
    run('prepare-client');
    execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'client/playwright-cloud.config.ts', '--project=mssql'],
      { cwd: root, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '.local/playwright' }, stdio: 'inherit', timeout: 600000 });
  } catch (error) {
    await saveJSON('mssql-acceptance-result.json', { status: 'failed', failedAt: new Date().toISOString(), source: 'mssql', restoredSource: null, diagnostics: 'Private CLI logs and browser assertion output; never treat this as passed.' });
    throw error;
  } finally {
    try { await restore(); } catch (error) {
      await saveJSON('mssql-acceptance-result.json', { status: 'failed', stage: 'restore', failedAt: new Date().toISOString(), source: 'mssql', restoredSource: null });
      throw error;
    }
    try {
      const receipt = await readJSON('mssql-acceptance-result.json');
      if (receipt.status === 'failed') await saveJSON('mssql-acceptance-result.json', { ...receipt, restoredSource: 'postgres', restoreVerifiedAt: new Date().toISOString() });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await saveJSON('mssql-acceptance-result.json', { status: 'passed', verifiedAt: new Date().toISOString(),
    source: 'mssql', restoredSource: 'postgres', mssqlRecoveryFix: 'test-patch', nativeCheckpointCDC: true, sameCloudInstance: (await target()).instanceId,
    cases: ['local-api', 'cloud-crud-offline', 'backend-outage', 'mssql-established-session-outage', 'sdk-stop-skip', 'client-decisions', 'postgres-live-restore'] });
} else throw new Error('Use setup, probe, up, cloud, restore or acceptance.');
