import { generateKeyPairSync, randomBytes, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('../.local/', import.meta.url);
const target = new URL('signing-keys.json', directory);

export async function generateKeys() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const keys = JSON.parse(await readFile(target, 'utf8'));
    const privateKey = createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
    const publicKey = createPublicKey({ key: keys.publicJwk, format: 'jwk' });
    const probe = Buffer.from('test-system-key-check');
    if (keys.publicJwk.d || keys.privateJwk.kid !== keys.publicJwk.kid ||
        keys.publicJwk.alg !== 'RS256' || keys.privateJwk.alg !== 'RS256' ||
        !verify('RSA-SHA256', probe, publicKey, sign('RSA-SHA256', probe, privateKey))) {
      throw new Error('Invalid or mismatched signing keys');
    }
    console.log('Preserved existing signing keys.');
    return keys;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Independent test-provider RS256 keys; never read parent signing material.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const metadata = { alg: 'RS256', kid: `powersync-${randomBytes(5).toString('hex')}` };
  const keys = {
    privateJwk: { ...privateKey.export({ format: 'jwk' }), ...metadata },
    publicJwk: { ...publicKey.export({ format: 'jwk' }), ...metadata }
  };
  await writeFile(target, JSON.stringify(keys, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created persistent signing keys in .local/signing-keys.json.');
  return keys;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await generateKeys();
