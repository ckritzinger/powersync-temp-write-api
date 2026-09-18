# PowerSync Write API

A self-hostable backend for the PowerSync write path: a client uploads its queued local changes to
an HTTP API, which persists them to your source database. PowerSync replicates that database back
to clients.

Clone it, point it at your own database and PowerSync instance, and change the code.

This repo assumes a **hosted PowerSync instance** ([PowerSync Cloud](https://www.powersync.com/) or
your own self-managed deployment elsewhere) and a **database you already run**. It does not bundle
either.

## Quickstart

```bash
docker compose up --build
```

Brings up the write API alone, at http://localhost:6060. On its own it has nothing to write to —
before it's useful you need:

1. **A database**, with replication already turned on so PowerSync can read its change feed. Set
   `DATABASE_TYPE` and `DATABASE_URI` in `.env`. Every database flavour needs something enabled
   before it replicates at all:

   | Flavour        | What must be true of your database                                                                                                                                                                                                                                                                                    |
   | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **Postgres**   | a publication named `powersync` covering the replicated tables; a user with `SELECT` on them and replication rights. **A Postgres source without a publication replicates nothing.**                                                                                                                                  |
   | **MongoDB**    | A replica set — change streams and the multi-document transactions the write API uses both require one. Post-images configured (`post_images: auto_configure`), since change streams alone do not carry the pre-update document.                                                                                      |
   | **MySQL**      | `log_bin` on, `gtid_mode=ON`, `enforce_gtid_consistency=ON`, `binlog_format=ROW`, `binlog_row_image=FULL`, a unique `server-id`; a user with `REPLICATION SLAVE` and `SELECT`. On managed MySQL these usually live in a parameter group and need a restart.                                                           |
   | **SQL Server** | CDC enabled at database level and per replicated table; a CDC-enabled `_powersync_checkpoints` table; SQL Server Agent **running**, or CDC captures nothing while appearing enabled; the user needs `cdc_reader`, `VIEW DATABASE PERFORMANCE STATE` in the database, and `VIEW SERVER PERFORMANCE STATE` in `master`. |

2. **A PowerSync instance** pointed at that same database, with sync rules for your schema. Its
   custom-auth (JWKS) settings need to reach this backend's `GET /api/auth/keys` — for local dev
   that means tunnelling `localhost:6060` (e.g. ngrok) so PowerSync Cloud can reach it.

3. Set `POWERSYNC_URL` and `JWT_ISSUER` in `.env` to whatever audience/issuer your PowerSync
   instance's auth settings expect.

4. **Your client needs to reach this backend.** `localhost:6060` only works if the client runs on
   this same machine. Otherwise either bind the backend to `0.0.0.0` and put a client on the same
   network, or tunnel it (e.g. `ngrok http 6060`) and point the client at the public URL instead.

5. **Your client needs code to actually call this backend.** Nothing calls `/api/data` for you —
   copy the pieces in `example-client/` into your app to perform writes. See
   `example-client/README.md` (fuller install docs there coming later).

If your database runs on this machine rather than in Docker, the backend reaches it at
`host.docker.internal`, not `localhost` — inside a container, `localhost` is the container.

## Layout

```
write-api/
├── docker-compose.yaml       # The write API, standalone
├── docker-compose.dev.yaml   # Overlay: edit backend code without rebuilding
├── .env                      # Backend config and throwaway dev keys
├── backend/                  # The write API (Express, port 6060) — this is the product
│   └── openapi.yaml          # The write API's contract, also consumed by example-client/
├── example-client/           # Minimum PowerSync-client code that calls the write API — read-only
│                              # reference, not a runnable project
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

Your working tree is mounted into the container and the process restarts on save — no image
rebuild. Or skip Docker entirely and run `pnpm dev` on the host (see `backend/README.md`).

Seams worth knowing:

- `backend/src/auth/verifier.ts` — swap the demo's tokens for your own identity provider. See
  [docs/auth-verifiers.md](./docs/auth-verifiers.md).
- `backend/src/auth/authorizer.ts` — **there is no authorization by default**, only
  authentication. Every authenticated write is currently allowed, no matter what it touches. See
  [docs/authorization.md](./docs/authorization.md).
- `backend/src/mapping/` — how a `CrudEntry` becomes a database write. The default is a naive 1:1
  field pass-through. See [docs/schema-mapping.md](./docs/schema-mapping.md).

Replacing the throwaway signing keys is one command:

```bash
cd backend && pnpm generate-keys      # prints both values for .env
```

> The signing keys in `.env` are a **public throwaway pair**, committed so the backend signs
> consistently across restarts. Replace them before this is anything but a demo.

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
