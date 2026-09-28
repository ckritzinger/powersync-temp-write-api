import { readFile } from 'node:fs/promises';
import { AuthConfigurationError, createTokenVerifier, resolvePowerSyncAuth } from './verifier/index.js';
import type { AuthSupplements } from './verifier/index.js';
import type { TokenVerifier } from './types.js';

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

async function loadVerifier(): Promise<TokenVerifier> {
  // The default is relative to this module; an override is absolute or relative to process cwd.
  const dumpPath = process.env.POWERSYNC_CONFIG_PATH ?? new URL('../../powersync-config.json', import.meta.url);
  let contents: string;
  try {
    contents = await readFile(dumpPath, 'utf8');
  } catch {
    throw new AuthConfigurationError(
      'Cannot read the PowerSync auth configuration. Export it to backend/powersync-config.json ' +
        'or set POWERSYNC_CONFIG_PATH in .env to a readable JSON file. ' +
        'For Docker, mount the file read-only. See backend/src/auth/SETUP.md.'
    );
  }

  let dump: unknown;
  try {
    dump = JSON.parse(contents);
  } catch {
    throw new AuthConfigurationError(
      'Invalid JSON in the PowerSync auth configuration. Re-export the complete CLI JSON response ' +
        'and check POWERSYNC_CONFIG_PATH in .env. See backend/src/auth/SETUP.md.'
    );
  }

  const result = resolvePowerSyncAuth(dump, supplements);
  if (result.status !== 'ready') {
    // Diagnostics name the offending field; they never echo configuration values.
    throw new AuthConfigurationError(
      'Invalid PowerSync auth configuration. Check POWERSYNC_CONFIG_PATH and the supplements ' +
        'in backend/src/auth/verifier.ts. See backend/src/auth/SETUP.md.\n\n' +
        result.diagnostics.map((d) => `${d.field}: ${d.message}`).join('\n')
    );
  }
  for (const diagnostic of result.diagnostics) console.warn(diagnostic.message);
  return createTokenVerifier(result.config);
}

// Startup awaits this before listening. Cache the promise so concurrent callers share one JWKS
// cache; configuration changes (including failed initialization) require a process restart.
let initialized: Promise<TokenVerifier> | undefined;
export function initializeVerifier(): Promise<TokenVerifier> {
  return (initialized ??= loadVerifier());
}

// Importing the app performs no auth file I/O. Direct users of the app still fail closed if they
// attempt a write without first initializing it through the normal startup entry point.
export const verifier: TokenVerifier = {
  async verify(token) {
    return (await initializeVerifier()).verify(token);
  }
};
