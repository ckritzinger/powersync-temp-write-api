# Demo client

A small React/Vite app that exercises the write path: it queues local changes, uploads them to the
write API as a transaction batch, and syncs the results back from PowerSync.

**This is a test fixture, not a starting point.** It is bound to the demo `lists` and `todos`
schema, so it only works against a bundled example — Adopter Mode does not run it. Bring your own
client for anything real.

## Running it

It comes up with any of the examples, at http://localhost:5173:

```bash
docker compose up --build        # from the repo root
```

In the container it is a production build with its URLs baked in at build time, because Vite
inlines `VITE_*` variables. For a loop that reloads on save and reads configuration at runtime:

```bash
pnpm install && pnpm dev
```

That reads `.env.local` — copy `.env.template` to create it.

## Authentication

Effectively anonymous. A random user id is generated and stored in local storage, and the backend
returns a valid token that is not tied to a specific user. Every client syncs the same data.

Swapping this for a real identity provider is a backend concern — see
[auth-verifiers.md](../auth-verifiers.md).

## Upload behaviour

`.env.template` documents the batching knobs. There is one upload path and one endpoint
(`POST /api/data`), which always takes an ordered run of whole transactions; the variables only
bound how much of the queue goes in each request:

- `VITE_BATCH_MAX_TRANSACTIONS` — transactions per request, default 10
- `VITE_BATCH_MAX_OPERATIONS` — operation ceiling, whichever bound is hit first, default 1000
- `VITE_BATCH_ON_FATAL_ERROR` — `stop` (default) ends the batch at a fatal failure; `skip` drops
  that transaction and continues, so a queue blocked by a poison operation can still drain

## Types

Generated from the shared contract at `backend/openapi.yaml`:

```bash
pnpm generate
```
