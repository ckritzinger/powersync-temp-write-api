# PowerSync Write API

A self-hostable backend for the PowerSync write path: a client uploads its queued local changes to
an HTTP API, which persists them to your source database. PowerSync replicates that database back
to clients.

Clone it, point it at your own database, and change the code.

![Architecture diagram](./diagram.png)

## Quickstart — see it work

This brings up a complete, self-contained system with **no configuration and no credentials**: a
seeded Postgres, the PowerSync service, the write API, and a small demo client.

```bash
docker compose up --build
```

- Demo client: http://localhost:5173
- Write API: http://localhost:6060
- PowerSync: http://localhost:8080
- Example Postgres: localhost:5432

Open the demo client, add a todo, and watch it land in Postgres and sync back.

**This is a smoke test, not the product.** The todo schema, the seed data and the demo client are
scaffolding to prove the machinery works before you wire in anything of your own. Everything
specific to it lives under `examples/` and can be deleted in one go.

## Point it at your own database

Edit `.env` and select Adopter Mode:

```bash
COMPOSE_FILE=docker-compose.yaml
DATABASE_TYPE=postgres
DATABASE_URI=postgres://user:password@your-host:5432/your-db
```

Then describe your own schema in `config/service.yaml` and `config/sync-config.yaml`. Those two
files are yours from the first minute — no example ever writes to them.

**Fill in `config/sync-config.yaml` before you start.** It ships empty, because only you know your
schema, and PowerSync will restart in a loop logging `'streams' are required` until it has at
least one stream. Remember `auto_subscribe: true` — without it a stream syncs nothing and reports
no error anywhere.

If your database runs on this machine rather than in Docker, reach it at `host.docker.internal`,
not `localhost` — inside a container, `localhost` is the container.

In Adopter Mode there is no bundled database and no demo client. Bring your own client.

> Bucket storage — PowerSync's own internal store — always runs in a container this project owns,
> in every mode. We never create schemas in a database you merely pointed us at.

## Switching modes

Mode selection is the `COMPOSE_FILE` line in `.env`, with the alternatives sitting there commented
out. The command stays a plain `docker compose up`, so `down`, `logs` and `ps` behave normally.

| `.env` line | What runs |
| --- | --- |
| `docker-compose.yaml:examples/postgres/compose.yaml` | Example Mode, [Postgres](./examples/postgres/README.md) |
| `docker-compose.yaml:examples/mongodb/compose.yaml` | Example Mode, [MongoDB](./examples/mongodb/README.md) |
| `docker-compose.yaml:examples/mysql/compose.yaml` | Example Mode, [MySQL](./examples/mysql/README.md) (Beta) |
| `docker-compose.yaml:examples/mssql/compose.yaml` | Example Mode, [SQL Server](./examples/mssql/README.md) (Beta) |
| `docker-compose.yaml` | Adopter Mode, your database |

Only one runs at a time — they share ports, and each has its own Compose project name so switching
never reuses the previous flavour's volumes.

**Bring the current mode down before switching.** Because each mode is its own Compose project,
`docker compose down` only stops the mode currently selected in `.env`. Edit the line first and the
old containers keep running and holding ports, and the new mode fails with
`Bind for 0.0.0.0:6060 failed: port is already allocated`. Down first, then switch.

If you would rather be explicit, the same thing without `.env`:

```bash
docker compose -f docker-compose.yaml -f examples/postgres/compose.yaml up
```

## Layout

```
write-api/
├── docker-compose.yaml       # Base: PowerSync, bucket storage, write API
├── .env                      # Mode selection and throwaway dev keys
├── config/                   # ADOPTER MODE config — yours to edit
│   ├── service.yaml
│   └── sync-config.yaml
├── examples/                 # Delete this when you no longer need it
│   └── postgres/
│       ├── compose.yaml      # Seeded Postgres + demo client
│       ├── powersync/        # This example's PowerSync config
│       └── init-scripts/     # Demo schema + seed data
├── backend/                  # The write API (Express, port 6060)
│   └── openapi.yaml          # Shared contract, read by both packages
└── frontend/                 # Demo client (React/Vite) — a test fixture
```

## Changing the backend

Append the development overlay to whichever mode you are in:

```bash
COMPOSE_FILE=docker-compose.yaml:examples/postgres/compose.yaml:docker-compose.dev.yaml
```

Your working tree is mounted into the container and the process restarts on save — an edit is
serving in about two seconds, with no image rebuild. It works in Adopter Mode too, which is
arguably where it matters more: wiring this into your own database is exactly when you are editing
`src/persistance/` and `src/auth/verifier.ts`.

Without the overlay, changes ship on rebuild — the deployment-shaped path:

```bash
docker compose up --build
```

The demo client is a Vite app, so its own loop is the usual one, on the host:

```bash
cd frontend && pnpm dev
```

That reads `.env.local` at runtime, so changing a URL needs no rebuild. In the container the client
is a production build with its URLs baked in, which is why it is not part of the overlay.

Auth seams worth knowing: `backend/src/auth/verifier.ts` is where you swap the demo's tokens for
your own identity provider — see [auth-verifiers.md](./auth-verifiers.md) for worked examples.

Replacing the throwaway signing keys is one command:

```bash
cd backend && pnpm generate-keys      # prints both values for .env
```

> The signing keys in `.env` are a **public throwaway pair**, committed so the backend signs
> consistently across restarts. Replace them before this is anything but a demo.

## Tests

```bash
pnpm install && pnpm test          # repo root: the resolved compose topology
cd backend && pnpm test            # the write API
```

The root suite asks Compose to *resolve* each mode rather than run it — no containers start and no
images are pulled, so it takes about a second. It exists because the two mechanisms holding the
mode switch together fail silently: if an example's config mount appended to the base's instead of
replacing it, the stack would come up perfectly healthy pointing at the wrong sync rules.

The backend's own suite needs no Docker.

## Generating types from the contract

Both packages generate TypeScript from `backend/openapi.yaml`:

```bash
cd backend && pnpm generate-types   # -> src/generated/api.ts
cd frontend && pnpm generate        # -> src/generated/api.d.ts
```

## Troubleshooting

**`ports are not available: ... 6060: bind: address already in use`** — something on the host is
already using the port, commonly a backend started with `pnpm start`. Stop it; the containerised
backend needs 6060.

**Sync config changes do nothing** — the service reads them at boot. `docker compose restart powersync`.

**Schema or seed changes do nothing** — init scripts only run on a database's first start.
`docker compose down -v` to drop the volume, then up again.
