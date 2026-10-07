import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { local } from './local-config.mjs';

export async function issueTunnelCertificate(hostname, base = local) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(hostname)) throw new Error('Invalid tunnel certificate hostname.');
  const tls = new URL('tls/', base);
  const previous = await readFile(new URL('server.crt', tls));
  if (new X509Certificate(previous).checkHost(hostname)) return false;
  const staging = new URL('tls-tunnel-next/', base);
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(new URL('server.ext', staging), [
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1,DNS:${hostname}`, ''
    ].join('\n'), { mode: 0o600 });
    const run = args => execFileSync('openssl', args, { cwd: fileURLToPath(staging), stdio: 'pipe' });
    run(['req', '-new', '-key', fileURLToPath(new URL('server.key', tls)), '-out', 'server.csr', '-subj', '/CN=postgres']);
    run(['x509', '-req', '-in', 'server.csr', '-CA', fileURLToPath(new URL('ca.crt', tls)), '-CAkey', fileURLToPath(new URL('ca.key', tls)),
      '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-out', 'server.crt', '-days', '365', '-sha256', '-extfile', 'server.ext']);
    const certificate = new X509Certificate(await readFile(new URL('server.crt', staging)));
    const ca = new X509Certificate(await readFile(new URL('ca.crt', tls)));
    if (!certificate.checkHost(hostname) || !certificate.verify(ca.publicKey)) throw new Error('Certificate verification failed.');
    const history = new URL('tls-history/', base);
    await mkdir(history, { recursive: true, mode: 0o700 });
    await writeFile(new URL(`server-${Date.now()}.crt`, history), previous, { mode: 0o600 });
    await rename(new URL('server.crt', staging), new URL('server.crt', tls));
    return true;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
