import { describe, expect, it } from 'vitest';
import request from 'supertest';

import app from './app.js';

/**
 * Seam: HTTP requests against the assembled application.
 *
 * These cover the assembly itself rather than any one route. The OpenAPI contract is loaded while
 * the app is being constructed, so if it cannot be resolved the validator throws on import and
 * every test here fails at once — which is the point. The backend image shipped a build context
 * that did not contain the contract, so the container started and died; this is the regression
 * net for that.
 */
describe('the assembled application', () => {
  it('serves its root route', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
  });

  it('rejects a request that violates the OpenAPI contract', async () => {
    // An empty batch violates minItems on transactions. A bearer token is supplied so the
    // request gets past the security check and fails on the body — a 401 here would mean the
    // contract never loaded and the request fell through to the auth gate instead.
    const response = await request(app)
      .post('/api/data')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ transactions: [] });

    expect(response.status).toBe(400);
  });
});
