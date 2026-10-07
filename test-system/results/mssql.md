# SQL Server acceptance — 2026-10-07

Passed. `pnpm run mssql:acceptance` completed at 09:53:35 UTC on the dedicated Cloud instance, with Postgres restored and live-verified at the same time (public JWKS, `verify-full` replication TLS, replication login, invalid-token rejection, Cloud widget checkpoint, installed export).

SQL Server 2022 (16.0.4205.1) ran under amd64 emulation on this ARM64 Docker host. SQL Server Agent ran and CDC captured an actual widget change before the Cloud switch. Local API CRUD/replay, required-field validation, source mismatch rejection, transaction rollback and stop/skip passed, with verified encrypted writer connections.

All five live browser cases passed in 2.2 minutes:

| Case | Time |
| --- | --- |
| Cloud CRUD convergence and offline queue across reload | 17.0s |
| Backend outage: queue retained across reload and recovery | 13.7s |
| SQL Server established-session outage: queue retained, recovery, client B convergence | 55.2s |
| Real SDK stop/skip batches: atomicity and unattempted writes | 26.6s |
| Client-directed retain and explicit discard | 15.3s |

During the SQL Server outage, the write API returned a retryable failure. One write stayed pending across reload and drained after restart. Client B converged through SDK recovery without a manual reconnect, **43.4 seconds** after the source came back (allowed: 150 seconds). That exceeds the original 30-second assertion. The budget matches the published PowerSync SQL Server replication limiter, which waits 30 seconds after ordinary errors and 120 seconds after ECONNREFUSED/ENOTFOUND. API and source assertions remain at 30 seconds. Rejected optimistic rows reconciled through native checkpoint CDC, with no heartbeat or local SQLite surgery. After restoration, the Postgres API browser regression and all 21 script tests passed.

## Earlier failed attempts (kept in private history)

- A copied sync query used the wrong schema; it was fixed to `dbo.widgets`.
- Four of five cases passed; the outage case failed under the original 30-second client B convergence assertion.
- One run was interrupted when its parent session ended, which also stopped the tunnel agent. A manual restore restarted the tunnels, which changed the TCP address, and reissued the Postgres tunnel certificate. Postgres was verified at 09:30:43 UTC.
- In one run, all five cases failed: writes reached SQL Server but never reached client B. Cloud status showed that the previous Postgres rules (`public.widgets`) were still replicating against SQL Server after the service switch, with fatal errors. Acceptance now waits up to 5 minutes for the active rules to replicate `dbo.widgets` with initial replication complete and no fatal errors, and fails with a private status snapshot otherwise. `scripts/mssql-replication.test.mjs` covers this gate.

## Coverage limits

This fixture uses native PowerSync checkpoint CDC. Two test-only generated adapter patches forward TLS settings and classify initial pool connection errors; no parent changes are included, and promoting them to parent sources is separate work. Cloud encrypts this disposable SQL Server connection with certificate trust overridden, because the current Cloud schema has no custom CA field; Cloud certificate identity is not verified. Microsoft does not support this emulated SQL Server host, so repeat on supported x86-64 hosting before drawing production conclusions. Production auth/authorization, schema evolution, deadlocks and unavailable-at-startup live browser recovery remain separate coverage; initial transient failure classification has adapter regression coverage only.
