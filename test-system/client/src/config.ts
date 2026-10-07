export interface ClientConfig {
  backendUrl: string;
  cloudUrl: string;
  userStorageKey: string;
  source: string;
}

// Set before dynamically importing the prepared connector: its constants capture these values.
export const clientConfig: ClientConfig = { backendUrl: '', cloudUrl: '', userStorageKey: '', source: 'postgres' };

export function configureClient(config: ClientConfig) {
  Object.assign(clientConfig, config);
}
