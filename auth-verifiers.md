# Using your own identity provider: Supabase & Clerk

This guide is for adopters of this template who have a real identity provider and want the
write API (`POST /api/data`) to accept *their* users' tokens instead of the demo's
self-issued PowerSync token. When you're done, every write is authenticated against your
provider — the demo's auth plumbing either disappears or shrinks to a sync-only concern.

## How auth is pluggable

The backend depends on a single interface, `TokenVerifier`
(`backend/src/auth/types.ts`):

```ts
export interface TokenVerifier {
  verify(token: string): Promise<{ sub: string; claims: Record<string, unknown> }>;
}
```

`requireAuth` (`backend/src/auth/middleware.ts`) calls it on every write and puts the
result on `req.auth`. Nothing downstream knows or cares which provider verified the token.

**You swap:**

1. `backend/src/auth/verifier.ts` — replace the exported `verifier` (one file).
2. A few env vars for your provider's keys/issuer.
3. The frontend `getToken()` — where the bearer token comes from
   (`frontend/src/library/powersync/DemoConnector.ts`, fed into `createOpenAPIClient`).

**You keep:** the `TokenVerifier` interface, `requireAuth`, the OpenAPI contract
(`bearerAuth` + `401`), the `OpenAPITransport` middleware shape, and the data route.

Every verifier is the same `jose` shape; providers differ on exactly two axes — **where the
signing key comes from** and **which claim proves the token was meant for you**:

| | PowerSync (demo) | Supabase | Clerk |
|---|---|---|---|
| Key source | backend's own in-process key | project JWKS endpoint | instance JWKS endpoint |
| Algorithm | RS256 | ES256 (default) / RS256 | RS256 |
| Origin claim | `aud` = PowerSync URL | `aud` = `authenticated` | no `aud` — check `azp` |
| `sub` | demo device UUID | Supabase auth user id | Clerk user id |
| Backend env | none | `SUPABASE_JWKS_URI`, `SUPABASE_ISSUER` | `AUTH_JWKS_URI`, `AUTH_ISSUER`, `AUTH_AUTHORIZED_PARTIES` |
| Frontend token | reuse `fetchCredentials()` token | `supabase.auth.getSession()` | `session.getToken()` |
| Sync token | same token | can be the same token | separate concern (see below) |

---

## Supabase

**Prerequisites:** a Supabase project with users signing in through `supabase-js`
(email/password, OAuth, magic link — any method). Your users' sessions carry a JWT access
token; that token becomes the write credential.

### Step 1: Replace the verifier

Supabase signs access tokens with **asymmetric signing keys** (default ES256) and publishes
the public keys at a JWKS endpoint. Replace the export in `backend/src/auth/verifier.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { TokenVerifier } from './types.js';

// https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
const JWKS = createRemoteJWKSet(new URL(process.env.SUPABASE_JWKS_URI!));

export const verifier: TokenVerifier = {
  async verify(token) {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.SUPABASE_ISSUER, // https://<project-ref>.supabase.co/auth/v1
      audience: 'authenticated'            // Supabase's aud for signed-in users
    });
    if (!payload.sub) {
      throw new Error('Token has no sub claim');
    }
    return { sub: payload.sub, claims: payload };
  }
};
```

`createRemoteJWKSet` fetches and caches the keys, picks the right key by the token's `kid`
header, and handles ES256/RS256 transparently — key rotation on the Supabase side needs no
code change here.

> **Legacy projects (HS256 shared secret):** older Supabase projects sign with a symmetric
> `JWT secret`. Supabase now strongly recommends **against** verifying with the shared
> secret — migrate the project to signing keys (Dashboard → JWT Keys → migrate/rotate),
> which is zero-downtime, and use the JWKS verifier above. If you can't migrate yet, the
> documented fallback is validating the token against the Auth server
> (`GET <issuer>/user` with the token) rather than embedding the secret in this backend.

> **Authorization note:** don't make authorization decisions from `user_metadata` claims —
> they are user-editable. Use `sub` (and `app_metadata` if you need roles).

### Step 2: Set environment variables

Follow the `backend/config.ts` pattern if you prefer config over `process.env`:

```
SUPABASE_JWKS_URI=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_ISSUER=https://<project-ref>.supabase.co/auth/v1
```

### Step 3: Point the frontend `getToken()` at Supabase

With Supabase the user actually signs in, and the write token is the **session access
token**:

```ts
// DemoConnector.ts (or your connector)
this.apiClient = createOpenAPIClient(this.config.backendUrl, {
  getToken: async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Not signed in');
    return token;
  }
  // No onUnauthorized cache-clearing needed: supabase-js refreshes the
  // session itself, and getSession() always returns the current token.
});
```

Remove the demo's `_writeToken` caching in `DemoConnector.ts` — `supabase-js` owns the
session lifecycle. A `401` still throws in `postTransaction`, so the PowerSync upload
retries; by then `supabase-js` has typically refreshed the token.

### Step 4: Decide how sync tokens work

PowerSync supports Supabase Auth natively — the PowerSync Service can verify Supabase JWTs
directly (enable Supabase auth on your PowerSync instance). That means `fetchCredentials()`
can return the *same* Supabase access token for sync, and the demo's `/api/auth/token`
endpoint (and the backend keypair) become unused. You end up with a clean one-token shape
with a real identity behind it. See:
https://docs.powersync.com/installation/authentication-setup/supabase-auth

