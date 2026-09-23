# Example client

**This is not a runnable project**

This is the minimum code a PowerSync client needs to talk to the write API in `backend/`

It is meant to be read and copied into your own app.

## What's here

```
src/
├── generated/api.d.ts               # Types generated from backend/openapi.yaml
├── PowersyncConnector.ts            # PowerSyncBackendConnector wiring the below into fetchCredentials/uploadData
├── PowersyncConnector.singlefile.ts # Same connector, zero deps beyond @powersync/*
└── library/powersync/
    ├── AppSchema.ts                 # Example PowerSync schema — replace with your own tables
    ├── WriteAPIClient.ts            # Turns a PowerSync CrudTransaction into a POST /api/data call
    ├── OpenAPITransport.ts          # Typed fetch wrapper around the OpenAPI contract
    ├── DemoConnectorConfig.ts       # Config/env parsing for the connector (batching, timeouts, etc.)
    └── TransactionBatching.ts       # Groups queued CrudTransactions into upload batches
```

`PowersyncConnector.ts` is the one you actually adapt into your app, the other four are what it depends
on.

If you'd rather not pull in `openapi-fetch`/generated types/`uuid`, or just want the smallest
possible copy-paste, use `PowersyncConnector.singlefile.ts` instead. This is the same behaviour, packaged as
one dependency-light file with its own header comment covering config and auth.

## Node package dependencies

The implementation assumes that your `package.json` contains the following dependencies:

```
@powersync/web    # or @powersync/react-native, >=1.26.0 required for getCrudTransactions()
openapi-fetch
uuid
```

## If you make API changes

`generated/api.d.ts` is regenerated from `backend/` (this folder has no `package.json` of its
own):

```bash
cd backend && pnpm generate-types
```

## Configuration

It reads these via `import.meta.env` (Vite-style). Swap for however your bundler exposes env
vars:

| Variable | Meaning |
| --- | --- |
| `VITE_BACKEND_URL` | Base URL of the write API, e.g. `http://localhost:6060` |
| `VITE_POWERSYNC_URL` | Your PowerSync instance's sync endpoint |
| `VITE_BATCH_MAX_TRANSACTIONS` | Transactions per upload request (default 1) |
| `VITE_BATCH_MAX_OPERATIONS` | Operations per batch (default 1000) |
| `VITE_REQUEST_TIMEOUT_MS` | Abort a write API request after this long (default 30000) |

See `.env.example` in this folder.

## Auth

`fetchCredentials()` ships with a default that mints a token from this backend's own demo
`GET /api/auth/token` endpoint and reuses it for write API calls too — one token, both purposes.

**This default will not work against a real PowerSync sync connection until your PowerSync
instance's custom-auth (JWKS) setting is pointed at this backend's `GET /api/auth/keys`** — see
the root README's Configuration section. Without that, PowerSync rejects every token it mints and
sync never connects, even though writes through the API keep working.

Once you have a real identity provider, replace `fetchCredentials()` with a mechanism that obtains
a token from it — ideally the same token you use to authenticate against your own write API too.
For further details of how to implement production quality authentication on various platforms,
please see [`../docs/auth-verifiers.md`](../docs/auth-verifiers.md).

See [error handling and developer-managed dead letters](../docs/error-handling.md) for the
`onFatalTransaction` retain/complete hook, custom codes/details, queue blocking, and coordinated
backend/connector deployment.
