import { v4 as uuid } from 'uuid';

// Requires @powersync/web (or @powersync/react-native) >=1.26.0 — that's the version
// getCrudTransactions() was added in, and uploadTransactionBatch() below depends on it.
import type { AbstractPowerSyncDatabase, CrudTransaction, PowerSyncBackendConnector } from '@powersync/web';
import {
  WriteAPIClient,
  type TransactionResult,
  type ClientHandledFatalResult
} from './library/powersync/WriteAPIClient';
import { AuthenticationError, createOpenAPIClient, type OpenAPIClient } from './library/powersync/OpenAPITransport';
import {
  DEFAULT_BATCHING_CONFIG,
  readDemoConfig,
  USER_ID_STORAGE_KEY,
  type BatchingConfig,
  type DemoConfig
} from './library/powersync/DemoConnectorConfig';
import { completeAcceptedPrefix, sleep } from './library/powersync/TransactionBatching';

export class PowersyncConnector implements PowerSyncBackendConnector {
  // ===========================================================================================
  // START HERE: uploadData and fetchCredentials are what connect PowerSync to your backend.
  // Both ship with a demo default that already works end-to-end for local development — see
  // each method's own comment for exactly what that means and what to change for production.
  //
  // See the client-side integration guide:
  // https://docs.powersync.com/configuration/app-backend/client-side-integration#backend-connector
  //
  // Everything below this block is a reference implementation, already working — you don't need
  // to touch it, but you can override any of it if you want different behaviour.

  // Called by PowerSync whenever it has local changes to send to your backend.
  // The implementation below already works with this repo's Write API backend.
  // No changes are needed to get started.
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const batching = this.getBatchingConfig();
    return this.uploadTransactionBatch(database, batching);
  }

  // Returns the credentials PowerSync uses for the SYNC (read) connection — a different thing
  // from the write API auth above uploadData uses, even though the demo default below happens to
  // fetch from the same place.
  //
  // THIS DEFAULT WILL NOT WORK OUT OF THE BOX. It mints a token from this backend's own demo
  // /api/auth/token endpoint, which is a validly-shaped PowerSync JWT — but your PowerSync
  // instance only trusts it once its custom-auth (JWKS) setting is pointed at this backend's
  // GET /api/auth/keys. Until you do that, PowerSync rejects every token this returns and sync
  // never connects, even though uploadData() above keeps working fine (it talks to this backend
  // directly, not to PowerSync). See the root README's Configuration section for that step.
  //
  // You've likely already implemented a real version of this while connecting your front-end to
  // PowerSync. Replace the body below with that once you have a real identity provider — see
  // https://docs.powersync.com/configuration/auth/development-tokens in the meantime.
  async fetchCredentials() {
    return {
      endpoint: this.config.powersyncUrl,
      token: await this.getAuthToken()
    };
  }

  // ===========================================================================================

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

    this.config = readDemoConfig();

    this.apiClient = createOpenAPIClient(this.config.backendUrl, {
      timeoutMs: this.config.requestTimeoutMs,
      getAuthToken: () => this.getAuthToken()
    });
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
  protected getBatchingConfig(): BatchingConfig {
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

  /**
   * Called only for client-directed fatal errors. Retaining blocks later uploads and may call
   * this hook again. Return 'complete' to explicitly discard the failed transaction.
   * See docs/error-handling.md for user interaction and notification deduplication guidance.
   */
  protected async onFatalTransaction(
    transaction: CrudTransaction,
    result: ClientHandledFatalResult
  ): Promise<'retain' | 'complete'> {
    console.error('Client handling required:', result.failedOperation.error_code, result.message);
    return 'retain';
  }

  /**
   * Called for a transient, in-band failure (the backend responded with `retryable_error`).
   * Default behaviour waits out the backend's requested `retryAfterMs` (if any) and then throws,
   * which causes PowerSync to retry the upload. Override to add custom logging/backoff, but a
   * retryable error must still result in a thrown error so the transaction stays in the queue.
   */
  protected async onRetryableError(result: Extract<TransactionResult, { status: 'retryable_error' }>): Promise<never> {
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
      ({ results } = await writeClient.processTransactionBatch(batch));
    } catch (error) {
      await this.onTransportError(error);
      return;
    }

    await completeAcceptedPrefix(
      batch,
      results,
      (index, result) => this.onFatalTransaction(batch[index], result),
      (result) => this.onRetryableError(result)
    );
  }
}
