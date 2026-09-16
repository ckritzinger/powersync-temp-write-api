import { v4 as uuid } from 'uuid';

import type { AbstractPowerSyncDatabase, CrudTransaction, PowerSyncBackendConnector } from '@powersync/web';
import { WriteAPIClient, type OnFatalError, type TransactionResult } from './WriteAPIClient';
import { createOpenAPIClient, type OpenAPIClient } from './OpenAPITransport';

/**
 * Bounds on a transaction batch, plus what the backend should do with a fatally failed transaction.
 */
export type BatchingConfig = {
  maxTransactions: number;
  maxOperations: number;
  onFatalError: OnFatalError;
};

export type DemoConfig = {
  backendUrl: string;
  powersyncUrl: string;
  /** `null` uploads one transaction per attempt, which is the default. */
  batching: BatchingConfig | null;
};

const USER_ID_STORAGE_KEY = 'ps_user_id';

const DEFAULT_MAX_OPERATIONS = 1000;

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

const readBatchingConfig = (): BatchingConfig | null => {
  const maxTransactions = Number(import.meta.env.VITE_BATCH_MAX_TRANSACTIONS ?? '');

  if (!Number.isInteger(maxTransactions) || maxTransactions < 1) {
    return null;
  }

  const maxOperations = Number(import.meta.env.VITE_BATCH_MAX_OPERATIONS ?? '');

  return {
    maxTransactions,
    maxOperations: Number.isInteger(maxOperations) && maxOperations > 0 ? maxOperations : DEFAULT_MAX_OPERATIONS,
    onFatalError: import.meta.env.VITE_BATCH_ON_FATAL_ERROR === 'skip' ? 'skip' : 'stop'
  };
};

export class DemoConnector implements PowerSyncBackendConnector {
  readonly config: DemoConfig;
  readonly userId: string;
  readonly apiClient: OpenAPIClient;

  private _clientId: string | null;
  private _writeClient: WriteAPIClient | null;
  private _writeToken: string | null;

  constructor() {
    let userId = localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!userId) {
      userId = uuid();
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    }
    this.userId = userId;
    this._clientId = null;
    this._writeClient = null;
    this._writeToken = null;

    this.config = {
      backendUrl: import.meta.env.VITE_BACKEND_URL,
      powersyncUrl: import.meta.env.VITE_POWERSYNC_URL,
      batching: readBatchingConfig()
    };

    this.apiClient = createOpenAPIClient(this.config.backendUrl, {
      getToken: () => this.getWriteToken(),
      // Token rejected, drop it so the next write fetches a fresh one.
      onUnauthorized: () => {
        this._writeToken = null;
      }
    });
  }

  async fetchCredentials() {
    const tokenEndpoint = 'api/auth/token';
    const res = await fetch(`${this.config.backendUrl}/${tokenEndpoint}?user_id=${this.userId}`);

    if (!res.ok) {
      throw new Error(`Received ${res.status} from ${tokenEndpoint}: ${await res.text()}`);
    }

    const { token } = await res.json();

    // The write API accepts the same token PowerSync sync uses, cache it so
    // writes reuse it instead of minting their own.
    this._writeToken = token;

    return {
      endpoint: this.config.powersyncUrl,
      token
    };
  }

  private async getWriteToken(): Promise<string> {
    if (!this._writeToken) {
      await this.fetchCredentials();
    }
    return this._writeToken!;
  }

  private async getWriteClient(database: AbstractPowerSyncDatabase): Promise<WriteAPIClient> {
    if (!this._writeClient) {
      this._writeClient = new WriteAPIClient({
        transport: this.apiClient.transport,
        userId: this.userId,
        clientId: this._clientId!
      });
    }
    return this._writeClient;
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    if (this.config.batching) {
      return this.uploadTransactionBatch(database, this.config.batching);
    }

    return this.uploadSingleTransaction(database);
  }

  /**
   * Upload one transaction per attempt. This is the default path and is unchanged by batching.
   */
  private async uploadSingleTransaction(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    this._clientId = await database.getClientId();
    const writeClient = await this.getWriteClient(database);
    const result = await writeClient.processTransaction(transaction);

    switch (result.status) {
      case 'success':
        await transaction.complete();
        break;
      case 'fatal_error':
        // Instead of blocking the queue with these errors,
        // discard the (rest of the) transaction.
        //
        // Note that these errors typically indicate a bug in the application.
        // If protecting against data loss is important, save the failing records
        // elsewhere instead of discarding, and/or notify the user.
        console.error('Fatal error:', result.failedOperation?.error_code, result.message);
        await transaction.complete();
        break;
      case 'retryable_error':
        // Error is retryable - e.g. network error or temporary server error.
        // Throwing an error here causes this call to be retried after a delay.
        throw new Error(result.message ?? 'Retryable error');
      default:
        //`not_attempted` only ever describes an entry in a batch result
        throw new Error(`Unexpected upload status: ${result.status}`);
    }
  }

  private async uploadTransactionBatch(database: AbstractPowerSyncDatabase, batching: BatchingConfig): Promise<void> {
    const batch: CrudTransaction[] = [];
    let operations = 0;

    for await (const transaction of database.getCrudTransactions()) {
      // Take the transaction, then test the bounds. Testing first would either split a transaction
      // that alone exceeds maxOperations, or stall the queue on it forever.
      batch.push(transaction);
      operations += transaction.crud.length;

      if (batch.length >= batching.maxTransactions || operations >= batching.maxOperations) {
        break;
      }
    }

    if (batch.length === 0) return;

    this._clientId = await database.getClientId();
    const writeClient = await this.getWriteClient(database);
    const { results } = await writeClient.processTransactionBatch(batch, batching.onFatalError);

    // Report everything the backend dropped *before* completing over it.
    //
    // These errors typically indicate a bug in the application. If protecting against data loss is
    // important, save the failing records elsewhere instead of discarding, and/or notify the user.
    //
    results.forEach((result, index) => {
      if (result.status === 'fatal_error') {
        console.error(
          `Fatal error on transaction ${index} of ${results.length}:`,
          result.failedOperation?.error_code,
          result.message
        );
      }
    });

    // One completion per batch, at the completion boundary. Completing a transaction also completes
    // every transaction before it, so completing each success in turn would be redundant.
    const boundary = completionBoundary(results);
    if (boundary >= 0) {
      await batch[boundary].complete();
    }

    // Anything from the failure onwards stays in the queue. Completing the applied prefix first means
    // the retry resumes from the failure instead of re-uploading transactions that already committed.
    const retryable = results.find((result) => result.status === 'retryable_error');
    if (retryable) {
      throw new Error(retryable.message ?? 'Retryable error');
    }
  }
}
