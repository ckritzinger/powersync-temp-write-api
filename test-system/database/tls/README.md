# Database TLS

`pnpm run setup` generates a private local CA and a CA-signed Postgres server certificate with OpenSSL. Files live in ignored `.local/tls/`. The server certificate is valid for one year; the CA is valid for ten years. Setup checks the existing server key/certificate pair and certificate validity and preserves them across reruns.

The certificate identifies `postgres`, `localhost`, and `127.0.0.1`. The startup wrapper copies mounted material into PostgreSQL-owned files with a mode 0600 private key. No private TLS key is sent to PowerSync or included in the backend image.

`pnpm run db:verify` checks the published localhost endpoint against the CA and hostname, and authenticates both database roles with `sslmode=verify-full` on the Docker hostname. It also verifies that replication connections without TLS are rejected.

The existing backend Postgres adapter does not configure TLS. Its non-TLS exception is restricted to the backend's fixed Docker IPv4 address and the `test_writer` role. Host/tunnel connections require TLS. Change `DOCKER_SUBNET` and `BACKEND_DB_IP` together in `.local/runtime.env` if the subnet conflicts with another Docker network.

Phase 3 must separately verify the tunnel connection and Cloud certificate settings. The public tunnel hostname will differ from this certificate's SANs. To use `verify-full` through a tunnel, explicitly issue a replacement server certificate with that hostname and restart Postgres, or use a stable endpoint whose hostname can be included. CA validation without hostname checking is a different guarantee. Upload only the public CA certificate where custom CA trust is supported. Record the actual Cloud TLS mode tested; Phase 2 does not claim Cloud verification.

Certificate rotation is explicit: stop this system, preserve/move `.local/tls/`, then run `node scripts/generate-tls.mjs` and restart. That does not reset database rows or JWT signing keys. Add the tunnel hostname before issuing a certificate for hostname verification in Phase 3.

References: [PostgreSQL server TLS](https://www.postgresql.org/docs/17/ssl-tcp.html), [PowerSync database connection](https://docs.powersync.com/configuration/source-db/connection).
