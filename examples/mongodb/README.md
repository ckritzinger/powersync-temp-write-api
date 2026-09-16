# Example: MongoDB

A MongoDB Example Source Database. Select it in `.env`:

```bash
COMPOSE_FILE=docker-compose.yaml:examples/mongodb/compose.yaml
```

Then `docker compose up --build`.

## No source container, and no seeding

This example adds **no database container at all**. PowerSync already runs a Mongo replica set for
bucket storage, so replication points at a second database on that same server —
`powersync_demo_source` alongside `powersync_bucket_storage`. Separate databases, one process.
Trying this flavour costs your machine nothing extra.

There is also **no seed script**. Collections are created implicitly by the write API's first
write, so the app starts empty. Add a list in the demo client and it appears.

## What this flavour needs

- **A replica set.** Change streams require one, and so do the multi-document transactions the
  write API uses to apply a Transaction atomically. A single node is fine outside production; the
  base compose file initialises `rs0` for exactly this reason.
- **Pre/post images.** Change streams alone do not carry the document as it was before an update.
  `post_images: auto_configure` in `powersync/service.yaml` turns this on for replicated
  collections. On Azure DocumentDB, which shares this connector, post-images are unsupported and
  this must be `off`.

MongoDB 6.0 or newer. The connector is **generally available**.

## The `_id` projection

MongoDB's primary key is `_id`; the client schema expects `id`. The sync rules bridge that:

```yaml
- SELECT _id as id, * FROM lists
```

Without the projection documents still sync, but arrive without the identifier the rest of the
system keys on. `*` carries `_id` through as well — harmless, since the client ignores columns it
does not declare.

## Gotchas

The write API stores `_id` as the **string** id the client generated, not an `ObjectId`. That is
what makes the round trip work: the id a client invents offline survives into Mongo unchanged.

A single write can produce more than one operation in a bucket for the same document. That is the
op log behaving normally, not a duplicate — operations apply in order and the client converges on
the latest.
