# Phase 3 Cloud and tunnel workflow

For sequential Postgres/MongoDB/MySQL tests on this same instance, use [the MongoDB runbook](../database/mongodb/README.md) or [MySQL runbook](../database/mysql/README.md). Its switch saves the deployed Postgres configuration privately, deploys service configuration before validating/deploying the new sync query, and restores Postgres after acceptance. The original baseline remains preserved. Source mismatches since preparation are rejected before deployment.

Token issuance and public JWKS are now provided by the [isolated auth gateway](../auth/README.md), independently of the production backend. The HTTPS tunnel still forwards to port 6061. Both the gateway and backend must run; bootstrap/export installation recreates both while preserving keys and data.

The scripts in this directory's parent implement the live setup workflow. You need a dedicated PowerSync Cloud instance, its URL/instance/project IDs, PowerSync management credentials, and an ngrok account supporting two simultaneous endpoints and public TCP access. Local implementation tests do not substitute for the live acceptance check.

The installed CLI used during implementation was PowerSync 0.9.3 and ngrok 3.22.1. The ngrok template uses supported version 2 configuration for compatibility with that agent. CLI commands always receive this system's explicit config directory and Cloud IDs; they never load the parent repository's PowerSync files.

## Configure the accounts and target

From `test-system/`, with Node 24, pnpm 9, and Docker running:

```sh
pnpm run setup
pnpm run cloud:configure \
  --instance-url https://YOUR-INSTANCE.powersync.journeyapps.com \
  --instance-id YOUR_INSTANCE_ID \
  --project-id YOUR_PROJECT_ID \
  --org-id YOUR_ORG_ID
```

Organization ID is optional for accounts with a single organization. Use the dedicated instance's actual URL; it becomes the JWT audience. The issuer remains the existing stable `JWT_ISSUER`. IDs must be the actual 24-character hexadecimal Cloud IDs, not these example strings.

Use an existing PowerSync CLI login or save a PAT in `.local/powersync-admin-token.txt`. The script passes that file's contents only through the child process environment, never command arguments or output. Keep secret files owner-readable and keep secrets out of chat. `cloud:fetch` proves whether the account can read the selected instance; `cloud:validate`/`cloud:deploy` require the corresponding management permissions.

For ngrok, save a test authtoken in `.local/ngrok-authtoken.txt`, then run:

```sh
pnpm run tunnels:configure
```

Alternatively, explicitly reuse your own ngrok account configuration:

```sh
pnpm run tunnels:configure --account-config '/absolute/path/to/your/ngrok.yml'
```

This merges account settings at launch without copying the account file's token. Only the two named test-system tunnels are started, even if your account file defines other tunnels. Their request inspection is disabled. Project settings live in `.local/ngrok.yml`; the agent API binds to `127.0.0.1:4041`. If that port is occupied, stop the previous test-system agent before starting another.

## Start the services and discover endpoints

```sh
pnpm run preflight --cloud
pnpm run backend:up
pnpm run tunnels
```

Keep the tunnel command running. In a second terminal, also from `test-system/`:

```sh
pnpm run tunnels:capture
pnpm run cloud:bootstrap
```

Capture verifies both tunnel names and their local forwarding ports, then saves their public addresses in `.local/tunnel-endpoints.json`. Bootstrap archives the prior auth file, installs generated remote-JWKS settings, adds the TCP tunnel hostname to the Postgres server certificate, and recreates the backend. CA, server private key, JWT keys, database credentials, and data remain intact.

The generated bootstrap file is explicitly recorded as bootstrap data; it is not a Cloud export. The backend loads it before fetching remote keys, so its own HTTPS JWKS endpoint does not need to be available during verifier initialization. The database tunnel uses `verify-full` with the private test CA; only the public CA certificate is supplied to Cloud.

## Prepare and deploy the dedicated Cloud instance

```sh
pnpm run cloud:fetch --baseline
pnpm run cloud:prepare
pnpm run cloud:validate
```

For a newly created, unprovisioned instance, validation can pass the schema and database checks while reporting that sync validation requires provisioning. Review the generated files, run `cloud:deploy` to provision the instance, then rerun `cloud:validate`. If the first provisioning command times out, check `cloud:status` and fetch the active configuration before retrying deployment. Private CLI failure diagnostics are saved under `.local/cloud/`.

