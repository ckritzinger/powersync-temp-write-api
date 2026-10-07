# Carry-over: SQL Server source acceptance

Updated 2026-10-07, around 11:22 SAST / 09:22 UTC. User requested this handoff because conversation tokens were running low.

## Objective and constraints

Implement SQL Server as the next source database in the isolated test system, using the same dedicated PowerSync Cloud instance and existing ngrok TCP/HTTPS tunnels. Run actual local API checks and five live SDK/browser cases, then restore and verify Postgres. MongoDB and MySQL acceptance were already completed before this task.

Read `test-system/AGENTS.md` before continuing. All modifications belong inside `test-system/`. Parent backend/connector files are read-only inputs. Never read/copy parent environment files, secrets or configuration exports. Own ignored `.local/` contains fixture credentials, signing keys, certificates, Cloud exports and receipts; do not print its raw exports/passwords. Preserve keys and all source volumes. No subagents unless explicitly authorized. No commits or branch merges were requested for this task.

Workspace: `/Users/christiaanlandman/code/powersync-temp-write-api`.
Commands below run from its `test-system/` directory. Use Node 24 explicitly:

```sh
/Users/christiaanlandman/.nvm/versions/node/v24.14.0/bin/node
```

Docker/network operations need sandbox escalation when restricted. The prefix for `node scripts/mssql.mjs acceptance` above is already approved.

## IMPORTANT: a full acceptance command is still running

Unified exec session **36387** is running:

```sh
/Users/christiaanlandman/.nvm/versions/node/v24.14.0/bin/node scripts/mssql.mjs acceptance
```

At the final handoff check:

- Runtime source was **mssql**.
- `.local/mssql-acceptance-result.json` was **running**, `restoredSource: null`.
- SQL Server startup/CDC gate passed at `2026-10-07T09:20:27.459Z`.
- Local API checks passed at `2026-10-07T09:21:02.826Z`.
- Cloud `deploy-service` had just completed. Validation, sync deployment, five browser tests and final Postgres restoration remained in that running process.
- No `.local/mssql-mssql-outage-result.json` existed yet.

**Do not start another acceptance/source switch while that process is running.** First poll session 36387 with `write_stdin`; if that session is unavailable in a new conversation, inspect the acceptance receipt and process list without printing process environments/secrets. Let the command finish: its `finally` restores Postgres and verifies a fresh Cloud checkpoint. Interrupting it can leave Cloud and local runtime on SQL Server.

A passed acceptance receipt is written only after all tests and verified restoration. A failed receipt stays failed even when restoration succeeds. If the process has died without restoring, run:

```sh
/Users/christiaanlandman/.nvm/versions/node/v24.14.0/bin/node scripts/mssql.mjs restore
```

This changes only the dedicated fixture target. Verify its receipt and selected source afterward.

## Dedicated Cloud and tunnels

- Org: `699d85b6634f0f000822d4dc`
- Project: `6ac4cdbe6860dd0007dbb1a1`
- Instance: `6ac4cdc03b1803753bcf622d`
- URL: `https://6ac4cdc03b1803753bcf622d.powersync.journeyapps.com`
- PowerSync CLI v0.9.3; existing CLI login/PAT is configured.
- Existing ngrok HTTPS gateway points to loopback6061; source TCP tunnel points to loopback5433.
- Browser/Vite at `http://127.0.0.1:5174`, with existing running server reused.
- Own Cloud target/endpoint exports stay in `.local/`. Never print full service configs or auth exports.

## Implemented

New files:

