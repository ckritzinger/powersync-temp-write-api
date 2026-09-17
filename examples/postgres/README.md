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

## Verify it end to end

The automated suite checks the resolved topology, not a live round trip — that is deliberate, since
bringing four flavours up is slow and flaky. This is the manual check it stands in for.

**1. Everything healthy.**

```bash
docker compose ps
```

**2. Get a token and write through the API.**

```bash
TOKEN=$(curl -s "http://localhost:6060/api/auth/token?user_id=demo-user" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:6060/api/data \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"transactions":[{"transaction_id":1,"crud":[{"op":"PUT","table":"todos",
       "id":"11111111-1111-1111-1111-111111111111",
       "op_data":{"description":"smoke test","completed":false,
                  "list_id":"75f89104-d95a-4f16-8309-5363f1bb377a"}}]}]}'
```

Expect `{"results":[{"status":"success"}]}`.

**3. Confirm it reached the database.**

```bash
docker compose exec -T pg-db psql -U postgres -d postgres \
  -c "select description from todos where description='smoke test'"
```

**4. Confirm it syncs back.**

```bash
curl -sN -m 10 -X POST http://localhost:8080/sync/stream \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"buckets":[],"include_checksum":true,"raw_data":true}' | grep "smoke test"
```

If step 4 finds nothing, replication is the problem, not the write — check `docker compose logs powersync`.
