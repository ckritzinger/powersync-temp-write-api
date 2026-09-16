import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Seam: the resolved Compose topology.
 *
 * These guard two mechanisms that fail SILENTLY. If an example's config mount appended to the
 * base's instead of replacing it, or a mode selection failed to resolve, the stack would come up
 * perfectly healthy and point at the wrong sync rules — nothing crashes, nothing logs an error,
 * and the only symptom is data that does not sync.
 *
 * Compose is asked to resolve each mode, not to run it: no containers start and no images are
 * pulled, so this observes the resolved contract rather than the text of the files.
 */

interface Mode {
  name: string;
  composeFile: string;
  projectName: string;
  services: string[];
  /** Repo-relative path expected to be mounted at /config, or null for no example override. */
  configMount: string;
  databaseType?: string;
  /** Substring the write API's and PowerSync's connection strings must both contain. */
  connectionHost?: string;
}

const ADOPTER_ENV = {
  DATABASE_TYPE: 'postgres',
  DATABASE_URI: 'postgres://someone:secret@their-own-host:5432/theirdb'
};

const MODES: Mode[] = [
  {
    name: 'Adopter Mode',
    composeFile: 'docker-compose.yaml',
    projectName: 'write-api',
    services: ['backend', 'mongo', 'mongo-rs-init', 'powersync'],
    configMount: 'config',
    databaseType: 'postgres',
    connectionHost: 'their-own-host'
  },
  {
    name: 'Example Mode: MongoDB',
    composeFile: 'docker-compose.yaml:examples/mongodb/compose.yaml',
    projectName: 'write-api-mongodb',
    // Deliberately no source database service: replication points at a second database on the
    // replica set already running for bucket storage.
    services: ['backend', 'frontend', 'mongo', 'mongo-rs-init', 'powersync'],
    configMount: 'examples/mongodb/powersync',
    databaseType: 'mongodb',
    connectionHost: 'mongo:27017/powersync_demo_source'
  },
  {
    name: 'Example Mode: Postgres',
    composeFile: 'docker-compose.yaml:examples/postgres/compose.yaml',
    projectName: 'write-api-postgres',
    services: ['backend', 'frontend', 'mongo', 'mongo-rs-init', 'pg-db', 'powersync'],
    configMount: 'examples/postgres/powersync',
    databaseType: 'postgres',
    connectionHost: 'pg-db'
  }
];

const resolve = async (composeFile: string) => {
  const { stdout } = await run('docker', ['compose', 'config', '--format', 'json'], {
    cwd: repoRoot,
    env: { ...process.env, ...ADOPTER_ENV, COMPOSE_FILE: composeFile },
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(stdout);
};

const mountedAtConfig = (service: { volumes?: { target: string; source: string }[] }): string[] =>
  (service.volumes ?? [])
    .filter((v) => v.target === '/config')
    .map((v) => path.relative(repoRoot, v.source));

describe.each(MODES)('$name', (mode) => {
  it('resolves to exactly the expected services', async () => {
    const resolved = await resolve(mode.composeFile);

    expect(Object.keys(resolved.services).sort()).toEqual(mode.services);
  });

  it('runs under its own project name, so modes cannot share volumes', async () => {
    const resolved = await resolve(mode.composeFile);

    expect(resolved.name).toBe(mode.projectName);
  });

  it('mounts exactly one config directory, and it is the right one', async () => {
    const resolved = await resolve(mode.composeFile);

    // Exactly one: an overlay that appended rather than replaced would give two, and PowerSync
    // would read whichever Docker happened to layer last.
    expect(mountedAtConfig(resolved.services.powersync)).toEqual([mode.configMount]);
  });

  it('points the write API and replication at the same database', async () => {
    const resolved = await resolve(mode.composeFile);
    const backend = resolved.services.backend.environment;
    const powersync = resolved.services.powersync.environment;

    expect(backend.DATABASE_TYPE).toBe(mode.databaseType);
    expect(backend.DATABASE_URI).toContain(mode.connectionHost);
    expect(powersync.PS_DATA_SOURCE_URI).toContain(mode.connectionHost);
  });

  it('keeps bucket storage in a container this project owns', async () => {
    const resolved = await resolve(mode.composeFile);

    // The fixed rule: bucket storage never points at the adopter's database, whatever mode it is.
    expect(resolved.services.powersync.environment.PS_MONGO_URI).toContain('mongodb://mongo:');
    expect(resolved.services.mongo).toBeDefined();
  });

  it('reaches the backend over the compose network, not the host', async () => {
    const resolved = await resolve(mode.composeFile);

    expect(resolved.services.powersync.environment.PS_JWKS_URL).toBe(
      'http://backend:6060/api/auth/keys'
    );
  });
});

/**
 * The development overlay is a modifier rather than a mode: it may be appended to either mode and
 * must change only how the backend runs. Adding or removing a service here would mean an adopter's
 * dev loop differs from what they deploy.
 */
describe('development overlay', () => {
  const withDev = (composeFile: string) => `${composeFile}:docker-compose.dev.yaml`;

  it.each(MODES)('adds no services and removes none from $name', async (mode) => {
    const plain = await resolve(mode.composeFile);
    const dev = await resolve(withDev(mode.composeFile));

    expect(Object.keys(dev.services).sort()).toEqual(Object.keys(plain.services).sort());
  });

  it.each(MODES)('mounts the working tree into the backend for $name', async (mode) => {
    const dev = await resolve(withDev(mode.composeFile));
    const mounts = (dev.services.backend.volumes ?? []) as { target: string; source?: string }[];

    const workingTree = mounts.find((v) => v.target === '/app');
    expect(workingTree?.source && path.relative(repoRoot, workingTree.source)).toBe('backend');

    // An anonymous volume keeps the image's Linux node_modules. Without it the bind mount above
    // shadows them with the host's, which on macOS are binaries the container cannot run.
    expect(mounts.some((v) => v.target === '/app/node_modules')).toBe(true);
  });

  it.each(MODES)('leaves the config mount untouched for $name', async (mode) => {
    const dev = await resolve(withDev(mode.composeFile));

    expect(mountedAtConfig(dev.services.powersync)).toEqual([mode.configMount]);
  });
});