- `mssql-plan.md`: task checklist; first four items complete, final live acceptance/restoration pending.
- `compose.mssql.yaml`: pinned SQL Server 2022 CU20 Ubuntu image, explicit `linux/amd64`, persistent `powersync-test-system-mssql-data`, isolated network IP .8, Developer edition, Agent enabled, 3GB container/2GB server memory. Startup probe uses loopback5434; normal selected source uses existing tunnel port5433. Backend mounts public CA and sets `NODE_EXTRA_CA_CERTS`.
- `database/mssql/start.sh`: copies TLS files with correct ownership/permissions, forces encryption, enables Agent, drops to mssql user.
- `database/mssql/init.sh` and `init.sql`: idempotent source/database/users/CDC initialization. `dbo.widgets`: string UUID primary key, required name. Native `dbo._powersync_checkpoints` identity/timestamp table with CDC. Separate writer and replication logins. Writer only has widget CRUD. Replication has widget/checkpoint/CDC reads, checkpoint insert/update, CDC-reader membership, metadata visibility and SQL Server 2022 performance-state permissions; no sysadmin/db_owner.
- `scripts/mssql-setup.mjs`: independent complex root/writer/replication passwords, preserved own keys, server certificate signed by existing fixture CA.
- `scripts/mssql-source.mjs`: actual source row/count/delete queries through root sqlcmd; validated UUID cleanup. Passwords via environment, never arguments. sqlcmd uses `-y 0` WITHOUT `-h` (they are incompatible).
- `scripts/mssql.mjs`: setup/probe/up/cloud/restore/acceptance. Probe checks Agent and actual CDC capture before stopping Postgres. Acceptance saves actual target-checked Postgres config, runs checks, switches Cloud, and restores in finally. Root credentials/config exports stay private.
- `scripts/verify-mssql.mjs`: actual API CRUD/replay, sparse required-field rejection, source mismatch rejection, stop/skip rollback, verified encrypted writer connection, both CDC tables.
- `scripts/mssql-recovery.test.mjs`: initial transient connection failures versus permanent auth errors; default certificate verification and explicit TLS forwarding.
- `backend/patches/mssql-recovery.json`: checked generated-backend-only patches for URI TLS settings and classifying initial `pool.connect()` failures. Parent unchanged. All profiles record `mssqlRecoveryFix: test-patch`.
- `powersync/sync-config.mssql.yaml`: edition3 stream query **`SELECT id, name FROM dbo.widgets`**.
- `client/tests/mssql.spec.ts`: five real Cloud SDK tests copied/adapted from MySQL, without heartbeat: CRUD/offline reload; backend outage; SQL Server established-session outage; SDK stop/skip atomicity/reconciliation; retain/discard decisions.
- `database/mssql/README.md` and `results/mssql.md`.

Modified source plumbing: `source-config.mjs`, `phase-three.mjs`, `cloud.mjs` bootstrap, `prepare-backend.mjs`, client source UI/main/Vite defaults, Cloud Playwright project, local source-isolation case, package commands, source/Cloud preparation regressions. README/client/backend/PowerSync/remaining-work docs updated. Source storage/decision namespaces and stale-tab source header guard apply to SQL Server.

## Verification already completed

- SQL Server **16.0.4205.1** actually started under amd64 emulation on this ARM64 Mac. Agent ran; an inserted widget appeared in CDC before the first Cloud switch. Repeated startup gates passed.
- Local API checks passed repeatedly, including writer CA verification and encrypted connection.
- Generated backend TypeScript build passed.
- Client TypeScript checks passed, including after the last outage-timeout change.
- Twelve source/Cloud configuration and SQL Server adapter regression tests passed together. Existing prepare-backend patch regression also passed earlier.
- Eight local browser tests passed, including Postgres/SQL Server independent queues with the same profile.
- First Cloud attempt failed because a copied sync query used the wrong schema. Fixed query to `dbo.widgets`, added a Cloud preparation regression. That attempt restored and verified Postgres.
- Next complete live run: **4/5 passed** in 2.0 minutes. CRUD/offline, backend outage, SDK stop/skip, and retain/discard all passed. Native checkpoint CDC reconciled rejected optimistic rows without a heartbeat or local SQLite surgery.
- SQL Server outage in that run returned retryable failure, retained pending work/reload, drained queue after recovery and committed the source row. **Client B did not receive it within the original 30-second assertion**. It failed at `converged()` client-B row check, not queue/API/source checks.
- That failed run restored Postgres and verified live Cloud at approximately09:20UTC. Its failed receipt is archived at `.local/mssql-attempt-history/outage-30s-failed.json` with `restoredSource: postgres` and `restoreVerifiedAt: 2026-10-07T09:20:00.762Z`.

## Last fix and current rerun

Read official PowerSync MSSQL replication code:

- `https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mssql/src/replication/MSSQLErrorRateLimiter.ts`
- `https://github.com/powersync-ja/powersync-service/blob/main/modules/module-mssql/src/replication/CDCReplicationJob.ts`

