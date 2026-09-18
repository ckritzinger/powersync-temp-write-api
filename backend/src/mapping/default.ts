import type { EntryMapper } from './types.js';

/**
 * INSERT YOUR OWN MAPPING CODE HERE.
 *
 * Passes the table name and every field straight through, unrenamed and untyped. That's exactly
 * right for a PowerSync table that already matches your DB schema column-for-column, and wrong
 * the moment it doesn't — a renamed column, a type your driver doesn't coerce for you, a table
 * that needs data split across more than one destination. See docs/schema-mapping.md.
 */
export const defaultMapper: EntryMapper = (entry) => {
  console.error(
    `defaultMapper: passing "${entry.table}" straight through with no renaming, type coercion, or ` +
      `validation. Fine for a table that already matches your schema exactly, wrong otherwise — write ` +
      `your own EntryMapper. See docs/schema-mapping.md.`
  );

  const data = entry.op_data ?? {};
  const id = (entry.id ?? data.id) as string;

  if (entry.op === 'DELETE') {
    return { table: entry.table, op: entry.op, id, data: {} };
  }

  const { id: _discardId, ...fields } = data;
  return { table: entry.table, op: entry.op, id, data: fields };
};
