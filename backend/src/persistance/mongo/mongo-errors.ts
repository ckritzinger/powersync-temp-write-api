import { FatalOperationError, RetryableError, messageOf } from '../../errors.js';

const MONGO_CODES: Record<number, string> = {
  121: 'DOCUMENT_VALIDATION_FAILURE',
  11000: 'UNIQUE_VIOLATION'
};

export const classifyMongoError = (error: unknown): Error => {
  const mongoError = error as { code?: number; hasErrorLabel?: (label: string) => boolean } | null | undefined;
  const message = messageOf(error);

  if (mongoError?.hasErrorLabel?.('TransientTransactionError')) {
    return new RetryableError(message);
  }

  const code = mongoError?.code;
  const named = code != null ? MONGO_CODES[code] : undefined;
  if (named) {
    return new FatalOperationError(named, message);
  }

  return new RetryableError(message);
};
