import { FatalOperationError, RetryableError, messageOf } from '../../errors.js';

const POSTGRES_CODES: Record<string, string> = {
  '23502': 'NOT_NULL_VIOLATION',
  '23503': 'FOREIGN_KEY_VIOLATION',
  '23505': 'UNIQUE_VIOLATION',
  '23514': 'CHECK_VIOLATION'
};

export const classifyPostgresError = (error: unknown): Error => {
  const code = (error as { code?: string })?.code ?? '';
  const message = messageOf(error);

  const named = POSTGRES_CODES[code];
  if (named) {
    return new FatalOperationError(named, message);
  }
  if (code.startsWith('23')) {
    return new FatalOperationError('CONSTRAINT_VIOLATION', message);
  }
  if (code.startsWith('22')) {
    return new FatalOperationError('INVALID_DATA', message);
  }
  if (code.startsWith('42')) {
    return new FatalOperationError('SCHEMA_MISMATCH', message);
  }

  return new RetryableError(message);
};
