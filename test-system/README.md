# PowerSync Cloud test system plan

Build an isolated development system for testing this repository's write API against PowerSync Cloud, without Supabase or an application deployment. Run Postgres, the existing backend, a separate test identity provider, and a small browser client locally. Expose the backend through HTTPS and Postgres through a separate TCP tunnel.

Status: Phases 1 and 2 are implemented and verified. Live Phase 3 passed on 2026-10-06 with the isolated test identity provider, public ngrok tunnels, and the dedicated PowerSync Cloud instance. Phase 4 two-client Cloud CRUD convergence and offline reload/reconnect recovery also passed. The requested live Phase 5 failure/recovery suite also passed with the test-only recovery profile. See [live recovery evidence](results/live-recovery.md) for outcomes and coverage limits. See [provider instructions](auth/README.md) and [live evidence](results/phase-3.md).

See [what remains to finish the test system](remaining-work.md) for the next steps, required account inputs, and completion criteria.

MongoDB source testing is implemented as a sequential switch on the same Cloud instance. See [the plan](mongodb-plan.md) and [MongoDB runbook](database/mongodb/README.md). `pnpm run mongodb:acceptance` runs local and live MongoDB checks and restores Postgres afterward. Browser queues are scoped by source; a checked fixture-only header prevents uploads into the wrong database. Complete exports and restore credentials stay in ignored `.local/`.

MySQL uses the same sequential workflow. See [the MySQL plan](mysql-plan.md) and [runbook](database/mysql/README.md). `pnpm run mysql:acceptance` verifies MySQL and restores Postgres; its Cloud binlog transport limitation is documented in the runbook.

SQL Server now has a startup/CDC gate and the same source-switching workflow. See [the SQL Server plan](mssql-plan.md), [runbook](database/mssql/README.md) and [verification status](results/mssql.md). `pnpm run mssql:acceptance` runs local and live checks and restores Postgres. This ARM64 host uses unsupported amd64 emulation; the runbook records transport and coverage limits.

For Phase 3 account configuration, tunnel startup, Cloud deployment, and end-to-end verification, follow [the Cloud workflow](powersync/README.md). Run `pnpm run test` and `pnpm run cloud:verify:local` for the checks that do not need those accounts.

For the browser app, follow [client instructions](client/README.md). Run `pnpm run client:dev` and open `http://127.0.0.1:5174`. Follow [the manual suite](manual-tests.md) for executable cases and evidence requirements. Local results are recorded for [Phase 4](results/phase-4.md) and [Phase 5](results/phase-5.md).

Recovery tests confirmed a [database-outage failure](results/recovery.md) in the baseline backend. An explicit [recovery profile](backend/README.md) patches only the generated backend and passes queue retention/reload/recovery checks. The parent source remains unchanged; select the profile explicitly and rebuild. API outage, committed-response replay and isolated JWKS recovery passed locally.

## Run the local backend and database

Select Node.js 24 and pnpm 9, and start Docker Desktop. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm run test
pnpm run db:up
pnpm run backend:up
pnpm run db:verify
pnpm run db:verify:persistence
pnpm run smoke
pnpm run smoke:restart
pnpm run smoke:widgets
pnpm run down
```

Use `pnpm run setup` explicitly: `pnpm setup` is a pnpm built-in command, not this project's setup script. Alternatively run `node scripts/setup.mjs` and `node scripts/smoke.mjs` directly with Node 24. These infrastructure scripts use Node built-ins; browser development requires the installed SDK and build dependencies.

The backend is available at `http://127.0.0.1:6061`. Change `BACKEND_PORT` in `.local/runtime.env` if that port is occupied. Startup builds the prepared backend, runs its TypeScript check, and waits for database/API health. The smoke check verifies health, public JWKS, persisted signing key identity, missing/invalid token rejection, and a successful authenticated empty database transaction.

The restart smoke check additionally obtains a token, restarts only the backend, and verifies that the previously issued token still authorizes a database transaction.

The widgets smoke check sends real PUT/PATCH/DELETE operations through the API and verifies each outcome directly in Postgres, using a fresh test ID that it removes afterward.

Setup records the parent revision, per-file hashes, and a source fingerprint in `.generated/backend/source-manifest.json`. It copies only selected backend files and TypeScript sources, then applies the exact-match verifier patch. Rerun setup after changing parent backend source, then rebuild with `pnpm run backend:up`.

