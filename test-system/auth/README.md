# Isolated test identity provider

The `auth` Compose service issues one-hour RS256 JWTs for anonymous demo identities and publishes their public signing key. It reads only this fixture's persistent `.local/signing-keys.json`. The write backend receives no private signing key and has no token or JWKS routes.

The gateway listens on loopback port 6061 (`BACKEND_PORT`). It serves `GET /api/auth/token?user_id=...` and `GET /api/auth/keys`, and forwards other requests unchanged to the backend. The backend also listens directly on loopback port 6062 (`WRITE_API_PORT`), where both auth routes return 404. Keeping the gateway on 6061 preserves the existing ngrok HTTPS tunnel and test-client URLs.

These are disposable test identities, not real user authentication: callers can choose any demo user ID. Keep this fixture scoped to a dedicated test instance. No production source changes or external identity provider are needed.

Run `pnpm run setup` and `pnpm run backend:up` with Node 24 to prepare current parent sources and start Postgres, the backend, and the auth gateway. Ordinary startup preserves the signing keys and database. Legacy `.local/keys.env` files are no longer used or mounted.

The generated verifier patch supplies the test issuer and actual Cloud audience to the existing verifier. PowerSync Cloud reads the public gateway JWKS through ngrok. Provider tokens work for both sync and writes; PowerSync temporary tokens remain disabled. The connector preparation patch replaces fixed-token retrieval with a call to this provider and preserves the parent connector's queue/error behavior.

Verification:

```sh
pnpm run test
pnpm run smoke:restart
pnpm run smoke:widgets
pnpm run client:test
pnpm run client:test:api
pnpm run cloud:verify
```

The final command requires running tunnels and a deployed Cloud instance. See [the Cloud workflow](../powersync/README.md). Reports distinguish direct API/queue checks from live Cloud checks.
