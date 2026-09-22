import { applySchema } from '../persistance/mongo/mongo-schema.js';
import type { TableSchema } from '../persistance/mongo/mongo-schema.js';
import type { EntryMapper } from './types.js';

/**
 * Builds an EntryMapper backed by per-collection schemas discovered from MongoDB's own
 * $jsonSchema validators (see mongo-schema.ts's discoverSchema, called once at boot in
 * mongo-persistance.ts).
 *
 * Only called for tables the persister has already confirmed have a discovered schema — a table
 * with none is dead-lettered and the transaction rejected before this mapper ever sees it (see
 * mongo-persistance.ts). The `?? {}` below is a defensive fallback, not the normal path.
 */
export const createMongoMapper = (schema: Record<string, TableSchema>): EntryMapper => {
  return (entry) => {
    const data = entry.op_data ?? {};
    const id = (entry.id ?? data.id) as string;

    if (entry.op === 'DELETE') {
      return { table: entry.table, op: entry.op, id, data: {} };
    }

    const { id: _discardId, ...fields } = data;
    const converted = applySchema(schema[entry.table] ?? {}, fields);
    return { table: entry.table, op: entry.op, id, data: converted };
  };
};