Published limiter waits30seconds after ordinary errors and120seconds for ECONNREFUSED/ENOTFOUND. This supports a longer Cloud recovery budget; it does not conclusively identify which error branch the deployed Cloud used in the failed attempt.

Changed ONLY SQL Server outage recovery timing:

- API pending/source assertions remain30seconds.
- Client-B replication convergence after SQL Server restart allows **150seconds**.
- That test has a240second total timeout; other tests retain existing limits.
- Client B must converge through SDK recovery, with NO manual reconnect.
- Successful outage receipt records `recoveryElapsedMs` and `replicationTimeoutMs`.
- A failed convergence saves private Cloud status before cleanup/restore.
- TypeScript passed after this change.

Current session36387 reruns **all five tests**, not just the failed case. No test is skipped and no assertion replaced with local row hiding. Await actual final outcome before marking complete.

## Remaining work

1. Resume/inspect session36387 and let acceptance finish. Keep user updated during ongoing work.
2. If SQL Server outage still fails, inspect its exact assertion and `.local/mssql-mssql-outage-cloud-status.json` privately; redact passwords/tokens before reporting anything. Inspect Agent/CDC source state and SDK connection state. Fix actual issue and rerun all five cases; preserve failed evidence and restoration. Do not simply keep increasing timeouts.
3. Require combined acceptance exit0, receipt `status: passed`, `restoredSource: postgres`, and fresh `.local/phase-three-result.json` live verification. Read actual outage elapsed time.
4. With Postgres restored, run its API browser regression if desired/appropriate (already used after other source changes):

```sh
PLAYWRIGHT_BROWSERS_PATH=.local/playwright /Users/christiaanlandman/.nvm/versions/node/v24.14.0/bin/node node_modules/@playwright/test/cli.js test --config client/playwright.config.ts --project=api
```

5. Update `results/mssql.md` with actual final suite timing, measured outage recovery, exact Postgres verification timestamp and coverage limits. Finish last two checkboxes in `mssql-plan.md` ONLY if actual full acceptance/restoration passed. Update `remaining-work.md` from underway to completed.
6. Review parent git status to confirm existing unrelated changes are unchanged. Entire test-system is ignored/untracked in parent, so parent status does not show these additions. Do not commit/merge without instruction.
7. Final response: concise result, runbook/results link, restored Postgres state, and material limits below.

## Material limits and follow-up

- Microsoft supports SQL Server containers on Intel/AMD x86-64 Linux; ARM64 emulation here is unsupported. Successful fixture tests are development evidence, not supported-platform certification. Repeat on supported x86-64 hosting before production conclusions: `https://learn.microsoft.com/sql/linux/install-upgrade/setup`.
- Local writer verifies fixture CA. Current Cloud SQL Server schema has no custom CA field: disposable Cloud connection uses encryption plus `additionalConfig.trustServerCertificate: true`. Do not claim Cloud certificate identity verification.
- SQL Server initial pool classification/TLS forwarding and earlier MySQL recovery fixes are **fixture-only patches**; promotion to parent production sources is separate, uncompleted work.
- Live outage case is established-session recovery. Initial transient failure classification has adapter regression coverage, not a separate unavailable-at-startup live browser test. Deadlocks, schema evolution, production auth/authorization and other source engines remain separate scope.
- Earlier linked PR1 (`ckritzinger/powersync-temp-write-api`, head a314a009f21b65c3693849a37461201cf3546fce, branch carl/ai-fight) was inspected during MySQL work and not merged. It contained Postgres SSL/MSSQL identifier/TLS forwarding and other improvements, no MySQL binlog service fix. No branch merge pending as part of SQL Server task.

## Existing unrelated parent state to preserve

Branch `overhaul`. Modified before this task: `backend/adapters.test.ts`, `backend/src/persistence/postgres/postgres-errors.ts`, `backend/src/persistence/postgres/postgres-persistence.ts`, `docs/error-handling.md`. Untracked before this task: `backend/postgres-errors.test.ts`, `backend/powersync/`, `branch-integration-plan.md`, `fatal-error-handling-plan.md`, `pr-description.md`, `pr-review.md`. Do not revert or absorb these unrelated changes.
