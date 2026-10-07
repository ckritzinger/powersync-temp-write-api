import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { local } from './local-config.mjs';
import { cli, origin, target, saveJSON, readJSON, readEndpoints, updateRuntime, compose, hasInlineKeyFallback } from './phase-three.mjs';
import { issueTunnelCertificate } from './tunnel-tls.mjs';
import { readEnv } from './local-config.mjs';
import { sourceType, connectionForSource } from './source-config.mjs';

const command = process.argv[2];
await mkdir(new URL('cloud/', local), { recursive: true, mode: 0o700 });
if (command === 'configure') {
  const value = {};
  for (const [flag, field] of [['--instance-url', 'instanceUrl'], ['--instance-id', 'instanceId'], ['--project-id', 'projectId'], ['--org-id', 'orgId']]) {
    const index = process.argv.indexOf(flag);
    if (index >= 0) value[field] = process.argv[index + 1];
  }
  value.instanceUrl = origin(value.instanceUrl);
  for (const field of ['instanceId', 'projectId']) if (!/^[a-f0-9]{24}$/i.test(value[field] ?? '')) throw new Error(`Supply ${field} as a 24-character Cloud ID.`);
  if (value.orgId && !/^[a-f0-9]{24}$/i.test(value.orgId)) throw new Error('Invalid orgId.');
  if (new URL(value.instanceUrl).hostname.endsWith('.invalid')) throw new Error('Supply the real instance URL.');
  await saveJSON('cloud-target.json', value);
  await updateRuntime({ POWERSYNC_URL: value.instanceUrl });
  console.log('Configured the dedicated Cloud target and token audience. Recreate the backend to load changes.');
} else if (command === 'fetch') {
  const parsed = JSON.parse(await cli(['fetch', 'config', '--output=json']));
  if (!parsed.config || typeof parsed.config !== 'object') throw new Error('CLI export is missing its complete config wrapper.');
  const name = process.argv.includes('--baseline') ? 'cloud-original.json' : 'cloud-export.json';
  if (name === 'cloud-original.json') {
    try { await writeFile(new URL(name, local), JSON.stringify(parsed, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; throw new Error('Baseline already exists; preserve it or explicitly archive it before fetching a new baseline.'); }
  } else await saveJSON(name, parsed);
  await saveJSON(name === 'cloud-original.json' ? 'cloud-original-target.json' : 'cloud-export-target.json', await target());
  console.log(`Saved the complete private export to .local/${name}; no configuration values printed.`);
} else if (command === 'bootstrap') {
  const config = await target();
  const endpoints = await readEndpoints();
  const source = sourceType(await readEnv('runtime.env'));
  const changed = source === 'postgres' && await issueTunnelCertificate(endpoints.database.hostname);
  if (source === 'mssql') await import('./mssql-setup.mjs').then(m => m.setupMSSQL());
  if (source === 'mysql') await import('./mysql-setup.mjs').then(m => m.setupMySQL());
  if (source === 'mongodb') await import('./mongodb-setup.mjs').then(m => m.setupMongoDB());
  await updateRuntime({ POWERSYNC_URL: config.instanceUrl });
  const history = new URL('auth-history/', local);
  await mkdir(history, { recursive: true, mode: 0o700 });
  await writeFile(new URL(`auth-${Date.now()}.json`, history), await readFile(new URL('auth-config.json', local)), { mode: 0o600 });
  await saveJSON('auth-config.json', { config: { client_auth: { jwks_uri: `${origin(endpoints.apiOrigin)}/api/auth/keys` } } });
  await saveJSON('auth-state.json', { kind: 'bootstrap', capturedAt: endpoints.capturedAt });
  if (changed) compose(['restart', 'postgres'], { stdio: 'inherit' });
  if (source === 'mssql') compose(['restart', 'mssql'], { stdio: 'inherit' });
  if (source === 'mysql') compose(['restart', 'mysql'], { stdio: 'inherit' });
  if (source === 'mongodb') compose(['restart', 'mongodb'], { stdio: 'inherit' });
  compose(['up', '-d', '--force-recreate', '--wait', 'backend', 'auth'], { stdio: 'inherit' });
  console.log('Installed generated remote-JWKS bootstrap configuration and tunnel-host TLS certificate. JWT and database keys are preserved.');
} else if (command === 'prepare') {
  const config = await target();
  const endpoints = await readEndpoints();
  const source = sourceType(await readEnv('runtime.env'));
  const database = await readEnv(source === 'postgres' ? 'database.env' : `${source}.env`);
  const baseline = await readJSON('cloud-original.json');
  const baselineTarget = await readJSON('cloud-original-target.json');
  if (baselineTarget.instanceId !== config.instanceId || baselineTarget.projectId !== config.projectId || baselineTarget.orgId !== config.orgId) {
    throw new Error('Baseline belongs to another Cloud target. Archive it and fetch the dedicated target baseline first.');
  }
  if (!baseline.config?.name || !baseline.config?.region) throw new Error('Fetch a complete baseline containing the instance name and region first.');
  const service = {
    ...baseline.config,
    _type: 'cloud',
    replication: { connections: [connectionForSource(source, endpoints.database, database, await readFile(new URL('tls/ca.crt', local), 'utf8'))] },
    client_auth: { jwks_uri: `${origin(endpoints.apiOrigin)}/api/auth/keys`, additional_audiences: [], allow_temporary_tokens: false }
  };
  // JSON is valid YAML, and avoids escaping certificate/secret values by hand.
  await writeFile(new URL('cloud/service.yaml', local), JSON.stringify(service, null, 2) + '\n', { mode: 0o600 });
  await writeFile(new URL('cloud/sync-config.yaml', local), await readFile(new URL(`../powersync/sync-config${source === 'postgres' ? '' : '.' + source}.yaml`, import.meta.url)), { mode: 0o600 });
  await saveJSON('cloud/prepared-target.json', { ...config, endpoints, source });
  console.log('Prepared .local/cloud/service.yaml and sync-config.yaml for the dedicated instance; review locally before deploy.');
} else if (['validate', 'deploy', 'deploy-service', 'deploy-sync'].includes(command)) {
  const expected = await target();
  const prepared = await readJSON('cloud/prepared-target.json');
  const endpoints = await readEndpoints();
  const source = sourceType(await readEnv('runtime.env'));
  if (prepared.instanceId !== expected.instanceId || prepared.projectId !== expected.projectId || prepared.orgId !== expected.orgId || prepared.instanceUrl !== expected.instanceUrl ||
      prepared.endpoints.apiOrigin !== endpoints.apiOrigin || prepared.endpoints.database.url !== endpoints.database.url || (prepared.source ?? 'postgres') !== source) {
    throw new Error('Target/endpoints changed since preparation. Regenerate and review the Cloud configuration first.');
  }
  const operation = command === 'deploy-service' ? ['deploy', 'service-config'] : command === 'deploy-sync' ? ['deploy', 'sync-config'] : [command];
  const output = await cli(operation);
  await writeFile(new URL(`cloud/${command}.log`, local), output, { mode: 0o600 });
  console.log(`Cloud ${command} completed; CLI output kept privately in .local/cloud/${command}.log.`);
} else if (command === 'install-export') {
  const exported = await readJSON('cloud-export.json');
  const endpoints = await readEndpoints();
  const config = await target();
  const exportTarget = await readJSON('cloud-export-target.json');
  if (exportTarget.instanceId !== config.instanceId || exportTarget.projectId !== config.projectId || exportTarget.orgId !== config.orgId) throw new Error('Export belongs to another Cloud target. Fetch the current target export first.');
  if (exported.config?.client_auth?.jwks_uri !== `${origin(endpoints.apiOrigin)}/api/auth/keys` || hasInlineKeyFallback(exported.config.client_auth.jwks)) {
    throw new Error('Export must use this tunnel JWKS URI without inline-key fallback. Fetch the deployed configuration after fixing Cloud auth.');
  }
  await saveJSON('auth-config.json', exported);
  await saveJSON('auth-state.json', { kind: 'cloud-export', instanceId: config.instanceId });
  compose(['up', '-d', '--force-recreate', '--wait', 'backend', 'auth'], { stdio: 'inherit' });
  console.log('Installed the complete Cloud export and recreated the backend.');
} else if (command === 'status') {
  const output = await cli(['status', '--output=json']);
  await writeFile(new URL('cloud/status.json', local), output, { mode: 0o600 });
  console.log('Saved Cloud diagnostics privately to .local/cloud/status.json.');
} else throw new Error('Use configure, fetch, bootstrap, prepare, validate, deploy, install-export, or status.');
