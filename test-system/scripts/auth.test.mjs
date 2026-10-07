import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { createAuthServer } from '../auth/server.mjs';

test('isolated provider signs scoped tokens, exposes public keys and forwards authenticated writes', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const metadata = { alg: 'RS256', kid: 'fixture-key' };
  const keys = { privateJwk: { ...pair.privateKey.export({ format: 'jwk' }), ...metadata },
    publicJwk: { ...pair.publicKey.export({ format: 'jwk' }), ...metadata } };
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, method: req.method, token: req.headers.authorization, body }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const options = { keys, issuer: 'test-issuer', audience: 'https://cloud.example.com',
    upstream: `http://127.0.0.1:${upstream.address().port}` };
  const server = createAuthServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const jwks = await fetch(`${base}/api/auth/keys`).then(r => r.json());
    assert.deepEqual(jwks, { keys: [keys.publicJwk] });
    assert.throws(() => createAuthServer({ ...options, keys: { ...keys, publicJwk: keys.privateJwk } }), /public/);
    assert.equal((await fetch(`${base}/api/auth/token`)).status, 400);
    assert.equal((await fetch(`${base}/api/auth/token?user_id=test`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/auth/unknown`)).status, 404);
    const response = await fetch(`${base}/api/auth/token?user_id=alice%20test`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { token, powersync_url } = await response.json();
    const [header, payload, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'fixture-key' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.sub, 'alice test');
    assert.equal(claims.iss, options.issuer);
    assert.equal(claims.aud, options.audience);
    assert.equal(claims.exp - claims.iat, 3600);
    assert.equal(powersync_url, options.audience);
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url')));
    const body = JSON.stringify({ transactions: [{ crud: [] }] });
    const forwarded = await fetch(`${base}/api/data?fixture=yes`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body }).then(r => r.json());
    assert.deepEqual(forwarded, { path: '/api/data?fixture=yes', method: 'POST', token: `Bearer ${token}`, body });
    await new Promise(resolve => upstream.close(resolve));
    assert.equal((await fetch(`${base}/api/data`, { method: 'POST', body })).status, 502);
  } finally {
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});
