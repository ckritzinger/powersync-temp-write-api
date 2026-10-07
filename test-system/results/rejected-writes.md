# Rejected writes and reconciliation — 2026-10-06

The test client now records backend-handled fatal transactions in profile-specific browser storage before queue completion. It displays the error code, affected row IDs and timestamp. Upload status explicitly reports rejection. Notices survive reload and deduplicate the same SDK operation IDs; later rejected edits to the same row remain separate notices. Tokens, operation values and backend error messages are not stored.

The observer is an explicit checked fixture patch to the prepared connector. Parent connector sources are unchanged. The existing fatal completion, retry and unattempted retention decisions remain in place. If browser storage fails, the observer throws before completing the rejected transaction, leaving it queued.

Live verification used the baseline backend, actual Postgres and PowerSync Cloud, and two independent Chromium clients. Both a valid-plus-invalid transaction and a single invalid insert returned `NOT_NULL_VIOLATION`, completed their upload queues, and left zero source rows and zero rows in client B. Client A's optimistic rows disappeared after normal sync checkpoints **without requiring another write**. Both notices survived reload. The existing atomic-pair, cross-user edit and committed-response replay checks also passed.

No compensating writes, internal SQLite changes, row hiding or alpha checkpoint mode are used. PowerSync already performs source reconciliation through its write checkpoints; see [Writing Client Changes](https://docs.powersync.com/handling-writes/writing-client-changes). While disconnected, API-only completion does not prove reconciliation. The history is a local diagnostic record, not durable server dead-letter storage or a client-directed remediation UI.

Validation: TypeScript check; four local real-SDK browser checks plus the actual API/Postgres browser check; live fatal/rollback/replay scenario. The local checks also verify that later rejections on the same row produce distinct notices. Sanitized live receipt: `.local/live-recovery-results/fatal-rollback-replay.json`.

Repeat from this directory with Node 24:

```sh
pnpm run client:check
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm exec playwright test --config client/playwright.config.ts --project=local --project=api
PLAYWRIGHT_BROWSERS_PATH=.local/playwright pnpm exec playwright test --config client/playwright-cloud.config.ts --project=cloud-recovery --grep 'live fatal'
```
