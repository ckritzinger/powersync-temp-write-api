# Fatal errors and developer-managed dead letters

Every fatal error defaults to backend handling. Replace the methods on
`fatalErrorHandler` in `backend/src/fatal-error-handler.ts` to choose which errors need
client intervention and deliver backend-directed failures to your own storage or service.
Authorization and all four database adapters use this shared routing after rollback.

```ts
export const fatalErrorHandler: FatalErrorHandler = {
  requiresClientHandling(error, context) {
    // context.transaction is the original uploaded transaction; context.auth is verified.
    return error.errorCode === 'USER_CONFIRMATION_REQUIRED';
  },
  async onDeadLetter(entry) {
    // Replace with your storage or notification integration.
    await developerOwnedStorage.insert(entry);
  }
};
```

Throw an application error from authorization, a mapper, or custom persistence logic:

```ts
throw new FatalOperationError(
  'USER_CONFIRMATION_REQUIRED',
  'Confirm the change before retrying.',
  { record_id: '123' }
);
```

Existing two-argument calls remain valid. Codes can be any application string. `details`
can be any JSON value; the API imposes no application-specific schema. Adapters attach the
zero-based original operation index when a particular operation fails. Transaction-level
failures, including commit failures, have no inferred operation index. Only include details
that the authenticated client should receive.

A `DeadLetterEntry` includes a fresh occurrence ID, ISO timestamp, full original transaction,
verified subject, code, message, optional details and operation index. The whole transaction
is included because none of its writes were accepted. The occurrence ID identifies this
notification attempt, not a stable transaction deduplication key.

Delivery is best effort. The server invokes `onDeadLetter` without awaiting its promise;
synchronous exceptions and rejected promises are logged, and an unresolved promise does not
block the response. A handler doing synchronous work can still delay the event loop. Delivery
may fail or be lost at shutdown. Repeated uploads can produce duplicate notifications. There
is no built-in persistence, delivery retry, replay API, or deduplication. Implement these in
your own service if required. The default handler logs the entry and points to this guide.
If classification throws or returns an invalid decision, the result is retryable and the
batch stops without sending a dead-letter notification.

## Response and queue behavior

Fatal results require `requires_client_handling` at transaction-result level and
`failed_operation` containing `error_code`, optional `message`, `details` and
`operation_index`. Success, retryable and not-attempted results do not carry the routing flag.

| Result | Backend batch | Client queue |
| --- | --- | --- |
| Success | Continue | Complete |
| Fatal, flag false | Honor `stop` / `skip` | Complete |
| Fatal, flag true | Always stop, even with `skip` | Await explicit client decision |
| Retryable | Stop | Retain and retry |
| Not attempted | No execution | Retain |

Both example connectors expose the same hook:

```ts
protected async onFatalTransaction(
  transaction: CrudTransaction,
  result: ClientHandledFatalResult
): Promise<'retain' | 'complete'> {
  if (result.failedOperation.error_code === 'USER_CONFIRMATION_REQUIRED') {
    const details = result.failedOperation.details;
    // Validate your application's details shape, then record/display the pending decision.
    // Deduplicate notifications in your application: this hook can run again on every retry.
    console.info('Confirmation required', details);
  }
  return 'retain';
}
```

The hook runs only for client-directed errors. The default logs and retains. Returning
`'complete'` explicitly releases/discards the failed transaction; it does **not** mean the
source write succeeded. Returning `'retain'`, an invalid value, or throwing keeps it queued
and throws from the upload attempt so PowerSync can retry. A malformed fatal response,
including a missing flag, also retains the transaction.

Only the contiguous accepted prefix is completed, including when a callback fails.
[PowerSync transaction completion also completes earlier transactions from the iterator](https://powersync-ja.github.io/powersync-js/common/interfaces/CommonPowerSyncDatabase#getcrudtransactions),
so a later success must never complete across a retained transaction.

A retained transaction blocks later uploads. A corrective write queued behind it cannot
unblock it by itself. For a replacement workflow, capture the user's intended correction
in application-owned state, get their decision, explicitly release the failed transaction,
and then submit the replacement. Account for crashes between release and replacement in
your application if that intent must survive them. The application owns UI, notification
deduplication, and decisions about release or replacement; returning `'complete'` is an
explicit acknowledgment of data loss for the rejected write.

Deploy the backend and updated connectors together. Older connectors that discard every
fatal error are incompatible with client-directed failures.
