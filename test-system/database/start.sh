#!/bin/sh
set -eu

# Host keys stay private. Copy them into container-owned files with PostgreSQL permissions.
mkdir -p /run/postgres-tls
cp /test-tls/server.crt /run/postgres-tls/server.crt
cp /test-tls/server.key /run/postgres-tls/server.key
cp /test-tls/ca.crt /run/postgres-tls/ca.crt
chown -R postgres:postgres /run/postgres-tls
chmod 700 /run/postgres-tls
chmod 600 /run/postgres-tls/server.key
chmod 644 /run/postgres-tls/server.crt /run/postgres-tls/ca.crt

# The writer adapter currently has no TLS option. Its exception applies only to the
# backend's fixed address, never to the host/tunnel forwarding address.
case "$BACKEND_DB_IP" in
  *[!0-9.]*|'') echo 'BACKEND_DB_IP must be an IPv4 address' >&2; exit 1 ;;
esac
cat > /run/postgres-tls/pg_hba.conf <<EOF
local all test_admin trust
local all all reject
hostnossl test_system test_writer ${BACKEND_DB_IP}/32 scram-sha-256
hostnossl all all 0.0.0.0/0 reject
hostnossl all all ::/0 reject
hostssl test_system powersync_role 0.0.0.0/0 scram-sha-256
hostssl test_system powersync_role ::/0 scram-sha-256
hostssl test_system test_writer 0.0.0.0/0 scram-sha-256
hostssl test_system test_writer ::/0 scram-sha-256
EOF
chown postgres:postgres /run/postgres-tls/pg_hba.conf
chmod 600 /run/postgres-tls/pg_hba.conf
exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10 \
  -c max_slot_wal_keep_size=1GB -c password_encryption=scram-sha-256 \
  -c ssl=on -c ssl_min_protocol_version=TLSv1.2 \
  -c ssl_cert_file=/run/postgres-tls/server.crt \
  -c ssl_key_file=/run/postgres-tls/server.key \
  -c hba_file=/run/postgres-tls/pg_hba.conf
