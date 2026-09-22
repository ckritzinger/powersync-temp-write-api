import { readFile } from 'node:fs/promises';
import { createTokenVerifier, resolvePowerSyncAuth } from './verifier/index.js';
import type { AuthSupplements } from './verifier/index.js';

// The CLI writes the dump wherever you run `powersync fetch config`; this repo keeps it at the
// backend root. Resolving against this module — not the process cwd — means it is found whether
// the server is started from here, from the repo root or from /app in the container. Point
// POWERSYNC_CONFIG_PATH (relative to cwd, or absolute) somewhere else if you keep it elsewhere.
const dumpPath = process.env.POWERSYNC_CONFIG_PATH ?? new URL('../../powersync-config.json', import.meta.url);
const dump: unknown = JSON.parse(await readFile(dumpPath, 'utf8'));

// Start with no supplements and let the diagnostics tell you what is missing. The common ones:

// | Supplement | When you need it |
// | --- | --- |
// | `issuer` | Any generic (non-Supabase) provider. PowerSync never validates `iss`, so the expected issuer comes from your own trusted settings, not the dump. |
// | `instanceUrl` | Generic Cloud imports: the instance URL is the default audience, and the export does not contain it. |
// | `audience` | Instead of `instanceUrl`, when you want to state the accepted audience list explicitly. Must include the exported `additional_audiences`. |
// | `supabaseUrl` / `provider: 'supabase'` | Supabase behind a custom domain, or when database-based detection is ambiguous. |
// | `jwksUri` | The export has no key endpoint and you know it. It cannot override a different exported URI. |
// | `jwksUriOverride` | The exported endpoint is written from the PowerSync service's network view (e.g. `http://backend:6060/...`) and your backend reaches those keys at a different address. |
// | `allowLocalHttp` / `allowInsecureHttpHosts` | Plain HTTP key endpoints. Loopback, or exactly named hosts — no wildcards. |
// | `algorithms` | Narrower asymmetric allowlist than the RS/PS/ES/EdDSA default. |
const supplements: AuthSupplements = {
  // Hosted Supabase Auth usually needs nothing here. See the table above.
};

const result = resolvePowerSyncAuth(dump, supplements);
if (result.status !== 'ready') {
  // Diagnostics name the offending field; they never echo configuration values.
  throw new Error(result.diagnostics.map((d) => `${d.field}: ${d.message}`).join('\n'));
}
for (const diagnostic of result.diagnostics) console.warn(diagnostic.message);

// One verifier per process — it owns the JWKS cache. Building one per request refetches keys.
export const verifier = createTokenVerifier(result.config);
