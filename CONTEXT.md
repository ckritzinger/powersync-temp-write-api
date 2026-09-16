# Write API

A demo of the PowerSync write path: a client connector uploads local changes to an HTTP backend defined by a shared OpenAPI spec, which persists them to a source database.

## Language

### The upload queue

**Operation**:
A single recorded change to one row — a PUT, PATCH or DELETE against a table, carrying the row id and the changed data. The smallest unit the client can upload.
_Avoid_: change, entry, mutation, CRUD entry

**Transaction**:
The set of operations recorded together while one client-side write transaction was active. Some operations belong to no transaction at all.
_Avoid_: batch, tx, unit of work

**Upload Queue**:
The ordered, append-only sequence of operations awaiting upload, oldest first. Operations leave the queue only by being completed.
_Avoid_: CRUD queue, outbox, pending changes

### Units of upload

**Transaction Batch**:
An ordered run of whole transactions taken from the head of the upload queue. It never splits a transaction. The only unit of upload: a client with one transaction to send uploads a transaction batch of one, not something else.
_Avoid_: multi-transaction batch, transaction group

### Authorising a write

**Write Token**:
The bearer credential a client attaches to every upload, identifying who is writing. This demo reuses the same token the client already holds for sync rather than minting a separate one.
_Avoid_: auth token, credential, JWT

**Verifier**:
What checks a write token and yields the writer behind it. The seam an adopter replaces to accept tokens from their own identity provider instead of the demo's.
_Avoid_: auth provider, validator, middleware

**Writer**:
The identity a write is attributed to once its token has been verified.
_Avoid_: user, caller, principal

### Completing work

**Completion**:
Removing operations from the upload queue once the backend has accepted them. Completion is always a prefix of the queue — everything up to a chosen operation — never an arbitrary subset.
_Avoid_: ack, commit, checkpoint

**Completion Boundary**:
The last transaction in a transaction batch that the client may complete through. Everything up to it leaves the upload queue, including any transaction the backend skipped.
_Avoid_: applied count, high water mark, cursor

**Applied Prefix**:
The operations or transactions in a batch that the backend committed. Contiguous from the head unless transactions were skipped, and smaller than what the client completes through whenever any were.
_Avoid_: partial success, applied count

**Skipped Transaction**:
A transaction the backend deliberately dropped rather than applied, because it contained a poison operation and the batch asked to continue past it. It leaves the upload queue without being applied, rather than blocking it.
_Avoid_: dropped write, discarded transaction

**Poison Operation**:
An operation that fails on every attempt because the fault is in the operation itself, not the environment. It sits at the head of the queue and blocks it until deliberately discarded.
_Avoid_: bad record, dead letter, stuck write

### Out of scope

**Mutator**:
A named server-side procedure invoked with arguments, as an alternative to uploading row-level operations. Referenced here only as a shape to borrow from; the write API demo uploads operations, not mutator calls.
_Avoid_: RPC, command, server function

**Batch**:
A bounded window over the head of the upload queue taken without regard to transaction boundaries, so that one transaction could span several requests. Named only to rule it out: the write API never splits a transaction, and the word batch on its own always means a transaction batch here.
_Avoid_: CRUD batch, chunk, page
