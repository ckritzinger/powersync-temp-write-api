import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { local, createLocal, readEnv } from './local-config.mjs';

export async function setupMySQL() {
  const secret = () => randomBytes(24).toString('hex');
  await createLocal('mysql.env', `MYSQL_ROOT_PASSWORD=${secret()}\nWRITE_DB_PASSWORD=${secret()}\nREPLICATION_DB_PASSWORD=${secret()}\n`);
  const credentials = await readEnv('mysql.env');
  for (const key of ['MYSQL_ROOT_PASSWORD', 'WRITE_DB_PASSWORD', 'REPLICATION_DB_PASSWORD']) {
    if (!/^[a-f0-9]{48}$/.test(credentials[key] ?? '')) throw new Error(`Invalid MySQL ${key}; preserve existing credentials.`);
  }
  const tls = new URL('mysql-tls/', local);
  await mkdir(tls, { recursive: true, mode: 0o700 });
  let hostname;
  try { hostname = JSON.parse(await readFile(new URL('tunnel-endpoints.json', local), 'utf8')).database.hostname; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hostname && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(hostname)) throw new Error('Invalid captured tunnel hostname.');
  await writeFile(new URL('ca.crt', tls), await readFile(new URL('tls/ca.crt', local)), { mode: 0o600 });
  await createLocal('mysql-tls/server.key', '');
  const key = fileURLToPath(new URL('server.key', tls));
  if (!(await readFile(key)).length) execFileSync('openssl', ['genrsa', '-out', key, '2048'], { stdio: 'pipe' });
  try {
    const cert = new X509Certificate(await readFile(new URL('server.crt', tls)));
    if (cert.checkHost('mysql') && (!hostname || cert.checkHost(hostname)) && Date.parse(cert.validTo) > Date.now()) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ext = new URL('server.ext', tls);
  await writeFile(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:mysql,DNS:localhost,IP:127.0.0.1${hostname ? ',DNS:' + hostname : ''}\n`, { mode: 0o600 });
  execFileSync('openssl', ['req', '-new', '-key', key, '-out', fileURLToPath(new URL('server.csr', tls)), '-subj', '/CN=mysql'], { stdio: 'pipe' });
  execFileSync('openssl', ['x509', '-req', '-in', fileURLToPath(new URL('server.csr', tls)), '-CA', fileURLToPath(new URL('tls/ca.crt', local)),
    '-CAkey', fileURLToPath(new URL('tls/ca.key', local)), '-set_serial', '0x' + randomBytes(16).toString('hex'), '-out', fileURLToPath(new URL('server.crt', tls)),
    '-days', '365', '-sha256', '-extfile', fileURLToPath(ext)], { stdio: 'pipe' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { await setupMySQL(); console.log('MySQL credentials, TLS ready; existing keys preserved.'); }