### Step 5: Verify

```bash
# Grab an access token from a signed-in session (browser devtools, or supabase-js)
TOKEN=<session access_token>

curl -i -X POST http://localhost:6060/api/data \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"crud":[]}'
# expect 200 {"status":"success"} and a backend log line:
#   Write authenticated as <supabase user id>
```

Then run the full [verification checklist](#verification-checklist).

---

## Clerk

**Prerequisites:** a Clerk application with users signing in via Clerk's components/SDK.
Clerk session tokens are JWTs, RS256-signed, published at your instance's JWKS endpoint.

### Step 1: Replace the verifier

The wrinkle: Clerk session tokens carry **no `aud` claim**. Origin is proven with `azp`
(authorized party — the origin that generated the token), which you validate against an
allow-list. Replace the export in `backend/src/auth/verifier.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { TokenVerifier } from './types.js';

// https://<your-frontend-api>.clerk.accounts.dev/.well-known/jwks.json
const JWKS = createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URI!));

export const verifier: TokenVerifier = {
  async verify(token) {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.AUTH_ISSUER // https://<your-frontend-api>.clerk.accounts.dev
    });
    // Clerk has no aud; it proves origin with azp. Reject tokens minted for
    // origins you don't recognize (CSRF protection).
    const allowed = (process.env.AUTH_AUTHORIZED_PARTIES ?? '').split(',').filter(Boolean);
    if (allowed.length && !allowed.includes(payload.azp as string)) {
      throw new Error(`azp ${String(payload.azp)} not in authorized parties`);
    }
    if (!payload.sub) {
      throw new Error('Token has no sub claim');
    }
    return { sub: payload.sub, claims: payload };
  }
};
```

The idiomatic alternative is `@clerk/backend`'s `verifyToken`/`authenticateRequest` with
the `jwtKey` option (networkless) — less code and it handles `azp` natively, at the cost of
a Clerk dependency in the backend.

### Step 2: Set environment variables

```
AUTH_JWKS_URI=https://<your-frontend-api>.clerk.accounts.dev/.well-known/jwks.json
AUTH_ISSUER=https://<your-frontend-api>.clerk.accounts.dev
AUTH_AUTHORIZED_PARTIES=http://localhost:5173,https://yourapp.com
```

### Step 3: Point the frontend `getToken()` at Clerk

Clerk session tokens are **short-lived (~60 seconds)** and the Clerk SDK re-mints them on
demand — so fetch per request and never cache:

```ts
// With @clerk/clerk-react: const { getToken } = useAuth()
this.apiClient = createOpenAPIClient(this.config.backendUrl, {
  getToken: async () => {
    const token = await clerk.session?.getToken();
    if (!token) throw new Error('Not signed in');
    return token;
  }
});
```

As with Supabase, remove the demo's `_writeToken` caching in `DemoConnector.ts` —
`getToken()` already returns a fresh (or freshly minted) token each call.

### Step 4: Decide how sync tokens work

Clerk tokens have no `aud`, and PowerSync sync auth expects one. Either:

1. **Clerk JWT template** — define a template in the Clerk dashboard that adds an `aud`
   (your PowerSync URL) and point your PowerSync instance's custom auth at Clerk's JWKS.
   One identity, Clerk-issued tokens everywhere.
2. **Keep two tokens** — the backend keeps minting its PowerSync token for sync
   (`/api/auth/token`, now taking the *Clerk* user id as `sub` — derived from a verified
   Clerk token, not a query param), while writes use the Clerk session token directly.

Either way the `sub` used for sync and writes must be the same user id, or synced rows and
written rows won't correlate. See:
https://docs.powersync.com/installation/authentication-setup/custom

### Step 5: Verify

Same as Supabase: grab a session token (e.g. `await window.Clerk.session.getToken()` in
devtools), curl `POST /api/data` with it, expect `200` and
`Write authenticated as <clerk user id>` in the backend log. Then run the full
[verification checklist](#verification-checklist).

---

## Things to plan for when adopting

- **Add a login UI.** The demo invents an anonymous UUID per browser
  (`localStorage` `ps_user_id` in `DemoConnector.ts`). With a real provider your app needs
  actual sign-in before any write can succeed — an unauthenticated user's `getToken()`
  should throw, and uploads will (correctly) fail until sign-in.
- **Identity changes shape.** `sub` goes from a device UUID to a real user id. Existing
  demo rows keyed to the old UUID won't correlate with the new identity.
- **Add per-row authorization.** The auth gate only proves *who* is writing.
  `req.auth.sub` is attached precisely so you can add ownership checks in
  `updateBatch`/DLQ rows without rework.
- **Scope sync to the user.** The demo's sync rules aren't user-scoped; with real
  identities you'll want PowerSync sync rules keyed on the same user id.

## Verification checklist

Whichever provider you use, the snippets above are a starting point — run these checks
against *your* provider before trusting the swap:

1. `POST /api/data` with no `Authorization` header → `401`.
2. A real, fresh token from a signed-in user → `200 {"status":"success"}`, and the backend
   logs `Write authenticated as <your provider's user id>`.
3. Tampered token (flip a character) and expired token → `401`, backend logs
   `Token verification failed: ...`.
4. If you keep the demo sync-token endpoint, `/api/auth/*` routes are still reachable
   without a token.
5. Kill and restore connectivity mid-session: uploads retry and succeed once the provider
   refreshes the session (the `401` → retry path).
