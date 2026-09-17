import { applySchema, schema } from '../persistance/mongo/mongo-schema.js';
import type { EntryMapper } from './types.js';

export const mongoMapper: EntryMapper = (entry) => {
  const tableSchema = schema[entry.table];
  if (!tableSchema) return null;

  const data = entry.op_data ?? {};
  const id = (entry.id ?? data.id) as string;

  if (entry.op === 'DELETE') {
    return { table: entry.table, op: entry.op, id, data: {} };
  }

  const { id: _discardId, ...fields } = data;
  const converted = applySchema(tableSchema, fields);
  return { table: entry.table, op: entry.op, id, data: converted };
};
