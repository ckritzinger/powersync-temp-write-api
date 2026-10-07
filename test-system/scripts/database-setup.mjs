import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { local, readEnv, createLocal } from './local-config.mjs';
import { generateTLS } from './generate-tls.mjs';

export async function setupDatabase() {
  const runtime = await readEnv('runtime.env');
  const secret = () => randomBytes(24).toString('hex');
  await createLocal('database.env', [
    'POSTGRES_USER=test_admin', 'POSTGRES_DB=test_system',
    `POSTGRES_PASSWORD=${secret()}`, `WRITE_DB_PASSWORD=${secret()}`,
    `REPLICATION_DB_PASSWORD=${secret()}`, ''
  ].join('\n'));
  const database = await readEnv('database.env');
  for (const field of ['POSTGRES_PASSWORD', 'WRITE_DB_PASSWORD', 'REPLICATION_DB_PASSWORD']) {
    if (!/^[a-f0-9]{48}$/.test(database[field] ?? '')) throw new Error(`Invalid ${field} in database.env; preserve existing database credentials when correcting it.`);
  }
  const uri = `postgres://test_writer:${database.WRITE_DB_PASSWORD}@postgres:5432/test_system`;
  let text = await readFile(new URL('runtime.env', local), 'utf8');
  if (!runtime.DATABASE_URI || /^postgres:\/\/test_system:[a-f0-9]+@smoke-db:5432\/test_system$/.test(runtime.DATABASE_URI)) {
    text = runtime.DATABASE_URI ? text.replace(/^DATABASE_URI=.*$/m, `DATABASE_URI=${uri}`) : text + `\nDATABASE_URI=${uri}\n`;
    console.log('Configured the backend to use the persistent database writer role.');
  }
  for (const [name, value] of Object.entries({ POSTGRES_PORT: '5433', DOCKER_SUBNET: '172.29.77.0/24', POSTGRES_DB_IP: '172.29.77.2', BACKEND_DB_IP: '172.29.77.3' })) {
    if (!runtime[name]) text += `${name}=${value}\n`;
  }
  if (text !== await readFile(new URL('runtime.env', local), 'utf8')) {
    await writeFile(new URL('runtime.env', local), text, { mode: 0o600 });
  }
  await generateTLS();
  console.log('Database settings and TLS ready; existing credentials and certificates preserved.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await setupDatabase();
