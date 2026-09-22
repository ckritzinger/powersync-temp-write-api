import * as mongo from 'mongodb';
import type { Persister, CrudEntry } from '../../types.js';
import { classifyMongoError } from './mongo-errors.js';
import type { EntryMapper } from '../../mapping/types.js';
import { createMongoMapper } from '../../mapping/mongo.js';
import { discoverSchema, type TableSchema } from './mongo-schema.js';
import { deadLetterQueue } from '../../dlq.js';
import { FatalOperationError, RetryableError } from '../../errors.js';
import type { AuthContext } from '../../auth/types.js';

export const createMongoPersister = async (uri: string, mapper?: EntryMapper): Promise<Persister> => {
  console.debug('Using MongoDB Persister');

  const client = new mongo.MongoClient(uri);
  const db = client.db();
  await client.connect();

  // Only discover $jsonSchema validators when no mapper was supplied — an adopter passing their
  // own mapper has already made this call themselves, and owns this decision entirely.
  const schema: Record<string, TableSchema> | null = mapper ? null : await discoverSchema(db);
  const resolvedMapper = mapper ?? createMongoMapper(schema!);

  const persister: Persister = {
    // No native row-level security equivalent for Mongo — auth is unused here. Real per-row
    // authorization means writing it yourself, either in authorize() or in this transaction.
    updateBatch: async (batch: CrudEntry[], _auth: AuthContext) => {
      // Transactions require a replica set or sharded cluster.
      const session = client.startSession();
      try {
        session.startTransaction();

        for (const op of batch) {
          // Strict mode: a table with no discovered $jsonSchema validator has no trustworthy
          // shape to write against — dead-letter the raw entry instead of guessing at it, and
          // reject the whole transaction rather than silently skipping just this op. See
          // docs/schema-mapping.md.
          if (schema && !schema[op.table]) {
            await deadLetterQueue.push({
              table: op.table,
              op: op.op,
              id: op.id,
              reason: `No MongoDB $jsonSchema validator found for collection "${op.table}" at boot.`,
              entry: op
            });
            throw new FatalOperationError(
              'SCHEMA_MISMATCH',
              `No MongoDB schema validator for collection "${op.table}" — entry dead-lettered, transaction rejected.`
            );
          }

          const mapped = resolvedMapper(op);
          if (mapped === null) continue;

          const collection = db.collection(mapped.table);

          if (mapped.op == 'PUT') {
            const doc: Record<string, unknown> = { _id: mapped.id, ...mapped.data };
            await collection.replaceOne({ _id: mapped.id as unknown as mongo.ObjectId }, doc, {
              upsert: true,
              session
            });
          } else if (mapped.op == 'PATCH') {
            await collection.updateOne(
              { _id: mapped.id as unknown as mongo.ObjectId },
              { $set: mapped.data },
              { session }
            );
          } else if (mapped.op == 'DELETE') {
            await collection.deleteOne({ _id: mapped.id as unknown as mongo.ObjectId }, { session });
          }
        }

        await session.commitTransaction();
      } catch (e) {
        // A failing abort must not mask the failure that caused it.
        await session.abortTransaction().catch(() => {});
        // classifyMongoError expects a raw driver error (reads .code/.hasErrorLabel); an error we
        // threw ourselves above has neither, and would otherwise fall through to "no code means
        // retryable" — turning a deliberate, permanent rejection into an infinite retry loop.
        throw e instanceof FatalOperationError || e instanceof RetryableError ? e : classifyMongoError(e);
      } finally {
        await session.endSession();
      }
    }
  };

  return persister;
};
