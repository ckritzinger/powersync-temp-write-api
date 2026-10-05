import type { CrudEntry } from './types.js';

/** A CrudEntry the backend refused to apply, kept for later inspection/replay. */
export interface DeadLetter {
  table: string;
  op: CrudEntry['op'];
  id: string;
  /** Why this entry couldn't be applied. */
  reason: string;
  /** The entry as the client sent it. */
  entry: CrudEntry;
}

export interface DeadLetterQueue {
  push(letter: DeadLetter): Promise<void>;
}

/**
 * INSERT YOUR OWN DEAD-LETTER SINK HERE.
 *
 * This default only logs — nothing is durably stored, so a restart loses every entry that
 * was "queued." Replace this with a real sink (a table in your own database, an SQS queue,
 * a Kafka topic, ...) before relying on it to actually hold anything.
 */
export const deadLetterQueue: DeadLetterQueue = {
  async push(letter) {
    console.error(
      `DEAD LETTER (not durably stored — no sink configured, see backend/src/dlq.ts): ` +
        `${letter.reason} [table=${letter.table} op=${letter.op} id=${letter.id}]`
    );
  }
};
