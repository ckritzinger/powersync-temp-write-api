# Browser test client

Authentication comes from the [isolated test provider](../auth/README.md), not the parent backend. The prepared connector fetches fresh provider tokens from the gateway on port 6061; its upload and queue handling is unchanged.

Run commands from `test-system/`, using Node 24 and pnpm 9:

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm run backend:up
pnpm run client:dev
```

Open `http://127.0.0.1:5174/?profile=a` and `http://127.0.0.1:5174/?profile=b`. Each profile uses a separate persistent SQLite database and demo identity. Open each local database, then connect to Cloud after completing [Phase 3](../powersync/README.md). The Cloud URL is left blank when only the local placeholder audience is configured.

Backend URL, Cloud URL and source defaults come from allowlisted public settings in this system's runtime file. Vite does not load environment files automatically. You can edit those URLs before opening the database; credentials and full Cloud exports are never sent to the app. The dev server refreshes its public defaults when runtime settings change. A production build captures those public defaults at build time.

Select Postgres, MongoDB, MySQL or SQL Server before opening a profile, or use `?source=mongodb&profile=a`. Each source keeps separate SQLite databases, identity/settings storage and decision history, including when profile names match. A checked fixture-only source header rejects uploads from a stale source tab and retains its queue. See [MongoDB source switching](../database/mongodb/README.md) and [MySQL source switching](../database/mysql/README.md) and [SQL Server source switching](../database/mssql/README.md).

The connector is prepared from the parent repository's single-file connector into ignored `.generated/connector/`. [The checked patches](connector-patches.json) adapt URLs and profile-specific identity storage, encode the demo user ID, and add a backend-fatal observer for rejection history. Upload, batching, retry and fatal completion decisions are preserved. The observer persists a diagnostic notice before completion; storage failures retain the transaction. Preparation records original, patch and prepared-source fingerprints; unexpected source changes fail closed.

Use Disconnect to pause sync and uploads, then make local writes and reload. Reopen the same profile to see its rows and pending operations, and reconnect to drain the queue. The local dev server must remain available to reload the app shell; this fixture does not install a service worker for loading the app with every network endpoint unavailable.

“Upload once (API only)” invokes the same connector against its real SDK queue while disconnected. Each click attempts one batch using the saved “Transactions per upload” setting (1–50, default 1), subject to the connector's existing operation limit. The fixture overrides the connector's existing batching configuration hook; parent sources and queue decisions are unchanged. Each transaction stays atomic. It is useful for local API tests, but proves no Cloud sync or reconciliation. Do not mix it with an active sync session.

For multi-transaction testing, choose 3 before opening the database. Disconnect, add a valid widget, queue a valid-plus-invalid transaction, then add another valid widget. Four operations in three transactions should be pending. The focused live runner switches this fixture's backend between `stop` and `skip`, verifies the SDK request and real queue, reloads before reconnecting, and checks source/Postgres plus client B. It restores the backend mode and deletes only its fresh source rows. See [live SDK batching evidence](../results/client-batching.md).

The transaction buttons queue either two valid inserts, one invalid insert, or a valid and invalid insert in the same transaction. A NULL `name` is invalid in source Postgres. The SDK may omit that field from INSERT payloads; source defaults still produce the NOT NULL failure. The default backend completes backend-directed fatal transactions. Rejected transactions are recorded per profile with error code, row IDs and timestamp; the history survives reload. Normal Cloud sync checkpoints reconcile optimistic rows, verified live without a subsequent write. Inspect source Postgres and client B to confirm persistence. See [rejected-write verification](../results/rejected-writes.md).

Demo identities are bound to a profile so queued writes cannot silently be sent as a different user after reload. Choose a fresh profile for a new identity or a clean test; normal shutdown does not delete local databases. Two tabs using the same profile intentionally share a database.

Client-directed fatal results appear under “Transactions needing a decision.” “Keep queued” retains the transaction and blocks later writes; “Discard transaction” persists explicit approval and retries the connector when disconnected. During Cloud sync, its next automatic retry applies that choice. The existing connector completes only the failed transaction; later unattempted work stays queued. Notices and choices survive reload, including a discard request interrupted by a network failure. This UI needs the explicit [client-directed backend profile](../backend/README.md); the baseline routes constraint failures to backend handling. Decisions are local fixture diagnostics, not server dead-letter storage. See [live verification](../results/client-decisions.md).

## Checks

```sh
pnpm run client:check
pnpm run client:build
pnpm run client:test
pnpm run client:test:preview
# Requires the isolated backend and Postgres to be running:
pnpm run client:test:api
# Requires running tunnels and a deployed Cloud instance; reuses a running client:
pnpm run client:test:cloud
# Temporarily interrupts this fixture; restores services and backend batch mode:
pnpm run client:test:cloud:recovery
# Focused real SDK batching acceptance; temporarily switches this fixture's backend mode:
pnpm run client:test:cloud:batch
# Builds test-only client-directed routing, verifies retain/discard and restores the original profile:
pnpm run client:test:cloud:decisions
# Interrupts this project's services; use the recovery backend profile for acceptance:
pnpm run client:test:recovery
```

The local browser checks use real SDK SQLite with controlled API responses. They cover reload persistence, profile isolation, atomic queue entries, backend fatal completion, retry retention, fresh credentials after a 401, and retention of not-attempted/client-directed fixture results. The API check uses the actual backend and confirms CRUD and atomic rollback directly in Postgres, cleaning up its fresh IDs afterward. Neither test suite claims live Cloud acceptance.

The recovery suite uses real API/Postgres outages and forwards then discards a committed upload response. The baseline backend loses the database-outage write; the explicit [recovery profile](../backend/README.md) passes retention, reload and recovery. See [recovery results](../results/recovery.md). The suite restores services and removes fresh test rows even on failure. Its baseline failure remains an ordinary failed acceptance test, not an expected-pass annotation.

Playwright requires Chromium. If it is not already installed, keep its download in this directory:

```sh
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm exec playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm run client:test
```

Use the same browser-path setting for the other browser checks. Reports/screenshots go to ignored `.local/browser-results/`; tracing and video are disabled to avoid recording auth traffic. The test runner reuses a running client on port 5174 or starts one when needed.

Vite bundles the SDK workers and WASM assets. Its dev and preview servers bind to loopback and supply cross-origin isolation headers. See [the SDK's Vite example](https://github.com/powersync-ja/powersync-js/blob/main/demos/example-vite/vite.config.ts). Built output lives in ignored `dist/client/`; `pnpm run client:preview` serves it locally with the same headers.
