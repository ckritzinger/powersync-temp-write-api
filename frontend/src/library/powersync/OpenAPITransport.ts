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
    }
  });

  return {
    transport: {
      async postTransaction(body) {
        const { data, error, response } = await client.POST('/api/data', { body });
        if (error) {
          if (response.status === 401) {
            options.onUnauthorized?.();
          }

          throw new Error(`Failed to post transaction: ${error.message}`);
        }
        return data;
      }
    }
  };
}
