# Phase 5 runbook and local API verification

The Postgres recovery fix was subsequently promoted to production and passed live baseline acceptance. See [production recovery verification](production-recovery.md); the older baseline failure discussed below is historical.

[The manual suite](../manual-tests.md) and API runner are implemented. The requested live failure/recovery cases passed on 2026-10-06 with the recovery backend profile. See [live recovery evidence](live-recovery.md).

Local checks passed against the actual isolated backend and source Postgres:

| Case | Observed result |
| --- | --- |
| Authentication | Trusted valid token accepted; missing, invalid, expired, wrong issuer and wrong audience rejected with 401 |
| Validation | Malformed body/operation, 0 transactions and 51 transactions rejected with 400; 50 empty transactions succeeded |
| Atomic rollback | Valid insert followed by NOT NULL failure left neither source row; backend-directed fatal result identified operation 1 |
| Batch `stop` | Results were success, fatal_error, not_attempted; only the first source row existed |
| Batch `skip` | Results were success, fatal_error, success; first and third source rows existed |
| Replay | Repeated PUT left one row with the expected name |
| Cross-user write | User B updated a row created by user A, matching the permissive demo authorizer |

The runner uses only this system's persisted key and runtime settings for signed fixtures. Test UUIDs are fresh and source rows are cleaned up. Both-mode verification restores the backend's original configured mode and preserves data and keys. A stale HTTP keep-alive connection after container recreation initially interrupted the check; fresh connections resolved that harness issue and both modes passed.

Browser queue and actual API CRUD checks are recorded in [Phase 4](phase-4.md). The new runbook reuses existing health, restart and widgets smoke checks rather than introducing another upload implementation.

Additional [local recovery checks](recovery.md) verified API-outage retention across reload, actual committed-response-loss replay, and fresh-verifier JWKS outage/recovery. Database outage failed against the baseline backend. The explicit [recovery profile](../backend/README.md) fixes the generated copy: retryable result, queue retained across reload and source row present after recovery. All three recovery cases and actual browser CRUD/fatal rollback passed with that profile. Parent sources were not changed; the baseline regression remains reproducible.

Live Cloud acceptance now covers two-client convergence, offline reconnection, API and database outage recovery through automatic uploads, shared-stream/cross-user visibility, public-JWKS failure with a fresh backend verifier, fatal writes/rollback, batch stop/skip replication, and committed-response replay. Cloud key-cache eviction and a full tunnel-agent restart with changed endpoints were not tested.

Multi-transaction connector batching and client-directed decision UI require separate documented extensions for full interactive coverage. Controlled-response queue tests do not prove the default backend routes errors to client handling. Durable dead letters and exactly-once side effects are not provided by this fixture.
