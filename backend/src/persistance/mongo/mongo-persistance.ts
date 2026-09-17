import * as mongo from 'mongodb';
import type { Persister, CrudEntry } from '../../types.js';
import { classifyMongoError } from './mongo-errors.js';
import type { EntryMapper } from '../../mapping/types.js';
import { mongoMapper } from '../../mapping/mongo.js';

export const createMongoPersister = async (uri: string, mapper: EntryMapper = mongoMapper): Promise<Persister> => {
  console.debug('Using MongoDB Persister');

  const client = new mongo.MongoClient(uri);
  const db = client.db();
  await client.connect();

  const persister: Persister = {
    updateBatch: async (batch: CrudEntry[]) => {
      // Transactions require a replica set or sharded cluster.
      const session = client.startSession();
      try {
        session.startTransaction();

        for (const op of batch) {
          const mapped = mapper(op);
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
        throw classifyMongoError(e);
      } finally {
        await session.endSession();
      }
    }
  };

  return persister;
};
