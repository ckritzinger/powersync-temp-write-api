import createClient from 'openapi-fetch';
import type { paths } from '../../generated/api';
import type { WriteAPITransport } from './WriteAPIClient';

export interface OpenAPIClient {
  transport: WriteAPITransport;
}

export interface OpenAPIClientOptions {
  /** Supplies the bearer token attached to write requests. */
  getToken: () => Promise<string>;
  /** Called when the backend rejects the token. */
  onUnauthorized?: () => void;
}

export function createOpenAPIClient(baseUrl: string, options: OpenAPIClientOptions): OpenAPIClient {
  const client = createClient<paths>({ baseUrl });

  client.use({
    async onRequest({ request }) {
      request.headers.set('Authorization', `Bearer ${await options.getToken()}`);
      return request;
    },
    // Handled here rather than per-method so every write endpoint recovers from a rejected
    // token, including any added later. The header is attached centrally; so is the rejection.
    async onResponse({ response }) {
      if (response.status === 401) {
        options.onUnauthorized?.();
      }
      return response;
    }
  });

  return {
    transport: {
      async postTransactionBatch(body) {
        const { data, error } = await client.POST('/api/data', { body });
        if (error) throw new Error(`Failed to post transactions: ${error.message}`);
        return data;
      }
    }
  };
}
