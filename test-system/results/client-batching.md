# Real SDK batching acceptance — 2026-10-06

Passed using the repository's prepared single-file connector, PowerSync Web SDK 2.4.2, actual fixture API/Postgres and two independent clients connected to the dedicated PowerSync Cloud instance. The backend used the baseline profile with the upstream database recovery fix. Parent connector/backend sources were unchanged for this task.

The client now saves a per-profile transaction limit (1–50, default 1). Its subclass overrides the connector's existing `getBatchingConfig()` hook, preserving the operation limit and existing upload/completion logic. The test selects 3, disconnects client A, and queues three separate transactions containing 1, 2 and 1 operations: valid insert, valid-plus-invalid pair, final valid insert. It checks the actual SDK-generated request contains those exact transactions in order.

| Mode | Actual response statuses | Pending after upload | Pending after reload | Reconnect behavior |
| --- | --- | --- | --- | --- |
| `stop` | `success`, `fatal_error`, `not_attempted` | 1 operation | 1 operation | Actual next SDK request contains only the final transaction; it succeeds and queue reaches zero |
| `skip` | `success`, `fatal_error`, `success` | 0 operations | 0 operations | Both valid rows already committed; queue remains empty |

In both modes the middle transaction reported backend-handled `NOT_NULL_VIOLATION` at operation index 1. Neither middle row existed in Postgres or client B. The rejection notice listed both IDs, survived reload and did not duplicate after reconnect. Normal Cloud checkpoints removed the rejected optimistic rows from A. Both valid rows ultimately matched in Postgres and client B; A and B had empty queues. In `stop`, the final row was absent from source and B until reconnect.

Validation: TypeScript check; focused live SDK batching test; four local browser checks and one actual API/Postgres browser check. The live test restores the configured backend batch mode and service availability, closes its own browser contexts and deletes only its fresh source rows. Signing keys, database volume and unrelated data are preserved. Sanitized receipt: `.local/live-recovery-results/client-batch-stop-skip.json`.

Repeat from `test-system/` with Node 24, the fixture services, tunnels and configured Cloud instance available:

```sh
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm run client:test:cloud:batch
```

This establishes real multi-transaction queue completion and unattempted retention for the default backend-handled fatal path. [Client-directed decision acceptance](client-decisions.md) is recorded separately with its explicit test-only routing profile. Arbitrary exactly-once side effects and durable server dead-letter storage remain outside these cases.
