import { readFile, writeFile } from 'node:fs/promises';
import { prepareBackend } from './prepare-backend.mjs';
import { generateKeys } from './generate-keys.mjs';
import { setupDatabase } from './database-setup.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Select Node.js 24 before setup.');
await prepareBackend();
const keys = await generateKeys();
const local = new URL('../.local/', import.meta.url);
async function createIfMissing(name, content) {
  try {
    await writeFile(new URL(name, local), content, { flag: 'wx', mode: 0o600 });
    console.log(`Created .local/${name}.`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Preserved .local/${name}.`);
  }
}
await createIfMissing('runtime.env', [
  '# Phase 1 local-only audience; replace with the actual Cloud URL in Phase 3.',
  'POWERSYNC_URL=https://test-system.invalid',
  'JWT_ISSUER=powersync-test-system',
  'BACKEND_PORT=6061',
  'BATCH_ON_FATAL_ERROR=stop',
  ''
].join('\n'));
await createIfMissing('auth-config.json', JSON.stringify({
  config: { client_auth: { jwks: { keys: [keys.publicJwk] } } }
}, null, 2) + '\n');
const auth = JSON.parse(await readFile(new URL('auth-config.json', local), 'utf8'));
const inlineKeys = auth.config?.client_auth?.jwks?.keys;
if (inlineKeys?.length && !inlineKeys.some(key => key.kid === keys.publicJwk.kid && key.n === keys.publicJwk.n)) {
  throw new Error('Preserved auth config does not trust the current signing key. Update it explicitly.');
}
await setupDatabase();
console.log('Setup complete. Persistent provider keys, verifier configuration, and Postgres settings are ready. Existing Cloud/tunnel settings were preserved.');
