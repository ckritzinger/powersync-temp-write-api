# MySQL acceptance — 2026-10-07

All five live browser tests passed together in 1.7 minutes on the existing dedicated Cloud instance. The fixture keeps separate persistent MySQL data and source-scoped browser storage. Postgres was restored on that same instance, and a fresh live Cloud checkpoint passed at 08:54 UTC. Its API browser regression also passed. The combined acceptance command exited successfully; all source volumes and auth keys were preserved.

## Implemented scope

MySQL 8.0.44 runs with GTID enabled, ROW binlogs, FULL row images and a strict InnoDB widgets table. The writer requires verified TLS and has widget read/write privileges. The replication user has widget/heartbeat SELECT and binlog privileges on this dedicated fixture server. Keys, credentials and both existing source volumes are preserved.

Local API CRUD/replay, explicit NULL rejection, rollback, stop/skip and source mismatch checks passed. The writer TLS probe confirmed encryption, a configured CA and certificate verification. Seven local browser tests passed, including independent Postgres/MySQL queues for the same profile. Nine source/Cloud configuration checks, two MySQL recovery regressions and client TypeScript checks passed. The generated backend also passed its TypeScript build.

## Live verification

| Case | Verified result |
| --- | --- |
| Two-client CRUD and offline reload | Inserts, renames and deletes converged through Cloud. One offline transaction survived reload, then drained to zero and reached client B. |
| Backend outage | One pending transaction survived reload and reached MySQL/client B after recovery. |
| MySQL outage | The initialized adapter returned retryable failure; one transaction survived reload and drained after recovery, with source/client B convergence. |
| SDK stop/skip batches | Stop returned success/fatal_error/not_attempted and retained the last transaction across reload. Skip returned success/fatal_error/success. The failing pair left zero source rows. Recovery drained queues and reconciled rejected optimistic rows. |
| Client decisions | Retain preserved three pending operations across reload. Explicit discard left one operation across another reload. Recovery drained it; rejected rows were absent from source and both clients. |

The heartbeat workaround is part of these passed results. Without it, batching and client decisions failed their reconciliation assertions within 30 seconds even though rollback and queue handling succeeded. The source-side event increments only `powersync_fixture_heartbeat`, outside the widgets sync query, every two seconds. Its binlog progress resolves the observed acknowledgement problem; the [checkpoint specification](https://github.com/powersync-ja/powersync-service/blob/main/docs/replication/06-checkpoints.md) describes the idle-source race. This is a fixture workaround, not a PowerSync Service fix. No compensating widget writes, local SQLite surgery or row hiding were used.

## Adapter defects found

The initial live suite passed CRUD/offline recovery and backend outage recovery, then exposed three failing tests:

- Pool acquisition bypassed `classifyMySQLError`, so a database outage became a fatal response.
- Sparse SDK PUTs omitted the NULL name, causing MySQL error 1364 (missing required field), which was unclassified.
- That unclassified error also prevented the expected client-directed validation decision.

The initial runner restored Postgres and verified its live Cloud checkpoint despite these test failures. A checked [fixture patch](../backend/patches/mysql-recovery.json) now classifies acquisition failures, retries known DNS failures and maps error 1364 to `NOT_NULL_VIOLATION`. Focused regressions passed. Parent sources remain unchanged, so the patch must be reviewed and promoted separately before claiming equivalent behavior from the production adapter. Live receipts record `mysqlRecoveryFix: test-patch` and backend source/prepared fingerprints.

The idle-source workaround was verified live with the original reconciliation assertions. Replication can read the dedicated heartbeat table’s metadata as well as widget rows; it has no source write privileges.

## Transport and PR review

The local writer verifies TLS. The current PowerSync [MySQL binlog listener](https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mysql/src/replication/MySQLConnectionManager.ts) does not pass TLS options; this disposable Cloud replication connection uses plaintext TCP and fixture-only data/credentials. Restored Postgres uses verify-full TLS.

The requested [write API PR #1](https://github.com/ckritzinger/powersync-temp-write-api/pull/1) was reviewed at `a314a009f21b65c3693849a37461201cf3546fce`. It changes write API behavior, Postgres SSL handling and SQL Server options, but contains no MySQL binlog changes. It was not merged.

## Repeat and evidence

From `test-system/` with Node 24 and the existing target/login/tunnels configured:

```sh
pnpm run mysql:acceptance
```

The [runbook](../database/mysql/README.md) has individual switch/verify/restore commands. Private Cloud exports, credentials and restore snapshots remain ignored in `.local/`. Sanitized receipts are:

- `.local/mysql-local-result.json`
- `.local/mysql-cloud-result.json`
- `.local/mysql-backend-outage-result.json`
- `.local/mysql-mysql-outage-result.json`
- `.local/mysql-batch-result.json`
- `.local/mysql-decisions-result.json`
- `.local/mysql-acceptance-result.json` for combined status and restoration
- `.local/phase-three-result.json` for restored Postgres verification

The combined receipt becomes passed only after successful Postgres restoration; failures remain marked failed even if restoration succeeds.

A database unavailable at adapter startup and multi-node failover remain untested.
