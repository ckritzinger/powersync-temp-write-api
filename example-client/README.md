# Example client

Not a runnable project — no `package.json`, no lockfile, on purpose. This is the minimum code a
PowerSync client needs to talk to the write API in `backend/`, meant to be read and copied into
your own app, not installed and run.

## What's here

```
src/
├── generated/api.d.ts               # Types generated from backend/openapi.yaml
└── library/powersync/
    ├── AppSchema.ts                 # Example PowerSync schema — replace with your own tables
    ├── WriteAPIClient.ts            # Turns a PowerSync CrudTransaction into a POST /api/data call
    ├── OpenAPITransport.ts          # Typed fetch wrapper around the OpenAPI contract
    └── DemoConnector.ts             # PowerSyncBackendConnector wiring the above into fetchCredentials/uploadData
```

Read them in that order — `DemoConnector.ts` is the one you actually adapt into your app; the
other three are what it depends on.

## What you need installed

```
@powersync/web    # or @powersync/react-native — whichever PowerSync SDK your app uses
openapi-fetch
uuid
```

`generated/api.d.ts` is regenerated from `backend/`, not from here (this folder has no
`package.json` of its own):

```bash
cd backend && pnpm generate-types
```

## Config `DemoConnector.ts` expects

It reads these via `import.meta.env` (Vite-style) — swap for however your bundler exposes env
vars:

| Variable | Meaning |
| --- | --- |
| `VITE_BACKEND_URL` | Base URL of the write API, e.g. `http://localhost:6060` |
| `VITE_POWERSYNC_URL` | Your PowerSync instance's sync endpoint |
| `VITE_BATCH_MAX_TRANSACTIONS` | Transactions per upload request (default 1) |
| `VITE_BATCH_MAX_OPERATIONS` | Operation ceiling per batch, whichever bound hits first (default 1000) |
| `VITE_BATCH_ON_FATAL_ERROR` | `stop` (default) or `skip` — see `backend/README.md` |
| `VITE_REQUEST_TIMEOUT_MS` | Abort a write API request after this long (default 30000) |

See `.env.example` in this folder.

## Auth

`DemoConnector` generates an anonymous per-browser user id and gets a token from the backend's
`GET /api/auth/token` — that's the whole demo auth story. To use a real identity provider instead,
see [`../docs/auth-verifiers.md`](../docs/auth-verifiers.md).
