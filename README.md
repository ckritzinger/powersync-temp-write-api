# PowerSync Write API

## TODO

 - [ ] server-side dead-lettering is not implemented.
 - [ ] No auth on /api/auth/token out of box. Quickstart path = open door.
 - [ ] Boot behavior inconsistent across DBs
 - [ ] Zero test coverage on persistence/mapping layer
 - [ ] Unmapped Mongo table writes fail silently
 - [ ] Fully typed client vs fetch-only single-file that can be copypastaed

## Intro

This is a self-hostable backend for the PowerSync write path: a client uploads its queued local changes to
an HTTP API, which persists them to your source database. PowerSync replicates that database back
to clients.

**Clone it, point it at your own database and PowerSync instance, and change the code.**

This repo assumes you already have:

1. A **hosted PowerSync instance** ([PowerSync Cloud](https://www.powersync.com/) or your own
   self-managed deployment elsewhere) connected to a **database you already run**
   (see [supported databases](https://docs.powersync.com/configuration/source-db/setup)).
   It does not bundle either of these.

2. A front-end already connected to PowerSync, displaying local data, and updating its local
   SQLite database with data mutations via `db.execute(...)`, as described in the
   [PowerSync Setup Guide](https://docs.powersync.com/intro/setup-guide#write-data).

PowerSync automatically queues these mutations and calls your `uploadData()` function, which is
where you upload the changes to your backend. The write API is that backend: it persists the
mutations to your source database. The `example-client` folder has a reference implementation of
`uploadData()` that connects to this API.

## Quickstart

```bash
docker compose up --build   # Crash-loops until configuration below is done, it needs DATABASE_TYPE and DATABASE_URI to boot
```

Brings up the write API at http://localhost:6060

### Configuration

For the API to be usable, you need to perform the following config:

1. Replace the throwaway signing keys:
   ```bash
   cd backend && pnpm generate-keys      # prints both values for .env
   ```

> The signing keys in `.env` are a **public throwaway pair**. These are committed so the backend signs
> consistently across restarts. __Replace them before this is anything but a demo.__ If no keypair is
> configured at all, the backend generates a temporary one at boot instead. This is fine for a one-off
> run, but every restart will create a new key. Once this happens, PowerSync will reject tokens it
> accepted moments earlier with:
> `PSYNC_S2101 — Could not find an appropriate key in the keystore`.

2. Set the rest of `.env`:

   | Variable | Meaning |
   | --- | --- |
   | `DATABASE_TYPE` | `postgres`, `mongodb`, `mysql`, or `mssql` |
   | `DATABASE_URI` | Connection string for your source database |
   | `PORT` | Defaults to 6060 |
   | `POWERSYNC_URL`, `JWT_ISSUER` | Audience and issuer for the tokens this backend mints — must match your PowerSync instance's auth settings |
   | `POWERSYNC_PRIVATE_KEY`, `POWERSYNC_PUBLIC_KEY` | The signing keys from step 1 |

   The backend refuses to start, before serving any traffic, if `DATABASE_URI` is unset or
   `DATABASE_TYPE` isn't one of the four above — with a message naming the fix, not a stack trace.

3. **Your client needs code to actually call this backend.** Nothing calls `/api/data` for you —
   copy the pieces in `example-client/` into your app to perform writes. See
   `example-client/README.md` for detailed instructions.

4. **Your client needs to reach this backend.** `localhost:6060` only works if the client runs on
   this same machine. Otherwise either bind the backend to `0.0.0.0` and put a client on the same
   network, or tunnel it (e.g. `ngrok http 6060`) and point the client at the public URL instead.

> If your database runs on this machine rather than in Docker, the backend reaches it at
> `host.docker.internal`, not `localhost` — inside a container, `localhost` is the container.

## Connect your front-end

The backend alone does nothing, it must be called by a PowerSync client.

To achieve that, you need to implement two methods on your `PowerSyncBackendConnector`:

 - `fetchCredentials()` (get a token from `/api/auth/token` or your own IdP), and
 -  `uploadData()` (turn queued local mutations into `POST /api/data` calls).

`example-client/` has a reference implementation of both, ready to copy into your app. Either use the
typed version or a single zero-dependency file. See [example-client/README.md](./example-client/README.md)
for what's there and how to wire it in.

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

## API overview

There are three endpoints. Only `/api/data` is in `backend/openapi.yaml` This is the main endpoint
used to write data back from the PowerSync client. The two auth endpoints below are
ancillary/for development purposes and are not included in the Write API spec.

- **POST `/api/data`** — the only write endpoint. Accepts a transaction batch (an ordered run of
  whole transactions from the client's upload queue) and applies each in its own database
  transaction, stopping at the first failure. Optional `on_fatal_error` in the body: `stop`
  (default) ends the batch there; `skip` drops that transaction and continues, so a queue blocked
  by one poison operation can still drain. Either way, the response reports one result per
  transaction sent, so the client always knows what was applied.

Every failure is either **retryable** (deadlock, lock timeout, connection loss)
or **fatal** (bad data that can never be stored, or an error the backend doesn't
recognize).
Each supported database maps its driver's own errors onto these two in `backend/src/persistance/*/*-errors.ts`.
Unrecognized errors default to fatal rather than being retried forever.

[node-postgres](https://github.com/brianc/node-postgres),
[mongodb](https://www.npmjs.com/package/mongodb), [mysql2](https://www.npmjs.com/package/mysql2),
and [node-mssql](https://www.npmjs.com/package/mssql) are used to implement the four persisters.

### Ancillary auth endpoints

- **GET `/api/auth/token`** — returns a JWT for PowerSync auth. Optional `user_id` query param
  sets the token's subject.
- **GET `/api/auth/keys`** — the JWKS endpoint your PowerSync instance's custom-auth settings
  verify tokens against.

[jose](https://github.com/panva/jose) signs and verifies the JWTs.

## Changing the backend

Append the development overlay to run with hot-reload:

```bash
COMPOSE_FILE=docker-compose.yaml:docker-compose.dev.yaml
docker compose up
```

Your working tree is mounted into the container and the process restarts on save.

Or skip Docker entirely:

```bash
cd backend && pnpm install && pnpm dev
```

**WARNING:** Running this alongside the Dockerized backend fails with "address already in use", or quietly
shadows the container port.

## Key integration points

- `backend/src/auth/verifier.ts` swap the demo's tokens for your own identity provider. See
  [docs/auth-verifiers.md](./docs/auth-verifiers.md).
- `backend/src/auth/authorizer.ts` **there is no authorization by default**, only
  authentication. Every authenticated write is currently allowed, no matter what it touches. See
  [docs/authorization.md](./docs/authorization.md).
- `backend/src/mapping/` how a `CrudEntry` becomes a database write. The default is a naive 1:1
  field pass-through. See [docs/schema-mapping.md](./docs/schema-mapping.md).

## Tests

```bash
cd backend && pnpm test    # HTTP against the assembled app, plus the boot-failure contract
cd backend && pnpm check   # types
```

Neither needs Docker.

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
