/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL: string;
  readonly VITE_POWERSYNC_URL: string;
  /** Set to a positive integer to upload transaction batches. Unset uploads one transaction at a time. */
  readonly VITE_BATCH_MAX_TRANSACTIONS?: string;
  /** Operation ceiling per batch. Defaults to 1000 when batching is on. */
  readonly VITE_BATCH_MAX_OPERATIONS?: string;
  /** `skip` lets the backend drop a fatally failed transaction and carry on. Defaults to `stop`. */
  readonly VITE_BATCH_ON_FATAL_ERROR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
