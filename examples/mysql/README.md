# Example: MySQL

A seeded MySQL Example Source Database. Select it in `.env`:

```bash
COMPOSE_FILE=docker-compose.yaml:examples/mysql/compose.yaml
```

Then `docker compose up --build`.

> **This connector is Beta.** Postgres and MongoDB are generally available; MySQL is not. Weigh
> that before building on it.

## What this flavour needs

PowerSync replicates MySQL by reading the **binary log**, which has to be enabled and in the right
shape *before the server starts*. That is why `init-scripts/my.cnf` is mounted into the server's
config directory rather than applied by a setup script — by the time a script could run, it is too
late.

The settings that matter, all verifiable with `SELECT @@log_bin, @@gtid_mode, @@binlog_format;`:

| Setting | Value | Why |
| --- | --- | --- |
| `log_bin` | on | Nothing replicates without it |
| `gtid_mode` | `ON` | Lets replication resume from a known position |
| `enforce_gtid_consistency` | `ON` | Required alongside GTID mode |
| `binlog_format` | `ROW` | PowerSync needs rows, not the statements that changed them |
| `binlog_row_image` | `FULL` | Partial images replicate updates incorrectly |
| `server-id` | unique | Each replica in a topology needs its own |

Two users, deliberately: the write API connects as root, while PowerSync connects as a restricted
`powersync` user holding `REPLICATION SLAVE` (to read the binary log) and `SELECT` (to take the
initial snapshot). Splitting them shows the least privilege replication actually needs.

MySQL 5.7 or newer.

## Pointing at your own MySQL instead

Switch to Adopter Mode in `.env` and set `DATABASE_URI`. Your server needs the same binlog settings
above — on managed MySQL that usually means a parameter group rather than a config file. AWS Aurora
in particular needs binary logging and GTID enabled through a DB Parameter Group, which requires a
restart.

## Gotchas

`init-scripts/setup.sql` runs **only on the database's first start**. Editing it later does nothing
until you drop the volume with `docker compose down -v`.

Ids are `CHAR(36)`, not a native UUID type — MySQL has none. The client generates the id offline and
it is stored verbatim, which is what makes the round trip work.
