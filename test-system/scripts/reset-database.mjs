import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--confirm-delete-test-database')) {
  throw new Error('This deletes all widgets and replication slots. Run pnpm run db:reset --confirm-delete-test-database to explicitly reset this test database.');
}
const volume = 'powersync-test-system-postgres-data';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const project = execFileSync('docker', ['volume', 'inspect', volume, '--format', '{{index .Labels "com.docker.compose.project"}}'], { encoding: 'utf8' }).trim();
if (project !== 'powersync-test-system') throw new Error('Refusing to remove a volume not owned by this Compose project.');
execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', 'down'], { cwd, stdio: 'inherit' });
execFileSync('docker', ['volume', 'rm', volume], { stdio: 'inherit' });
console.log('Removed only the test-system database volume. Keys, certificates, and credentials remain. Run pnpm run db:up to initialize it again.');
