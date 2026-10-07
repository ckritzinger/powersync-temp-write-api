import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Disposable fixture identities only. This service is not a user login system.
export function createAuthServer({ keys, issuer, audience, upstream }) {
  const privateKey = createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const publicKey = { ...keys.publicJwk };
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
    if (publicKey[field] !== undefined) throw new Error('JWKS must contain public material only.');
  }
  const base = new URL(upstream);
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith('/api/auth/')) {
      if (req.method === 'OPTIONS') return json(204, null);
      if (req.method !== 'GET') return json(405, { message: 'Method not allowed' });
      if (url.pathname === '/api/auth/keys') return json(200, { keys: [publicKey] });
      if (url.pathname === '/api/auth/token') {
        const userId = url.searchParams.get('user_id');
        if (!userId || userId.length > 128 || /[\x00-\x1f\x7f]/.test(userId)) {
          return json(400, { message: 'Supply a demo user_id of 1–128 printable characters.' });
        }
        const now = Math.floor(Date.now() / 1000);
        const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: publicKey.kid })}.${encode({
          sub: userId, iss: issuer, aud: audience, iat: now, exp: now + 3600
        })}`;
        const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
        return json(200, { token, powersync_url: audience });
      }
      return json(404, { message: 'Not found' });
    }
    // Preserve the original request path and body; never forward to a client-selected host.
    const headers = { ...req.headers, host: base.host };
    delete headers.connection;
    const request = http.request({ hostname: base.hostname, port: base.port, path: req.url,
      method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    request.setTimeout(30000, () => request.destroy());
    request.on('error', () => {
      if (!res.headersSent) json(502, { message: 'Test write API unavailable' });
      else res.destroy();
    });
    req.on('aborted', () => request.destroy());
    req.pipe(request);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = JSON.parse(await readFile(process.env.SIGNING_KEYS_PATH ?? '/run/secrets/signing-keys.json', 'utf8'));
  if (!process.env.JWT_ISSUER || !process.env.POWERSYNC_URL) throw new Error('Configure the test issuer and Cloud audience.');
  createAuthServer({ keys, issuer: process.env.JWT_ISSUER, audience: process.env.POWERSYNC_URL,
    upstream: process.env.WRITE_API_URL ?? 'http://backend:6060' }).listen(6060, '0.0.0.0');
  console.log('Test auth gateway listening; signing material is never logged.');
}
