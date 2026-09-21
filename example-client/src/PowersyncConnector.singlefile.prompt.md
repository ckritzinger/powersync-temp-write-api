# Regeneration prompt: PowersyncConnector.singlefile.ts

This file is not consumed by any tooling — it's a prompt to hand to Claude (or read yourself)
whenever `PowersyncConnector.ts` or the files under `library/powersync/` change, so
`PowersyncConnector.singlefile.ts` can be regenerated to match without re-deriving these design
decisions from scratch.

## When to use this

Any time the split version's behavior, config surface, or wire contract changes:
`PowersyncConnector.ts`, `library/powersync/WriteAPIClient.ts`,
`library/powersync/OpenAPITransport.ts`, `library/powersync/DemoConnectorConfig.ts`,
`library/powersync/TransactionBatching.ts`, or `backend/openapi.yaml`.

## The prompt

> Regenerate `example-client/src/PowersyncConnector.singlefile.ts` from the current state of
> `example-client/src/PowersyncConnector.ts` and the files it imports from
> `example-client/src/library/powersync/` (`WriteAPIClient.ts`, `OpenAPITransport.ts`,
> `DemoConnectorConfig.ts`, `TransactionBatching.ts`), plus `backend/openapi.yaml` for the wire
> contract. Preserve all runtime behavior exactly. Apply these fixed design decisions:
>
> 1. **Single file, additive.** Everything lives in `PowersyncConnector.singlefile.ts`. Don't
>    touch or replace the split version — both are maintained side by side.
> 2. **Zero dependencies beyond `@powersync/web`/`@powersync/react-native`.** No `openapi-fetch`,
>    no `uuid`, no generated `api.d.ts`, no relative imports. Exactly one `import` line, from
>    `@powersync/web`. Use plain `fetch` for all HTTP calls (auth header injection, JSON body,
>    `AbortSignal.timeout(...)` for the timeout, manual `response.ok`/status check).
> 3. **Config via SHOUTY_CASE consts at the top of the file**, not env vars and not constructor
>    options — a copy-pasted file can't assume a bundler exposes `import.meta.env`. Mirror the
>    split version's current defaults exactly (as of writing: `MAX_TRANSACTIONS_PER_BATCH = 1`,
>    `MAX_OPERATIONS_PER_BATCH = 1000`, `ON_FATAL_ERROR = 'stop'`, `REQUEST_TIMEOUT_MS = 30_000`).
>    If `DemoConnectorConfig.ts`'s defaults changed, update the consts to match — don't reintroduce
>    the null-fallback/"unset means default" parsing logic; a const always has a value, so that
>    branch has nothing to do.
> 4. **User id via `crypto.randomUUID()`**, not the `uuid` package. Keep a one-line comment noting
>    that older React Native needs a polyfill (`react-native-get-random-values` or `expo-crypto`)
>    for `crypto.randomUUID()` to exist at all.
> 5. **Hand-written literal types, not generated ones.** Re-derive the wire shapes
>    (`CrudEntryAPI`, `CrudTransactionAPI`, `TransactionBatchAPI`, `TransactionResponseAPI`,
>    `TransactionBatchResponseAPI`, the `ErrorCode` union, etc.) from the current
>    `backend/openapi.yaml`, as literal unions/interfaces — not `string`/`any`. This file has no
>    codegen step, but "no codegen" doesn't mean "no type safety": keep it as precise as hand-typing
>    allows.
> 6. **Keep the `AuthenticationError` distinction.** 401/403 responses throw a dedicated
>    `AuthenticationError` (not a generic `Error`) so `onTransportError` can clear the cached token
>    and force a refetch on retry. Every other non-2xx response is `{ message }` per
>    `backend/openapi.yaml` — parse and surface that message in a generic `Error`.
> 7. **`AppSchema.ts` is out of scope.** The single file is the connector only, not the demo app's
>    schema. Don't import or embed it.
> 8. **No `WriteAPIClient`/`OpenAPITransport` DI abstraction.** The split version separates these
>    for composability across files; the single file has no test double to inject, so inline the
>    transport call as a private method on the connector class directly.
> 9. **No `clientId`/`_writeClient` bookkeeping.** In the split version these are threaded through
>    `WriteAPIClientOptions` but never actually sent over the wire or read anywhere — dead state.
>    Confirm that's still true against the current split version before dropping it; if a future
>    change actually wires `clientId` into the request body, carry that behavior over instead.
> 10. **Fully self-contained top-of-file comment block.** Someone copying just this one file won't
>     carry the README with them. The header must stand alone: what the file is, when to use it
>     over the split version, every const that needs editing, and the full auth caveat (demo token
>     vs a real identity provider, the JWKS/`GET /api/auth/keys` requirement for sync to work,
>     links to the client-side integration guide and `docs/auth-verifiers.md`).
> 11. **Keep the overridable hook shape identical**: `uploadData`, `fetchCredentials`,
>     `getBatchingConfig`, `onFatalTransaction`, `onRetryableError`, `onTransportError` — same
>     method names, same override points, same doc comments explaining each, so someone reading
>     both versions side by side sees the same shape.
>
> After regenerating, update:
> - `example-client/README.md`'s "What's here" tree and the sentence pointing at the single-file
>   alternative, if the split version's file list changed.
> - `docs/test.txt` section 5's check that `PowersyncConnector.singlefile.ts` has exactly one
>   import line, from `@powersync/web`.
>
> Do not add a `package.json`, build step, or test suite to `example-client/` — it stays
> non-runnable reference code, same as the split version.

## Background: why these decisions, not others

- **Config-as-consts over constructor options was a deliberate reversal of the first
  recommendation.** The initial proposal was a constructor options object (more "proper," easier
  to unit test). The decision that shipped was top-of-file consts instead — simpler for someone
  who just wants to paste, edit two URLs, and go, with no object to construct or wire up.
- **The self-contained-comment requirement is load-bearing.** The single file is explicitly meant
  to travel *without* the README. If regenerating trims the header down to match the split
  version's terser style, that defeats the point — verbosity in the header is intentional here,
  not a smell.
- **The "no external libraries" constraint includes `uuid`, not just `openapi-fetch`.** It's easy
  to swap out the OpenAPI client and miss that `uuid` is also a dependency the split version pulls
  in via `PowersyncConnector.ts`'s constructor.
