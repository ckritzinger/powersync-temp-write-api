# Test system development

- Treat this directory as the development root for the isolated PowerSync Cloud test system. Follow README.md's implementation plan.
- Keep all new or modified repository files inside this directory. Parent backend and connector sources are read-only inputs.
- Never load or copy the parent's environment files, signing keys, Cloud exports, or other local secrets.
- Keep generated backend copies in `.generated/`; apply explicit, checked patches from this directory rather than editing parent sources.
- Keep test-system secrets and local configuration in `.local/`. Never commit private keys, credentials, tokens, or complete Cloud exports.
- Scope Docker resources and cleanup to the `powersync-test-system` project. Preserve unrelated containers, volumes, and existing local changes.
- Preserve signing keys and database data on normal startup/shutdown. Reset operations must be explicit and narrowly scoped.
- Verify each implemented phase with meaningful checks. Distinguish local verification from live PowerSync Cloud verification and report untested paths.
