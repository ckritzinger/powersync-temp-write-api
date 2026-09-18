# PowerSync Write API

A self-hostable backend for the PowerSync write path: a client uploads its queued local changes to
an HTTP API, which persists them to your source database. PowerSync replicates that database back
to clients.

Clone it, point it at your own database and PowerSync instance, and change the code.

This repo assumes you already have:

1. A **hosted PowerSync instance** ([PowerSync Cloud](https://www.powersync.com/) or your own
   self-managed deployment elsewhere) connected to a **database you already run**. It does not
   bundle either of these.

2. A front-end already connected to PowerSync, displaying local data, and updating its local
   SQLite database with data mutations via `db.execute(...)`, as described in the
   [PowerSync Setup Guide](https://docs.powersync.com/intro/setup-guide#write-data).

PowerSync automatically queues these mutations and calls your `uploadData()` function, which is
where you upload the changes to your backend. The write API is that backend: it persists the
mutations to your source database. The `example-client` folder has a reference implementation of
`uploadData()` that connects to this API.

## Quickstart

```bash
docker compose up --build
```

Brings up the write API at http://localhost:6060

### Configuration

For the API to be usable, you need to perform the following config:

1. Replace the throwaway signing keys:
   ```bash
   cd backend && pnpm generate-keys      # prints both values for .env
   ```

> The signing keys in `.env` are a **public throwaway pair**, committed so the backend signs
> consistently across restarts. Replace them before this is anything but a demo.

2. Set `DATABASE_TYPE`, `DATABASE_URI`, `POWERSYNC_URL`, and `JWT_ISSUER` in `.env` to point at
   that database and match your PowerSync instance's auth settings (audience/issuer).

3. **Your client needs code to actually call this backend.** Nothing calls `/api/data` for you —
   copy the pieces in `example-client/` into your app to perform writes. See
   `example-client/README.md` for detailed instructions.

4. **Your client needs to reach this backend.** `localhost:6060` only works if the client runs on
   this same machine. Otherwise either bind the backend to `0.0.0.0` and put a client on the same
   network, or tunnel it (e.g. `ngrok http 6060`) and point the client at the public URL instead.

> If your database runs on this machine rather than in Docker, the backend reaches it at
> `host.docker.internal`, not `localhost` — inside a container, `localhost` is the container.

## Layout

```
write-api/
├── docker-compose.yaml       # The write API, standalone
├── docker-compose.dev.yaml   # Overlay: edit backend code without rebuilding
├── .env                      # Backend config and throwaway dev keys
├── backend/                  # The write API (Express, port 6060)
│   └── openapi.yaml          # The write API's contract, also consumed by example-client/
├── example-client/           # Minimum PowerSync-client code that calls the write API
└── docs/
    ├── auth-verifiers.md     # Swapping demo auth for Supabase/Clerk/your own IdP
    ├── authorization.md      # Wiring in real authorization — there is none by default
    ├── schema-mapping.md     # Beyond the default 1:1 field mapping
    └── test.txt              # Manual QA checklist
```

## Changing the backend

Append the development overlay to run with hot-reload:

```bash
COMPOSE_FILE=docker-compose.yaml:docker-compose.dev.yaml
docker compose up
```

Your working tree is mounted into the container and the process restarts on save.

Or skip Docker entirely and run `pnpm dev` on the host (see `backend/README.md`).

## Key integration points

- `backend/src/auth/verifier.ts` swap the demo's tokens for your own identity provider. See
  [docs/auth-verifiers.md](./docs/auth-verifiers.md).
- `backend/src/auth/authorizer.ts` **there is no authorization by default**, only
  authentication. Every authenticated write is currently allowed, no matter what it touches. See
  [docs/authorization.md](./docs/authorization.md).
- `backend/src/mapping/` how a `CrudEntry` becomes a database write. The default is a naive 1:1
  field pass-through. See [docs/schema-mapping.md](./docs/schema-mapping.md).

## Generating types from the contract

The repo root has no `package.json` of its own — there's nothing to install and nothing to run
from here. Everything with a build step lives in `backend/`:

```bash
cd backend && pnpm install
cd backend && pnpm generate-types   # regenerates backend/src/generated/api.ts AND
                                     # example-client/src/generated/api.d.ts, both from openapi.yaml
```

**Changed `backend/openapi.yaml`? Run it.** Nothing regenerates these automatically, and stale
stubs compile fine while silently drifting from what the backend actually accepts.
