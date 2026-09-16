# Self-hosting plan: hand `write-api` to an adopter

## Goal

`write-api` becomes a **starter template**. An adopter clones it, points it at their own
source database, runs it, and edits the backend code. The todo app and its seeded tables are
scaffolding — clearly fenced, clearly deletable.

## Vocabulary

Used consistently across the READMEs. Not written to `CONTEXT.md` — that stays as-is.

- **Adopter** — the person we hand this to. Distinct from **Writer**, which already means an
  authenticated end user in this codebase.
- **Example Source Database** — the bundled, seeded, throwaway database.
- **Example Mode** / **Adopter Mode** — the two run modes.
- **Source database** — whichever database is actually configured. Plays two roles at once:
  PowerSync *replicates from* it, and the write API *persists to* it.
- **Bucket storage** — the PowerSync service's own internal store. Ours, not the adopter's.

## The two modes

**Example Mode** — the default, and the README's first command. Zero config, zero credentials.
`docker compose up` yields a working system with a seeded database and the todo frontend.
Framed explicitly as *verify the machinery, then replace it*, so nobody mistakes the todo app
for the product.

**Adopter Mode** — the real path. No source database container, no frontend. `DATABASE_URI`
must be set; the backend fails loudly with a readable message when it isn't, rather than
defaulting to something surprising.

## Fixed rule

**Bucket storage never leaves the docker boundary.** Always MongoDB, always a container we own.
Even where PowerSync would allow sharing an adopter's Postgres 14+ instance (supported from PG14
onward, blocked below it), we don't. We do not create schemas in someone else's database.

## Layout

```
write-api/
├── docker-compose.yaml           # base: powersync, mongo, mongo-rs-init, backend
├── docker-compose.dev.yaml       # overlay: bind-mount backend/, tsx watch
├── .env                          # COMPOSE_FILE + dev keypair + adopter's DATABASE_URI
├── .env.template
├── README.md                     # rewritten
├── config/                       # ADOPTER MODE config — the adopter's from minute one
│   ├── service.yaml
│   └── sync-config.yaml
├── examples/
│   ├── postgres/
│   │   ├── compose.yaml
│   │   ├── README.md
│   │   ├── powersync/{service.yaml,sync-config.yaml}
│   │   └── init-scripts/setup.sql
│   ├── mongodb/
│   │   ├── compose.yaml
│   │   ├── README.md
│   │   └── powersync/{service.yaml,sync-config.yaml}
│   ├── mysql/
│   │   ├── compose.yaml
│   │   ├── README.md
│   │   ├── powersync/{service.yaml,sync-config.yaml}
│   │   └── init-scripts/{my.cnf,setup.sql}
│   └── mssql/
│       ├── compose.yaml
│       ├── README.md
│       ├── powersync/{service.yaml,sync-config.yaml}
│       └── init-scripts/setup.sql
├── backend/
│   ├── openapi.yaml              # moved from repo root
│   └── …
└── frontend/                     # test fixture; exists only inside Example Mode
```

### Why base + overlays

The matrix is four flavours x two modes x (dev | built). Overlays compose **multiplicatively**:
five overlay files cover eight combinations, and adding a fifth flavour is one new file.

Two alternatives were rejected:

- **One compose file per example** (the `self-host-demo` pattern, using `include:` + `extends:`)
  restates the mount and `depends_on` wiring four times, and `include:` cannot override an
  included service's `depends_on` — a wall `self-host-demo` hit on its own MSSQL demo, forcing
  a copy-paste of the backend service. We would hit it on the identical flavour.
- **One file with Compose profiles** breaks on the config mount: the `powersync` service needs a
  different `/config` source per flavour, and a single service definition cannot vary its volumes
  by profile. The workaround (templating the path through a variable) leaves two things that must
  agree; out of step, it boots the wrong sync rules with no error.

### Overlay conventions

- Each example overlay carries a top-level `name:` (`write-api-postgres`, …) so switching
  flavours never silently reuses the previous flavour's volumes.
- Flavour-specific values (`DATABASE_TYPE`, `DATABASE_URI`, `PS_DATA_SOURCE_URI`) are literals in
  the overlay. They are facts about the flavour, not things a human edits.
- `.env` holds only what a human edits.
- **Relative paths inside an overlay resolve against the project directory** — the directory of
  the *first* compose file, i.e. the repo root — not against the overlay's own location.
  Verified. So `examples/postgres/compose.yaml` writes `./examples/postgres/powersync:/config`,
  not `./powersync:/config`. This reads wrong at a glance and will trip up anyone adding a
  flavour; call it out in a comment at the top of each overlay.

## Switching modes

One line in `.env`, alternatives sitting there commented out:

```bash
COMPOSE_FILE=docker-compose.yaml:examples/postgres/compose.yaml
# COMPOSE_FILE=docker-compose.yaml:examples/mongodb/compose.yaml
# COMPOSE_FILE=docker-compose.yaml:examples/mysql/compose.yaml
# COMPOSE_FILE=docker-compose.yaml:examples/mssql/compose.yaml
# COMPOSE_FILE=docker-compose.yaml                              # Adopter Mode
```

Append `:docker-compose.dev.yaml` for the watch loop. The command is always plain
`docker compose up`, so `down` / `logs` / `ps` behave exactly as anyone expects. The explicit
`-f` form is documented underneath for anyone who prefers it.

## The four examples

