import express, { type Request, type Response } from 'express';
import { getPersister } from '../persistance/persister.js';
import { FatalOperationError, RetryableError } from '../errors.js';
import type { CrudEntry, OpBody, OpResponse, TransactionResult } from '../types.js';

const router = express.Router();

/**
 * Apply one transaction and classify the outcome.
 */
const applyTransaction = async (crud: CrudEntry[]): Promise<TransactionResult> => {
  try {
    const { updateBatch } = await getPersister();
    await updateBatch(crud);
    return { status: 'success' };
  } catch (e) {
    if (e instanceof FatalOperationError) {
      return {
        status: 'fatal_error',
        message: e.message,
        failed_operation: {
          error_code: e.errorCode,
          message: e.message
        }
      };
    } else if (e instanceof RetryableError) {
      return { status: 'retryable_error', message: e.message };
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'retryable_error', message: msg };
    }
  }
};

/**
 * Handle a CrudTransaction.
 */
router.post(
  '/',
  async (
    req: Request<{}, OpResponse<'postCrudTransaction'>, OpBody<'postCrudTransaction'>>,
    res: Response<OpResponse<'postCrudTransaction'>>
  ) => {
    // Verified identity from the token
    console.log(`Write authenticated as ${req.auth?.sub}`);

    const result = await applyTransaction(req.body.crud);

    // The success message is this endpoint's alone — batch results carry a bare status per entry.
    res
      .status(200)
      .send(result.status === 'success' ? { status: 'success', message: 'Transaction completed' } : result);
  }
);

/**
 * Handle a TransactionBatch: apply each transaction in its own database transaction, in
 * upload-queue order.
 *
 * Stops at the first failure, unless `on_fatal_error` is `skip`, in which case a fatally failed
 * transaction is dropped and the batch continues. A retryable failure always ends the batch.
 *
 * The response holds one result per transaction sent, matched positionally, so the client never has
 * to infer which transactions were applied. Transactions the batch never reached are reported as
 * `not_attempted` rather than omitted.
 */
router.post(
  '/batch',
  async (
    req: Request<{}, OpResponse<'postTransactionBatch'>, OpBody<'postTransactionBatch'>>,
    res: Response<OpResponse<'postTransactionBatch'>>
  ) => {
    // Verified identity from the token
    console.log(`Batch write authenticated as ${req.auth?.sub}`);

    // Defaulted here rather than relying on the validator injecting the schema default, so this
    // handler reads correctly on its own.
    const { transactions, on_fatal_error = 'stop' } = req.body;
    const results: TransactionResult[] = [];

    for (const transaction of transactions) {
      const result = await applyTransaction(transaction.crud);
      results.push(result);

      if (result.status === 'success') {
        continue;
      }

      // Skipping covers fatal failures only. A retryable failure ends the batch.
      const skipping = result.status === 'fatal_error' && on_fatal_error === 'skip';

      if (!skipping) {
        break;
      }
    }

    while (results.length < transactions.length) {
      results.push({ status: 'not_attempted' });
    }

    res.status(200).send({ results });
  }
);

export { router as dataRouter };
