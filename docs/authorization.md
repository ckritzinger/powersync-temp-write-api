# Wiring in authorization

Authentication (`backend/src/auth/verifier.ts`, see [auth-verifiers.md](./auth-verifiers.md))
answers *who is writing*. Authorization answers *what they're allowed to write* — and this
backend ships with no opinion on that at all.

## The seam

`backend/src/auth/authorizer.ts` exports `authorizer: Authorizer`, called once per transaction in
`src/api/data.ts`, before anything is persisted:

```ts
export interface Authorizer {
  authorize(crud: CrudEntry[], auth: AuthContext): boolean | Promise<boolean>;
}
```

`crud` is the transaction's operations as the client sent them — table, op, id, `op_data`. `auth`
is the verified identity from the token (`{ sub, claims }`). Return `false` to reject the whole
transaction; it comes back to the client as a fatal error (not retried).

**The default implementation allows everything**, and logs an error every single time it's called:

```
authorize(): no authorization is configured — every authenticated write is being allowed,
no matter who sent it or what it touches. Replace backend/src/auth/authorizer.ts before
this is anything but a demo. See docs/authorization.md.
```

Replace the export. There's no worked example here beyond that — what "allowed" means is
specific to your data model (per-table role checks? per-row ownership? something else?), and a
generic demo backend has no context on your rows to write a real example against.

## The limitation worth knowing before you design around it

`authorize()` only sees what the client *sent* — it cannot look up the row currently in the
database, because `Persister` has no read path, only `updateBatch`. A check like "does this user
already own the list they're patching?" cannot be answered inside `authorize()` for a PATCH or
DELETE; the existing row isn't available there.

Two ways around that:

- **Coarse checks in `authorize()`** — role/claim-based, or shape-based (e.g. reject writes to
  tables a client should never touch directly). No row lookup needed:

  ```ts
  // export const authorizer: Authorizer = {
  //   authorize(crud, auth) {
  //     return crud.every((entry) => entry.op_data?.owner_id === auth.sub);
  //   }
  // };
  ```

  This only works if `op_data.owner_id` can be trusted — the client sent it, so it's exactly as
  trustworthy as the client. Fine as a shape check; not a substitute for verifying ownership
  against the row that actually exists (below).

- **Row-level checks inside the persister** — the persister you're actually using already holds a
  live connection/transaction, so it can look up the existing row before writing, or express the
  check directly in the write itself (e.g. `UPDATE ... WHERE id = $1 AND owner_id = $2`):

  ```ts
  // const { rows } = await client.query('SELECT owner_id FROM lists WHERE id = $1', [entry.id]);
  // if (rows[0]?.owner_id !== auth.sub) {
  //   throw new FatalOperationError('UNAUTHORIZED', 'Not the owner of this row');
  // }
  ```

  (Postgres shown; same idea in any persister with a live connection — a lookup before the write,
  or the ownership check folded straight into the `WHERE` clause.)

## MongoDB, MySQL, SQL Server

No native row-level security exists, and none is added here. `auth` is threaded into each of these persisters'
`updateBatch` too, but unused. Real authorization for these means writing it yourself, either as
a coarse check in `authorize()`, or inline in that database's persister where you have a live
connection to query or condition the write against.

## Postgres: row-level security

Postgres is the only one of the four supported databases with a built-in mechanism for this.
`createPostgresPersister` (`backend/src/persistance/postgres/postgres-persistance.ts`) sets a
session variable from the authenticated `sub` at the start of every transaction:

```ts
await client.query('SELECT set_config($1, $2, true)', ['app.user_id', auth.sub]);
```

The `true` scopes it to the current transaction. A Row-Level Security policy on your tables can
reference it:

```sql
CREATE POLICY owner_only ON lists
  USING (owner_id = current_setting('app.user_id', true));
```

**No policies are defined by this reference backend.** The session variable is wired through;
writing (and enabling) the policies for your schema is yours to do.
