# What remains to finish the Cloud test system

The local infrastructure, isolated identity provider, browser client and manual runbook are ready. Live Phase 3 passed on 2026-10-06. Two-client CRUD convergence and offline reload/reconnect recovery also passed. The requested live Phase 5 failure and recovery suite also passed. The production recovery fix is implemented and verified. Rejected-write notices, checkpoint reconciliation, real SDK multi-transaction batching, and client-directed retain/discard decisions are now verified. MongoDB acceptance passed on 2026-10-07 using the same Cloud instance, followed by verified Postgres restoration. MySQL local acceptance and all five live browser tests also passed on 2026-10-07 with explicit fixture recovery/classification patches and a source heartbeat for checkpoint reconciliation. SQL Server local acceptance and all five live browser tests passed on 2026-10-07 under amd64 emulation, using native checkpoint CDC and fixture-only adapter patches, followed by verified Postgres restoration. Reviewing and packaging the fixture remains.

You do not need to deploy an application server for this setup. Docker runs the backend and selected source on your computer; an HTTPS tunnel exposes auth/API routes, and a separate TCP tunnel exposes the selected source to Cloud. Keep the computer and both tunnels running during testing.

## Current status

| Phase | What exists | What remains |
| --- | --- | --- |
| 1: Backend and test provider | Separate auth gateway, persistent test keys and provider tokens; backend auth routes return 404; verified | No additional implementation required for the planned fixture |
| 2: Source database | Persistent Postgres, widgets table, limited roles and verified TLS; actual Cloud replication passed | No additional work for this source fixture |
| 3: Tunnels and Cloud | Public JWKS, verified database TLS, Cloud auth and widget checkpoint passed live | Repeat setup/verification when tunnel endpoints change |
| 4: Browser client | Real two-client Cloud CRUD convergence and offline reload/reconnect recovery passed | Repeat as needed with `client:test:cloud` |
| 5: Manual suite | API, live recovery, real SDK batching and client-directed retain/discard acceptance passed | Review and package the fixture and acceptance commands |
| MongoDB source | Authenticated TLS replica set, local API acceptance and five live browser tests passed; Postgres restored and verified | Cold-start discovery during a database outage and multi-node failover remain untested |
| MySQL source | GTID/ROW/FULL binlogs, verified writer TLS, local acceptance and five live tests passed with fixture patches and checkpoint heartbeat | Review/promote adapter fixes and address managed-service checkpoint/transport limits; startup outage and multi-node failover remain untested |

See [MongoDB results](results/mongodb.md) and its [runbook](database/mongodb/README.md). Repeat with `pnpm run mongodb:acceptance`. See [MySQL results](results/mysql.md) and its [runbook](database/mysql/README.md); repeat with `pnpm run mysql:acceptance`. See [SQL Server results](results/mssql.md) and its [runbook](database/mssql/README.md); repeat with `pnpm run mssql:acceptance`.

Existing evidence: [Phase 1](results/phase-1.md), [Phase 2](results/phase-2.md), [Phase 3 local checks](results/phase-3.md). Live acceptance and its sanitized receipt are recorded in Phase 3 results.

## 1. Maintain or repeat the live Phase 3 check

### Account inputs to supply

- A dedicated disposable PowerSync Cloud instance: its actual URL, instance ID, project ID, and organization ID when required.
- PowerSync management access through an existing CLI login or a PAT saved in `.local/powersync-admin-token.txt`.
- An ngrok account supporting simultaneous HTTPS and public TCP endpoints. Save its test authtoken in `.local/ngrok-authtoken.txt`, or explicitly select your own account configuration through the tunnel script.

Keep credentials and complete Cloud exports in ignored `.local/` files. Use this system's own keys and settings, rather than the parent project's environment or Cloud configuration.

### Run the existing workflow

Follow [the Phase 3 Cloud workflow](powersync/README.md) for the complete commands and configuration arguments. Its sequence is:

1. Run setup, configure the dedicated Cloud target, and configure the tunnel account.
2. Run Cloud preflight, start the backend/database, and keep `pnpm run tunnels` running in its own terminal.
3. Capture the endpoints and bootstrap auth and the database certificate for those addresses.
4. Fetch the original Cloud baseline once, prepare configuration, validate it, and review the generated files locally.
5. Deploy to the dedicated instance, fetch its actual export, install that export, and inspect Cloud status.
6. Run `pnpm run cloud:verify`.

The deploy step changes the selected instance's source connection, auth and sync configuration. Use the dedicated test instance throughout.

### What counts as done

The live check must pass against the actual Cloud service. It checks public JWKS, verified Postgres TLS and replication login through the TCP tunnel, invalid-token rejection, and a widget uploaded through the public API arriving in a completed Cloud sync checkpoint.

Check Cloud replication diagnostics as well. Copy a sanitized summary from `.local/phase-three-result.json` into [the Phase 3 results](results/phase-3.md). A reachable API or JWKS URL alone does not complete this phase.

