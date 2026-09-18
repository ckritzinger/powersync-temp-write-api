import { v4 as uuid } from 'uuid';

import type { AbstractPowerSyncDatabase, CrudTransaction, PowerSyncBackendConnector } from '@powersync/web';
import { WriteAPIClient, type OnFatalError, type TransactionResult } from './WriteAPIClient';
import { AuthenticationError, createOpenAPIClient, DEFAULT_REQUEST_TIMEOUT_MS, type OpenAPIClient } from './OpenAPITransport';

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
  /** Abort a write API request that takes longer than this. */
  requestTimeoutMs: number;
};

const USER_ID_STORAGE_KEY = 'ps_user_id';

const DEFAULT_MAX_OPERATIONS = 1000;

const DEFAULT_BATCHING_CONFIG: BatchingConfig = {
  maxTransactions: 1,
  maxOperations: DEFAULT_MAX_OPERATIONS,
  onFatalError: 'skip'
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  private _authToken: string | null;

  constructor() {
    let userId = localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!userId) {
      userId = uuid();
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    }
    this.userId = userId;
    this._clientId = null;
    this._writeClient = null;
    this._authToken = null;

    const requestTimeoutMs = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS ?? '');

    this.config = {
      backendUrl: import.meta.env.VITE_BACKEND_URL,
      powersyncUrl: import.meta.env.VITE_POWERSYNC_URL,
      batching: readBatchingConfig(),
      requestTimeoutMs: Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS
    };

    this.apiClient = createOpenAPIClient(this.config.backendUrl, {
      timeoutMs: this.config.requestTimeoutMs,
      getAuthToken: () => this.getAuthToken()
    });
  }

  async fetchCredentials() {
    // PowerSync calls this on connect and again whenever it decides the sync token needs
    // refreshing, so route through the shared cache: every call here gets a fresh token, and the
    // write API (via getAuthToken) piggybacks on it instead of fetching its own.
    const token = await this.fetchAuthToken();
    this._authToken = token;

    return {
      endpoint: this.config.powersyncUrl,
      token
    };
  }

  private async fetchAuthToken(): Promise<string> {
    const tokenEndpoint = 'api/auth/token';
    const res = await fetch(`${this.config.backendUrl}/${tokenEndpoint}?user_id=${this.userId}`);

    if (!res.ok) {
      throw new Error(`Received ${res.status} from ${tokenEndpoint}: ${await res.text()}`);
    }

    const { token } = await res.json();
    return token;
  }

  /**
   * The bearer token for write API requests. Reuses whatever fetchCredentials last fetched for the
   * sync connection; fetches its own if nothing has been cached yet (e.g. before the first
   * connect), or after {@link onTransportError} invalidated a rejected token.
   */
  private async getAuthToken(): Promise<string> {
    if (!this._authToken) {
      this._authToken = await this.fetchAuthToken();
    }
    return this._authToken;
  }

  /**
   * The batching config to use for the current upload. Reads the env-derived default; override to
   * make batching dynamic (e.g. shrink batch size after a fatal error, adjust for network conditions).
   */
  protected getBatchingConfig(): BatchingConfig  {
    return this.config.batching || DEFAULT_BATCHING_CONFIG;
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
    const batching = this.getBatchingConfig();
    return this.uploadTransactionBatch(database, batching);
  }


  /**
   * Called when the backend permanently rejects a transaction (a bug in the application, not a
   * transient failure). The transaction is discarded and the queue moves on regardless of what
   * this method does.
   *
   * Default behaviour is to log and drop the data. Dead-lettering should happen server-side, where
   * the failed write can actually be inspected and fixed — a client-side dead-letter queue is opaque
   * to that process. Override to alert someone or forward `result` to a backend endpoint, not to
   * store it locally.
   */
  protected async onFatalTransaction(transaction: CrudTransaction, result: TransactionResult): Promise<void> {
    console.error('Fatal error:', result.failedOperation?.error_code, result.message);
  }

  /**
   * Called for a transient, in-band failure (the backend responded with `retryable_error`).
   * Default behaviour waits out the backend's requested `retryAfterMs` (if any) and then throws,
   * which causes PowerSync to retry the upload. Override to add custom logging/backoff, but a
   * retryable error must still result in a thrown error so the transaction stays in the queue.
   */
  protected async onRetryableError(result: TransactionResult): Promise<never> {
    await sleep(result.retryAfterMs ?? 0);
    throw new Error(result.message ?? 'Retryable error');
  }

  /**
   * Called for a transport-level failure (network error, timeout, non-2xx response) — the backend
   * was never reached or never returned a classified result at all. Default behaviour routes it
   * through {@link onRetryableError} so both failure kinds share one override point and the
   * transaction stays in the queue for retry. Override to distinguish transport failures from
   * in-band retryable errors.
   *
   * A rejected/expired token ({@link AuthenticationError}) is handled here too: the cached token is
   * dropped so the next attempt's {@link getAuthToken} call fetches a fresh one before retrying.
   */
  protected async onTransportError(error: unknown): Promise<never> {
    if (error instanceof AuthenticationError) {
      this._authToken = null;
    }

    const message = error instanceof Error ? error.message : String(error);
    return this.onRetryableError({ status: 'retryable_error', message });
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

    let results: TransactionResult[];
    try {
      ({ results } = await writeClient.processTransactionBatch(batch, batching.onFatalError));
    } catch (error) {
      await this.onTransportError(error);
      return;
    }

    // Report everything the backend dropped *before* completing over it, via the same
    // overridable hook the single-transaction path uses.
    for (const [index, result] of results.entries()) {
      if (result.status === 'fatal_error') {
        await this.onFatalTransaction(batch[index], result);
      }
    }

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
      await this.onRetryableError(retryable);
    }
  }
}
