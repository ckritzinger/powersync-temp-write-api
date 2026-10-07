import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { local, readEnv, parseEnv } from './local-config.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const names = { api: 'powersync-test-system-api', database: 'powersync-test-system-db' };
export function hasInlineKeyFallback(jwks) {
  return jwks !== undefined && !(Array.isArray(jwks?.keys) && jwks.keys.length === 0);
}
export function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}
export function tcpEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'tcp:' || !url.port || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(url.hostname) || Number(url.port) > 65535 || Number(url.port) < 1) {
    throw new Error('Expected a public tcp://hostname:port endpoint.');
  }
  return { hostname: url.hostname, port: Number(url.port), url: `tcp://${url.hostname}:${url.port}` };
}
export function discoverTunnels(data, runtime) {
  function select(name, protocol, port) {
    const matches = data.tunnels?.filter(t => t.name === name && t.proto === protocol);
    if (matches?.length !== 1) throw new Error(`Expected exactly one running ${name} ${protocol} tunnel.`);
    const tunnel = matches[0];
    const upstream = String(tunnel.config?.addr ?? '');
    if (![ `127.0.0.1:${port}`, `http://127.0.0.1:${port}`, `tcp://127.0.0.1:${port}` ].includes(upstream)) {
      throw new Error(`Unexpected upstream for ${name}; refusing another project's tunnel.`);
    }
    return tunnel.public_url;
  }
  return {
    apiOrigin: origin(select(names.api, 'https', runtime.BACKEND_PORT ?? '6061')),
    database: tcpEndpoint(select(names.database, 'tcp', runtime.POSTGRES_PORT ?? '5433'))
  };
}
export async function saveJSON(name, value) {
  await writeFile(new URL(name, local), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export async function readJSON(name) { return JSON.parse(await readFile(new URL(name, local), 'utf8')); }
export async function readEndpoints() {
  const endpoints = await readJSON('tunnel-endpoints.json');
  const database = tcpEndpoint(endpoints.database?.url);
  if (database.hostname !== endpoints.database.hostname || database.port !== endpoints.database.port) throw new Error('Inconsistent captured TCP endpoint. Capture the current endpoints again.');
  return { ...endpoints, apiOrigin: origin(endpoints.apiOrigin), database };
}
export async function target() {
  const value = await readJSON('cloud-target.json').catch(() => { throw new Error('Run cloud:configure with the dedicated instance URL and IDs first.'); });
  value.instanceUrl = origin(value.instanceUrl);
  if (new URL(value.instanceUrl).hostname.endsWith('.invalid')) throw new Error('A real Cloud instance URL is required.');
  for (const field of ['instanceId', 'projectId']) if (!/^[a-f0-9]{24}$/i.test(value[field] ?? '')) throw new Error(`Missing/invalid Cloud ${field}.`);
  if (value.orgId && !/^[a-f0-9]{24}$/i.test(value.orgId)) throw new Error('Invalid Cloud orgId.');
  return value;
}
export async function updateRuntime(values) {
  let text = await readFile(new URL('runtime.env', local), 'utf8');
  const existing = await readEnv('runtime.env');
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error('Invalid runtime configuration value.');
    const line = `${key}=${value}`;
    text = key in existing ? text.replace(new RegExp(`^${key}=.*$`, 'm'), () => line) : text.trimEnd() + '\n' + line + '\n';
  }
  await writeFile(new URL('runtime.env', local), text, { mode: 0o600 });
}
export function compose(args, options = {}) {
  const source = parseEnv(readFileSync(new URL('runtime.env', local), 'utf8')).DATABASE_TYPE ?? 'postgres';
  const files = ['mongodb', 'mysql', 'mssql'].includes(source) && !args.includes('-f') ? ['-f', 'compose.yaml', '-f', `compose.${source}.yaml`] : [];
  return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', ...files, ...args], { cwd: root, encoding: 'utf8', ...options });
}
export async function cli(args) {
  const config = await target();
  const env = { ...process.env };
  for (const key of ['API_URL', 'INSTANCE_ID', 'PROJECT_ID', 'ORG_ID']) delete env[key];
  try { env.PS_ADMIN_TOKEN = (await readFile(new URL('powersync-admin-token.txt', local), 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // CLI stdout may contain full source configuration; callers must keep it private.
  try {
    return execFileSync('powersync', [...args, '--directory', '.local/cloud', '--instance-id', config.instanceId,
      '--project-id', config.projectId, ...(config.orgId ? ['--org-id', config.orgId] : [])],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 360000 });
  } catch (error) {
    const logName = `cloud/${args.slice(0, 2).join('-').replace(/[^a-z0-9-]/gi, '')}-error.log`;
    await writeFile(new URL(logName, local), `${error.stdout ?? ''}\n${error.stderr ?? ''}`, { mode: 0o600 });
    throw new Error(`PowerSync CLI ${args.slice(0, 2).join(' ')} failed. Private diagnostics saved to .local/${logName}. Check instance IDs, login/PAT permissions, and CLI version. Output suppressed because it may contain configuration secrets.`);
  }
}
