import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readEnv, local } from './local-config.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const runtime = await readEnv('runtime.env');
const port = runtime.POSTGRES_PORT ?? '5433';
if (!/^\d+$/.test(port)) throw new Error('Invalid POSTGRES_PORT.');
function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '--env-file', '.local/runtime.env', ...args], { cwd, encoding: 'utf8', ...options });
}
function sql(script) {
  // Passwords remain inside the database container's environment, not command arguments/output.
  try { return compose(['exec', '-T', 'postgres', 'sh', '-s'], { input: 'set -eu\n' + script, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Database verification failed; inspect the test-system database configuration and logs.'); }
}
const id = randomUUID();
const slot = `phase_two_${randomBytes(6).toString('hex')}`;
const admin = `psql -X -v ON_ERROR_STOP=1 -At -U test_admin -d test_system`;
const writer = `PGPASSWORD="$WRITE_DB_PASSWORD" psql -X -v ON_ERROR_STOP=1 -At "host=postgres dbname=test_system user=test_writer sslmode=verify-full sslrootcert=/test-tls/ca.crt"`;
const replica = `PGPASSWORD="$REPLICATION_DB_PASSWORD" psql -X -v ON_ERROR_STOP=1 -At "host=postgres dbname=test_system user=powersync_role sslmode=verify-full sslrootcert=/test-tls/ca.crt"`;

const settings = sql(`${admin} <<'SQL'
SELECT current_setting('wal_level'), current_setting('max_replication_slots')::int >= 10, current_setting('max_wal_senders')::int >= 10, current_setting('ssl');
SELECT pubname, schemaname, tablename FROM pg_publication_tables WHERE pubname='powersync';
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN ('test_writer','powersync_role') ORDER BY rolname;
SELECT has_table_privilege('test_writer','public.widgets','SELECT,INSERT,UPDATE,DELETE'), has_table_privilege('powersync_role','public.widgets','SELECT'), has_table_privilege('powersync_role','public.widgets','INSERT'), has_schema_privilege('test_writer','public','CREATE');
SQL`);
assert.deepEqual(settings.split('\n'), [
  'logical|t|t|on', 'powersync|public|widgets',
  'powersync_role|f|f|f|t|f', 'test_writer|f|f|f|f|f', 't|t|f|f'
]);
console.log('PASS: logical replication settings, publication membership, and limited role grants.');

// Exercise the host-published endpoint with CA and hostname verification, without credentials.
execFileSync('openssl', ['s_client', '-starttls', 'postgres', '-connect', `127.0.0.1:${port}`,
  '-CAfile', fileURLToPath(new URL('tls/ca.crt', local)), '-verify_hostname', 'localhost', '-verify_return_error'],
  { input: '', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
console.log('PASS: host-published Postgres endpoint validates against the test CA and localhost hostname.');
assert.throws(() => execFileSync('openssl', ['s_client', '-starttls', 'postgres', '-connect', `127.0.0.1:${port}`,
  '-CAfile', fileURLToPath(new URL('tls/ca.crt', local)), '-verify_hostname', 'wrong-host.invalid', '-verify_return_error'],
  { input: '', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }));
const protocol = sql(`PGPASSWORD="$REPLICATION_DB_PASSWORD" psql -X -v ON_ERROR_STOP=1 -At "host=postgres dbname=test_system user=powersync_role replication=database sslmode=verify-full sslrootcert=/test-tls/ca.crt" -c 'IDENTIFY_SYSTEM'`);
assert.match(protocol, /^\d+\|\d+\|[A-F0-9]+\/[A-F0-9]+\|test_system$/);
console.log('PASS: incorrect certificate hostname rejected; replication protocol authentication succeeds over verified TLS.');

try {
  const positive = sql(`${writer} <<'SQL'
INSERT INTO public.widgets VALUES ('${id}', 'phase two persistence');
UPDATE public.widgets SET name='phase two verified' WHERE id='${id}';
SELECT name FROM public.widgets WHERE id='${id}';
SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();
SQL`);
  assert.ok(positive.includes('phase two verified\nt'));
  const read = sql(`${replica} -c "SELECT name FROM public.widgets WHERE id='${id}'"`);
  assert.equal(read, 'phase two verified');

  sql(`if ${replica} -c "INSERT INTO public.widgets VALUES ('${randomUUID()}', 'must fail')" >/dev/null 2>&1; then exit 1; fi
if ${writer} -c "CREATE TABLE public.must_not_exist (id int)" >/dev/null 2>&1; then exit 1; fi
if PGPASSWORD="$REPLICATION_DB_PASSWORD" psql -X "host=postgres dbname=test_system user=powersync_role sslmode=disable" -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
if PGPASSWORD="$WRITE_DB_PASSWORD" psql -X "host=postgres dbname=test_system user=test_writer sslmode=disable" -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
if PGPASSWORD=wrong psql -X "host=postgres dbname=test_system user=powersync_role sslmode=verify-full sslrootcert=/test-tls/ca.crt" -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi`);
  console.log('PASS: writer CRUD, replication SELECT, TLS enforcement, invalid password rejection, and denied extra privileges.');

  // Use a real logical slot and pgoutput decoding as the replication role. The temporary
  // slot dies with this connection, and no abandoned permanent slot can retain WAL.
  const decoded = sql(`export PHASE_TWO_ID='${id}'
${replica} <<'SQL'
SELECT slot_name FROM pg_create_logical_replication_slot('${slot}', 'pgoutput', true);
\\! PGPASSWORD="$WRITE_DB_PASSWORD" psql -X -v ON_ERROR_STOP=1 "host=postgres dbname=test_system user=test_writer sslmode=verify-full sslrootcert=/test-tls/ca.crt" -c "UPDATE public.widgets SET name='phase two decoded' WHERE id='$PHASE_TWO_ID'" >/dev/null
SELECT count(*) > 0 FROM pg_logical_slot_get_binary_changes('${slot}', NULL, NULL, 'proto_version', '1', 'publication_names', 'powersync');
SQL`);
  assert.equal(decoded, `${slot}\nt`);
  assert.equal(sql(`${admin} -c "SELECT count(*) FROM pg_replication_slots WHERE slot_name='${slot}'"`), '0');
  console.log('PASS: replication role creates a temporary pgoutput slot and decodes a committed widget change; slot cleaned up.');

  if (process.argv.includes('--recreate')) {
    compose(['down'], { stdio: 'inherit' });
    compose(['up', '-d', '--wait', 'backend'], { stdio: 'inherit' });
    assert.equal(sql(`${replica} -c "SELECT name FROM public.widgets WHERE id='${id}'"`), 'phase two decoded');
    console.log('PASS: widget data persisted across full Compose shutdown and container recreation.');
  }
} finally {
  sql(`${writer} -c "DELETE FROM public.widgets WHERE id='${id}'"`);
}
console.log('Database verification complete; temporary row removed. Cloud/tunnel connectivity remains untested.');
