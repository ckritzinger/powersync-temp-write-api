// ============================================================================================
// PowerSync Write API connector — single-file version
// ============================================================================================
//
// Copy this ONE file into your project and it works, with no other files from this repo and no
// extra npm dependencies (beyond `@powersync/web` or `@powersync/react-native`, which you already
// have). If you'd rather adapt a version split across small, well-named files (types, batching,
// transport, config all separated), see `PowersyncConnector.ts` and `library/powersync/` next to
// this file instead — same behaviour, different packaging.
//
// What you get:
//   - PowerSyncBackendConnector implementation: fetchCredentials() + uploadData()
//   - Talks to this repo's write API backend (`backend/`) via plain `fetch` — no `openapi-fetch`,
//     no generated types, no build step required to consume this file
//   - Batches queued CrudTransactions into upload requests, with retry/fatal-error handling
//   - A demo auth default that mints a token from the backend's own `/api/auth/token` endpoint
//
// WHAT YOU MUST EDIT — the SHOUTY_CASE consts directly below. There is no env-var indirection
// here on purpose: a file meant to be pasted into an arbitrary project (Vite, Next, React Native,
// plain Node...) can't assume how *your* bundler exposes environment variables. Point these
// consts at your own values, or wire them up to your own config/env system if you prefer.
//
// AUTH — READ THIS BEFORE SHIPPING:
//   fetchCredentials() below returns a token minted by this backend's demo `GET /api/auth/token`
//   endpoint, reused for write API calls too (one token, both purposes). This is convenient for
//   local development but:
//     1. It will NOT work against a real PowerSync sync connection until your PowerSync
//        instance's custom-auth (JWKS) setting is pointed at this backend's `GET /api/auth/keys`.
//        Until then PowerSync rejects every token this mints and sync never connects — even
//        though uploadData() below keeps working fine, since it talks to the backend directly.
//     2. Once you have a real identity provider, replace fetchCredentials() (and getAuthToken()
//        below) with a mechanism that obtains a token from it — ideally the same token you use to
//        authenticate against your own write API. See:
//          https://docs.powersync.com/configuration/auth/development-tokens
//          https://docs.powersync.com/configuration/app-backend/client-side-integration#backend-connector
//        For guidance wiring up specific real-world providers (Supabase, Auth0, Clerk, Firebase,
//        custom JWT, ...), see this repo's `docs/auth-verifiers.md`.
//
// ============================================================================================

// Requires @powersync/web (or @powersync/react-native) >=1.26.0 — that's the version
// getCrudTransactions() was added in, and uploadTransactionBatch() below depends on it.
import type { AbstractPowerSyncDatabase, CrudEntry, CrudTransaction, PowerSyncBackendConnector } from '@powersync/web';

// ------------------------------------------------------------------------------------------
// CONFIG — edit these for your own project
// ------------------------------------------------------------------------------------------

/** Base URL of your write API, e.g. `http://localhost:6060` in local dev. */
const BACKEND_URL = 'http://localhost:6060';

/** Your PowerSync instance's sync endpoint. */
const POWERSYNC_URL = '';

/** localStorage key used to persist the demo auth's anonymous user id across reloads. */
const USER_ID_STORAGE_KEY = 'ps_user_id';

/** Transactions per upload request. 1 uploads one transaction per attempt (the safest default). */
const MAX_TRANSACTIONS_PER_BATCH = 1;

/** Upper bound on total CRUD operations per upload request, regardless of transaction count. */
const MAX_OPERATIONS_PER_BATCH = 1000;

/**
 * What the backend should do when a transaction in a batch fails fatally.
 * 'stop' (default): the batch ends, everything after the failure is reported not_attempted.
 * 'skip': a backend-directed failure is dropped and the batch continues.
 * Client-directed failures always stop the batch and await an explicit client decision.
 */
const ON_FATAL_ERROR: OnFatalError = 'stop';

