# Example clien

**This is not a runnable project**

This is the minimum code a PowerSync client needs to talk to the write API in `backend/`, meant to be read and copied into your own app, not installed and run.

## What's here

```
src/
├── generated/api.d.ts               # Types generated from backend/openapi.yaml
└── library/powersync/
    ├── AppSchema.ts                 # Example PowerSync schema — replace with your own tables
    ├── WriteAPIClient.ts            # Turns a PowerSync CrudTransaction into a POST /api/data call
    ├── OpenAPITransport.ts          # Typed fetch wrapper around the OpenAPI contrac
    └── DemoConnector.ts             # PowerSyncBackendConnector wiring the above into fetchCredentials/uploadData
```

`DemoConnector.ts` is the one you actually adapt into your app, the other three are what it depends on.

## Node package dependencies

The implementation assumes that your `package.json` contains the following dependencies:

```
@powersync/web    # or @powersync/react-native
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
| `VITE_BATCH_ON_FATAL_ERROR` | `stop` (default) or `skip` — see `backend/README.md` |
| `VITE_REQUEST_TIMEOUT_MS` | Abort a write API request after this long (default 30000) |

See `.env.example` in this folder.

## Auth

The demo code assumes that you have already implemented a mechanism to obtain a token, and that this same token will be used to authenticate both against the PowerSync backend and also against your own write API.

For further details of how to implement production quality authentication on various platforms, please see [`../docs/auth-verifiers.md`](../docs/auth-verifiers.md).
