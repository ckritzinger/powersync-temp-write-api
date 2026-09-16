import config from '../../config.js';
import { factories } from './persister-factories.js';
import type { Persister } from '../types.js';

let substituted: Persister | null = null;
let fromConfig: Promise<Persister> | null = null;

export const setPersister = (persister: Persister): void => {
  substituted = persister;
};

export const resetPersister = (): void => {
  substituted = null;
};

export const getPersister = async (): Promise<Persister> => {
  if (substituted) {
    return substituted;
  }

  if (!fromConfig) {
    fromConfig = createConfiguredPersister().catch((error: unknown) => {
      // Don't cache a failure, a transient connection problem should not be permanent.
      fromConfig = null;
      throw error;
    });
  }

  return fromConfig;
};

const createConfiguredPersister = async (): Promise<Persister> => {
  const factory = factories[config.database.type];
  if (!factory) {
    throw new Error(`Unsupported database type: ${config.database.type}`);
  }
  if (!config.database.uri) {
    throw new Error('DATABASE_URI environment variable is required');
  }

  return factory(config.database.uri);
};
