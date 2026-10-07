# Isolated test provider verification — 2026-10-06

The test system now uses a separate Compose auth gateway. Only that service mounts `.local/signing-keys.json`. The current parent backend and connector sources are copied with checked patches; production files were not modified. The selected generated backend profile is `recovery`.

Passed:

- Seven focused tests for RS256 token signatures/claims/expiry, public-only JWKS, invalid identities/methods, authenticated request forwarding, unavailable-upstream 502 handling, empty Cloud inline-key lists, tunnel/Cloud target isolation, and configuration patches. Three existing Postgres recovery unit tests also passed.
- Prepared browser client TypeScript check and the backend Docker build/type check.
- Both `/api/auth/token` and `/api/auth/keys` return 404 on the backend directly. Its environment contains no signing keys and its mounts contain no private signing material.
- Health, public test JWKS, missing/invalid token rejection, authenticated transactions, and real source-confirmed PUT/PATCH/DELETE.
- A provider-issued token remained valid after backend restart, preserving the signing key.
- API authentication suite: valid accepted; missing, invalid, expired, wrong issuer and wrong audience rejected. Validation, rollback, default-mode batching, replay, and authenticated cross-user writes passed.
- Five browser checks: SQLite reload/profile isolation; atomic queue and backend fatal completion; auth/retry retention and refreshed credentials; not-attempted/client-directed fixture retention; real API CRUD and fatal rollback with source Postgres confirmation.
- Actual Cloud acceptance: public JWKS, public Postgres verified TLS/replication login, invalid-token rejection, provider JWT acceptance, exact temporary widget in a completed sync checkpoint, and actual Cloud export installed. The temporary row was deleted. See [Phase 3](phase-3.md).

Chromium was initially missing; it was installed under ignored `.local/playwright/`, then all five browser checks passed. No tokens or private keys are recorded here.

Two-client Cloud CRUD convergence and browser offline reload/reconnect recovery subsequently passed; see [Phase 4](phase-4.md). Pending: the remaining live recovery/manual cases. Controlled client-directed response fixtures do not establish that path against the default backend.
