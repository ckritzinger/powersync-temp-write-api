import { FatalOperationError, RetryableError, messageOf } from '../../errors.js';

const MYSQL_ERRNOS: Record<number, string> = {
  1048: 'NOT_NULL_VIOLATION',
  1062: 'UNIQUE_VIOLATION',
  1452: 'FOREIGN_KEY_VIOLATION',
  3819: 'CHECK_VIOLATION',
  1366: 'INVALID_DATA'
};

export const classifyMySQLError = (error: unknown): Error => {
  const { errno, sqlState } = (error as { errno?: number; sqlState?: string }) ?? {};
  const message = messageOf(error);

  const named = errno != null ? MYSQL_ERRNOS[errno] : undefined;
  if (named) {
    return new FatalOperationError(named, message);
  }

  const state = sqlState ?? '';
  if (state.startsWith('23')) {
    return new FatalOperationError('CONSTRAINT_VIOLATION', message);
  }
  if (state.startsWith('22')) {
    return new FatalOperationError('INVALID_DATA', message);
  }
  if (state.startsWith('42')) {
    return new FatalOperationError('SCHEMA_MISMATCH', message);
  }

  return new RetryableError(message);
};
