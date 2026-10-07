# MongoDB acceptance — 2026-10-07

MongoDB acceptance passed against the existing PowerSync Cloud instance. The combined runner switched its source from Postgres to MongoDB, passed local API checks and all five live browser tests, then restored Postgres and verified a fresh Cloud checkpoint. Both source volumes and auth keys were preserved. Changes stay inside `test-system/`; parent adapters are read-only inputs.

## Verified behavior

| Scope | Result |
| --- | --- |
| Local MongoDB API | CRUD and replay passed against an authenticated TLS replica set. Wrong-source requests were rejected. Validation failed at operation index 1; the transaction left zero documents. Batch stop/skip returned the expected outcomes. |
| Live two-client CRUD and offline recovery | Inserts, updates and deletes converged through Cloud. An offline write survived reload with one pending transaction, then drained to zero and appeared in the second client. |
| Live backend outage | One pending transaction survived reload during the outage, drained after recovery, and reached source MongoDB and client B. |
| Live MongoDB outage | With the adapter already initialized, one pending transaction survived reload and drained after database recovery; source and client B converged. |
| Live SDK batching | Stop returned success/fatal_error/not_attempted and retained the last transaction across reload. Skip returned success/fatal_error/success. Failed transactions left zero documents; recovery drained remaining work and reconciled rejected rows. |
| Live client-directed decisions | MongoDB validation failure retained three operations across reload. Explicit discard left one operation across another reload; recovery drained it. Failed source transactions left zero documents. |
| Source isolation | Six local browser tests passed, including independent Postgres/MongoDB queues for the same profile. Eight source/configuration unit tests passed. |
| Postgres restoration | Public JWKS, verify-full database TLS, replication login, invalid-token rejection and a completed Cloud widget checkpoint passed at 08:12 UTC. The existing Postgres API browser test also passed. |

The five MongoDB browser tests passed together in 1.2 minutes. Client TypeScript checks and generated backend checks/build also passed.

## Repeat

With the existing Cloud target, CLI login and tunnels configured, run from `test-system/` using Node 24:

```sh
pnpm run mongodb:acceptance
```

This command restores Postgres in `finally`, including after a test failure. Source switching can take several minutes. See the [runbook](../database/mongodb/README.md) for individual commands and [completed plan](../mongodb-plan.md) for implementation scope.

Sanitized receipts remain in ignored `.local/`:

- `mongodb-local-result.json`
- `mongodb-cloud-result.json`
- `mongodb-backend-outage-result.json`
- `mongodb-mongodb-outage-result.json`
- `mongodb-batch-result.json`
- `mongodb-decisions-result.json`
- `phase-three-result.json` for restored Postgres live verification

Future combined runs also write `mongodb-acceptance-result.json` after successful restoration. Complete Cloud exports, restore snapshots and credentials remain private.

## Limits

The local MongoDB writer verifies the fixture CA. The disposable Cloud source uses encrypted TLS with certificate verification disabled because the current MongoDB Cloud configuration schema has no custom-CA field. A publicly trusted MongoDB certificate can avoid that exception. Restored Postgres retains verify-full TLS.

Cold-start adapter/schema discovery while MongoDB is unavailable remains untested; the outage test explicitly initializes the adapter first. This fixture is a single-node replica set and does not establish multi-node failover behavior.
