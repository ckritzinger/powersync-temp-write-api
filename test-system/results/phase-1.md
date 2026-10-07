# Phase 1 verification

Verified on 2026-10-05 using Docker Desktop and Node.js 24.

- Backend preparation copied 42 selected files, with source fingerprint prefix `c0be16889067` recorded in the generated manifest.
- Docker image built successfully from the prepared sources and frozen backend lockfile; TypeScript checking passed during the build.
- The exact-match verifier patch test passed, including rejection of missing and ambiguous patch targets.
- Setup rerun preserved the signing keys, derived key environment file, runtime settings, and auth configuration byte for byte.
- Parent source files still matched their recorded hashes after preparation and setup rerun.
- Live HTTP smoke checks passed: health, public-only JWKS, persistent key identity, missing/invalid token rejection, and a successful authenticated empty transaction against disposable Postgres.
- A token issued before backend restart successfully authorized a transaction after restart.
- Local secrets and generated sources are ignored by Git.

This verifies local inline-JWKS authentication only. PowerSync Cloud, remote JWKS fetching, tunnels, replication, real application writes, and the browser client are not implemented or verified in Phase 1. The smoke database is disposable and has no host port.
