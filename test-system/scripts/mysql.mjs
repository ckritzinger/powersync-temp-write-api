import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { local, readEnv } from './local-config.mjs';
import { setupMySQL } from './mysql-setup.mjs';
import { prepareBackend } from './prepare-backend.mjs';
import { root, compose, cli, target, readEndpoints, readJSON, saveJSON, updateRuntime } from './phase-three.mjs';

function run(script, args = []) {
  execFileSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, stdio: 'inherit', timeout: 600000 });
}
async function snapshotCloud() {
  const currentTarget = await target();
  let previous;
  try {
    previous = await readJSON('mysql-cloud-restore.json');
    if (JSON.stringify(previous.target) !== JSON.stringify(currentTarget)) throw new Error('Saved restore configuration belongs to another Cloud instance.');
    if ((await readEnv('runtime.env')).DATABASE_TYPE === 'mysql') return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const exported = JSON.parse(await cli(['fetch', 'config', '--output=json']));
  if (exported.config?.replication?.connections?.[0]?.type !== 'postgresql' || typeof exported.syncRules !== 'string') {
    throw new Error('The first source switch must save a complete working Postgres Cloud configuration.');
  }
  if (previous) {
    await mkdir(new URL('mysql-restore-history/', local), { recursive: true, mode: 0o700 });
    await saveJSON(`mysql-restore-history/restore-${Date.now()}.json`, previous);
  }
  await saveJSON('mysql-cloud-restore.json', { target: currentTarget, exported, capturedAt: new Date().toISOString() });
  console.log('Saved private Postgres Cloud restore configuration; auth keys and source data preserved.');
}
async function mysqlUp() {
  const runtime = await readEnv('runtime.env');
  if ((runtime.DATABASE_TYPE ?? 'postgres') === 'postgres') await saveJSON('mysql-runtime-restore.json', {
    DATABASE_TYPE: 'postgres', DATABASE_URI: runtime.DATABASE_URI
  });
  if (!['postgres', 'mysql'].includes(runtime.DATABASE_TYPE ?? 'postgres')) throw new Error('Restore Postgres before switching to MySQL.');
  await setupMySQL();
  if (runtime.DATABASE_TYPE !== 'mysql') {
    compose(['stop', 'backend', 'auth', 'postgres'], { stdio: 'inherit' });
    const credentials = await readEnv('mysql.env');
    const ca = await readFile(new URL('mysql-tls/ca.crt', local), 'utf8');
    const ssl = encodeURIComponent(JSON.stringify({ ca, rejectUnauthorized: true }));
    await updateRuntime({ DATABASE_TYPE: 'mysql', DATABASE_URI: `mysql://test_writer:${credentials.WRITE_DB_PASSWORD}@mysql:3306/test_system?ssl=${ssl}&connectTimeout=5000` });
  }
  compose(['up', '-d', '--wait', 'mysql'], { stdio: 'inherit' });
  compose(['exec', '-T', 'mysql', 'sh', '/fixture/init.sh'], { stdio: 'pipe' });
  await prepareBackend();
  compose(['up', '-d', '--build', '--force-recreate', '--wait', 'backend', 'auth'], { stdio: 'inherit' });
}
async function mysqlCloud() {
  await snapshotCloud();
  if ((await readEnv('runtime.env')).DATABASE_TYPE !== 'mysql') throw new Error('Start the MySQL fixture before changing Cloud.');
  try {
    run('cloud', ['prepare']); run('cloud', ['deploy-service']); run('cloud', ['validate']); run('cloud', ['deploy-sync']);
    run('cloud', ['fetch']); run('cloud', ['install-export']); run('cloud', ['status']);
  } catch (error) {
    // Capture source diagnostics before finally switches the TCP endpoint back to Postgres.
    try { run('cloud', ['status']); } catch {}
    throw error;
  }
}
async function restore() {
  const snapshot = await readJSON('mysql-cloud-restore.json');
  if (JSON.stringify(snapshot.target) !== JSON.stringify(await target())) throw new Error('Cloud target changed; refusing restore to another instance.');
  if ((await readEnv('runtime.env')).DATABASE_TYPE === 'mysql') compose(['stop', 'backend', 'auth', 'mysql'], { stdio: 'inherit' });
  await updateRuntime(await readJSON('mysql-runtime-restore.json'));
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
  console.log('Restored and verified Postgres on the same Cloud instance; MySQL data retained.');
}
const command = process.argv[2];
if (command === 'setup') { await setupMySQL(); console.log('MySQL fixture material ready.'); }
else if (command === 'up') { await snapshotCloud(); await mysqlUp(); }
else if (command === 'cloud') await mysqlCloud();
else if (command === 'restore') await restore();
else if (command === 'acceptance') {
  await snapshotCloud();
  await saveJSON('mysql-acceptance-result.json', { status: 'running', startedAt: new Date().toISOString(), source: 'mysql', restoredSource: null });
  try {
    await mysqlUp(); run('verify-mysql'); await mysqlCloud();
    run('prepare-client');
    execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'client/playwright-cloud.config.ts', '--project=mysql'],
      { cwd: root, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '.local/playwright' }, stdio: 'inherit', timeout: 600000 });
  } catch (error) {
    await saveJSON('mysql-acceptance-result.json', { status: 'failed', failedAt: new Date().toISOString(), source: 'mysql', restoredSource: null, diagnostics: 'Private CLI logs and browser assertion output; never treat this as passed.' });
    throw error;
  } finally {
    try { await restore(); } catch (error) {
      await saveJSON('mysql-acceptance-result.json', { status: 'failed', stage: 'restore', failedAt: new Date().toISOString(), source: 'mysql', restoredSource: null });
      throw error;
    }
    try {
      const receipt = await readJSON('mysql-acceptance-result.json');
      if (receipt.status === 'failed') await saveJSON('mysql-acceptance-result.json', { ...receipt, restoredSource: 'postgres', restoreVerifiedAt: new Date().toISOString() });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await saveJSON('mysql-acceptance-result.json', { status: 'passed', verifiedAt: new Date().toISOString(),
    source: 'mysql', restoredSource: 'postgres', mysqlRecoveryFix: 'test-patch', checkpointHeartbeat: true, sameCloudInstance: (await target()).instanceId,
    cases: ['local-api', 'cloud-crud-offline', 'backend-outage', 'mysql-established-session-outage', 'sdk-stop-skip', 'client-decisions', 'postgres-live-restore'] });
} else throw new Error('Use setup, up, cloud, restore or acceptance.');
