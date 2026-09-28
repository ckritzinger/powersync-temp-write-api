# Setup guide: verifying PowerSync tokens in your write API

You do not hand-write issuer/audience/key settings: the instance configuration already contains
them, and the resolver turns it into a verifier or tells you exactly which field is missing.

**Prerequisites:** Node.js 22+, the `jose` dependency, the modules under `src/` available to your
backend, and the [PowerSync CLI](https://github.com/powersync-ja/powersync-cli) for the export.

## 1. Export the instance configuration (PowerSync Cloud)

```sh
powersync login                 # or set PS_ADMIN_TOKEN

powersync fetch instances       # find the instance you want

1. Option 1
powersync link cloud            # link this directory to it, once
powersync fetch config --output=json > powersync-config.json

2. Option 2
powersync fetch config \
  --instance-id="<instance-id>" \
  --project-id="<project-id>" \
  --org-id="<org-id>" \
  --output=json > powersync-config.json
```

If the directory is not linked, pass `--instance-id=<instance-id>` to `fetch config` instead of
linking. Flags above are CLI v0.10; v0.9 also required `--project-id` and `--org-id`.

Two things about that file:

- **Keep it out of version control.** The dump carries database settings and secret references.
  This repository ignores `powersync-config*.json` — do the same in yours.
- **Pass it whole.** The resolver expects the complete CLI response (the object with a top-level
  `config` key), not just the `client_auth` section. It reads only auth fields and stores nothing.

Re-export whenever you change auth settings in the dashboard. The dump is a snapshot; a verifier
built from a stale one may not match what the instance currently accepts.

### Supplying the file at startup

For local execution, save the export as `backend/powersync-config.json`. That default is resolved
relative to the verifier module, regardless of where you start the process. Alternatively set
`POWERSYNC_CONFIG_PATH` in the process environment or the `.env` loaded from your working directory:

```sh
cd backend
POWERSYNC_CONFIG_PATH=/absolute/path/to/powersync-config.json pnpm start
```

A relative override is resolved from the process working directory. Generic providers may also
need trusted `issuer` and `instanceUrl` or `audience` supplements in `src/auth/verifier.ts`; follow
the resolver diagnostics and the table in that file.

Docker Compose mounts `./backend/powersync-config.json` read-only at
`/run/secrets/powersync-config.json` and sets the container's `POWERSYNC_CONFIG_PATH` accordingly.
To use another host file, set `POWERSYNC_CONFIG_PATH` to its absolute host path in the root `.env`
or shell before running `docker compose up --build`. The source file must exist; Compose will
reject a missing bind source instead of creating a directory. The development overlay uses the
same mount. Config exports are excluded from the image and Git.

Startup initializes auth before listening. Unreadable files, invalid JSON, or unsupported auth
settings stop the backend with `Cannot start.` and setup instructions, without printing config
contents or a stack trace. Auth is required; there is no fallback to demo tokens. Configuration
and verification keys are initialized once per process, so restart after changing the export or
supplements. Remote JWKS keys still refresh according to the verifier's cache policy.

Tests use synthetic auth configuration and local signing keys. They do not require your export
or a live identity provider.

## 2. Self-hosted instead of Cloud

Self-hosted deployments have no management API, so `powersync fetch config` does not apply. Parse
`config/service.yaml` yourself — resolving `!env` references as PowerSync does — and call
`resolveSelfHostedAuth`, which takes `client_auth.audience` as the complete accepted list:

```ts
const service = parse(await readFile('./config/service.yaml', 'utf8'), { customTags: [envTag] });
const result = resolveSelfHostedAuth(service, { issuer: 'powersync-dev' });
```

See `examples/self-hosted-verifier.ts` for the `!env` tag and the typical `jwksUriOverride`. The two
entry points are deliberately separate because Cloud and self-hosted disagree on what a configured
audience means; `instanceUrl` and `jwksUri` are rejected for self-hosted. Self-hosted Supabase Auth
needs a second audience policy and is not supported — configure its JWKS endpoint explicitly.

## 3. What your route handlers see

`verify(token)` resolves to `{ sub, claims }` after checking signature, allowed algorithm, issuer,
audience, expiry, `nbf`, and a non-empty subject. Otherwise it throws one of:

| Error                    | Handling                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `AuthConfigurationError` | Resolved settings were incomplete. Fail startup and fix configuration.                                        |
| `InvalidTokenError`      | Bad signature or claims, or no matching key. Reject with 401.                                                 |
| `KeyFetchError`          | The JWKS endpoint could not supply keys. Fail closed; 503 separates a dependency outage from bad credentials. |

Remote keys are cached (5s fetch timeout, 10-minute cache, 30s refresh cooldown, all adjustable via
`VerifierOptions`), so a rotation may take a moment to become visible. Inline keys come from the
dump: rotating them means re-exporting and restarting.

## Boundaries worth knowing before you start

- Asymmetric user tokens only. A dump containing a Supabase legacy HS256 secret or other symmetric
  key is rejected outright, even if a usable key source sits beside it.
- PowerSync temporary tokens are never accepted.
- One issuer and one audience policy per verifier. Multiple issuers, or separate Clerk session
  tokens with an `azp` policy, need an adapter that does not exist yet.
- Authentication only. Deciding whether this `sub` may perform this write is still your backend's
  job. Base authorization on server-controlled permissions. A valid signature proves the issuer
  issued the claims, but some claims may contain profile data the user can edit before a token is
  issued (such as Supabase's `user_metadata`). Do not use those claims to grant permissions.
