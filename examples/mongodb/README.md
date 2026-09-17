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

## Pointing at your own MongoDB instead

You do not need this example for that. Switch to Adopter Mode in `.env` and set `DATABASE_URI` to
your own server. The requirements above still apply:

- **A replica set.** Atlas gives you one automatically. A self-managed single node needs
  `rs.initiate()` before change streams or transactions work at all.
- **Post-images.** Set `post_images: auto_configure` in `config/service.yaml`, and make sure the
  replication user can configure `changeStreamPreAndPostImages` on the replicated collections.
- **Privileges.** `changeStream` at database level, plus read on the collections you replicate.

**Azure DocumentDB** uses this same connector, but does **not** support post-images — set
`post_images: off` there.

Bucket storage does not go into your server. Even here, where the example shares one Mongo process
between source and storage, Adopter Mode keeps storage in a container this project owns.

## Gotchas

The write API stores `_id` as the **string** id the client generated, not an `ObjectId`. That is
what makes the round trip work: the id a client invents offline survives into Mongo unchanged.

A single write can produce more than one operation in a bucket for the same document. That is the
op log behaving normally, not a duplicate — operations apply in order and the client converges on
the latest.

## Verify it end to end

The automated suite checks the resolved topology, not a live round trip — that is deliberate, since
bringing four flavours up is slow and flaky. This is the manual check it stands in for.

**1. Everything healthy.**

```bash
docker compose ps
```

**2. Get a token and write through the API.**

```bash
TOKEN=$(curl -s "http://localhost:6060/api/auth/token?user_id=demo-user" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:6060/api/data \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"transactions":[{"transaction_id":1,"crud":[{"op":"PUT","table":"todos",
       "id":"11111111-1111-1111-1111-111111111111",
       "op_data":{"description":"smoke test","completed":false,
                  "list_id":"75f89104-d95a-4f16-8309-5363f1bb377a"}}]}]}'
```

Expect `{"results":[{"status":"success"}]}`.

**3. Confirm it reached the database.**

```bash
docker compose exec -T mongo mongosh --quiet --eval \
  'db.getSiblingDB("powersync_demo_source").todos.find({description:"smoke test"}).toArray()'
```

**4. Confirm it syncs back.**

```bash
curl -sN -m 10 -X POST http://localhost:8080/sync/stream \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"buckets":[],"include_checksum":true,"raw_data":true}' | grep "smoke test"
```

This example starts empty, so step 2 is also how you get your first row. The synced document
carries both `id` and `_id`; that is expected.