The baseline is the complete private export of the selected instance before changes. It is created once and never silently overwritten. Preparation preserves the instance name, region, and other baseline settings, replaces its source connection with the tunneled replication role, and configures the public JWKS URL and widgets stream. All generated service configuration and credentials are stored in ignored `.local/cloud/` files.

Review `.local/cloud/service.yaml` and `.local/cloud/sync-config.yaml` locally. The source must name the captured TCP host/port, `test_system`, `powersync_role`, `sslmode: verify-full`, and this system's public CA. The client auth must use the captured HTTPS `/api/auth/keys` URI. The widgets stream auto-subscribes all test users. The service file is JSON syntax, which is valid YAML and preserves multiline certificates without manual escaping.

When ready to apply those changes to the dedicated instance:

```sh
pnpm run cloud:deploy
pnpm run cloud:fetch
pnpm run cloud:install-export
pnpm run cloud:status
pnpm run cloud:verify
```

Deploy changes the selected Cloud instance's source connection, auth, and sync configuration. Scripts reject a target or endpoint change since preparation. CLI output can include source configuration, so it is captured privately instead of printed to the terminal. Failures report the failing operation without echoing configuration secrets.

After deployment, fetch saves the complete actual Cloud export. Installation checks that its target and JWKS URI match this system and that there is no inline-key fallback, then mounts the complete export and recreates the backend. The backend's existing resolver performs the remaining auth configuration validation on startup.

Status saves private Cloud diagnostics; also check the instance's database/replication status in the Dashboard. The live verification requires the current two tunnels, validates public JWKS without interstitial-bypass headers, validates the TCP certificate hostname and replication login, checks invalid-token rejection, uploads a widget through the public API, and waits for that exact widget and a completed checkpoint on the actual Cloud NDJSON sync stream. It deletes the test widget and saves a sanitized receipt in `.local/phase-three-result.json`. A successful root route or JWKS response alone never marks Phase 3 passed.

This diagnostic uses the official HTTP sync protocol; it does not build the Phase 4 browser client or exercise SDK queue persistence.

## Endpoint changes and shutdown

Random tunnel addresses may change after reconnect. Recapture them, rerun bootstrap and preparation, validate/deploy, fetch/install the export, and rerun live verification. Preserve the original baseline unless you deliberately change to a different dedicated instance. A new TCP hostname causes server certificate reissuance with the same CA/key; previous certificates are archived in `.local/tls-history/`.

Stop the tunnel command with Ctrl+C, then run `pnpm run down` to stop this project's containers and preserve data/keys. Pause or remove the dedicated Cloud source in the Dashboard when finished so an unused replication slot does not retain WAL. Never reset a database with an active Cloud source without planning its resync.

## Local verification without account access

```sh
pnpm run test
pnpm run cloud:verify:local
```

Tests cover tunnel identity/upstream rejection, strict endpoint validation, fragmented NDJSON decoding, required row/checkpoint completion, and server certificate issuance preserving the CA/private keys. The container check uses an isolated HTTPS JWKS fixture to exercise the actual backend verifier and database transaction, restores the base Compose configuration, and stops containers. It does not contact ngrok or PowerSync Cloud.

References: [ngrok configuration](https://ngrok.com/docs/agent/config/v2), [ngrok agent API](https://ngrok.com/docs/agent/api), [PowerSync CLI](https://docs.powersync.com/tools/cli), [PowerSync custom auth](https://docs.powersync.com/configuration/auth/custom), [Cloud database TLS settings](https://docs.powersync.com/configuration/source-db/connection), [sync request/response protocol](https://github.com/powersync-ja/powersync-service/blob/main/packages/service-core/src/util/protocol-types.ts).

SQL Server reuses the same instance and TCP tunnel. Follow the [startup/CDC gate and acceptance runbook](../database/mssql/README.md). Its generated Cloud configuration uses `dbo` schema and the native checkpoint CDC table, with encrypted disposable-server connections and explicit certificate trust. The combined runner restores and verifies Postgres.
