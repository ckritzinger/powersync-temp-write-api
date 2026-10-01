# Configuring token verification

The default `backend/src/auth/verifier.ts` reads a PowerSync Cloud JSON export, resolves
its authentication settings, and builds a verifier. It may need additional trusted
settings, such as the expected issuer or audience.

Authentication configuration is separate from the demo signing keys. The API does not
accept tokens from `/api/auth/token` merely because it issued them.

## Choose an integration

- **PowerSync Cloud:** use the export and supplements below. Supabase with asymmetric
  signing keys is supported by this path.
- **Self-hosted PowerSync:** adapt the loader to use `resolveSelfHostedAuth`, as shown below.
  The default loader does not read YAML or detect self-hosted configuration automatically.
- **Custom provider:** preserve the startup and request exports when replacing the verifier.
  See [Supabase and Clerk integration](../../../docs/auth-verifiers.md).
- **Local HTTP testing:** use the demo configuration below. It requires no PowerSync instance.

Use Node.js 24 and pnpm 9 for local development and tests. Install backend dependencies
with `pnpm --dir backend install` from the repository root. The export commands also require
the [PowerSync CLI](https://docs.powersync.com/tools/cli).

## PowerSync Cloud export

From the repository root, export directly to the path the backend expects:

```sh
powersync login
powersync fetch config --instance-id="<instance-id>" --output=json > backend/powersync-config.json
```

Alternatively, run `powersync link cloud --instance-id="<instance-id>"` once, then omit the
instance flag on later exports. If your installed CLI also requires organization or project
IDs, pass `--org-id` and `--project-id`; use `powersync fetch config --help` to inspect its flags.
The [export command](https://github.com/powersync-ja/powersync-cli/blob/main/cli/src/commands/fetch/config.ts)
prints JSON when `--output=json` is supplied.

Pass the complete response with its top-level `config` object. Keep it out of version control;
it can contain database settings and secret references. This repository ignores
`powersync-config*.json` and excludes them from Docker images.

Re-export and restart the backend after changing auth settings. The resolver may inspect
replication settings to identify a Supabase project. If it infers Supabase from a database
connection, verify separately that your PowerSync instance accepts those tokens too.

### Supplements

Edit the existing `supplements` object in `backend/src/auth/verifier.ts`.
For a generic provider, for example:

```ts
const supplements: AuthSupplements = {
  issuer: 'https://issuer.example.com',
  instanceUrl: 'https://your-instance.powersync.example.com'
};
```

Use your provider's actual issuer and your actual PowerSync instance URL. Instead of
`instanceUrl`, you can supply an `audience` array containing the intended accepted audiences,
including any exported `additional_audiences`.

Standard hosted Supabase configurations usually need no supplements. For a custom domain
or ambiguous project detection, supply `provider: 'supabase'` and `supabaseUrl` as directed by
the resolver. See the full supplement table in `verifier.ts`.

For JWKS URLs, distinguish two settings:

- `jwksUri` supplies a missing endpoint; it cannot conflict with the exported endpoint.
- `jwksUriOverride` replaces remote endpoints when the backend needs a different address.
  It leaves inline public keys unchanged.

HTTPS is required by default. For local development, `allowLocalHttp: true` permits loopback
HTTP endpoints. Other HTTP hosts require exact names in `allowInsecureHttpHosts`.

## File paths and startup

| Run mode | Environment file | Default auth file |
| --- | --- | --- |
| Docker Compose | Root `.env`, for Compose interpolation | `backend/powersync-config.json` on the host |
| `pnpm --dir backend dev` or `start` | `backend/.env` | `backend/powersync-config.json` |

For Compose, `POWERSYNC_CONFIG_PATH` in the root `.env` selects an absolute host path. Compose
mounts that file at `/run/secrets/powersync-config.json` and sets the container's variable to
the mounted path. A missing source file prevents the container from starting.

For local execution, the default path is relative to the verifier module. A custom
`POWERSYNC_CONFIG_PATH` is resolved from the process working directory, normally `backend/`.
For example, from the repository root:

```sh
POWERSYNC_CONFIG_PATH=/absolute/path/to/powersync-config.json pnpm --dir backend start
```

Startup calls `initializeVerifier()` before listening. Invalid configuration produces
`Cannot start.` and setup instructions. Remote JWKS endpoints are contacted on demand during
verification, so startup does not test their availability. Configuration and inline keys are
cached per process; restart after changing them. Remote keys refresh according to the cache policy.

## Local demo authentication

For the manual HTTP checks, create `backend/powersync-config.json` with this content:

```json
{
  "config": {
    "client_auth": {
      "jwks_uri": "http://127.0.0.1:6060/api/auth/keys"
    }
  }
}
```

This is a local test configuration using the Cloud export format, not an export from an instance.
Set the `supplements` object in `backend/src/auth/verifier.ts` to:

```ts
const supplements: AuthSupplements = {
  issuer: 'powersync-dev',
  audience: ['powersync-dev'],
  allowLocalHttp: true
};
```

Set `JWT_ISSUER=powersync-dev` and `POWERSYNC_URL=powersync-dev` in the environment file for
your run mode. Generate a signing pair with `pnpm --dir backend generate-keys` and copy both
values into that same environment file. The loopback JWKS URL works inside the backend
container and for a local backend on port 6060. Adjust it if you change the backend's port.

This setup tests writes without a sync connection. To sync with a real PowerSync instance,
configure that instance to trust the demo keys and accept the token's audience. The instance
must reach its configured JWKS URL; a cloud instance cannot use your backend's loopback URL.
Set the client's sync URL to the real instance URL. The client's sync URL and the token's
`aud` are separate settings, even when they have the same value.

## Self-hosted PowerSync

Use the configuration that runs your PowerSync service. Parse its YAML and resolve `!env`
references in your own loading code, or save the already-resolved configuration as JSON.
The repository does not include a YAML parser or a service configuration file.

For the JSON approach, save the resolved service configuration in `backend/powersync-config.json`.
It has `client_auth` at the top level, without the Cloud `config` wrapper. For example:

```json
{
  "client_auth": {
    "jwks_uri": "https://issuer.example.com/.well-known/jwks.json",
    "audience": ["powersync-app"]
  }
}
```

Adapt `backend/src/auth/verifier.ts` as follows:

1. Import `resolveSelfHostedAuth` in place of `resolvePowerSyncAuth` from `./verifier/index.js`.
2. Keep file loading, JSON parsing, diagnostic handling, and `createTokenVerifier(result.config)`.
3. Replace the resolver call with `resolveSelfHostedAuth(dump, supplements)`.
4. Set `supplements` to your expected issuer, for example `{ issuer: 'https://issuer.example.com' }`.
   Remove Cloud-only `instanceUrl`, `jwksUri`, `provider`, and `supabaseUrl` supplements.
5. Update the loader's file-error messages to refer to your service JSON instead of a Cloud export.
   Keep the `initializeVerifier` and `verifier` exports used by the application.

The existing Compose mount can carry this JSON file after the loader is adapted. Rebuild the
image, or restart the development process, after changing the loader.

`client_auth.audience` is the complete audience list for this resolver. Use `jwksUriOverride`
when the backend needs a different endpoint address. The resolver does not support the
self-hosted `supabase: true` mode's separate audience policy. For Supabase, omit that flag
and configure `client_auth.jwks_uri` and `client_auth.audience: ["authenticated"]` directly;
supply the project's `/auth/v1` issuer. See [PowerSync's manual configuration](https://docs.powersync.com/configuration/auth/supabase-auth#manual-jwks-configuration).

## Verification behavior

The built-in verifier requires a valid signature, an allowed asymmetric algorithm, matching
issuer and audience, `exp`, and a non-empty `sub`. It also checks `nbf` when present.
It returns `{ sub, claims }` or throws:

| Error | Meaning and current handling |
| --- | --- |
| `AuthConfigurationError` | Invalid settings; normal startup fails before listening. |
| `InvalidTokenError` | Invalid signature or claims, or no matching key. Middleware returns 401. |
| `KeyFetchError` | JWKS retrieval failed. Middleware currently returns 401 for this too. |

Remote JWKS defaults are a 5-second fetch timeout, 10-minute cache, and 30-second refresh
cooldown. Pass `VerifierOptions` to `createTokenVerifier` to change them. Inline key rotation
requires updating the file and restarting.

The built-in resolver supports one issuer and one audience policy per verifier. It rejects
symmetric keys, private keys, legacy Supabase secrets, and configurations with no supported
verification keys. PowerSync temporary tokens are excluded. Clerk session tokens without
`aud` need the custom integration in [the provider guide](../../../docs/auth-verifiers.md).

Authentication does not restrict writes. Add [authorization](../../../docs/authorization.md)
using trusted identity and permissions, and configure sync access separately.
