import { fatalErrorHandler, notifyDeadLetter, type FatalErrorContext } from '../fatal-error-handler.js';
import express, { type Request, type Response } from 'express';
import { getPersister } from '../persistance/persister.js';
import { authorizer } from '../auth/authorizer.js';
import { FatalOperationError, RetryableError } from '../errors.js';
import type { AuthContext } from '../auth/types.js';
import type { OpBody, OpResponse, TransactionResult } from '../types.js';

const router = express.Router();

/**
 * Apply one transaction and classify the outcome.
 */
const applyTransaction = async (
  transaction: FatalErrorContext['transaction'],
  auth: AuthContext
): Promise<TransactionResult> => {
  try {
    const allowed = await authorizer.authorize(transaction.crud, auth);
    if (!allowed) {
      throw new FatalOperationError('UNAUTHORIZED', 'Not authorized to apply this transaction');
    }

    const { updateBatch } = await getPersister();
    await updateBatch(transaction.crud, auth);
    return { status: 'success' };
  } catch (e) {
    if (e instanceof RetryableError) return { status: 'retryable_error', message: e.message };
    const error =
      e instanceof FatalOperationError
        ? e
        : new FatalOperationError('UNCLASSIFIED_ERROR', e instanceof Error ? e.message : String(e));
    const context = { transaction, auth };
    let requiresClientHandling: boolean;
    try {
      requiresClientHandling = await fatalErrorHandler.requiresClientHandling(error, context);
      if (typeof requiresClientHandling !== 'boolean') throw new Error('Invalid fatal error routing decision');
    } catch (failure) {
      console.error('Fatal error classification failed:', failure);
      return { status: 'retryable_error', message: 'Fatal error routing failed; retry the transaction' };
    }
    if (!requiresClientHandling) notifyDeadLetter(error, context);
    return {
      status: 'fatal_error',
      requires_client_handling: requiresClientHandling,
      message: error.message,
      failed_operation: {
        error_code: error.errorCode,
        message: error.message,
        details: error.details,
        operation_index: error.operationIndex
      }
    };
  }
};

/**
 * Handle a TransactionBatch: apply each transaction in its own database transaction, in
 * upload-queue order.
 *
 * This is the only write endpoint. A client uploading a single transaction sends a batch of one —
 * there is no separate single-transaction path, on the wire or in here.
 *
 * Stops at the first failure, unless `on_fatal_error` is `skip`, in which case a fatally failed
 * backend-directed transaction is dropped and the batch continues. Client-directed fatal
 * errors and retryable failures always end the batch.
 *
 * The response holds one result per transaction sent, matched positionally, so the client never has
 * to infer which transactions were applied. Transactions the batch never reached are reported as
 * `not_attempted` rather than omitted.
 */
router.post(
  '/',
  async (
    req: Request<{}, OpResponse<'postTransactionBatch'>, OpBody<'postTransactionBatch'>>,
    res: Response<OpResponse<'postTransactionBatch'>>
  ) => {
    // Verified identity from the token
    console.log(`Write authenticated as ${req.auth?.sub}`);

    // Defaulted here rather than relying on the validator injecting the schema default, so this
    // handler reads correctly on its own.
    const { transactions, on_fatal_error = 'stop' } = req.body;
    const results: TransactionResult[] = [];

    for (const transaction of transactions) {
      const result = await applyTransaction(transaction, req.auth!);
      results.push(result);

      if (result.status === 'success') {
        continue;
      }

      // Skipping covers fatal failures only. A retryable failure ends the batch.
      const skipping = result.status === 'fatal_error' && !result.requires_client_handling && on_fatal_error === 'skip';

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
