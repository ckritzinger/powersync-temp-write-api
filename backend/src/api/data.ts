import express, { type Request, type Response } from 'express';
import config from '../../config.js';
import { factories } from '../persistance/persister-factories.js';
import { FatalOperationError, RetryableError } from '../errors.js';
import type { OpBody, OpResponse } from '../types.js';

const router = express.Router();

const persistenceFactory = factories[config.database.type];
if (!persistenceFactory) {
  throw new Error(`Unsupported database type: ${config.database.type}`);
}
if (!config.database.uri) {
  throw new Error('DATABASE_URI environment variable is required');
}

const { updateBatch } = await persistenceFactory(config.database.uri);

/**
 * Handle a CrudTransaction.
 */
router.post(
  '/',
  async (
    req: Request<{}, OpResponse<'postCrudTransaction'>, OpBody<'postCrudTransaction'>>,
    res: Response<OpResponse<'postCrudTransaction'>>
  ) => {
    try {
      // Verified identity from the token
      console.log(`Write authenticated as ${req.auth?.sub}`);
      await updateBatch(req.body.crud);
      res.status(200).send({ status: 'success', message: 'Transaction completed' });
    } catch (e) {
      if (e instanceof FatalOperationError) {
        res.status(200).send({
          status: 'fatal_error',
          message: e.message,
          failed_operation: { error_code: e.errorCode, message: e.message }
        });
      } else if (e instanceof RetryableError) {
        res.status(200).send({
          status: 'retryable_error',
          message: e.message
        });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(200).send({ status: 'retryable_error', message: msg });
      }
    }
  }
);

export { router as dataRouter };