Local settings are in `.local/runtime.env`; persistent RS256 keys are in `.local/signing-keys.json`. Setup preserves both; signing keys are mounted only in the separate auth gateway. The old derived `.local/keys.env` is no longer used. It refuses malformed or mismatched existing keys instead of silently replacing them. Intentional rotation requires stopping this system, explicitly moving the old key file out of the way, updating/replacing the auth configuration, and rerunning setup. Never do this as part of an ordinary restart.

The initial `.local/auth-config.json` is a generated Cloud-shaped bootstrap file containing inline public JWKS, not a Cloud export. Its audience `https://test-system.invalid` is a local-only placeholder. In Phase 3, update the runtime audience to the real instance URL and replace the auth file with the Cloud export. Setup preserves an existing auth file. Secrets are owner-readable files under an owner-only `.local/` directory; neither that directory nor other test-system files enter the Docker build context. Only `.generated/backend/` and the Dockerfile are sent to the builder.

Postgres is published only on `127.0.0.1:5433` (change `POSTGRES_PORT` in `.local/runtime.env` as needed). The Phase 1 disposable fixture has been replaced by the `postgres` service and dedicated `powersync-test-system-postgres-data` volume. `pnpm run down` preserves this volume, signing keys, credentials, and certificates. Backend request logs are inside the container under `/tmp`; inspect them with `docker compose --env-file .local/runtime.env logs backend`.

## Database roles and initialization

Setup generates `.local/database.env` with separate persistent admin, writer, and replication passwords. Do not change these values on an initialized database expecting them to take effect: container environment changes do not update database roles. Normal setup reruns preserve the file. Phase 1's default disposable-database URI is automatically migrated to the new writer URI; custom database URIs are preserved and must be updated explicitly if you want this local database.

| Role | Purpose | Permissions |
| --- | --- | --- |
| `test_admin` | Local initialization and inspection | Container administrator; only local socket access allowed |
| `test_writer` | Existing backend writes | Connect, schema usage, widget SELECT/INSERT/UPDATE/DELETE; no schema creation or replication |
| `powersync_role` | PowerSync source connection | Connect, schema usage, widget SELECT, logical replication; no writes |

The database is named `test_system`. Initialization creates `public.widgets (id uuid PRIMARY KEY, name text NOT NULL)` and publication `powersync` for that table only. It does not grant access to future tables automatically. The table has no RLS; adding RLS later requires reviewing replication visibility and permissions.

Initialization SQL runs only on a fresh volume. For later schema changes, apply a reviewed migration; editing `database/init/` does not alter an existing database. To explicitly delete all test rows and slots and initialize again:

```sh
pnpm run db:reset --confirm-delete-test-database
pnpm run db:up
pnpm run backend:up
```

The reset script checks the exact volume's Compose project label, stops only this project, and removes only `powersync-test-system-postgres-data`. It retains local keys, TLS material, and credentials. Disconnect the dedicated Cloud source before resetting a database already connected to Cloud.

`pnpm run db:verify` checks database grants, real writer operations, denied operations, verified TLS, non-TLS rejection, replication-protocol login, and actual `pgoutput` decoding through a temporary logical slot. It removes its test row and leaves no replication slot. `pnpm run db:verify:persistence` additionally removes/recreates the containers and confirms data survives. The replication slot WAL limit is 1 GB; a lagging future Cloud slot may need resync if this limit is exceeded.

## Database TLS and networking

Setup requires OpenSSL with `-addext` support and generates a private test CA and server certificate under `.local/tls/`. Existing valid material is preserved; partial, mismatched, or expired server material fails setup. Tests validate the server chain and hostname rather than merely enabling encryption. See [TLS instructions](database/tls/README.md) for certificate lifecycle and the separate Cloud/tunnel verification required in Phase 3.

Replication connections require TLS and SCRAM passwords. The parent's current Postgres adapter does not enable TLS, so only `test_writer` at the backend's fixed Docker IPv4 address may use a non-TLS connection. Host/tunnel addresses do not receive this exception. The default Docker subnet is `172.29.77.0/24`, with Postgres at `172.29.77.2` and the backend at `172.29.77.3`; adjust `DOCKER_SUBNET`, `POSTGRES_DB_IP`, and `BACKEND_DB_IP` together if another network overlaps. The optional local JWKS check reserves `.4` in that subnet (override with `JWKS_FIXTURE_IP` if needed). Changes require container/network recreation, preserving the volume.

