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

/**
 * `not_attempted` is only ever returned for an entry in a batch result — the single-transaction
 * endpoint never emits it. It is in the union because both endpoints share one response schema.
 */
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
  postTransaction(body: CrudTransaction_API): Promise<TransactionResponse>;
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
  processTransaction(transaction: CrudTransaction): Promise<TransactionResult>;
  processTransactionBatch(transactions: CrudTransaction[], onFatalError: OnFatalError): Promise<TransactionBatchResult>;
  create(table: string, id: string, data: Record<string, unknown>): Promise<TransactionResult>;
  update(table: string, id: string, data: Record<string, unknown>): Promise<TransactionResult>;
  delete(table: string, id: string): Promise<TransactionResult>;
}

/** Shape one SDK transaction for the wire. Shared by the single-transaction and batch paths. */
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

  async processTransaction(transaction: CrudTransaction): Promise<TransactionResult> {
    const response = await this.options.transport.postTransaction(toApiTransaction(transaction));

    return toResult(response);
  }

  /**
   * Upload a run of whole transactions in one request. The backend applies each in its own database
   * transaction, in the order given, and returns one result per transaction sent.
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

  create(table: string, id: string, data: Record<string, unknown>): Promise<TransactionResult> {
    return this.sendSingle({ op: 'PUT', table, id, op_data: data });
  }

  update(table: string, id: string, data: Record<string, unknown>): Promise<TransactionResult> {
    return this.sendSingle({ op: 'PATCH', table, id, op_data: data });
  }

  delete(table: string, id: string): Promise<TransactionResult> {
    return this.sendSingle({ op: 'DELETE', table, id });
  }

  private async sendSingle(entry: Pick<CrudEntry_API, 'op' | 'table' | 'id' | 'op_data'>): Promise<TransactionResult> {
    const body: CrudTransaction_API = {
      crud: [entry]
    };

    const response = await this.options.transport.postTransaction(body);

    return toResult(response);
  }
}
