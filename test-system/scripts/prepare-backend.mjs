import { readFile, writeFile, mkdir, readdir, lstat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (data) => createHash('sha256').update(data).digest('hex');

export function applyPatch(source, patch) {
  if (!patch.before || source.split(patch.before).length !== 2) {
    throw new Error(`Expected exactly one patch match in ${patch.file}; inspect upstream changes.`);
  }
  return source.replace(patch.before, () => patch.after);
}

export function applyRecoveryPatch(source, patch) {
  // A promoted production fix is accepted only when the complete checked replacement
  // appears once and there are no extra copies of its original matching text.
  if (source.split(patch.after).length === 2 &&
      source.split(patch.before).length === patch.after.split(patch.before).length) return source;
  return applyPatch(source, patch);
}

export async function prepareBackend({ profile: requestedProfile } = {}) {
  let profile = requestedProfile;
  if (!profile) {
    try { profile = JSON.parse(await readFile(path.join(root, '.local/backend-profile.json'), 'utf8')).profile; }
    catch (error) { if (error.code !== 'ENOENT') throw error; else profile = 'baseline'; }
  }
  if (!['baseline', 'recovery', 'client-directed'].includes(profile)) throw new Error('Backend profile must be baseline, recovery or client-directed.');
  const source = path.resolve(root, '../backend');
  // Explicit allowlist: never traverse parent environment/configuration artifacts.
  const files = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'index.ts', 'app.ts', 'config.ts', 'powersync-reference-write-api.openapi.yaml'];
  async function walk(relative) {
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Refusing source symlink: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(name);
    }
  }
  await walk('src');
  files.sort();
  const patchNames = ['verifier-supplements.json', 'source-guard.json', 'mysql-recovery.json', 'mssql-recovery.json', ...(profile !== 'baseline' ? ['postgres-recovery.json'] : []), ...(profile === 'client-directed' ? ['client-directed.json'] : [])];
  const patchFiles = await Promise.all(patchNames.map(async name => {
    const bytes = await readFile(path.join(root, 'backend/patches', name));
    return { name, bytes, parsed: JSON.parse(bytes) };
  }));
  const contents = new Map();
  for (const file of files) {
    if (!(await lstat(path.join(source, file))).isFile()) throw new Error(`Not a regular file: ${file}`);
    contents.set(file, await readFile(path.join(source, file)));
  }
  const entries = [...contents].map(([file, content]) => ({ file, sha256: hash(content) }));
  const prepared = new Map(contents);
  for (const { name, parsed } of patchFiles) {
    for (const patch of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!prepared.has(patch.file)) throw new Error(`Patch target is outside prepared source: ${patch.file}`);
      const apply = name === 'postgres-recovery.json' ? applyRecoveryPatch : applyPatch;
      prepared.set(patch.file, Buffer.from(apply(prepared.get(patch.file).toString(), patch)));
    }
  }
  const patches = patchFiles.map(({ name, bytes }) => ({ name, sha256: hash(bytes) }));
  const recoveryPatches = JSON.parse(await readFile(path.join(root, 'backend/patches/postgres-recovery.json'), 'utf8'));
  const upstreamRecovery = recoveryPatches.every(patch => {
    const text = contents.get(patch.file)?.toString() ?? '';
    return text.split(patch.after).length === 2 && text.split(patch.before).length === patch.after.split(patch.before).length;
  });
  const manifest = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
    sourceSha256: hash(JSON.stringify(entries)),
    profile,
    mysqlRecoveryFix: 'test-patch',
    mssqlRecoveryFix: 'test-patch',
    recoveryFix: upstreamRecovery ? 'upstream' : profile !== 'baseline' ? 'test-patch' : 'absent',
    patchSha256: hash(JSON.stringify(patches)),
    patches,
    preparedSha256: hash(JSON.stringify([...prepared].map(([file, bytes]) => ({ file, sha256: hash(bytes) })))),
    files: entries
  };
  const destination = path.join(root, '.generated/backend');
  const staging = path.join(root, '.generated/backend-next');
  await mkdir(staging, { recursive: true });
  // Only these fixed, generated directories are replaced. Never touch parent sources.
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const [file, bytes] of prepared) {
    await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
    await writeFile(path.join(staging, file), bytes);
  }
  await writeFile(path.join(staging, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rm(destination, { recursive: true, force: true });
  await rename(staging, destination);
  if (requestedProfile) {
    await mkdir(path.join(root, '.local'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, '.local/backend-profile.json'), JSON.stringify({ profile }) + '\n', { mode: 0o600 });
  }
  console.log(`Prepared ${files.length} source files; profile ${profile}; fingerprint ${manifest.sourceSha256.slice(0, 12)}.`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--profile')) throw new Error('Usage: prepare-backend.mjs [--profile baseline|recovery|client-directed]');
  await prepareBackend({ profile: args[1] });
}
