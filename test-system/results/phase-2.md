# Phase 2 verification

Verified on 2026-10-05 with PostgreSQL 17.6, Docker Desktop, and Node.js 24.

- The persistent database initialized its widgets table, separate admin/writer/replication roles, and the widgets-only `powersync` publication.
- Logical WAL, ten replication slots, ten WAL senders, and server TLS were enabled.
- Both application roles authenticated over TLS with CA and hostname verification. Invalid passwords and non-TLS replication access were rejected.
- The host-published Postgres endpoint passed certificate chain and localhost hostname validation. An incorrect hostname was rejected.
- The replication role authenticated through the replication protocol and successfully executed `IDENTIFY_SYSTEM`.
- Writer INSERT/UPDATE/DELETE and replication SELECT worked. Replication INSERT and writer schema creation were denied; neither role has superuser or role-creation privileges.
- The replication role created a temporary `pgoutput` slot and decoded a committed widget change through the publication. The slot disappeared at connection close.
- A test row survived full Compose shutdown and container recreation using the named volume.
- Real API PUT/PATCH/DELETE operations succeeded with the restricted writer role and were confirmed directly in Postgres.
- Setup rerun preserved database credentials, JWT keys, auth/runtime configuration, and TLS material byte for byte. Parent backend source hashes remained unchanged.
- Explicit reset removed only the labeled test-system database volume, retained local material, and successfully reinitialized the roles/schema/publication. Database checks passed again after reset.
- The existing verifier patch test passed. Database credentials and private TLS keys are ignored by Git.

Temporary test rows and slots were removed. Containers were stopped after verification; the initialized database volume and local configuration remain available.

The backend uses its fixed Docker-address non-TLS writer exception because the parent adapter has no TLS option. Host/tunnel connections require TLS. PowerSync Cloud, public tunnels, remote JWKS, and actual Cloud replication have not been tested; those remain Phase 3 work. The local server certificate does not yet identify a future public tunnel hostname.
