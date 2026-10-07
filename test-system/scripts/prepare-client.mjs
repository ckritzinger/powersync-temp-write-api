import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyPatch } from './prepare-backend.mjs';

const root = new URL('../', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function prepareClient() {
  // Read this one source file only, never parent configuration or environment files.
  const source = new URL('../example-client/src/PowersyncConnector.singlefile.ts', root);
  if (!(await lstat(source)).isFile()) throw new Error('Connector source must be a regular file.');
  const original = await readFile(source, 'utf8');
  const patches = JSON.parse(await readFile(new URL('client/connector-patches.json', root), 'utf8'));
  let prepared = original;
  for (const patch of patches) prepared = applyPatch(prepared, { ...patch, file: 'PowersyncConnector.singlefile.ts' });
  const destination = new URL('.generated/connector/', root);
  await mkdir(destination, { recursive: true });
  await writeFile(new URL('PowersyncConnector.ts', destination), prepared);
  await writeFile(new URL('source-manifest.json', destination), JSON.stringify({
    source: 'example-client/src/PowersyncConnector.singlefile.ts',
    sourceSha256: sha256(original),
    patchesSha256: sha256(JSON.stringify(patches)),
    preparedSha256: sha256(prepared)
  }, null, 2) + '\n');
  console.log(`Prepared existing connector; fingerprint ${sha256(original).slice(0, 12)}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareClient();
