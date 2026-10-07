import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { local } from './local-config.mjs';

export async function generateTLS(base = local) {
  const directory = new URL('tls/', base);
  try {
    await access(directory);
    const ca = new X509Certificate(await readFile(new URL('ca.crt', directory)));
    const server = new X509Certificate(await readFile(new URL('server.crt', directory)));
    const privateKey = createPrivateKey(await readFile(new URL('server.key', directory)));
    if (!ca.ca || !server.verify(ca.publicKey) || !server.checkHost('postgres') || !server.checkIP('127.0.0.1') ||
        !server.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })) ||
        Date.parse(server.validTo) <= Date.now() || Date.parse(ca.validTo) <= Date.now()) {
      throw new Error('Existing database TLS material is invalid or expired; replace it explicitly.');
    }
    return;
  } catch (error) {
    // A partial existing directory must fail rather than silently rotating its certificates.
    if (error.code !== 'ENOENT') throw error;
    try { await access(directory); throw new Error('Incomplete existing TLS directory; repair it explicitly.'); }
    catch (check) { if (check.code !== 'ENOENT') throw check; }
  }
  const staging = new URL('tls-next/', base);
  await mkdir(staging, { mode: 0o700 });
  const cwd = fileURLToPath(staging);
  function openssl(args) { execFileSync('openssl', args, { cwd, stdio: 'pipe' }); }
  try {
    openssl(['genrsa', '-out', 'ca.key', '2048']);
    openssl(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '3650', '-out', 'ca.crt',
      '-subj', '/CN=PowerSync test system CA', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    openssl(['genrsa', '-out', 'server.key', '2048']);
    openssl(['req', '-new', '-key', 'server.key', '-out', 'server.csr', '-subj', '/CN=postgres']);
    await writeFile(new URL('server.ext', staging), [
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth', 'subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1', ''
    ].join('\n'), { mode: 0o600 });
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'server.crt', '-days', '365', '-sha256', '-extfile', 'server.ext']);
    await rename(staging, directory);
    console.log('Generated local Postgres CA and server certificate.');
  } catch {
    await rm(staging, { recursive: true, force: true });
    throw new Error('Failed to generate database TLS certificates. Check that OpenSSL with -addext is installed.');
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await generateTLS();
