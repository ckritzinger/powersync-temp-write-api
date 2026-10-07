#!/bin/sh
set -eu
mkdir -p /run/mssql-tls /var/opt/mssql
cp /test-tls/server.crt /test-tls/server.key /run/mssql-tls/
chown -R mssql:root /run/mssql-tls /var/opt/mssql
chmod 700 /run/mssql-tls
chmod 600 /run/mssql-tls/server.key
cat > /var/opt/mssql/mssql.conf <<CONF
[network]
tlscert = /run/mssql-tls/server.crt
tlskey = /run/mssql-tls/server.key
forceencryption = 1
[memory]
memorylimitmb = 2048
[sqlagent]
enabled = true
CONF
chown mssql:root /var/opt/mssql/mssql.conf
exec su -s /bin/sh mssql -c /opt/mssql/bin/sqlservr
