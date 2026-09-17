# Backend

## Overview

Node.js server application with HTTP endpoints to authorize a [PowerSync](https://www.powersync.com/) enabled application to sync data between a client device and a PostgreSQL, MySQL, MSSQL or MongoDB database.

The endpoints are as follows:

1. GET `/api/auth/token`

   - Returns a JWT access token used for PowerSync authentication.
   - Provide an optional `user_id` query parameter to set the subject of the JWT.

2. GET `/api/auth/keys`

   - JWKS endpoint used by the PowerSync service to validate JWTs.

3. POST `/api/data`

   - Accepts a **transaction batch** — an ordered run of whole transactions from the head of the client's upload queue — and applies each one in its own database transaction, in order. This is the only write endpoint: a client with a single transaction to upload sends a transaction batch of one.
   - Stops at the first failure. The response holds one result per transaction sent, in the same order and always the same length as the request, so the client never has to infer which transactions were applied. Transactions the batch never reached are reported as `not_attempted`.
   - Optional `on_fatal_error` in the request body: `stop` (the default) ends the batch at a fatal failure; `skip` drops that transaction and carries on, so a queue blocked by a poison operation can still drain. The skipped transaction's result still reports `fatal_error` with the error classification, so the client can record that it discarded the transaction.
   - `skip` applies to **fatal failures only**. A retryable failure always ends the batch.
   - The client may complete through the last result whose status is `success` or `fatal_error`. A `retryable_error` or `not_attempted` result is not completable.

### Error classification

Every failure is sorted into one of two kinds. `src/errors.ts` defines the two, and each
supported database maps its driver's errors onto them in its own `*-errors.ts` under
`src/persistance/`:

- **retryable** — the environment misbehaved (deadlock, lock timeout, connection loss, resource exhaustion). The client uploads the transaction again after a delay.
- **fatal** — the data is wrong and can never be stored (missing required field, constraint violation, malformed or out-of-range value, schema mismatch). The client discards the transaction.

## Packages

[node-postgres](https://github.com/brianc/node-postgres), [mongodb](https://www.npmjs.com/package/mongodb),
[mysql2](https://www.npmjs.com/package/mysql2) and [node-mssql](https://www.npmjs.com/package/mssql) back the
four persisters behind `POST /api/data`. [jose](https://github.com/panva/jose) signs and verifies the JWT.

## Running it

The backend runs in Docker Compose, alongside the PowerSync service and bucket storage. It is not
meant to be started on its own — see the [root README](../README.md) for the two run modes.

From the repo root:

```bash
docker compose up --build
```

To edit backend code without rebuilding the image, append the development overlay to `COMPOSE_FILE`
in the root `.env`:

```bash
COMPOSE_FILE=docker-compose.yaml:examples/postgres/compose.yaml:docker-compose.dev.yaml
```

Your working tree is mounted in and the process restarts on save.

> Running `pnpm start` on the host as well will fail with `address already in use`, or quietly
> shadow the container — both want port 6060.

## Configuration

Set in the root `.env` and in the Compose overlays, not here:

| Variable | Meaning |
| --- | --- |
| `DATABASE_TYPE` | `postgres`, `mongodb`, `mysql` or `mssql` |
| `DATABASE_URI` | Connection string for the source database |
| `PORT` | Defaults to 6060 |
| `POWERSYNC_URL`, `JWT_ISSUER` | Audience and issuer for the tokens this backend mints |
| `POWERSYNC_PRIVATE_KEY`, `POWERSYNC_PUBLIC_KEY` | Base64 JWKs for signing |

The backend refuses to start, before serving any traffic, if `DATABASE_URI` is unset or
`DATABASE_TYPE` is not one of the four — with a message naming the fix rather than a stack trace.

If no keypair is configured it generates a temporary one at boot. That is fine for a one-off run
and wrong for everything else: every restart mints a new key, and PowerSync rejects tokens it
accepted moments earlier with `PSYNC_S2101 — Could not find an appropriate key in the keystore`.
The repo ships a committed throwaway pair so this does not happen. To mint your own:

```bash
pnpm generate-keys
```

## Using your own identity provider

`src/auth/verifier.ts` is the seam. The demo verifies the same token this backend mints; replace
that export to accept tokens from Supabase, Clerk, Auth0 or anything else. Worked examples are in
[auth-verifiers.md](../auth-verifiers.md).

## Tests

```bash
pnpm test     # HTTP against the assembled app, plus the boot-failure contract
pnpm check    # types
```

Neither needs Docker.
