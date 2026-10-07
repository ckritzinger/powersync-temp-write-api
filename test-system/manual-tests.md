# Manual Cloud deployment tests

Run commands from `test-system/`. Record expected and actual results separately; a local API pass does not imply Cloud sync passed. The browser client and API cases are implemented. Live cases below require completion of [Phase 3](powersync/README.md).

Latest acceptance: the requested live API/Postgres/JWKS recovery, fatal writes, rollback, batch stop/skip, shared-stream visibility and committed-response replay passed with the recovery profile. See [recorded results](results/live-recovery.md). Repeat with `pnpm run client:test:cloud:recovery` using Node 24 and `PLAYWRIGHT_BROWSERS_PATH=.local/playwright`. It restores services and the configured batch mode and removes its fresh rows.

## Prepare a session

1. Select Node 24 and pnpm 9, start Docker, run `pnpm install --frozen-lockfile` and `pnpm run setup`.
2. Follow the Cloud workflow to start the backend and both tunnels, deploy the dedicated instance, install its actual export, and pass `pnpm run cloud:verify`.
3. Run `pnpm run client:dev`. Open client A at `http://127.0.0.1:5174/?profile=a` and client B at `http://127.0.0.1:5174/?profile=b`. Use fresh profile names for a clean run.
4. Open both databases and connect both clients. Wait for initial sync to complete. Record their demo user IDs and starting queue counts.

Keep the local app server reachable for reload tests. Use Disconnect or selectively block backend/Cloud requests when simulating remote outages; browser-wide Offline mode also prevents loading the local app shell.

To inspect source state, substitute the fresh UUIDs displayed by the app into this query:

```sh
docker compose --env-file .local/runtime.env exec -T postgres \
  psql -X -U test_admin -d test_system \
  -c "SELECT id, name FROM public.widgets WHERE id IN ('FIRST-UUID', 'SECOND-UUID');"
```

Use source rows and client B's view to verify outcomes. Pending counts represent operations, while uploads contain whole transactions. Avoid inspecting/exporting browser Authorization headers or pasting private configuration into results.

## API baseline

```sh
pnpm run smoke
pnpm run smoke:restart
pnpm run smoke:widgets
pnpm run manual:api
pnpm run manual:api batch --both-batch-modes
pnpm run client:test
pnpm run client:test:preview
pnpm run client:test:api
pnpm run client:test:recovery
pnpm run auth:test:outage
```

Stop the manually running client before browser checks, which start their own server on port 5174. The API runner creates fresh UUIDs and deletes its rows. `batch --both-batch-modes` temporarily recreates only the backend with a private Compose override, checks `stop` and `skip`, and restores the configured mode in `finally`. Run it between interactive tests, as it interrupts API requests.

The original unfixed baseline failed database-outage retention. Current parent sources include the production fix, and current baseline passes; see [production verification](results/production-recovery.md) and [profile instructions](backend/README.md). Run `pnpm run backend:recovery` and `pnpm run backend:up` before checking the fix, and record which profile was tested. `auth:test:outage` uses an isolated HTTPS fixture and stops the test containers afterward; run `pnpm run backend:up` before returning to browser tests. See [recorded recovery evidence](results/recovery.md).

| Case | Command / action | Expected result |
| --- | --- | --- |
| API-01 | `pnpm run manual:api auth` | Valid token succeeds; missing, invalid, expired, wrong issuer and wrong audience return 401. Claim fixtures are signed with this system's trusted key. |
| API-02 | `pnpm run manual:api validation` | Malformed body/operation, 0 transactions and 51 transactions return 400; 50 empty transactions succeed. |
| API-03 | `pnpm run smoke:widgets` | PUT, PATCH and DELETE each match source Postgres. |
| API-04 | `pnpm run manual:api rollback` | Valid insert followed by NOT NULL failure rolls back both rows; backend-directed fatal result identifies operation 1. |
| API-05 | `pnpm run manual:api batch --both-batch-modes` | `stop`: success, fatal, not_attempted. `skip`: success, fatal, success. Source rows match those outcomes. |
| API-06 | `pnpm run manual:api replay` | Repeating the same PUT leaves one row with the expected name. This does not establish exactly-once side effects. |
| API-07 | `pnpm run manual:api crossUser` | User B can update user A's widget under the current permissive authorizer. |
| API-08 | `pnpm run smoke:restart` | A token issued before backend restart remains valid afterward. |

The API runner writes sanitized `.local/manual-api-result.json`, overwriting the previous receipt. Promote summaries to `results/` before another run if needed. API issuer checks are stricter than PowerSync's key/audience validation; do not infer Cloud issuer enforcement from API-01.

## Live client cases

