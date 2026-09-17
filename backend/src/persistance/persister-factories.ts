import { createMongoPersister } from './mongo/mongo-persistance.js';
import { createMySQLPersister } from './mysql/mysql-persistance.js';
import { createPostgresPersister } from './postgres/postgres-persistance.js';
import { createMSSQLPersister } from './mssql/mssql-persistance.js';
import type { PersisterFactory } from '../types.js';

export const factories: Record<string, PersisterFactory> = {
  mongodb: createMongoPersister,
  postgres: createPostgresPersister,
  mysql: createMySQLPersister,
  mssql: createMSSQLPersister
};
