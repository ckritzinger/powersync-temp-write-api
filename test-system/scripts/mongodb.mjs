import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { local, readEnv } from './local-config.mjs';
import { setupMongoDB } from './mongodb-setup.mjs';
import { prepareBackend } from './prepare-backend.mjs';
import { root, compose, cli, target, readEndpoints, readJSON, saveJSON, updateRuntime } from './phase-three.mjs';

function run(script, args = []) {
  execFileSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: root, stdio: 'inherit', timeout: 600000 });
}
async function snapshotCloud() {
  const currentTarget = await target();
  let previous;
  try {
    previous = await readJSON('mongodb-cloud-restore.json');
    if (JSON.stringify(previous.target) !== JSON.stringify(currentTarget)) throw new Error('Saved restore configuration belongs to another Cloud instance.');
    if ((await readEnv('runtime.env')).DATABASE_TYPE === 'mongodb') return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const exported = JSON.parse(await cli(['fetch', 'config', '--output=json']));
  if (exported.config?.replication?.connections?.[0]?.type !== 'postgresql' || typeof exported.syncRules !== 'string') {
    throw new Error('The first source switch must save a complete working Postgres Cloud configuration.');
  }
  if (previous) {
    await mkdir(new URL('mongodb-restore-history/', local), { recursive: true, mode: 0o700 });
    await saveJSON(`mongodb-restore-history/restore-${Date.now()}.json`, previous);
  }
  await saveJSON('mongodb-cloud-restore.json', { target: currentTarget, exported, capturedAt: new Date().toISOString() });
  console.log('Saved private Postgres Cloud restore configuration; auth keys and source data preserved.');
}
async function mongoUp() {
  const runtime = await readEnv('runtime.env');
  if ((runtime.DATABASE_TYPE ?? 'postgres') === 'postgres') await saveJSON('mongodb-runtime-restore.json', {
    DATABASE_TYPE: 'postgres', DATABASE_URI: runtime.DATABASE_URI
  });
  await setupMongoDB();
  if (runtime.DATABASE_TYPE !== 'mongodb') {
    compose(['stop', 'backend', 'auth', 'postgres'], { stdio: 'inherit' });
    const credentials = await readEnv('mongodb.env');
    await updateRuntime({ DATABASE_TYPE: 'mongodb', DATABASE_URI:
      `mongodb://test_writer:${credentials.WRITE_DB_PASSWORD}@mongodb:27017/test_system?authSource=test_system&replicaSet=rs0&directConnection=true&tls=true&tlsCAFile=/run/mongo-tls/ca.crt&serverSelectionTimeoutMS=5000` });
  }
  compose(['up', '-d', '--wait', 'mongodb'], { stdio: 'inherit' });
  compose(['exec', '-T', 'mongodb', 'mongosh', '--quiet', '--tls', '--tlsCAFile', '/run/mongo-tls/ca.crt', '/fixture/init.js'], { stdio: 'inherit' });
  await prepareBackend();
  compose(['up', '-d', '--build', '--force-recreate', '--wait', 'backend', 'auth'], { stdio: 'inherit' });
}
async function mongoCloud() {
  await snapshotCloud();
  if ((await readEnv('runtime.env')).DATABASE_TYPE !== 'mongodb') throw new Error('Start the MongoDB fixture before changing Cloud.');
  run('cloud', ['prepare']); run('cloud', ['deploy-service']); run('cloud', ['validate']); run('cloud', ['deploy-sync']);
  run('cloud', ['fetch']); run('cloud', ['install-export']); run('cloud', ['status']);
}
async function restore() {
  const snapshot = await readJSON('mongodb-cloud-restore.json');
  if (JSON.stringify(snapshot.target) !== JSON.stringify(await target())) throw new Error('Cloud target changed; refusing restore to another instance.');
  if ((await readEnv('runtime.env')).DATABASE_TYPE === 'mongodb') compose(['stop', 'backend', 'auth', 'mongodb'], { stdio: 'inherit' });
  await updateRuntime(await readJSON('mongodb-runtime-restore.json'));
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
  console.log('Restored and verified Postgres on the same Cloud instance; MongoDB data retained.');
}
const command = process.argv[2];
if (command === 'setup') { await setupMongoDB(); console.log('MongoDB fixture material ready.'); }
else if (command === 'up') { await snapshotCloud(); await mongoUp(); }
else if (command === 'cloud') await mongoCloud();
else if (command === 'restore') await restore();
else if (command === 'acceptance') {
  await snapshotCloud();
  try {
    await mongoUp(); run('verify-mongodb'); await mongoCloud();
    run('prepare-client');
    execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'client/playwright-cloud.config.ts', '--project=mongodb'],
      { cwd: root, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '.local/playwright' }, stdio: 'inherit', timeout: 600000 });
  } finally { await restore(); }
  await saveJSON('mongodb-acceptance-result.json', { status: 'passed', verifiedAt: new Date().toISOString(),
    source: 'mongodb', restoredSource: 'postgres', sameCloudInstance: (await target()).instanceId,
    cases: ['local-api', 'cloud-crud-offline', 'backend-outage', 'mongodb-established-session-outage', 'sdk-stop-skip', 'client-decisions', 'postgres-live-restore'] });
} else throw new Error('Use setup, up, cloud, restore or acceptance.');
