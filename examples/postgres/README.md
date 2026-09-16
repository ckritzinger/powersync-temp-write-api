# Example: Postgres

A seeded Postgres Example Source Database, plus the demo client. Select it in `.env`:

```bash
COMPOSE_FILE=docker-compose.yaml:examples/postgres/compose.yaml
```

Then `docker compose up --build`.

## What this flavour needs

PowerSync replicates from Postgres via **logical decoding**, which is why the container runs with
`wal_level=logical`. Two things must exist in the database:

- A publication named `powersync` covering the replicated tables. `init-scripts/setup.sql` creates
  it — a Postgres source without one replicates nothing.
- A user with `SELECT` on those tables and replication rights. The example uses the superuser,
  which you should not do anywhere real.

Postgres 11 or newer. The connector is **generally available** — the most mature of the four.

## Pointing at your own Postgres instead

You do not need this example for that. Switch to Adopter Mode in `.env` and set `DATABASE_URI`.
The requirements above still apply to your database: logical replication enabled, a `powersync`
publication, and a user that can read the tables.

If your database is on this machine rather than in Docker, reach it at `host.docker.internal`
rather than `localhost` — inside a container, `localhost` is the container.

Hosted Postgres generally needs `sslmode` changed from `disable` in `config/service.yaml`.

## Gotchas

`init-scripts/setup.sql` runs **only on the database's first start**. Editing it after the fact
does nothing until you drop the volume:

```bash
docker compose down -v
```

The seeded list id is fixed (`75f89104-…`) so the seeded todos can reference it. Changing it means
changing both.
