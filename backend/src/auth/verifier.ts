import { createLocalJWKSet, jwtVerify } from 'jose';
import config from '../../config.js';
import { getPublicJwk } from '../api/auth.js';
import type { TokenVerifier } from './types.js';

/**
 * The active TokenVerifier.
 *
 * The demo ships PowerSyncVerifier below: it verifies the same PowerSync JWT
 * this backend mints in /api/auth/token (the token the client already fetches
 * in fetchCredentials()), against the backend's own public key. Note the
 * audience is the PowerSync URL.
 *
 * Adopters: replace this export with your own provider's verification, e.g.
 * a `createRemoteJWKSet` against your IdP's JWKS endpoint (Supabase, Clerk,
 * Auth0). See auth-verifiers.md for worked examples.
 */
export const verifier: TokenVerifier = {
  async verify(token) {
    const jwks = createLocalJWKSet({ keys: [await getPublicJwk()] });
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.powersync.jwtIssuer,
      audience: config.powersync.url
    });
    if (!payload.sub) {
      throw new Error('Token has no sub claim');
    }
    return { sub: payload.sub, claims: payload };
  }
};
