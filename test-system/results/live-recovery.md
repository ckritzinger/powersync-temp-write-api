# Live failure and recovery acceptance — 2026-10-06

Subsequent update: the recovery fix was promoted into production sources and database-outage recovery passed again with the baseline profile. See [production recovery verification](production-recovery.md). The profile/fingerprints and limitations below describe the earlier test-only run.

The requested cases passed against the dedicated PowerSync Cloud instance, ngrok public HTTPS/TCP tunnels, isolated test identity provider, actual write API/Postgres, and two independent Chromium clients using real SDK queues. Tests ran sequentially and restored services after each case. Backend profile: `recovery`; source fingerprint `740b10c08363`; prepared fingerprint `d109fd22356b`. Parent source files were not changed.

| Case | Expected | Observed | Result |
| --- | --- | --- | --- |
| API outage | Failed writes remain queued across reload; automatic upload resumes after restart | One operation retained before and after reload; zero after recovery; exact row in Postgres and client B | Passed |
| Postgres outage | Connection acquisition returns retryable; queue survives reload; replication resumes | Retryable result; one retained operation across reload; zero after recovery; exact row in Postgres and B | Passed with recovery profile |
| Public JWKS outage | Fresh backend verifier rejects trusted token without key access; queue and auth recover | Auth service stopped, backend cache cleared; same token returned 401 during outage and 200 after recovery; queue survived reload, drained and converged in B | Passed |
| Atomic valid pair | Two inserts commit and sync together | Both exact names in source and B; zero pending queue | Passed |
| Valid + invalid transaction | NOT NULL error rolls back entire transaction and completes backend-directed fatal queue entry | `fatal_error`, backend handling, NOT NULL classification; neither source row existed and neither appeared in B; queue empty | Passed |
| Single invalid write | No source row, fatal entry completes | No row in source/B; queue empty | Passed |
| Cross-user write | B may update A's row under the fixture's permissive authorization | B's rename appeared in source and A; B's queue drained | Passed |
| Lost successful response | Retain queue after actual commit, then retry and converge | Actual successful response discarded; source and B had one row while A retained one operation; second upload drained queue and left exactly one widget row | Passed |
| Batch stop | First commits, failed transaction rolls back, third is unattempted | `success`, `fatal_error`, `not_attempted`; only first row in source and B; rollback left zero rows | Passed |
| Batch skip | First and third commit; failed transaction rolls back | `success`, `fatal_error`, `success`; first/third rows in source and B; rollback left zero rows | Passed |
| API baseline | Correct auth/validation, rollback, batch behavior and replay | Valid accepted; missing/invalid/expired/wrong-issuer/wrong-audience rejected; malformed/0/51 transactions rejected, 50 accepted; both batch modes and replay passed | Passed |

Rejected optimistic state is distinct from source truth: the original run observed optimistic rows immediately after fatal completion. Subsequent [rejection and reconciliation verification](rejected-writes.md) confirmed that normal sync checkpoints remove them without another write. The fixture now records rejection notices that survive reload. This is local diagnostic history, not durable server dead-letter storage.

Coverage limits:

- Database recovery uses the test-only patch. The baseline production backend's acquisition-error regression is still separate work.
- JWKS testing verified the backend's fresh remote key fetch through the actual public JWKS URI. Cloud key-cache eviction was not forced. The TCP tunnel stayed running while the auth service was unavailable.
- The original batch tests sent direct API requests. Subsequent [real SDK batching acceptance](client-batching.md) verified `stop`, `skip`, retained `not_attempted` queue entries across reload, and reconnect recovery. The interactive default remains one transaction per upload; configurable batching is available. [Client-directed decisions](client-decisions.md) subsequently passed with an explicit test-only routing profile.
- Replay establishes widget upsert state, not exactly-once arbitrary side effects or durable dead letters.

Private sanitized receipts: `.local/live-recovery-results/backend-outage.json`, `postgres-outage.json`, `public-jwks-outage.json`, `fatal-rollback-replay.json`, `batch-stop-skip.json`; API receipt: `.local/manual-api-result.json`. Tracing/video are disabled and no tokens or complete Cloud exports are included in this report.

The first outage run exposed harness issues: waiting for a POST response when an unavailable API failed the browser preflight, and not tolerating a connection reset during restart health polling. Queue retention was visible during that first API failure. The checks were corrected, cleanup made tolerant of already-closed browser contexts, and the three outage tests plus live batching passed on rerun. The fatal/rollback/replay scenario passed in the original run.

Repeat from `test-system/`, with Node 24:

```sh
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm run client:test:cloud:recovery
pnpm run manual:api all --both-batch-modes
pnpm run cloud:verify
```

The live browser suite reuses the client on port 5174 or starts one if needed. It restores the configured batch mode and services, closes its own browser contexts and deletes only fresh test rows. Signing keys, database volume and unrelated rows are preserved.

Final checks passed: auth, backend and Postgres were healthy; batch mode was restored to `stop`; the temporary outage/replay/batch names matched zero source rows; end-to-end `cloud:verify` passed again and deleted its probe row. The existing client and ngrok sessions remain running.
