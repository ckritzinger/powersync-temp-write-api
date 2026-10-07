# MySQL source testing plan

Reuse the dedicated Cloud instance sequentially. Preserve Postgres, MongoDB, signing keys and tunnel identity. All changes stay inside `test-system/`.

- [x] Add a persistent MySQL 8.0 source with GTID, ROW/FULL binlogs, strict InnoDB widgets and separate writer/replication users.
- [x] Add source selection, verified local writer TLS, Cloud CLI switching and target-checked Postgres restoration.
- [x] Keep MySQL browser storage and upload queues separate from other sources.
- [x] Verify real API CRUD/replay, validation, atomic rollback and stop/skip.
- [x] Verify live two-client CRUD, offline reload, backend/database outages, SDK batching and client decisions.
- [x] Restore Postgres, verify Cloud replication and record results/runbook.

PowerSync's current MySQL binlog listener does not pass TLS options. The disposable Cloud replication connection therefore uses plaintext TCP with a separate limited replication identity; the local writer uses verified TLS. Do not use production data or credentials with this fixture. Database unavailability at startup and multi-node failover are outside the initial acceptance scope.

References: [source validation](https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mysql/src/common/check-source-configuration.ts), [binlog connection](https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mysql/src/replication/MySQLConnectionManager.ts).

Reviewed [write API PR #1](https://github.com/ckritzinger/powersync-temp-write-api/pull/1) at head `a314a009f21b65c3693849a37461201cf3546fce`. It contains no MySQL binlog/PowerSync Service changes, so it does not resolve replication TLS. No branch merge was performed.

Initial live acceptance exposed parent-adapter gaps: pool acquisition bypasses MySQL classification, and a sparse SDK PUT omitting a required name yields error 1364. Added checked fixture-only recovery/classification patches; parent sources remain untouched. All live results must identify that patch.

Rejected optimistic rows initially remained visible within the 30-second assertion window. A dedicated two-second source heartbeat resolved the observed reconciliation failures; all five live tests passed with their original reconciliation assertions. See [results](results/mysql.md).
