# SQL Server source fixture

Use Node 24 and the existing dedicated Cloud target and ngrok tunnels. Restore Postgres before starting. Run from `test-system/`:

```sh
pnpm run mssql:probe
pnpm run mssql:acceptance
```

The independent probe uses loopback port 5434 and leaves Cloud and Postgres selected. Acceptance first repeats that startup/CDC gate, saves the actual Postgres Cloud configuration privately, then switches the existing TCP tunnel's port 5433 to SQL Server. After deploying, it waits up to five minutes until Cloud's active sync rules replicate `dbo.widgets` with initial replication complete and no fatal errors; a service switch can otherwise leave the previous Postgres rules replicating against SQL Server. It then runs actual local API checks and five live browser tests, and restores/verifies Postgres in `finally`. Failed tests remain failed even when restoration succeeds. Read [results](../../results/mssql.md) for actual verification status.

For individual stages: `mssql:setup`, `mssql:up`, `mssql:verify`, `mssql:cloud`, and `mssql:restore`. Individual `up`/`cloud` commands leave SQL Server selected until you run `restore`. The complete acceptance workflow restores automatically. Keep `pnpm run tunnels` running throughout. If the tunnel agent restarts, the TCP address can change: run `pnpm run tunnels:capture` and reissue the Postgres tunnel certificate before restoring. Keys, credentials, volumes and browser queues are preserved.

The pinned SQL Server 2022 Developer image is `linux/amd64`. Microsoft supports SQL Server containers on x86-64 Linux hosts; emulation on this ARM64 Mac is unsupported. The startup gate checks Agent and an actual CDC change before interrupting Postgres. A successful emulated test is development evidence, not supported production deployment evidence. See [Microsoft requirements](https://learn.microsoft.com/sql/linux/install-upgrade/setup).

The fixture enables database CDC, `dbo.widgets` CDC and `dbo._powersync_checkpoints` CDC. SQL Server Agent runs capture/cleanup jobs. Widgets use string UUID primary keys and required names. The writer can only read/write widgets. The replication login has source/checkpoint and CDC reads, checkpoint insert/update, metadata visibility, CDC reader membership, and SQL Server 2022 performance-state permissions. It is not a database owner or sysadmin. Checkpoints use PowerSync's native source mechanism; no periodic heartbeat is added.

The server requires TLS. The local writer verifies the generated CA through a public certificate mount and `NODE_EXTRA_CA_CERTS`. Cloud's current SQL Server connection schema has no custom CA setting; this disposable source uses encrypted connections with `additionalConfig.trustServerCertificate=true`. This does not prove Cloud certificate identity verification. All root/writer/replication secrets are independently generated and ignored under `.local/`; sqlcmd receives passwords from environment variables, never command arguments.

Two checked adaptations apply only to the generated backend: forward explicit TLS settings and classify initial pool connection errors. The manifest records `mssqlRecoveryFix: test-patch`. Parent sources remain unchanged. Browser databases/settings/decisions are scoped by source, and stale tabs cannot upload to another selected source.

Private evidence includes `.local/mssql-startup-result.json`, `.local/mssql-local-result.json`, the five browser receipts and `.local/mssql-acceptance-result.json`. Complete source/restore exports and CLI logs also remain private. Do not share them without redaction.

The database-outage case allows 150 seconds for Cloud-to-client recovery while retaining 30-second API/source assertions. The [official SQL Server limiter](https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mssql/src/replication/MSSQLErrorRateLimiter.ts) waits 30 seconds after ordinary replication errors and 120 seconds after DNS/refused-connection errors. Its receipt records measured recovery time; client B reconnects through the SDK without manual intervention. This tests eventual recovery within that budget, not recovery within 30 seconds.
