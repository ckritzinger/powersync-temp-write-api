# Building more sophisticated schema mapping

Every persister maps each PowerSync `CrudEntry` through an `EntryMapper`
(`backend/src/mapping/types.ts`) before writing it:

```ts
export type EntryMapper = (entry: CrudEntry) => MappedEntry | null;
```

One entry in, one `{ table, op, id, data }` out — synchronously — or `null` to drop the operation
entirely. It's called once per operation, inside that database's transaction loop, immediately
before the write. Install your own by passing it as the second argument when creating a persister
(`backend/src/persistance/persister-factories.ts` is where each database's factory is chosen):

```ts
createPostgresPersister(uri, myCustomMapper);
```

## What ships today

**`defaultMapper`** (used by Postgres, MySQL, SQL Server) does nothing: table name and every field
pass straight through, unrenamed and untyped. It logs an error on every call saying exactly that —
it's fine for a PowerSync table that already matches your DB schema column-for-column, and wrong
the moment it doesn't.

**`mongoMapper`** (used by MongoDB) is the one non-trivial built-in example: a static
per-collection type-coercion table in `backend/src/persistance/mongo/mongo-schema.ts`, applied to
every field the schema names. A table with no entry in that schema logs an error and gets its
operations dropped, rather than failing silently.

## Patterns for a real mapper

- **Renaming.** Map a PowerSync table or column name to a different one in your actual schema —
  `defaultMapper`'s pass-through can't do this at all; your replacement just returns a different
  `table`/key in `data`.
- **Type coercion.** `mongo-schema.ts`'s `applySchema` is the template — a map of column name to
  converter function, applied field-by-field. The same shape works for any database; SQL drivers
  generally need less of it than Mongo's driver does, but timestamps and booleans are common spots
  where the client's JSON and your column type disagree.
- **Computed / server-stamped fields.** Add or overwrite a field the client shouldn't control —
  `updated_at`, a normalized value, anything derived rather than client-supplied. (If what you're
  stamping is *identity* — `owner_id`, `created_by` — see [authorization.md](./authorization.md)
  first; that's an authorization concern wearing a mapping hat.)
- **Dropping fields.** Return `data` without a field the client sent but your schema doesn't have,
  or doesn't want writable.

## What this interface cannot do

`EntryMapper` is deliberately narrow, and two things don't fit it — don't contort a mapper to
attempt them:

- **Fan-out.** One `CrudEntry` becomes exactly one `MappedEntry`. If a single PowerSync operation
  needs to become writes to more than one table or document, that can't be expressed as a mapper
  return value.
- **Async work.** No database lookups, no foreign-key resolution, nothing that needs an
  `await` — the signature is synchronous.

If you need either, don't fight the interface: fork the relevant persister's `updateBatch` loop
(`backend/src/persistance/<database>/`) and do the mapping inline there, where a live
connection/transaction for that operation already exists.
