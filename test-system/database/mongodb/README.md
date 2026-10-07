# MongoDB on the existing Cloud instance

This fixture uses MongoDB 7.0.16 as an authenticated single-node replica set. MongoDB and Postgres have separate persistent volumes and credentials. Only the selected source binds the existing loopback TCP tunnel port (`POSTGRES_PORT`, normally 5433); switching stops the other source without removing its volume. The backend adapter uses `DATABASE_TYPE=mongodb` and verifies the fixture CA.

The `widgets` collection has string UUID `_id` values, a required string `name`, strict validation and enabled pre/post images. The writer and replication users are separate. PowerSync's replication role can read/watch `test_system` and maintain `_powersync_checkpoints`; it has no access to unrelated databases. The sync query maps `_id` to client `id`.

Run from `test-system/` with Node 24 and the existing Cloud target, CLI login, auth gateway and tunnels configured:

```sh
# Full sequential acceptance, restoring Postgres in finally:
pnpm run mongodb:acceptance
```

For individual steps:

```sh
pnpm run mongodb:up       # Save Postgres restore state, start MongoDB, initialize and rebuild backend
pnpm run mongodb:verify   # Actual local API CRUD/replay, validation, rollback, stop/skip and source guard
pnpm run mongodb:cloud    # Same instance: service deployment, query validation, sync deployment, export installation
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm exec playwright test --config client/playwright-cloud.config.ts --project=mongodb
pnpm run mongodb:restore # Restore local Postgres and saved Cloud configuration; run its live checkpoint verification
```

The CLI may take several minutes when switching source engines. Schema and connection checks can pass while query validation against the old source times out; the workflow deploys service configuration first, then validates and deploys the new sync query. Transient diagnostics can reference the previous stream during the transition. Tests wait for real initial sync and exact source/client convergence.

Restore snapshots, passwords, replica-set key, TLS private keys and complete Cloud exports remain private in ignored `.local/`. The runner restores the fixture-known Postgres replication password explicitly rather than reusing a Cloud secret reference that an intervening deploy may have changed. It checks target identity before restore.

Browser databases, identity/settings storage and decision histories are scoped by source. Open `http://127.0.0.1:5174/?source=mongodb&profile=a` and the corresponding `profile=b` URL. A checked fixture-only request header prevents queued writes from another source reaching the selected database. Existing Postgres local databases retain their original names; they are not erased. Close old synced tabs before switching. The dev server refreshes its allowlisted public defaults when the runtime source changes; private settings are never exposed to the browser.

TLS scope: the local writer validates the fixture CA. Cloud's current MongoDB connection schema has no custom-CA field, so this disposable self-signed source uses `tls=true&tlsAllowInvalidCertificates=true`. Traffic is encrypted, but Cloud does not verify its server certificate. A hosted MongoDB source with a publicly trusted certificate can use verification. Postgres restoration retains its existing `verify-full` setup.

Live checks cover CRUD, offline queue persistence, API outages, established MongoDB session outages, SDK batches in both modes, rollback/reconciliation and explicit client-directed retain/discard. MongoDB validation errors are `DOCUMENT_VALIDATION_FAILURE`; the decision profile handles that code through a checked generated-backend patch. Cold-start adapter/schema discovery while MongoDB is unavailable is a separate untested case; this suite explicitly warms the adapter before its database-outage check.

Results: [MongoDB plan](../../mongodb-plan.md), [MongoDB results](../../results/mongodb.md), and sanitized `.local/mongodb-*-result.json` receipts. Normal cleanup deletes only newly generated test documents and preserves both volumes and auth keys.
