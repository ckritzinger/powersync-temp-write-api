# Setup guide: verifying PowerSync tokens in your write API

You do not hand-write issuer/audience/key settings: the instance configuration already contains
them, and the resolver turns it into a verifier or tells you exactly which field is missing.

**Prerequisites:** Node.js 22+, the `jose` dependency, the modules under `src/` available to your
backend, and the [PowerSync CLI](https://github.com/powersync-ja/powersync-cli) for the export.

## 1. Export the instance configuration (PowerSync Cloud)

```sh
powersync login                 # or set PS_ADMIN_TOKEN
powersync fetch instances       # find the instance you want
powersync link cloud            # link this directory to it, once
powersync fetch config --output=json > powersync-config.json
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
  job — and don't use user-editable profile claims to make that decision.
