import { FatalOperationError, RetryableError, messageOf } from '../../errors.js';

const MSSQL_NUMBERS: Record<number, string> = {
  515: 'NOT_NULL_VIOLATION',
  547: 'CONSTRAINT_VIOLATION',
  2601: 'UNIQUE_VIOLATION',
  2627: 'UNIQUE_VIOLATION',
  220: 'INVALID_DATA',
  245: 'INVALID_DATA',
  2628: 'INVALID_DATA',
  8114: 'INVALID_DATA',
  8115: 'INVALID_DATA',
  8152: 'INVALID_DATA',
  207: 'SCHEMA_MISMATCH',
  208: 'SCHEMA_MISMATCH'
};

export const classifyMSSQLError = (error: unknown): Error => {
  const number = (error as { number?: number })?.number;
  const message = messageOf(error);

  const named = number != null ? MSSQL_NUMBERS[number] : undefined;
  if (named) {
    return new FatalOperationError(named, message);
  }

  return new RetryableError(message);
};