The initial test CA-signed certificate identifies `postgres`, `localhost`, and `127.0.0.1`. Phase 3 bootstrap adds the captured TCP tunnel hostname while preserving the CA and server key. The live check verifies the public tunnel connection using that hostname; local Phase 2 checks do not claim that PowerSync Cloud has connected.

## Development boundary

All test-system source, configuration, scripts, dependencies, generated backend copies, secrets, logs, and test evidence belong under this repository's `test-system/` directory. Run development commands from this directory. Read the parent backend and example connector as inputs; do not modify them or use their existing environment files, Cloud exports, or running services.

Docker-managed images and volumes and external PowerSync configuration necessarily live outside the directory. Give all containers, networks, and volumes a dedicated Compose project name, `powersync-test-system`. Keep their definitions here. Tunnel account setup is an external prerequisite; keep this project's tunnel configuration here.

Use a dedicated disposable PowerSync Cloud instance. This plan tests signed demo identities, not real user login. All test users may read the same widgets initially, and the existing authorizer permits authenticated writes.

## Architecture

| Component | Location | Connections |
| --- | --- | --- |
| Postgres with logical replication | Dedicated local container | Backend uses its Docker hostname; Cloud uses the TCP tunnel |
| Existing write API | Dedicated local container | Direct loopback port 6062; gateway forwards to container port 6060 |
| Test identity provider and gateway | Separate local container | Loopback port 6061; owns token/JWKS routes and forwards writes |
| HTTPS tunnel | Local tunnel agent | Public HTTPS address forwards to localhost:6061 |
| TCP tunnel | Local tunnel agent | Public TCP address forwards to localhost:5433 |
| Browser client | Local development server on port 5174 | Uses localhost:6061 for writes/auth and the Cloud URL for sync |
| PowerSync | Dedicated Cloud instance | Fetches public JWKS and replicates Postgres |

Ports must be configurable, with a preflight collision check. Bind local container ports to loopback. Keep the computer and tunnels running throughout a test session.

The cloud service fetches `/api/auth/keys`; the browser fetches `/api/auth/token?user_id=manual` and uploads transactions to `/api/data`. The backend and PowerSync use the same persistent signing public key. Only the isolated auth service receives the private key. The parent backend has no token/JWKS routes; its generated copy verifies provider tokens without receiving signing material.

An HTTP tunnel cannot carry the Postgres replication connection. Use a raw public TCP endpoint for that connection, with Postgres TLS configured and tested through the tunnel. Do not rely on encryption between the tunnel agent and provider to protect the separate Cloud-to-public-endpoint hop.

## Planned directory layout

```text
test-system/
  README.md                    This plan, later expanded with run instructions
  AGENTS.md                    Development scope and verification rules
  .gitignore                   Local secrets and generated artifacts
  .env.example                 Placeholder configuration only
  package.json                 Orchestration scripts
  pnpm-lock.yaml
  compose.yaml                 Dedicated database and backend containers
  backend/
    Dockerfile                 Node 24 build from the prepared backend copy
    patches/                   Explicit, reviewable test configuration changes
  database/
    init/                      Schema, roles, publication setup
    tls/                       Certificate generation instructions
  powersync/
    sync-config.yaml           One auto-subscribed widgets stream
    auth-config.example.json   Clearly identified bootstrap configuration
  tunnels/
    ngrok.example.yml          Both endpoints in one agent configuration
  client/
    package.json
    src/                       Minimal browser app and prepared connector
  scripts/
    prepare-backend.mjs
    generate-keys.mjs
    preflight.mjs
    smoke.mjs
  manual-tests.md
  results/                     Sanitized test evidence
  .local/                      Ignored env, keys, exports, certificates, tunnel config
  .generated/                  Ignored prepared backend and connector copies
```

Implement incrementally. Do not create placeholder scripts that appear functional before they are implemented.

## Phase 1 Prepare the isolated backend

