# Stop a transaction batch at the first failure

A transaction batch applies each transaction in its own database transaction, so a failure
partway through leaves the transactions before it committed. We stop at the first failure of any
kind and report the outcome of every transaction we were sent — applied, failed, or not
attempted — rather than pressing on. A client that would rather drain its upload queue than
preserve a broken write can opt in to the backend skipping a transaction that contains a poison
operation, but that opt-in covers **fatal failures only**: a transient failure ends the batch
whatever the client asked for, because skipping it would discard an operation the next attempt
would have committed.

## Considered options

- **Skip every failure class, not just fatal ones.** Rejected: a momentary database fault would
  permanently discard good writes, and the transactions queued behind it would very likely fail
  the same way, so there is nothing to gain in exchange for the data loss.

- **Report a count of applied transactions instead of one result per transaction.** Rejected on
  two counts. Once transactions can be skipped the applied set is no longer contiguous, so no
  single number can say *which* transactions were dropped. And a count makes the client do index
  arithmetic whose off-by-one failure mode is completing operations the backend never applied —
  silent data loss with no visible symptom. A result per transaction removes the arithmetic
  entirely.

- **Have the client re-upload the survivors rather than the backend skipping.** On a fatal
  failure the client would complete through the poison operation's transaction and send a fresh
  batch starting after it. Rejected: it costs an extra round trip for every poison operation,
  and it puts the same recovery logic in every client SDK instead of once in the backend.

## Consequences

The applied prefix is no longer contiguous once transactions can be skipped, and it is no longer
the same thing as the boundary the client completes through. Both concepts now exist separately
in the glossary.
