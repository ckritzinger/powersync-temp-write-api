# Client-directed fatal decisions — 2026-10-07

Passed against the actual fixture API/Postgres, real PowerSync Web SDK queue, and two clients connected to the dedicated Cloud instance. The explicit `client-directed` generated-backend profile uses an exact-match patch to route only `NOT_NULL_VIOLATION` to client handling. Parent sources are unchanged. The test uses backend batch mode `skip` to verify that client-directed failures still stop later transactions.

The UI records a per-profile notice with error code, row IDs and SDK operation IDs. “Keep queued” preserves the failed transaction. “Discard transaction” persists the user's explicit choice before retrying; the connector's existing completion logic then completes only that rejected transaction. Repeated failures deduplicate the notice. Records contain no tokens, operation values or backend error messages.

| Step | Verified outcome |
| --- | --- |
| Three queued transactions: valid, valid-plus-invalid pair, valid | Four operations; real API response `success`, client-directed `fatal_error`, `not_attempted` |
| Keep queued | First transaction completed; failed pair and later insert remain: three operations |
| Reload and retry | Choice survives; three operations remain; one notice; request contains only failed pair and later insert |
| Inspect source and client B | First insert exists; failed pair and later insert are absent |
| Explicit discard | Failed pair completes; only later insert remains: one operation |
| Reload again | Discard record and one pending operation survive |
| Reconnect | Actual next upload contains only later insert; both clients converge, queues empty, rejected optimistic rows disappear |

The local real-SDK test additionally interrupts the discard upload before a response, reloads with all three operations still queued and the persisted discard request, then retries. Only the failed transaction completes; the later operation remains until its own successful upload. This guards against losing a decision or completing later work after transport failure.

Validation: TypeScript; five local browser checks and the actual API/Postgres browser check; focused live Cloud retain/discard test. The runner restores the original backend profile and normal batch mode, preserves keys and database volume, and deletes only fresh test source rows. Sanitized live receipt: `.local/live-recovery-results/client-directed-decisions.json`.

Repeat from `test-system/` with Node 24, fixture services, tunnels and Cloud available:

```sh
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm run client:test:cloud:decisions
```

This is an isolated test UI. It does not add production authorization, remediation edits, server-side durable dead letters, or cross-device decision storage. Discard does not write compensating deletes; Cloud checkpoint reconciliation supplies source truth.
