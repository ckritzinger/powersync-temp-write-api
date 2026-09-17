import { describe, expect, it } from 'vitest';
import request from 'supertest';

import app from './app.js';

/**
 * Seam: HTTP requests against the assembled application.
 *
 * These cover the assembly itself rather than any one route. The validator resolves the OpenAPI
 * contract lazily, on the first request rather than at construction — which is why the backend
 * image booted, reported itself running, and only then answered everything with a 500. Spec
 * resolution happens before the ignorePaths check, so an unreadable contract fails every request
 * including the exempted ones: remove the contract and both tests below fail, which is what makes
 * them the regression net for that bug. Verified by deleting it and watching them go red.
 */
describe('the assembled application', () => {
  it('serves its root route', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
  });

  it('rejects a request that violates the OpenAPI contract', async () => {
    // A Transaction Batch carrying no transactions violates minItems. A bearer token is supplied
    // so the request gets past the security check and fails on the body — a 401 here would mean
    // the contract never loaded and the request fell through to the auth gate instead.
    const response = await request(app)
      .post('/api/data')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ transactions: [] });

    expect(response.status).toBe(400);
  });
});
