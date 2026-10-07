# Generated backend profiles

The backend verifies provider tokens but does not issue them. The separate [auth gateway](../auth/README.md) owns test token/JWKS routes on port 6061; the backend is reachable directly on port 6062. Only the gateway mounts the test signing keys. `backend:up` prepares current parent sources and starts both services.

Parent backend sources remain read-only. Preparation copies the allowlisted source files into `.generated/backend/` and applies exact-match patches. The production Postgres recovery fix has now been promoted into parent sources. Profiles retain compatibility with older inputs; current baseline and recovery profiles both include the production fix.

| Profile | Patches | Purpose |
| --- | --- | --- |
| `baseline` | Auth supplements and fixture source guard | Use current parent behavior, including the promoted production recovery fix |
| `recovery` | Auth/source guard plus Postgres recovery | Apply the checked recovery patch only when missing from parent input |
| `client-directed` | Auth/source guard, Postgres recovery, and validation routing | Route `NOT_NULL_VIOLATION` and MongoDB `DOCUMENT_VALIDATION_FAILURE` to client decisions; other fatal errors keep default handling |

A fresh setup defaults to `baseline`. Selecting a profile persists it in ignored `.local/backend-profile.json`; ordinary setup/preparation preserves that selection. Rebuild after switching so the running container uses the selected source:

```sh
# From test-system/, with Node 24 and pnpm 9:
pnpm run backend:recovery
pnpm run backend:up
pnpm run client:test:recovery
```

The focused `client:test:cloud:decisions` runner builds the explicit `client-directed` profile, verifies the retain/discard UI with the real SDK queue and Cloud, and restores the original profile and normal backend batch mode. Its checked [routing patch](patches/client-directed.json) changes only the generated copy. For interactive testing, run `pnpm run backend:client-directed` followed by `pnpm run backend:up`; restore with `pnpm run backend:baseline` and `pnpm run backend:up`. See [decision verification](../results/client-decisions.md).

For current production-source acceptance without the test-only recovery patch:

```sh
pnpm run backend:baseline
pnpm run backend:up
pnpm run client:test:recovery
```

The current baseline now passes database-outage acceptance: the API returns `retryable_error`, the queued write survives reload, and it reaches source Postgres and a second client through Cloud after recovery. See [production recovery verification](../results/production-recovery.md). The original baseline failure is historical evidence in [recovery results](../results/recovery.md); reproducing it requires the original unfixed source revision.

[postgres-recovery.json](patches/postgres-recovery.json) makes two changes:

- Classify errors from `pool.connect()` before they reach the API's generic fatal handler.
- Treat the explicitly listed transient Node transport errors as retryable. Credential failures, constraints and unknown error codes retain their existing fatal classifications.

Transaction rollback and client release remain intact. Tests exercise acquisition failure, permanent errors, commit failure and cleanup; the real browser/database outage test verifies queue persistence and recovery.

The generated source manifest records `recoveryFix` as `upstream`, `test-patch`, or `absent`, plus the profile, original source fingerprint, individual patch fingerprints and prepared-source fingerprint. Recovery receipts read the manifest from the running container and include its profile; `*-baseline.json` and `*-recovery.json` are stored separately under `.local/recovery-results/`.

`backend:up` starts Postgres and rebuilds/recreates the backend and auth gateway, preserving the database volume. This prevents Compose from retaining a previous profile's container after a rebuild. Recovery checks reject a running profile or prepared-source fingerprint that differs from the selected generated source.

Ordinary patches must match exactly once. Recovery patches also accept their complete replacement exactly once, with no extra copies of the original text, so an upstream fix is never applied twice. Unexpected source changes fail before replacing the generated backend. Neither profile rotates keys or resets data.

All profiles also apply a checked fixture-only [MySQL recovery patch](patches/mysql-recovery.json): classify connection acquisition failures, retry transient Docker DNS failures, and map MySQL error 1364 (missing required field in a sparse SDK PUT) to `NOT_NULL_VIOLATION`. Parent sources are unchanged; manifests record `mysqlRecoveryFix: test-patch`. Live MySQL outage and validation results depend on this patch.

All profiles apply a checked fixture-only [SQL Server patch](patches/mssql-recovery.json): forward URI TLS settings with certificate verification enabled by default, and classify initial pool connection failures. The server enforces encryption and the local writer trusts only this fixture CA. Manifests record `mssqlRecoveryFix: test-patch`; parent sources remain unchanged. Initial failure classification has adapter regression coverage; established-session recovery is tested by the live SQL Server suite.
