# SQL Server source testing plan

Reuse the dedicated Cloud instance sequentially. Preserve all existing source volumes, signing keys and tunnel identity. Keep changes inside `test-system/`; parent adapters are read-only inputs.

- [x] Prove SQL Server startup on this ARM64 Docker host before switching Postgres or Cloud. Use an explicit amd64 image; emulation is not a Microsoft-supported deployment.
- [x] Add a persistent SQL Server fixture with Agent/CDC enabled, strict widgets, source checkpoint table and separate writer/replication identities.
- [x] Add source selection, encrypted transport, source-scoped browser queues and target-checked CLI switching/restoration.
- [x] Verify actual API CRUD/replay, validation, rollback and stop/skip.
- [x] Verify live two-client CRUD, offline reload, backend/database outages, SDK batching, decisions and rejected-row reconciliation.
- [x] Restore Postgres, verify Cloud replication and record evidence/runbook.

If the image cannot run here, retain the implementation for an x86-64 Docker host and record local/live checks as blocked instead of claiming emulated or Cloud verification. The working Postgres source remains selected until the startup gate succeeds.

References: [Microsoft platform requirements](https://learn.microsoft.com/sql/linux/install-upgrade/setup), [PowerSync SQL Server source initialization](https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mssql/dev/init.sql).