| Case | Actions | Expected result and evidence |
| --- | --- | --- |
| CLOUD-01 | Run `pnpm run cloud:verify`; inspect Dashboard replication diagnostics. | Public key fetch, verified TCP replication and authenticated Cloud sync pass; the uploaded widget arrives with a completed checkpoint. |
| CLIENT-01 | In A, add a uniquely named widget. Record its UUID, inspect source, then inspect B. Rename in A, then delete. | Each change persists in source and arrives in B. A's queue returns to zero. |
| CLIENT-02 | Disconnect A, add a widget, record pending count, reload and reopen the same profile. Reconnect. | Row and queue survive reload; source and B receive the write after recovery; queue drains. |
| CLIENT-03 | In A, click “Add two widgets atomically.” Record both UUIDs and inspect source/B. | Both rows commit in one queued transaction and both sync. |
| CLIENT-04 | Click “Queue valid + invalid transaction.” Inspect both source UUIDs, queue and rejection history. | Neither row commits; the fatal queue entry completes. One rejection notice lists both IDs. After Cloud catches up, both optimistic rows disappear without another write. |
| CLIENT-05 | Click “Queue invalid widget (NULL name).” Inspect its source UUID, queue and rejection history; reload and reopen. | No source row; fatal entry completes. The rejection notice survives reload and Cloud reconciliation removes the optimistic row. Local history is not durable server dead-letter storage. |
| CLIENT-06 | Use different demo users in A and B; have B rename A's widget. | Both see shared widgets, and B's authenticated write is allowed. Per-user isolation is not configured. |
| CLIENT-07 | In a browser with test request interception, discard one successful `/api/data` response after source commit, then let the connector retry. Record the UUID and source state. | Retry retains work until a response is accepted; replay leaves the expected widget state. Record duplicate effects if any. Merely repeating PUT is API-06, not a real lost-response test. |

For CLIENT-07, `pnpm run client:test:recovery` now provides controlled browser interception that forwards the actual API request and loses only its successful response. It passed for local API-only uploads. Repeat under the live Cloud workflow to establish client B convergence; a connection failure before sending the request does not exercise committed-response loss.

## Outage and queue cases

Perform these on the dedicated fixture, one at a time. Restore each service before proceeding.

| Case | Actions | Expected result and recovery |
| --- | --- | --- |
| RECOVERY-01 | Stop only the API with `docker compose --env-file .local/runtime.env stop backend`. Add a widget in A while connected. | Transport failure retains the queue. Start with `pnpm run backend:up`; the write eventually reaches source/B and the queue drains. |
| RECOVERY-02 | Stop only Postgres with `docker compose --env-file .local/runtime.env stop postgres`. Attempt a fresh write in A and inspect its result/queue. | Baseline: backend-directed `UNCLASSIFIED_ERROR`, drained queue, missing source row after recovery (failed). Recovery profile: retryable result, queue survives reload and write persists after recovery (passed locally). Restore with `pnpm run db:up` and `pnpm run backend:up`, then inspect the fresh UUID in source. |
| RECOVERY-03 | With remote-JWKS auth installed, stop the tunnel agent and restart only the backend to clear its verifier cache. Use local API auth/upload, keeping the source database running. | A fresh key fetch fails and the API returns 401; uploads remain queued. Restart tunnels, recapture and update changed endpoints through the Cloud workflow, then verify recovery. Cached keys or inline fallback invalidate this test. |
| RECOVERY-04 | Run `pnpm run client:test`. | Controlled retryable and 401 responses retain real SDK queue entries; a later success drains them, and 401 causes fresh credentials. This is a local fixture check. |
| RECOVERY-05 | For an interactive retry retention case, block A's write API requests while leaving Cloud reachable. Add a widget, reload/reopen A, unblock writes and reconnect. | Queue remains while requests fail, survives reload and drains after recovery. Source and B converge. |

The isolated JWKS endpoint variant of RECOVERY-03 passed with `pnpm run auth:test:outage`: a fresh verifier returned 401 during outage and accepted the same token after recovery. This establishes backend behavior without public tunnels; it does not test Cloud key fetching or Cloud-side caches.

Run `PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm run client:test:cloud:batch` with Node 24 for real SDK multi-transaction acceptance. This switches only the fixture backend between `stop` and `skip` and restores its normal mode afterward. It queues a valid insert, an atomic valid-plus-invalid pair and a final valid insert with batch size 3. Under `stop`, the first two transactions complete, only the unattempted final insert survives reload, and reconnect uploads that transaction alone. Under `skip`, both valid inserts commit and the queue is empty after reload. Source/Postgres and client B are checked before and after recovery; rejected local rows reconcile after sync. See [recorded SDK batching results](results/client-batching.md).

The interactive client defaults to one transaction per upload. Set “Transactions per upload” to 3 before opening a profile to exercise batching manually.

Run `PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm run client:test:cloud:decisions` for client-directed retain/discard acceptance. The runner builds the explicit test-only `client-directed` profile, verifies that Keep queued preserves the failed transaction and blocks later work across reload, then explicitly discards it and checks recovery through Cloud. It restores the original backend profile afterward. See [recorded decisions](results/client-decisions.md). For interactive checks, select `backend:client-directed` and rebuild with `backend:up`; use a fresh client profile with batch size 3 and queue a valid insert, a valid-plus-invalid pair, and a later insert while disconnected. Upload once, Keep queued, reload/reopen, then Discard transaction and reconnect. Restore the baseline profile and rebuild when finished.

## Record and close the session

Create a sanitized file under `results/` with a row per case:

| Case | Expected | Actual source / queue / client B | Status | Evidence |
| --- | --- | --- | --- | --- |
| CLIENT-01 | CRUD persists and syncs | Fill in observed outcomes and UUIDs | passed / failed / not tested | Sanitized receipt or screenshot reference |

Record configuration mode, source/connector fingerprints and whether checks used the actual Cloud service or local fixtures. Do not include tokens, private keys, database passwords or full Cloud exports. Unexecuted cases remain not tested even when their instructions are complete.

Delete successful test rows through the app and confirm deletion in B. For rejected optimistic rows, record their behavior after sync; use a fresh profile for the next clean run. Stop the dev server and tunnel agent, run `pnpm run down`, and pause/remove the dedicated Cloud source. Normal shutdown preserves database data and signing keys.
