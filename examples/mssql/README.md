# Example: SQL Server

A seeded SQL Server Example Source Database. Select it in `.env`:

```bash
COMPOSE_FILE=docker-compose.yaml:examples/mssql/compose.yaml
```

Then `docker compose up --build`.

> **This connector is Beta**, and it has a sharp edge the others do not — see *Schema changes*
> below before you change any table.

## Schema changes are not adopted automatically

SQL Server replicates through **Change Data Capture**, and CDC captures a table's shape at the
moment it is enabled. Alter a table afterwards and replication does not notice: it keeps producing
the old shape, and your new column simply never arrives. Nothing errors.

Adopting a schema change means redeploying the Sync Config, and re-enabling CDC on the changed
table. In a project whose whole premise is swapping in your own schema, this is the thing most
likely to cost you an afternoon. It is upstream behaviour and cannot be fixed here.

## What this flavour needs

The most bootstrap of the four. There is no entrypoint directory to drop SQL into the way Postgres
and MySQL have, so `init-scripts/setup.sql` runs from a one-shot `mssql-setup` container that must
complete before PowerSync starts. It is written to be safe to run more than once.

- **CDC at database level** — `sys.sp_cdc_enable_db`.
- **A `_powersync_checkpoints` table, with CDC enabled on it.** This is PowerSync's, not yours; it
  is how the connector tracks position.
- **CDC per replicated table** — `sys.sp_cdc_enable_table` with `@role_name = N'cdc_reader'`.
- **SQL Server Agent running.** CDC capture and cleanup are Agent jobs. Without the Agent, CDC is
  enabled and nothing is ever captured — replication stays silently empty. That is what
  `MSSQL_AGENT_ENABLED: "true"` is for.
- **Two permission levels for the replication user.** `VIEW DATABASE PERFORMANCE STATE` in the user
  database, and `VIEW SERVER PERFORMANCE STATE` **in `master`**. The second is a server-level
  permission on the login; granting only the database-level one leaves replication failing with
  *"The user does not have permission to perform this action."*

The write API connects as `sa`; PowerSync connects as the restricted `powersync_user`.

SQL Server 2019 or newer, or Azure SQL Database.

## Running on Apple Silicon

Microsoft publishes no arm64 image, so this runs under emulation via `platform: linux/amd64`. It
works, but the server is slow to start — the healthcheck allows a long start period for exactly
this reason. The other three flavours run natively.

## Pointing at your own SQL Server instead

Switch to Adopter Mode in `.env` and set `DATABASE_URI`. Your database needs everything listed
above. On Azure SQL Database the login is created differently — see PowerSync's docs for
`CREATE USER ... FROM EXTERNAL PROVIDER`.

## Gotchas

Ids are `UNIQUEIDENTIFIER`. SQL Server renders them uppercase, so a lowercase id from a client and
its uppercase form in the database are the same value.

`setup.sql` is idempotent, but the seed data only inserts when the seeded list is absent. Drop the
volume with `docker compose down -v` for a genuinely clean start.

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
                  "list_id":"75F89104-D95A-4F16-8309-5363F1BB377A"}}]}]}'
```

Expect `{"results":[{"status":"success"}]}`.

**3. Confirm it reached the database.**

```bash
docker compose exec -T mssql-db /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "Powersync_demo_pw1" -C -Q \
  "USE powersync_demo; SELECT description FROM dbo.todos WHERE description='smoke test';"
```

**4. Confirm it syncs back.**

```bash
curl -sN -m 10 -X POST http://localhost:8080/sync/stream \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"buckets":[],"include_checksum":true,"raw_data":true}' | grep "smoke test"
```

CDC polls rather than streams, so step 4 can lag a few seconds behind step 3. If it never
arrives, check that SQL Server Agent is running and the CDC capture jobs exist.
