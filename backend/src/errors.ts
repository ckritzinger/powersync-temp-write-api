/** Transient failure (deadlock, timeout, connection error). Client should retry. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Non-recoverable failure (constraint violation, schema mismatch). Client should NOT retry. */
export class FatalOperationError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

export const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : String(error);
};
