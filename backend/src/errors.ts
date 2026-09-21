/**
 * The backend is misconfigured and cannot start. Carries a message written for whoever is running
 * it, naming the fix rather than only the fault.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Transient failure (deadlock, timeout, connection error). Client should retry. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type ErrorCode =
  | 'NOT_NULL_VIOLATION'
  | 'UNIQUE_VIOLATION'
  | 'FOREIGN_KEY_VIOLATION'
  | 'CHECK_VIOLATION'
  | 'CONSTRAINT_VIOLATION'
  | 'INVALID_DATA'
  | 'SCHEMA_MISMATCH'
  | 'DOCUMENT_VALIDATION_FAILURE'
  | 'UNAUTHORIZED'
  | 'UNCLASSIFIED_ERROR';

/** Non-recoverable failure (constraint violation, schema mismatch). Client should NOT retry. */
export class FatalOperationError extends Error {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : String(error);
};
