import type { TransactionResult } from './WriteAPIClient';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The completion boundary: the index of the last transaction the client may complete through, or
 * `-1` if it may complete nothing.
 *
 * `success` is completable, and so is `fatal_error`: the transaction is being discarded, either
 * because the backend skipped it or because this connector discards unrecoverable writes rather than
 * blocking the queue forever. `retryable_error` and `not_attempted` are **not** completable, those
 * transactions were not applied and must stay in the queue for the next attempt.
 */
export const completionBoundary = (results: Pick<TransactionResult, 'status'>[]): number => {
  let boundary = -1;

  for (const [index, result] of results.entries()) {
    if (result.status !== 'success' && result.status !== 'fatal_error') {
      break;
    }
    boundary = index;
  }

  return boundary;
};
