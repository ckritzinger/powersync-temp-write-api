import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverTunnels, origin, tcpEndpoint, names, hasInlineKeyFallback } from './phase-three.mjs';
import { waitForWidget } from './sync-probe.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { generateTLS } from './generate-tls.mjs';
import { issueTunnelCertificate } from './tunnel-tls.mjs';
import { execFileSync } from 'node:child_process';

test('Cloud exports may omit inline keys or include an empty list, but cannot supply a fallback', () => {
  assert.equal(hasInlineKeyFallback(undefined), false);
  assert.equal(hasInlineKeyFallback({ keys: [] }), false);
  for (const jwks of [null, {}, { keys: null }, { keys: 'invalid' }, { keys: [{ kty: 'RSA' }] }]) {
    assert.equal(hasInlineKeyFallback(jwks), true);
  }
});

test('endpoint discovery rejects unrelated, ambiguous, or malformed tunnels', () => {
  const sample = { tunnels: [
    { name: names.api, proto: 'https', public_url: 'https://example.ngrok.app', config: { addr: 'http://127.0.0.1:6061' } },
    { name: names.database, proto: 'tcp', public_url: 'tcp://1.tcp.ngrok.io:12345', config: { addr: '127.0.0.1:5433' } }
  ] };
  assert.equal(discoverTunnels(sample, {}).database.port, 12345);
  assert.throws(() => discoverTunnels({ tunnels: sample.tunnels.slice(1) }, {}), /exactly one/);
  assert.throws(() => discoverTunnels({ tunnels: [...sample.tunnels, sample.tunnels[0]] }, {}), /exactly one/);
  assert.throws(() => discoverTunnels(sample, { BACKEND_PORT: '9999' }), /upstream/);
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path']) assert.throws(() => origin(url));
  for (const url of ['tcp://example.com', 'tcp://user:secret@example.com:1', 'tcp://example.com:1/path']) assert.throws(() => tcpEndpoint(url));
});

function stream(chunks, type = 'application/x-ndjson') {
  return new Response(new ReadableStream({ start(controller) {
    for (const text of chunks) controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  } }), { headers: { 'content-type': type } });
}
const put = JSON.stringify({ data: { data: [{ object_type: 'widgets', object_id: 'id', op: 'PUT', data: JSON.stringify({ name: 'test' }) }] } }) + '\n';
const checkpoint = JSON.stringify({ checkpoint_complete: { last_op_id: '1' } }) + '\n';
test('sync probe handles fragmented lines and requires the correct row plus a completed checkpoint', async () => {
  await waitForWidget(stream([put.slice(0, 8), put.slice(8) + checkpoint]), 'id', 'test');
  await assert.rejects(waitForWidget(stream([put]), 'id', 'test'), /ended/);
  await assert.rejects(waitForWidget(stream([put + checkpoint]), 'other-id', 'test'), /ended/);
  await assert.rejects(waitForWidget(stream(['<html>login</html>'], 'text/html'), 'id', 'test'), /NDJSON/);
  await assert.rejects(waitForWidget(stream([JSON.stringify({ checkpoint: { streams: [{ errors: ['failed'] }] } }) + '\n']), 'id', 'test'), /subscription/);
});

