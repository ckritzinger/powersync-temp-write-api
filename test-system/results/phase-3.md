# Phase 3 implementation and local verification

Live Phase 3 passed on 2026-10-06 at 11:08:40 UTC using the isolated auth gateway, the current parent backend without demo auth routes, the recovery backend profile, ngrok HTTPS/TCP endpoints, and the dedicated PowerSync Cloud instance.

Verified live: public JWKS without bypass headers; public Postgres certificate hostname and CA verification; replication-role TLS login; invalid-token rejection; provider-issued JWT acceptance; a temporary widget uploaded through the public API and received in a completed Cloud sync checkpoint; actual Cloud export installed. The test widget was deleted. Sanitized receipt: `.local/phase-three-result.json`.

Cloud diagnostics reported the source connected with no errors. The first provisioning command failed after applying service settings; active-config fetch and status checks confirmed those settings. Validation and the subsequent deploy succeeded. The export contains `jwks: { keys: [] }`; installation now accepts that empty list while rejecting actual inline-key fallback.

This milestone does not establish two-browser convergence or offline recovery through Cloud.

The following implementation/local-verification notes describe earlier work.

Implemented:

- Project-specific ngrok configuration and foreground startup of the two named HTTPS/TCP endpoints, with request inspection disabled.
- Endpoint discovery that checks tunnel identity, protocol, and local forwarding ports.
- Dedicated Cloud target configuration, private baseline/export capture, service/stream generation, validation, deployment, diagnostics, and complete export installation.
- Server certificate reissuance for the captured TCP hostname while preserving the private key and trusted CA.
- A live verification command for public JWKS, public Postgres TLS/replication login, invalid-token rejection, and an uploaded widget arriving through a completed Cloud sync checkpoint.

Local verification passed:

- Five tests covering endpoint rejection, fragmented NDJSON and checkpoint completion, certificate issuance/key preservation, Cloud configuration generation and target isolation, and the existing backend verifier patch.
- The ngrok reference configuration validates with the installed ngrok 3.22.1 agent.
- Preflight confirms Node 24, OpenSSL, ngrok, PowerSync CLI 0.9.3, Docker, local configuration, and Compose syntax.
- The actual backend fetched an isolated HTTPS JWKS, trusted its fixture CA, and verified a signed token through a real Postgres transaction. This used no public tunnel or Cloud account.
- A Docker address collision discovered by the added fixture was resolved by reserving the Postgres address as well as backend/fixture addresses.
- Containers were stopped after the check. The persistent database volume and original auth, JWT key, and database TLS files remain available. Parent project files were not modified.

Previously required live inputs/checks (now supplied and verified):

- The dedicated instance URL and instance/project IDs, and organization ID when required.
- An ngrok test authtoken or explicitly selected existing account configuration with public TCP support.
- PowerSync management access via existing CLI login or a project-local PAT.
- Actual tunnel startup, Cloud validation/deployment, complete export installation, replication diagnostics, and `pnpm run cloud:verify` passing against the real Cloud service.

Follow [the Cloud workflow](../powersync/README.md). A passing live check writes a sanitized receipt to ignored `.local/phase-three-result.json`; promote a sanitized summary into this directory after live acceptance.
