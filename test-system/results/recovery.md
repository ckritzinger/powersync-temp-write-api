# Recovery test results

Historical reproduction below predates the promoted production fix. Current baseline acceptance is recorded in [production recovery verification](production-recovery.md).

These checks used the actual isolated backend, SDK SQLite queue and source Postgres. They did not connect to PowerSync Cloud. The baseline exposes the write-loss bug; the explicit recovery profile fixes the generated test copy and passes the same acceptance test.

| Case | Expected | Observed | Status |
| --- | --- | --- | --- |
| API outage | Retain a queued write across reload, then upload after API restart | Pending count stayed 1 during outage and after reload; reached 0 after recovery; source row existed | Passed |
| Database outage, baseline | Return retryable error, retain the queue, and persist after Postgres recovery | HTTP 200 with `fatal_error`, `UNCLASSIFIED_ERROR`, `requires_client_handling: false`; pending count became 0; source row remained absent after recovery | **Failed** |
| Database outage, recovery profile | Return retryable error, retain across reload, then persist after recovery | HTTP 200 with `retryable_error`; pending count stayed 1 during outage and after reload; source row existed after recovery | Passed |
| Committed response loss | Retain queued work when a successful response is lost, then replay | The test forwarded the real upload, confirmed success and source commit, and discarded its response. Queue stayed 1, then drained after replay; source had one widget with the expected name | Passed |
| Remote JWKS outage | Fresh verifier returns 401 while key endpoint is unavailable; accepts the same token after recovery | Actual backend rejected the token with 401, then returned a successful database transaction with that same token after endpoint/verifier restart | Passed |

The database failure was reproduced after stopping Postgres and restarting the backend to clear pooled connections. A fresh valid widget was queued and uploaded through the unchanged repository connector. Restoring Postgres did not recover the write because the backend-directed fatal response had already completed its queue entry. Local optimistic rows do not change that result.

The parent adapter acquires a connection before its classification `try`. Its error escapes to the API's default unclassified fatal handling. The [recovery patch](../backend/patches/postgres-recovery.json) classifies acquisition failures and maps explicitly listed Node transport codes, including `ECONNREFUSED`, to retryable errors. Unit checks preserve fatal credential/constraint/unknown errors and verify transaction cleanup after commit failure.

No parent backend or connector sources were modified. The baseline generated copy retains only the existing auth configuration patch; the recovery profile additionally applies the checked Postgres patch. The database test remains a failing acceptance test against the baseline and passes against the recovery profile. Recovery-profile CRUD/fatal rollback, API outage and committed-response-loss checks passed as well.

## Reproduce

From `test-system/`, with Node 24, pnpm 9 and Docker:

```sh
pnpm run backend:recovery
pnpm run backend:up
pnpm run client:test:recovery
# Run separately after the browser suite:
pnpm run auth:test:outage
```

Stop a manually running client before the browser checks; the runner owns port 5174. For the original failure, select `pnpm run backend:baseline`, rebuild with `pnpm run backend:up` and rerun the suite: its database case fails. See [profile instructions](../backend/README.md).

The suite restores the API/Postgres services in `finally` and removes its fresh source rows. Receipts read the profile/fingerprints from the running container and are stored separately as `*-baseline.json` and `*-recovery.json` under `.local/recovery-results/`. Profile selection persists across setup; the current local selection is `recovery`.

The JWKS check uses a private HTTPS fixture with verified CA trust, remote keys only, and a freshly restarted verifier. It leaves original auth/key/database TLS files intact and stops this project's containers afterward, preserving the database volume. Its sanitized receipt is `.local/jwks-outage-result.json`.

The response-loss pass establishes replay behavior for widget upsert state. It does not establish exactly-once execution or absence of duplicate arbitrary side effects. Cloud convergence, automatic upload recovery through Cloud, and public tunnel failures remain untested.