This milestone proves the Cloud auth and replication path without needing a browser app. It does not test browser upload queues or offline persistence.

## 2. Repeat the passed Phase 4 browser checks as needed

The Vite TypeScript app is implemented under `client/`, with pinned PowerSync Web SDK dependencies, bundled worker/WASM assets and development headers. Follow [client instructions](client/README.md) and start it with `pnpm run client:dev`.

It reuses the repository's single-file connector through a prepared copy with checked configuration adaptations and a recorded source fingerprint. Queue decisions are preserved; a checked fixture observer records backend-fatal rejection history before completion.

The app provides:

- A demo user ID and connect/disconnect controls.
- A widgets list with add, rename and delete actions using local PowerSync writes.
- Sync state, pending upload count and upload errors.
- Multi-operation transaction and invalid-write actions for failure tests.
- Per-profile rejected transaction history that survives reload; [normal checkpoint reconciliation verified live](results/rejected-writes.md).
- Saved transactions-per-upload configuration; [real SDK batching, unattempted retention across reload and reconnect recovery verified live](results/client-batching.md).
- Separate local database names or browser profiles for two independent clients.

Verify that client A's insert, update and delete reach source Postgres and client B. Then verify an offline write survives browser reload, uploads after reconnect, and leaves both clients converged with an empty pending queue.

Local and live acceptance are recorded in [Phase 4 results](results/phase-4.md). Run `pnpm run client:test:cloud` with Node 24 and the documented browser-path setting to repeat the actual two-client checks.

## 3. Repeat the passed Phase 5 cases or extend coverage

The requested live cases are recorded in [live recovery evidence](results/live-recovery.md). Run `pnpm run client:test:cloud:recovery` with Node 24 and the documented browser-path setting to repeat them; the suite temporarily interrupts only this fixture and restores services/configuration. Follow [manual-tests.md](manual-tests.md) for setup, exact actions, expected outcomes and recovery instructions. The existing smoke commands and new `manual:api` runner cover the API baseline; [Phase 5 results](results/phase-5.md) distinguish verified local cases from pending live cases.

The [database-outage failure](results/recovery.md) is fixed in an explicit [generated-backend recovery profile](backend/README.md), with real queue/reload/recovery verification. The equivalent production fix is now in parent sources and verified with the baseline profile; record the selected profile in live results.

Cover these groups:

| Group | Required checks |
| --- | --- |
| Authentication | Valid, missing, invalid and expired tokens; wrong issuer/audience signed with the trusted test key; persistent keys across backend restart |
| Writes and validation | PUT/PATCH/DELETE, replay, malformed requests, and batches of 0, 50 and 51 transactions |
| Transaction failures | Atomic rollback; batch `stop` and `skip` behavior; correct `not_attempted` outcomes |
| Connector queues | Successful and backend-directed fatal completion; retryable work retained; real multi-transaction `stop`/`skip` and unattempted retention across reload verified |
| Recovery | Offline reload, API outage, database outage, JWKS fetch failure with a fresh verifier cache, and recovery |
| Visibility and replay | Expected shared widgets and authenticated cross-user writes; source state after a lost-response replay |

For each case, record expected versus actual behavior, source rows, pending queue state and the second client's synced view. Mark cases passed, failed or not tested, with sanitized evidence under `results/`.

Client-directed fatal handling now has an explicit checked test-only profile, decision UI and [live acceptance](results/client-decisions.md). Repeat with `client:test:cloud:decisions`; its runner restores the original backend profile. The default handler does not exercise that path. The existing system does not establish durable dead letters or exactly-once side effects.

## Operating the fixture between sessions

- If tunnel addresses change, recapture endpoints, bootstrap, prepare/validate/deploy, fetch/install the export, and rerun live verification. Preserve the original Cloud baseline.
- Stop the tunnel process with Ctrl+C and run `pnpm run down` for normal shutdown. Database data and signing keys are preserved.
- Pause or remove the dedicated Cloud source when finished so an idle replication slot does not keep retaining WAL. Disconnect it before an explicit database reset and plan to resync afterward.

## When the original task is complete

The test system is complete when a fresh setup can follow this directory's instructions, live Phase 3 passes, two browser clients demonstrate CRUD and offline recovery, and the manual suite has recorded outcomes for the required cases.

Real user login, per-user authorization and permanent application hosting are separate production work. The planned fixture uses signed demo identities and a shared widgets stream; it already has the auth mechanism needed to test PowerSync Cloud.

## Additional source coverage

MongoDB, MySQL and SQL Server local/live acceptance passed on the same dedicated Cloud instance, with Postgres restored; see SQL Server [results](results/mssql.md) and [runbook](database/mssql/README.md). MySQL and SQL Server recovery/TLS adaptations remain checked fixture-only patches; promotion into parent production sources is separate work. SQL Server runs under unsupported amd64 emulation here; repeat on a supported x86-64 host before drawing supported-platform conclusions.