| Flavour | Source container | Bootstrap | Connector status |
|---|---|---|---|
| **Postgres** | `postgres:18`, `wal_level=logical` | `setup.sql` ending in `create publication powersync` | GA (11+) |
| **MongoDB** | *none* — reuses the base `mongo` replica set, second database | none; `post_images: auto_configure` | GA (6.0+) |
| **MySQL** | `mysql`, mounted `my.cnf` | `gtid_mode`, `enforce_gtid_consistency`, `binlog_format=ROW`, `binlog_row_image=FULL`, server-id, `REPLICATION SLAVE` user | Beta (5.7+) |
| **SQL Server** | `mssql` + one-shot setup container | `sp_cdc_enable_db`, CDC-enabled `_powersync_checkpoints`, per-table `sp_cdc_enable_table`, `cdc_reader` grant | Beta (2019+) |

MongoDB is nearly free: the base already runs a Mongo replica set for bucket storage, so the
example points replication at a second database on the same instance.

All four remain valid `DATABASE_TYPE` values in Adopter Mode regardless — this table is only
about which flavours ship a runnable database.

## Sync rules: migrate to edition 3

Both formats work on `journeyapps/powersync-service:latest`, and `bucket_definitions:` is legacy
rather than deprecated — but whatever we ship is what an adopter copies when writing rules for
their own schema, and upstream docs now describe only `streams:`.

Three changes that must land together:

1. `config: {edition: 3}` + `streams:` replacing `bucket_definitions:`
2. `sync_config:` replacing the deprecated `sync_rules:` key in the service config
   (specifying both is a hard error)
3. `auto_subscribe: true` on **every** stream

File renames following upstream: `config/powersync.yaml` -> `config/service.yaml`,
`config/sync_rules.yaml` -> `config/sync-config.yaml`.

MongoDB's rules differ by necessity, because `_id` is the primary key:

```yaml
queries:
  - select _id as id, * from lists
  - select _id as id, * from todos
```

**Gotcha:** `auto_subscribe` defaults to `false`. Omit it and the client syncs nothing, with no
error. Client-side subscription is new in edition 3; the legacy format has no equivalent.

No frontend code changes needed: `@powersync/web` is at `^1.38.7`, past the 1.32.0 threshold
where the Rust sync client became the default.

## Auth and keys

A fixed throwaway keypair committed in `.env`, commented as public and replaceable, plus a
`pnpm generate-keys` script wrapping the existing `src/utils/generate-key.ts`.

Rationale: `src/api/auth.ts` generates a temporary keypair at boot when
`POWERSYNC_PRIVATE_KEY` is unset. Under `tsx watch` the backend restarts on every save, so every
save mints a new signing key and silently 401s every token already issued — failures that look
like a bug in the adopter's own change.

`PS_JWKS_URL` becomes `http://backend:6060/api/auth/keys`. The backend is inside compose now, so
`host.docker.internal` goes away entirely.

Frontend `VITE_*` build args stay on `localhost` ports — they resolve in the browser, not on the
compose network.

## `openapi.yaml` moves into `backend/`

The containerised backend currently **boots but serves nothing**: `backend/app.ts` reads
`path.join(__dirname, '..', 'openapi.yaml')`, but `backend/Dockerfile`'s build context is
`backend/`, so the spec is never copied in. The validator loads the spec lazily, so the container
starts cleanly and then answers every request with
`500 openapi.validator: spec could not be read at /openapi.yaml`.

Four edits:

- `backend/app.ts:27` — `path.join(__dirname, '..', 'openapi.yaml')` -> `path.join(__dirname, 'openapi.yaml')`
- `backend/package.json:13` — `../openapi.yaml` -> `./openapi.yaml`
- `frontend/package.json:6` — `../openapi.yaml` -> `../backend/openapi.yaml`
- `README.md:41` — wording

## Dev loop

`docker-compose.dev.yaml` bind-mounts `backend/` and runs `tsx watch`. It touches the backend
only, because that is the code adopters change, and because an adopter in Adopter Mode has no
frontend service for a combined overlay to reference.

It applies to **both** modes. Adopter Mode + dev is arguably the primary case: someone wiring the
write API into their own database is exactly who is editing `src/persistance/` and
`src/auth/verifier.ts`.

The frontend's dev mode (`vite dev` against a bind-mount, with HMR and runtime `.env` reading
instead of baked-in build args) folds into the example overlays, where a frontend exists.

A full `docker compose build` path remains as the deploy-shaped reference.

## Deliverables

1. Rewritten root `README.md` — Example Mode quickstart, then Adopter Mode setup, then the
   code-change loop.
2. Four per-example READMEs covering each flavour's prerequisites and gotchas.

Explicitly **not** in scope: `CONTEXT.md` updates, ADRs, `.scratch/` issues. The service image
stays on `:latest`.

## Risks

1. ~~The config mount override is load-bearing.~~ **Verified** on Compose v2.38.2. An overlay
   declaring `./examples/postgres/powersync:/config` *replaces* the base's `./config:/config` —
   the resolved config has exactly one bind at `/config`, pointing at the example. Volumes merge
   keyed by target path, as hoped. No fallback needed.
2. ~~`COMPOSE_FILE` read from `.env`.~~ **Verified.** With
   `COMPOSE_FILE=docker-compose.yaml:examples/postgres/compose.yaml` in `.env`, a bare
   `docker compose config` resolves the merged stack and picks up the overlay's `name:`
   (`write-api-postgres`). Setting it to `docker-compose.yaml` alone yields Adopter Mode with the
   `./config` mount and the default project name. No fallback needed.
4. **Four examples means four sets of sync rules** that must move together whenever the demo
   schema changes. Ongoing drift we are signing up for.
5. **MySQL and SQL Server are Beta connectors.** On SQL Server, schema changes are *not* picked
   up automatically — every table change needs a redeployed sync config. A real footgun for a
   repo whose point is swapping in your own schema. Goes in `examples/mssql/README.md`.
6. **`:latest` drift.** A clone six months from now gets a service version we never tested
   against. Accepted deliberately.
