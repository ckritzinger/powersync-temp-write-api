# MySQL on the existing Cloud instance

The fixture runs MySQL 8.0.44 with a persistent volume, GTID enabled, ROW-format binlogs and FULL row images. Strict InnoDB `widgets` rows have a string UUID primary key and a required non-null name. The API writer has only widget read/write access and requires verified TLS. The separate replication user has widget/heartbeat SELECT and global REPLICATION SLAVE/CLIENT privileges; MySQL requires those global privileges for binlog access, which spans this dedicated server’s binlogs. This server hosts only fixture data.

MySQL and Postgres share the existing loopback TCP tunnel port sequentially. Their credentials and volumes are separate. Browser databases, settings and decisions are scoped by source; a fixture request header rejects mismatched queues. Normal switches preserve all source data and auth keys.

From `test-system/` with Node 24, the existing Cloud target, CLI login and both tunnels configured:

```sh
pnpm run mysql:acceptance
```

The full runner tests local API handling, deploys MySQL to the same dedicated instance through the CLI, runs five real SDK browser tests, then restores Postgres in `finally` and verifies a fresh Cloud checkpoint. CLI source transitions can take several minutes. A restore failure is surfaced; rerun `mysql:restore` after resolving it.

Individual commands:

```sh
pnpm run mysql:up
pnpm run mysql:verify
pnpm run mysql:cloud
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm exec playwright test --config client/playwright-cloud.config.ts --project=mysql
pnpm run mysql:restore
```

Open fresh clients at `http://127.0.0.1:5174/?source=mysql&profile=a` and `profile=b`. Close previous synced tabs before switching sources. Runtime changes refresh only allowlisted public client defaults.

The tests check exact source rows and client B convergence, persisted queues across offline/outage reload, rollback, stop/skip outcomes, retained unattempted writes and explicit client decisions. Explicit NULL names and SDK PUTs omitting a required name produce `NOT_NULL_VIOLATION`. Live tests exposed parent-adapter gaps in connection acquisition classification and error 1364 handling; checked generated-backend patches cover them without changing parent sources. Manifests and receipts identify the fixture patch. Database outage coverage warms the adapter before stopping MySQL.

## Transport scope

The local writer verifies the generated CA and encrypts its MySQL connection. PowerSync's current [binlog listener](https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mysql/src/replication/MySQLConnectionManager.ts) does not forward TLS options, so this disposable Cloud replication connection uses plaintext TCP. It uses fixture-only credentials and data. Postgres restoration retains verify-full TLS. TLS-enabled Cloud binlog replication would require a PowerSync Service change; write API connection options alone cannot add it.

Secrets, TLS keys, complete Cloud exports and target-checked restore snapshots stay in ignored `.local/`. The public TCP tunnel exposes only the selected source. Normal cleanup deletes only fresh test rows, preserving volumes.

See the [plan](../../mysql-plan.md) and [results](../../results/mysql.md). Sanitized evidence is recorded in `.local/mysql-*-result.json`; the combined receipt is written only after successful Postgres restoration. Cold-start database outage and multi-node failover remain outside this suite.

## Idle-source checkpoint workaround

The live tests found that rejected optimistic rows remained in client A even after the queue drained and successful writes reached client B. PowerSync’s [checkpoint specification](https://github.com/powersync-ja/powersync-service/blob/main/docs/replication/06-checkpoints.md) requires a later source event when a checkpoint mapping is created after replication has already observed its head; the MySQL route adapter currently leaves source advancement as a TODO. This fixture enables a MySQL event that increments a dedicated heartbeat row every two seconds while MySQL is running. The row is outside the widgets sync query. It creates binlog progress without compensating widget writes or editing/hiding local SQLite rows. All five live tests passed with the heartbeat enabled, including their original reconciliation assertions. This is a fixture workaround, not a promoted PowerSync Service fix.
