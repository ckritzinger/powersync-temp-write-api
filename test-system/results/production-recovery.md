# Production Postgres recovery verification — 2026-10-06

The previously verified recovery fix is now implemented in parent production sources:

- Connection acquisition errors pass through the existing Postgres classifier before API routing.
- Explicit known transient Node transport codes return retryable errors. Bad credentials, constraints and unknown non-transient codes remain fatal.
- Acquisition failures perform no transaction cleanup; transaction failures still attempt rollback and release the acquired client.

Verification passed:

- Complete production backend suite: 8 test files, 90 tests, including acquisition failure through the actual HTTP API, permanent credential rejection, commit-reset rollback/release, operation context and error classification.
- Production TypeScript check (`tsc -b`).
- Nine focused fixture tests for checked patches, upstream-fix recognition, recovery classification/cleanup, Cloud/tunnel target isolation and TLS.
- Actual Cloud database-outage browser case using the `baseline` generated backend with `recoveryFix: upstream`. Postgres was stopped, stale pooled connections cleared, and a write returned retryable. One operation survived reload; after database recovery automatic upload drained it, the exact row persisted, and the second Cloud client converged.

The baseline manifest contains only the auth-supplements patch, not the Postgres recovery patch. Source fingerprint: `5d7346d19823`. Prepared fingerprint: `d109fd22356b`, identical to the previously accepted recovery-patched backend, proving this promotion preserves that tested implementation.

The fixture now recognizes the complete recovery replacement already present upstream without applying it twice; ambiguous matches still fail closed. Its manifest distinguishes `upstream`, `test-patch` and `absent`. Baseline is the selected running profile.

Sanitized live receipt: `.local/live-recovery-results/postgres-outage.json`. This run supersedes the older test-only Postgres receipt. Historical baseline failure remains documented in [recovery results](recovery.md), and the other live scenarios remain in [live recovery results](live-recovery.md).

Services were restored and fresh test rows cleaned up. No signing keys or database data were reset. The production changes are uncommitted. Product reconciliation for rejected optimistic rows and optional client-directed/multi-transaction connector extensions remain separate work.
