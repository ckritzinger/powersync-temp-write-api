# MongoDB source testing plan

Use the existing PowerSync Cloud instance sequentially for Postgres and MongoDB. Preserve Postgres data, auth keys, tunnel identity and private restore configuration. Keep changes inside `test-system/`; parent adapters remain read-only.

## Implementation

- [x] Add an authenticated, TLS-enabled single-node MongoDB replica set with a persistent fixture volume.
- [x] Initialize a `widgets` collection with string `_id`, required non-null string `name`, strict schema validation and change-stream post-images. Create separate writer and PowerSync replication users.
- [x] Add source selection for backend Compose, local runtime and Cloud generation. Keep the existing TCP tunnel port; only one source binds it at a time.
- [x] Save the currently deployed Postgres service and sync configuration privately before the first switch. Validate and deploy MongoDB through the CLI to the same instance; support restoring Postgres.
- [x] Namespace browser databases/settings by source so queued Postgres writes cannot upload into MongoDB.
- [x] Verify local API CRUD, schema validation, atomic rollback, batch stop/skip and replay against actual MongoDB.
- [x] Run two-client Cloud CRUD and offline reload/recovery with fresh MongoDB profiles, then real SDK batching and client-directed decision coverage using MongoDB validation classifications.
- [x] Restore Postgres, verify its Cloud replication, record sanitized evidence and update the runbook.

## Acceptance

Local API reachability is not Cloud replication evidence. Live acceptance requires exact MongoDB source documents, a second synced client, empty queues after recovery, rollback leaving no documents, and source-isolated client storage. Record any blocked or untested cases explicitly. Normal source switches must not rotate keys, delete volumes or discard pending writes.

The MongoDB adapter requires a replica set for transactions and discovers validators at startup. IDs remain string UUIDs. MongoDB validation failures use `DOCUMENT_VALIDATION_FAILURE`, rather than Postgres `NOT_NULL_VIOLATION`.

Established API/database outage recovery also passed. Cold-start discovery with MongoDB unavailable remains untested. The self-signed Cloud MongoDB connection is TLS-encrypted with server-certificate verification disabled because the current Cloud schema has no custom-CA field; local writer connections verify the fixture CA. See [runbook](database/mongodb/README.md) for the exact scope.

Completed evidence: [MongoDB results](results/mongodb.md).

References: [PowerSync source setup](https://docs.powersync.com/configuration/source-db/setup), [source connections](https://docs.powersync.com/configuration/source-db/connection), [CLI](https://docs.powersync.com/tools/cli).