/** Abort a write API request that takes longer than this many milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

// ------------------------------------------------------------------------------------------
// The connector — see the supporting types/helpers below the class if you want the wire-level
// detail.
// ------------------------------------------------------------------------------------------

export class PowersyncConnector implements PowerSyncBackendConnector {
  // ===========================================================================================
  // START HERE: uploadData and fetchCredentials are what connect PowerSync to your backend.
  // Both ship with a demo default that already works end-to-end for local development — see
  // each method's own comment for exactly what that means and what to change for production.
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
  // fetch from the same place. See the AUTH note at the top of this file before shipping this.
  async fetchCredentials() {
    return {
      endpoint: POWERSYNC_URL,
      // Most likely you want to replace this with whatever you're already using to get a token
      // from your identity provider, so the sync connection and write API share the same auth.
      token: await this.getAuthToken()
    };
  }

  // ===========================================================================================

  readonly userId: string;
  private _authToken: string | null;

  constructor() {
    // USER ID: crypto.randomUUID() is built into browsers and Node >=14.17, no dependency needed.
    // If you're targeting older React Native, crypto.randomUUID() may not exist there yet —
    // install a polyfill (e.g. `react-native-get-random-values` or `expo-crypto`) or swap this
    // for whatever random-id generator your platform already gives you.
    let userId = localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!userId) {
      userId = crypto.randomUUID();
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    }
    this.userId = userId;
    this._authToken = null;
  }

  private async fetchAuthToken(): Promise<string> {
    const tokenEndpoint = 'api/auth/token';
    const res = await fetch(`${BACKEND_URL}/${tokenEndpoint}?user_id=${this.userId}`);

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
   * The batching config to use for the current upload. Reads the consts at the top of this file;
   * override to make batching dynamic (e.g. shrink batch size after a fatal error, adjust for
   * network conditions).
   */
  protected getBatchingConfig() {
    return {
      maxTransactions: MAX_TRANSACTIONS_PER_BATCH,
      maxOperations: MAX_OPERATIONS_PER_BATCH,
      onFatalError: ON_FATAL_ERROR
    };
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

  /**
   * POST /api/data via plain fetch — no openapi-fetch, no generated client. Every non-2xx response
   * this backend returns (400/401/500) is `{ message }` (see backend/openapi.yaml); 401/403 become
   * an {@link AuthenticationError} so onTransportError can clear the cached token and retry.
   */
  private async postTransactionBatch(body: TransactionBatchAPI): Promise<TransactionBatchResponseAPI> {
    const response = await fetch(`${BACKEND_URL}/api/data`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${await this.getAuthToken()}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const { message } = (await response.json().catch(() => ({ message: response.statusText }))) as MessageResponseAPI;

      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
          `Authentication failed (${response.status}) posting transaction batch: ${message}`
        );
      }
      throw new Error(`Failed to post transaction batch (${response.status}): ${message}`);
    }

    return response.json();
  }

  private async uploadTransactionBatch(
    database: AbstractPowerSyncDatabase,
    batching: ReturnType<PowersyncConnector['getBatchingConfig']>
  ): Promise<void> {
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

    const body: TransactionBatchAPI = {
      transactions: batch.map(toApiTransaction),
      on_fatal_error: batching.onFatalError
    };

    let results: TransactionResult[];
    try {
      const response = await this.postTransactionBatch(body);
      results = response.results.map(toResult);
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

// ------------------------------------------------------------------------------------------
// WIRE TYPES — hand-written to match backend/openapi.yaml. Deliberately not generated: this
// file has no build step. If the contract changes, update these by hand (or regenerate from the
// split version's `generated/api.d.ts` and copy the shapes across).
// ------------------------------------------------------------------------------------------

type CrudOp = 'PUT' | 'PATCH' | 'DELETE';

interface CrudEntryAPI {
  id: string;
  op: CrudOp;
  table: string;
  transaction_id?: number;
  op_data?: Record<string, unknown>;
}

interface CrudTransactionAPI {
  crud: CrudEntryAPI[];
  transaction_id?: number;
}

type OnFatalError = 'stop' | 'skip';

interface TransactionBatchAPI {
  transactions: CrudTransactionAPI[];
  on_fatal_error: OnFatalError;
}

/** `not_attempted` means the batch ended before this transaction was reached. */
type TransactionStatus = 'success' | 'retryable_error' | 'fatal_error' | 'not_attempted';

/** Machine-readable classification of a fatal failure, backend-specific. */
type ErrorCode =
  | 'NOT_NULL_VIOLATION'
  | 'UNIQUE_VIOLATION'
  | 'FOREIGN_KEY_VIOLATION'
  | 'CHECK_VIOLATION'
  | 'CONSTRAINT_VIOLATION'
  | 'INVALID_DATA'
  | 'SCHEMA_MISMATCH'
  | 'DOCUMENT_VALIDATION_FAILURE'
  | 'UNAUTHORIZED'
  | 'UNCLASSIFIED_ERROR'
  | (string & {});

interface FailedOperationAPI {
  error_code: ErrorCode;
  details?: unknown;
  operation_index?: number;
  message?: string;
}

type TransactionResponseAPI =
  | { status: 'success' | 'not_attempted' }
  | { status: 'retryable_error'; message?: string; retry_after_ms?: number }
  | {
      status: 'fatal_error';
      message?: string;
      requires_client_handling: boolean;
      failed_operation: FailedOperationAPI;
    };

/** One result per transaction sent, in the same order and always the same length as the request. */
interface TransactionBatchResponseAPI {
  results: TransactionResponseAPI[];
}

/** `{ message }` — the shape of every non-2xx response this backend returns (400/401/500). */
interface MessageResponseAPI {
  message: string;
}

// ------------------------------------------------------------------------------------------
// Internal (camelCase) result shape passed to the overridable hooks above.
// ------------------------------------------------------------------------------------------

type TransactionResult =
  | { status: 'success' | 'not_attempted' }
  | { status: 'retryable_error'; message?: string; retryAfterMs?: number }
  | {
      status: 'fatal_error';
      message?: string;
      requiresClientHandling: boolean;
      failedOperation: FailedOperationAPI;
    };

type ClientHandledFatalResult = Extract<TransactionResult, { status: 'fatal_error' }> & {
  requiresClientHandling: true;
};

/** Thrown when the backend rejects a request as unauthenticated/unauthorized (401/403). */
class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Complete only the contiguous accepted prefix, even when a callback throws. */
async function completeAcceptedPrefix(
  batch: { complete(): Promise<void> }[],
  results: TransactionResult[],
  onFatal: (index: number, result: ClientHandledFatalResult) => Promise<'retain' | 'complete'>,
  onRetryable: (result: Extract<TransactionResult, { status: 'retryable_error' }>) => Promise<never>
): Promise<void> {
  if (!Array.isArray(results) || results.length !== batch.length) throw new Error('Invalid batch result count');
  let boundary = -1;
  try {
    for (const [index, result] of results.entries()) {
      if (result?.status === 'success') {
        boundary = index;
        continue;
      }
      if (result?.status === 'fatal_error') {
        if (
          typeof result.requiresClientHandling !== 'boolean' ||
          !result.failedOperation ||
          typeof result.failedOperation.error_code !== 'string' ||
          (result.failedOperation.message !== undefined && typeof result.failedOperation.message !== 'string') ||
          (result.failedOperation.operation_index !== undefined &&
            (!Number.isInteger(result.failedOperation.operation_index) || result.failedOperation.operation_index < 0))
        ) {
          throw new Error('Malformed fatal transaction result');
        }
        if (result.requiresClientHandling) {
          const decision = await onFatal(index, {
            ...result,
            requiresClientHandling: true
          });
          if (decision !== 'complete') throw new Error('Fatal transaction retained for client handling');
          boundary = index;
          // Client-directed failures always end the backend batch. Never complete a later result.
          return;
        }
        boundary = index;
        continue;
      }
      if (result?.status === 'retryable_error') {
        // Complete the accepted prefix before invoking backoff/retry hooks.
        if (boundary >= 0) {
          const accepted = boundary;
          boundary = -1;
          await batch[accepted].complete();
        }
        await onRetryable(result);
        throw new Error('Retryable transaction retained');
      }
      if (result?.status === 'not_attempted') return;
      throw new Error('Malformed transaction result');
    }
  } finally {
    if (boundary >= 0) await batch[boundary].complete();
  }
}

/** Shape one SDK transaction for the wire. */
const toApiTransaction = (transaction: CrudTransaction): CrudTransactionAPI => ({
  crud: transaction.crud.map((op: CrudEntry) => ({
    id: op.id,
    op: op.op as CrudOp,
    table: op.table,
    ...(op.transactionId != null && { transaction_id: op.transactionId }),
    ...(op.opData != null && { op_data: op.opData })
  })),
  ...(transaction.transactionId != null && {
    transaction_id: transaction.transactionId
  })
});

const toResult = (response: TransactionResponseAPI): TransactionResult => {
  if (response?.status === 'fatal_error')
    return {
      status: response.status,
      message: response.message,
      requiresClientHandling: response.requires_client_handling,
      failedOperation: response.failed_operation
    };
  if (response?.status === 'retryable_error')
    return {
      status: response.status,
      message: response.message,
      retryAfterMs: response.retry_after_ms
    };
  return response;
};
