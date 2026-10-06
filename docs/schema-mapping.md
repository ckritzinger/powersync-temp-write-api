# Schema mapping

Each persister calls an `EntryMapper` before writing a PowerSync `CrudEntry`:

```ts
export type EntryMapper = (entry: CrudEntry) => MappedEntry | null;
```

The mapper runs synchronously inside the database transaction. It returns one
`{ table, op, id, data }` entry, or `null` to skip the operation. Pass a custom mapper
as the second argument to the persister factory:

```ts
createPostgresPersister(uri, myCustomMapper);
```

The factories are configured in `backend/src/persistence/persister-factories.ts`.

## Default mapping

Postgres, MySQL, and SQL Server use `defaultMapper`. It preserves table and field
names without converting or validating values, and logs this on every call. The row ID
is taken from `entry.id` (falling back to `op_data.id`) and removed from the remaining fields.
Replace it if your client and database schemas differ.

MongoDB uses `createMongoMapper`. At startup, `discoverSchema` reads collection
`$jsonSchema` validators through `db.listCollections()` and builds field type
converters. See `backend/src/persistence/mongo/mongo-schema.ts`.

With the default MongoDB mapper, a write to a collection without a discovered validator
fails with `SCHEMA_MISMATCH`. The error includes the original operation index, and the
whole transaction is rolled back. The shared [fatal-error handler](error-handling.md)
routes the failure. A custom mapper handles its own schema mapping.

Add a `$jsonSchema` validator for each collection that accepts writes through the
default mapper. Restart the backend after adding or changing validators.

## Custom mapping

- **Rename tables or fields.** Return a different `table` or change the keys in `data`.
- **Convert values.** Use a converter for fields whose JSON values differ from the
  database type, such as timestamps or booleans. See `applySchema` in `mongo-schema.ts`.
- **Set server-controlled fields.** Add or overwrite values such as `updated_at`.
  For ownership fields such as `owner_id` and `created_by`, see
  [authorization](authorization.md). The mapper does not receive the verified identity.
- **Remove fields.** Omit fields that the database does not store or clients may not write.

## Database lookups and multiple writes

`EntryMapper` supports synchronous, one-to-one transformations. It cannot perform
asynchronous database lookups or return writes to multiple tables or documents.

Implement those operations in the relevant persister's `updateBatch` method under
`backend/src/persistence/<database>/`, using its database connection and transaction.