test('tunnel certificate issuance preserves keys and CA and adds verifiable hostname identity', async () => {
  const fixtures = new URL('../.generated/phase-three-fixtures/', import.meta.url);
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(fixtures) + 'tls-');
  const base = pathToFileURL(directory + '/');
  try {
    await generateTLS(base);
    const before = await Promise.all(['ca.crt', 'ca.key', 'server.key'].map(name => readFile(new URL(`tls/${name}`, base))));
    assert.equal(await issueTunnelCertificate('1.tcp.ngrok.io', base), true);
    const server = new X509Certificate(await readFile(new URL('tls/server.crt', base)));
    const ca = new X509Certificate(await readFile(new URL('tls/ca.crt', base)));
    assert.ok(server.checkHost('1.tcp.ngrok.io'));
    assert.ok(server.checkHost('postgres'));
    assert.ok(server.checkIP('127.0.0.1'));
    assert.ok(server.verify(ca.publicKey));
    assert.deepEqual(await Promise.all(['ca.crt', 'ca.key', 'server.key'].map(name => readFile(new URL(`tls/${name}`, base)))), before);
    const certificate = await readFile(new URL('tls/server.crt', base));
    assert.equal(await issueTunnelCertificate('1.tcp.ngrok.io', base), false);
    assert.deepEqual(await readFile(new URL('tls/server.crt', base)), certificate);
    await assert.rejects(issueTunnelCertificate('bad\nhost', base), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Cloud preparation uses the dedicated baseline and rejects another target before a deploy or auth change', async () => {
  const fixtures = new URL('../.generated/phase-three-fixtures/', import.meta.url);
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(fixtures) + 'cloud-');
  const base = pathToFileURL(directory + '/');
  const local = new URL('.local/', base);
  const config = { instanceUrl: 'https://cloud.example.com', instanceId: 'a'.repeat(24), projectId: 'b'.repeat(24) };
  try {
    await cp(new URL('./', import.meta.url), new URL('scripts/', base), { recursive: true });
    await cp(new URL('../powersync/', import.meta.url), new URL('powersync/', base), { recursive: true });
    await mkdir(new URL('tls/', local), { recursive: true });
    const save = (name, value) => writeFile(new URL(name, local), JSON.stringify(value));
    await save('cloud-target.json', config);
    await save('cloud-original-target.json', config);
    await save('cloud-original.json', { config: { _type: 'cloud', name: 'dedicated test', region: 'us', retention: { days: 3 } } });
    await save('tunnel-endpoints.json', { apiOrigin: 'https://test.ngrok.app', database: { url: 'tcp://1.tcp.ngrok.io:12345', hostname: '1.tcp.ngrok.io', port: 12345 } });
    await writeFile(new URL('runtime.env', local), 'DATABASE_TYPE=postgres\n');
    await writeFile(new URL('database.env', local), 'REPLICATION_DB_PASSWORD=fixture-only-secret\n');
    await writeFile(new URL('tls/ca.crt', local), 'fixture public CA');
    const run = command => execFileSync(process.execPath, [fileURLToPath(new URL('scripts/cloud.mjs', base)), command], { cwd: directory, stdio: 'pipe' });
    run('prepare');
    const service = JSON.parse(await readFile(new URL('cloud/service.yaml', local), 'utf8'));
    assert.equal(service.name, 'dedicated test');
    assert.equal(service.region, 'us');
    assert.deepEqual(service.retention, { days: 3 });
    assert.equal(service.replication.connections[0].sslmode, 'verify-full');
    assert.equal(service.replication.connections[0].password.secret, 'fixture-only-secret');
    assert.equal(service.client_auth.jwks_uri, 'https://test.ngrok.app/api/auth/keys');
    assert.match(await readFile(new URL('cloud/sync-config.yaml', local), 'utf8'), /auto_subscribe: true/);
    await writeFile(new URL('mongodb.env', local), 'REPLICATION_DB_PASSWORD=mongo-fixture-secret\n');
    await writeFile(new URL('runtime.env', local), 'DATABASE_TYPE=mongodb\n');
    run('prepare');
    const mongo = JSON.parse(await readFile(new URL('cloud/service.yaml', local), 'utf8'));
    assert.equal(mongo.replication.connections[0].type, 'mongodb');
    assert.equal(mongo.replication.connections[0].password.secret, 'mongo-fixture-secret');
    assert.match(await readFile(new URL('cloud/sync-config.yaml', local), 'utf8'), /_id AS id/);
    await writeFile(new URL('mssql.env', local), 'REPLICATION_DB_PASSWORD=mssql-fixture-secret\n');
    await writeFile(new URL('runtime.env', local), 'DATABASE_TYPE=mssql\n');
    run('prepare');
    const mssql = JSON.parse(await readFile(new URL('cloud/service.yaml', local), 'utf8'));
    assert.equal(mssql.replication.connections[0].type, 'mssql');
    assert.equal(mssql.replication.connections[0].schema, 'dbo');
    assert.equal(mssql.replication.connections[0].password.secret, 'mssql-fixture-secret');
    assert.match(await readFile(new URL('cloud/sync-config.yaml', local), 'utf8'), /FROM dbo.widgets/);
    await writeFile(new URL('runtime.env', local), 'DATABASE_TYPE=postgres\n');
    assert.throws(() => run('deploy-service'), /Target\/endpoints changed/);
    run('prepare');
    await save('auth-config.json', { preserved: true });
    await save('cloud-export.json', { config: { client_auth: { jwks_uri: 'https://test.ngrok.app/api/auth/keys' } } });
    await save('cloud-export-target.json', { ...config, instanceId: 'c'.repeat(24) });
    assert.throws(() => run('install-export'), /Export belongs to another Cloud target/);
    assert.deepEqual(JSON.parse(await readFile(new URL('auth-config.json', local), 'utf8')), { preserved: true });
    await save('cloud-target.json', { ...config, instanceId: 'c'.repeat(24) });
    assert.throws(() => run('prepare'), /Baseline belongs to another Cloud target/);
    assert.throws(() => run('deploy'), /Target\/endpoints changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