1. Create a preparation script that copies the necessary parent backend sources, manifests, and lockfile into `.generated/backend/`. Exclude environment files, Cloud exports, logs, dependencies, and unrelated local artifacts. Record source revision and a content fingerprint so uncommitted source changes are identifiable.
2. Apply one explicit configuration patch to the generated verifier's supplements: read the trusted test issuer and PowerSync instance URL from environment variables. Preserve the existing Cloud resolver, startup validation, and JWT verifier. Require the patch to match exactly once and fail clearly if upstream source changes.
3. Build the copy with a test-system Dockerfile using Node 24 and pnpm 9. Do not install into the parent backend or modify its Dockerfile. Mount the test-system auth configuration read-only.
4. Generate a fresh persistent asymmetric signing pair under `.local/`, using this fixture's independent key generator. Regeneration must be explicit so restarts never silently change identity keys.
5. Keep database credentials, signing keys, tunnel tokens, and Cloud exports ignored. Expose only public client settings to the browser.

Use a stable issuer string such as `powersync-test-system`, accepted identically by token generation and backend verification. Set `POWERSYNC_URL` to the actual Cloud instance URL, making it both the demo token audience and returned sync endpoint. A rotating tunnel URL must not silently change issuer or audience.

Acceptance: the generated backend starts, `/` responds, and a locally minted token authorizes an empty CRUD transaction. Original backend files and configuration are unchanged.

## Phase 2 Prepare Postgres

1. Add a pinned Postgres container with `wal_level=logical` and sufficient replication slots and WAL senders for the test instance.
2. Create `public.widgets (id uuid PRIMARY KEY, name text NOT NULL)`.
3. Create a write role for the backend and a separate login replication role for PowerSync, with schema usage and table SELECT permission. Create the `powersync` publication for `public.widgets` as the initialization administrator.
4. Generate local server TLS material and configure Postgres to accept the intended authenticated replication connection. Document the Cloud TLS mode and certificate trust actually validated; do not claim certificate verification when only encryption was tested.
5. Use a dedicated Docker volume. Explain that initialization scripts run only for a fresh database volume; provide an explicit reset command scoped to this Compose project.

Acceptance: SQL writes work with the write role; replication prerequisites and publication membership are verifiable. Test credentials are not printed in diagnostic output.

## Phase 3 Establish tunnels and Cloud configuration

External prerequisites: Docker, Node 24, pnpm 9, an authenticated tunnel account with public TCP support, and access to a dedicated PowerSync Cloud instance. Check current tunnel account limits before assuming both endpoints can run together.

1. Start both endpoints through one project-specific tunnel configuration. Capture the HTTPS origin and public database hostname/port into `.local/` without committing them.
2. Before the API starts, write a minimal Cloud-shaped bootstrap auth file with `config.client_auth.jwks_uri` set to the public HTTPS `/api/auth/keys` URL. Label this as generated bootstrap data, not an actual Cloud export. Supply trusted issuer and audience through the generated verifier patch. The existing verifier fetches remote keys on demand, avoiding a startup dependency on its own JWKS route.
3. Start the API. Confirm the public JWKS URL returns JSON with public keys and no login screen, tunnel interstitial, or private key material.
4. Configure the Cloud source using the TCP endpoint, replication credentials, and tested TLS settings. Keep the backend's database URI pointed at the local container, not the tunnel.
5. Configure Cloud client auth with the public JWKS URL and the intended audience. Add one auto-subscribed sync stream selecting `id` and `name` from `public.widgets`.
6. Save and deploy the Cloud configuration. Export the complete Cloud JSON into `.local/`, replace the bootstrap file with that real export, and restart the backend. Never reuse the parent's export implicitly.
7. Check Cloud replication status and logs, then authenticate a client. A successful JWKS HTTP response alone does not prove that Cloud accepts the token.

If a tunnel address changes, update its dependent Cloud settings, re-export configuration, and restart the backend. Preserve signing keys and issuer. Document the updated endpoint in the session's sanitized results.

Acceptance: PowerSync Cloud can replicate the local table and accept a token minted by the local backend. No application server has been deployed to a cloud host.

## Phase 4 Build the minimal client

Implemented: see [client instructions](client/README.md) and [local verification](results/phase-4.md). The following design describes the acceptance scope; live two-client Cloud verification remains pending.

Use a small Vite TypeScript browser app with the PowerSync Web SDK. Pin tested dependencies in this directory's lockfile and configure the SDK's required worker/WASM assets and development headers according to the selected version.

Reuse the repository's single-file connector initially, prepared from source with explicit changes only to configuration and imports as necessary. Preserve its upload, retry, and fatal-result semantics. Record its source fingerprint. The test must exercise the repository connector rather than a newly invented upload path.

