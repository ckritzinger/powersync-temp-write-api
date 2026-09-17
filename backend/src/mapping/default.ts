import type { EntryMapper } from './types.js';

export const defaultMapper: EntryMapper = (entry) => {
  const data = entry.op_data ?? {};
  const id = (entry.id ?? data.id) as string;

  if (entry.op === 'DELETE') {
    return { table: entry.table, op: entry.op, id, data: {} };
  }

  const { id: _discardId, ...fields } = data;
  return { table: entry.table, op: entry.op, id, data: fields };
};
