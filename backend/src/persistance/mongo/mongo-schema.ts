import type { Db } from 'mongodb';

export type TypeConverter = (v: unknown) => unknown;

export type TableSchema = Record<string, TypeConverter>;

export const types: Record<string, TypeConverter> = {
  date: (v) => new Date(v as string | number),
  boolean: (v) => !!v,
  string: (v) => String(v),
  number: (v) => Number(v)
};

const BSON_TYPE_CONVERTERS: Record<string, TypeConverter> = {
  date: types.date,
  bool: types.boolean,
  boolean: types.boolean,
  string: types.string,
  int: types.number,
  long: types.number,
  double: types.number,
  decimal: types.number,
  number: types.number
};

/**
 * Derives a TableSchema from a $jsonSchema validator's `properties`. A field whose bsonType we
 * don't recognize (object, array, objectId, binData, ...) is left out of the result — applySchema
 * treats a missing entry as "pass this field through unconverted", not "drop it".
 */
function tableSchemaFromJsonSchema(jsonSchema: Record<string, unknown>): TableSchema {
  const properties = (jsonSchema.properties ?? {}) as Record<string, { bsonType?: string | string[] }>;
  const schema: TableSchema = {};

  for (const [field, def] of Object.entries(properties)) {
    const bsonType = Array.isArray(def?.bsonType) ? def.bsonType.find((t) => t !== 'null') : def?.bsonType;
    const converter = bsonType ? BSON_TYPE_CONVERTERS[bsonType] : undefined;
    if (converter) {
      schema[field] = converter;
    }
  }

  return schema;
}

/**
 * Discovers per-collection type coercion from MongoDB's own schema validation ($jsonSchema),
 * instead of a hand-maintained static map. Only collections with a real $jsonSchema validator get
 * an entry — a collection with none configured, or that doesn't exist yet, is absent from the
 * result. That absence is load-bearing: the caller (mongo-persistance.ts) treats "no entry" as
 * "no trustworthy shape to write against" and dead-letters the write instead of guessing at it.
 *
 * Captured once at boot, closed over for the life of the process. A validator added or changed on
 * a running server isn't picked up until restart — the same staleness tradeoff a hand-edited
 * static schema file would have had.
 */
export async function discoverSchema(db: Db): Promise<Record<string, TableSchema>> {
  const schema: Record<string, TableSchema> = {};
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();

  for (const info of collections) {
    const jsonSchema = (info.options as { validator?: { $jsonSchema?: Record<string, unknown> } } | undefined)
      ?.validator?.$jsonSchema;
    if (jsonSchema) {
      schema[info.name] = tableSchemaFromJsonSchema(jsonSchema);
    }
  }

  return schema;
}

/**
 * Applies a table's type coercion to the fields present in `data`. A field with a converter in
 * `tableSchema` is coerced; a field with none — because the table has no schema at all, or its
 * validator didn't name this field, or named it with an unrecognized bsonType — passes through
 * unchanged rather than being dropped.
 *
 * A production application should probably also use MongoDB Schema Validation itself to enforce
 * these types in the database, not only coerce them on the way in.
 */
export function applySchema(tableSchema: TableSchema, data: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(data)) {
    if (rawValue == null) {
      converted[key] = rawValue;
      continue;
    }
    const converter = tableSchema[key];
    converted[key] = converter ? converter(rawValue) : rawValue;
  }

  return converted;
}
