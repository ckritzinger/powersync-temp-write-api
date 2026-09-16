import type { CrudEntry as SDKCrudEntry, CrudTransaction } from '@powersync/web';

export interface CrudTransaction_API {
  crud: CrudEntry_API[];
  transaction_id?: number;
}

export interface CrudEntry_API {
  id: string;
  op: 'PUT' | 'PATCH' | 'DELETE';
  table: string;
  transaction_id?: number;
  op_data?: Record<string, unknown>;
}

/** What the backend should do when a transaction in a batch fails fatally. */
export type OnFatalError = 'stop' | 'skip';

export interface TransactionBatch_API {
  transactions: CrudTransaction_API[];
  /**
   * Required here, though the contract marks it optional with a default of `stop`: openapi-typescript
   * emits a property carrying a `default` as required. This client always sends it explicitly, so the
   * stricter type costs nothing.
   */
  on_fatal_error: OnFatalError;
}

/** `not_attempted` means the batch ended before this transaction was reached. */
export type TransactionStatus = 'success' | 'retryable_error' | 'fatal_error' | 'not_attempted';

export interface FailedOperation_API {
  error_code: string;
  message?: string;
}

export interface TransactionResponse {
  status: TransactionStatus;
  retry_after_ms?: number;
  failed_operation?: FailedOperation_API;
  message?: string;
}

/** One result per transaction sent, in the same order and always the same length as the request. */
export interface TransactionBatchResponse {
  results: TransactionResponse[];
}

export interface WriteAPITransport {
  postTransactionBatch(body: TransactionBatch_API): Promise<TransactionBatchResponse>;
}

export interface TransactionResult {
  status: TransactionStatus;
  message?: string;
  failedOperation?: FailedOperation_API;
}

export interface TransactionBatchResult {
  results: TransactionResult[];
}

export interface WriteAPIClientOptions {
  transport: WriteAPITransport;
  userId: string;
  clientId: string;
}

export interface IWriteAPIClient {
  processTransactionBatch(transactions: CrudTransaction[], onFatalError: OnFatalError): Promise<TransactionBatchResult>;
}

/** Shape one SDK transaction for the wire. */
const toApiTransaction = (transaction: CrudTransaction): CrudTransaction_API => ({
  crud: transaction.crud.map((op: SDKCrudEntry) => ({
    id: op.id,
    op: op.op as 'PUT' | 'PATCH' | 'DELETE',
    table: op.table,
    ...(op.transactionId != null && { transaction_id: op.transactionId }),
    ...(op.opData != null && { op_data: op.opData })
  })),
  ...(transaction.transactionId != null && { transaction_id: transaction.transactionId })
});

const toResult = (response: TransactionResponse): TransactionResult => ({
  status: response.status,
  message: response.message,
  failedOperation: response.failed_operation
});

export class WriteAPIClient implements IWriteAPIClient {
  constructor(private options: WriteAPIClientOptions) {}

  /**
   * Upload a run of whole transactions in one request. The backend applies each in its own database
   * transaction, in the order given, and returns one result per transaction sent. Uploading a single
   * transaction is a batch of one — there is no separate path for it.
   */
  async processTransactionBatch(
    transactions: CrudTransaction[],
    onFatalError: OnFatalError
  ): Promise<TransactionBatchResult> {
    const body: TransactionBatch_API = {
      transactions: transactions.map(toApiTransaction),
      on_fatal_error: onFatalError
    };

    const response = await this.options.transport.postTransactionBatch(body);

    return { results: response.results.map(toResult) };
  }
}
