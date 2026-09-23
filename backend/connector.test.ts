import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('uuid', () => ({ v4: () => 'test-user' }));
vi.mock('../example-client/src/library/powersync/OpenAPITransport', () => ({
  AuthenticationError: class extends Error {},
  createOpenAPIClient: () => ({ transport: {} })
}));
vi.mock('../example-client/src/library/powersync/DemoConnectorConfig', () => ({
  readDemoConfig: () => ({
    backendUrl: '',
    batching: { maxTransactions: 3, maxOperations: 100, onFatalError: 'skip' }
  }),
  USER_ID_STORAGE_KEY: 'user',
  DEFAULT_BATCHING_CONFIG: {}
}));
// Reference clients use their host application's dependencies and module resolution.
const splitPath = '../example-client/src/PowersyncConnector.ts';
const singlePath = '../example-client/src/PowersyncConnector.singlefile.ts';
const { PowersyncConnector: Split } = await import(new URL(splitPath, import.meta.url).href);
const { PowersyncConnector: Single } = await import(new URL(singlePath, import.meta.url).href);

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => 'user' }));

for (const [name, Connector] of [
  ['split', Split],
  ['single', Single]
] as const) {
  describe(`${name} connector queue completion`, () => {
    async function upload(results: unknown[], decision: unknown = 'retain') {
      const connector = new Connector();
      const hook = vi.fn(async () => {
        if (decision instanceof Error) throw decision;
        return decision;
      });
      const batch = [1, 2, 3].map((id) => ({
        crud: [{ id: String(id), table: 'items', op: 'PUT' }],
        complete: vi.fn(async () => {})
      }));
      // Replace only transport/config seams; exercise the actual upload and result handling.
      Object.assign(connector, {
        getBatchingConfig: () => ({ maxTransactions: 3, maxOperations: 100, onFatalError: 'skip' }),
        onFatalTransaction: hook,
        getWriteClient: async () => ({ processTransactionBatch: async () => ({ results }) }),
        postTransactionBatch: async () => ({
          results: results.map((r: any) => ({
            ...r,
            requires_client_handling: r.requiresClientHandling,
            failed_operation: r.failedOperation
          }))
        })
      });
      const database = {
        getClientId: async () => 'client',
        async *getCrudTransactions() {
          yield* batch;
        }
      };
      let error: unknown;
      try {
        await connector.uploadData(database as any);
      } catch (e) {
        error = e;
      }
      return { batch, hook, error };
    }
    const success = { status: 'success' };
    const fatal = {
      status: 'fatal_error',
      requiresClientHandling: true,
      failedOperation: { error_code: 'CUSTOM', details: { record_id: '2' } }
    };
    const suffix = { status: 'not_attempted' };

    it.each(['retain', 'invalid', new Error('callback failed')])(
      'retains with decision %s and completes earlier success',
      async (decision) => {
        const { batch, hook, error } = await upload([success, fatal, suffix], decision);
        expect(error).toBeTruthy();
        expect(hook).toHaveBeenCalledOnce();
        expect(batch[0].complete).toHaveBeenCalledOnce();
        expect(batch[1].complete).not.toHaveBeenCalled();
        expect(batch[2].complete).not.toHaveBeenCalled();
      }
    );
    it('explicitly completes a client-directed failure', async () => {
      const { batch, error } = await upload([success, fatal, suffix], 'complete');
      expect(error).toBeUndefined();
      expect(batch[1].complete).toHaveBeenCalledOnce();
      expect(batch[0].complete).not.toHaveBeenCalled();
      expect(batch[2].complete).not.toHaveBeenCalled();
    });
    it('completes backend-directed failures without a callback', async () => {
      const { batch, hook, error } = await upload([success, { ...fatal, requiresClientHandling: false }, success]);
      expect(error).toBeUndefined();
      expect(hook).not.toHaveBeenCalled();
      expect(batch[2].complete).toHaveBeenCalledOnce();
    });
    it.each([
      { status: 'fatal_error', failedOperation: { error_code: 'CUSTOM' } },
      { status: 'fatal_error', requiresClientHandling: false },
      { ...fatal, requiresClientHandling: 'false' },
      { ...fatal, failedOperation: {} }
    ])('retains malformed fatal results', async (malformed) => {
      const { batch, hook, error } = await upload([success, malformed, success]);
      expect(error).toBeTruthy();
      expect(hook).not.toHaveBeenCalled();
      expect(batch[0].complete).toHaveBeenCalledOnce();
      expect(batch[2].complete).not.toHaveBeenCalled();
    });
    it('retains retryable errors and their suffix', async () => {
      const { batch, error } = await upload([success, { status: 'retryable_error' }, suffix]);
      expect(error).toBeTruthy();
      expect(batch[0].complete).toHaveBeenCalledOnce();
      expect(batch[1].complete).not.toHaveBeenCalled();
    });
  });
}