The UI needs:

- A test user ID and connect/disconnect controls.
- Sync connection state, upload errors, and pending upload count.
- A widget list with add, rename, and delete actions using local PowerSync writes.
- A multi-operation transaction action for rollback testing.
- A clearly labeled invalid-write action for exercising fatal results.

Use separate browser profiles or separate client database names for two-client tests. Display source-confirmed outcomes through the second synced client; do not treat optimistic local changes as proof of persistence. Keep tokens out of UI and logs.

Acceptance: client A creates a widget; it appears in source Postgres and client B. Update and delete follow the same path. An offline write survives reload and uploads after reconnect.

## Phase 5 Manual tests and evidence

The executable [manual instructions](manual-tests.md), API smoke script and `manual:api` cases are implemented. Use fresh UUIDs and record expected versus actual results, source rows, client queue state, and replication outcome. Save only sanitized evidence in `results/`. See [current verification](results/phase-5.md); unexecuted live cases remain pending.

Required coverage:

- Health, valid JWT, missing token, invalid token, expiry, and wrong issuer/audience. Wrong-claim fixtures must be signed with the trusted test key so they exercise claim validation.
- PUT, PATCH, DELETE and replay of the same PUT.
- Invalid request shape, zero transactions, 50 transactions, and 51 transactions.
- Atomic rollback: success followed by a NOT NULL failure within one transaction leaves neither row persisted.
- Batch order under `stop` and `skip`, including the correct `not_attempted` results.
- Successful and backend-directed fatal queue completion; retryable and unattempted queue retention.
- API outage, database outage, offline client reload, recovery, and backend restart with persistent keys.
- JWKS reachability failure with a fresh verifier cache; record the current backend's 401 behavior for key-fetch failure.
- Confirmation that default authorization permits authenticated cross-user writes and the initial global stream shares widgets across test users.

Client-directed fatal handling is implemented as an explicit test-only `client-directed` backend profile and retain/discard UI. [Live acceptance](results/client-decisions.md) verifies persistence across reload, blocked later uploads, explicit discard and Cloud reconciliation. The baseline handler still routes constraint failures to backend handling; the focused runner restores its original backend profile.

Do not promise exactly-once processing or durable dead letters: the existing backend provides neither. A lost-response replay test should inspect final database state and any duplicate side effects.

## Developer workflow across phases

The local setup, preflight, database, tunnel, backend and client commands below are implemented. Configure account credentials and the dedicated Cloud target using the linked Cloud workflow before starting tunnels:

```sh
cd test-system
pnpm install
pnpm run setup          # Prepare copies and local configuration; preserve existing secrets
pnpm preflight          # Check prerequisites, Compose configuration, and required files
pnpm db:up
pnpm tunnels            # Keep the two-endpoint tunnel agent running
pnpm backend:up
# Configure Cloud, export into .local/, then recreate the backend
pnpm client:dev
pnpm smoke
pnpm down               # Stop only this system; retain database and signing keys
```

Provide separate explicit reset operations for test rows, the database volume, and signing keys. Ordinary shutdown must never remove data or rotate keys. Stop the tunnel agent and pause/remove the dedicated Cloud source when finished so an unused replication slot does not retain WAL indefinitely.

## Completion criteria

- A fresh checkout can be configured by following only this directory's instructions, with external account steps clearly identified.
- Every repository file created or modified for this effort is inside `test-system/`.
- Persistent test identities survive restarts; no secret appears in committed files or test evidence.
- Cloud-to-local JWKS verification and Cloud-to-local Postgres replication both work.
- Two clients demonstrate insert, update, delete, offline recovery, and the documented queue behavior.
- Results distinguish passed, failed, and untested cases. No full cloud validation is claimed without a live Cloud instance and working tunnels.

## References

- [Existing backend setup](../README.md)
- [Existing authentication configuration](../backend/src/auth/SETUP.md)
- [Existing connector behavior](../example-client/README.md)
- [Existing error handling](../docs/error-handling.md)
- [PowerSync custom authentication](https://docs.powersync.com/configuration/auth/custom)
- [PowerSync source database setup](https://docs.powersync.com/configuration/source-db/setup)
- [ngrok TCP endpoints](https://ngrok.com/docs/gateway/endpoints/tcp)
