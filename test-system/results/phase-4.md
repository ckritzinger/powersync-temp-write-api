# Phase 4 implementation and local verification

The browser client is implemented under `test-system/client/`. Live two-client Cloud acceptance passed at 2026-10-06T13:44:18.661Z. Two independent Chromium contexts used real SDK queues, different demo identities, the isolated auth provider, actual source Postgres, and the dedicated PowerSync Cloud service.

Live results:

- Both clients connected and completed initial sync.
- Client A inserted, renamed and deleted a widget. Each action was confirmed directly in source Postgres and in client B.
- Client A disconnected with auth/write/Cloud routes blocked, queued a write, and reloaded. The row and pending queue survived, while source Postgres and client B had no such row.
- After restoring routes and reconnecting, automatic upload drained the queue and both clients converged. Both pending queues were empty.
- Temporary rows were deleted and cleanup was confirmed in Postgres and client B.

Run again with `PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm run client:test:cloud` using Node 24. The check reuses the running client on port 5174 or starts it when needed. It uses fresh profiles/UUIDs, closes its browser contexts, and cleans up source rows. Receipt: `.local/phase-four-cloud-result.json`; traces and video remain disabled.

Implemented:

- Vite TypeScript app with pinned `@powersync/web` 2.4.2, bundled worker/WASM assets and cross-origin isolation headers on loopback port 5174.
- Widgets schema, persistent independent client profiles, demo identities, connect/disconnect controls, CRUD, transaction/failure actions, sync status, pending operation count and upload errors.
- Prepared copy of the repository's single-file connector with exact-match configuration patches and a source fingerprint. Upload/retry/completion logic is preserved.
- API-only one-transaction upload control for local diagnostics, clearly distinguished from Cloud sync.
- Browser checks using real SDK SQLite and controlled API responses, plus a separate actual backend/Postgres integration check. Reports stay under ignored `.local/`; traces/video are disabled.

Verification passed:

- TypeScript check and production build, including emitted worker and WASM assets.
- Browser checks in development and production preview: local CRUD, service-offline reload persistence, independent profiles, atomic queued transactions, backend fatal completion, retryable retention and credential refresh after 401.
- Additional production-preview fixture checks confirmed that `not_attempted` and client-directed fatal responses retain real queued work. They do not claim those paths were produced by the default backend.
- Actual browser uploads through the reused connector: source-confirmed PUT/PATCH/DELETE, two valid inserts committed together, and valid-plus-invalid transaction fully rolled back with the backend fatal queue entry completed. Fresh source rows were removed afterward.
- Desktop and mobile screenshots inspected; no layout clipping observed.
- Existing five infrastructure tests still pass.

The SDK omits a NULL field from INSERT payloads; the invalid action still fails the source NOT NULL constraint. Local optimistic rows after a rejected write are not evidence of source persistence.

Pending:

- Live outage/reconciliation cases from [the manual suite](../manual-tests.md).

The app shell requires its local dev/preview server for reload. These checks simulate unavailable auth/write/sync services, not a browser with every network request disabled. No real user login or production authorization model was added.
