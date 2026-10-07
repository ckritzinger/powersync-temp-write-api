#!/bin/sh
set -eu
mkdir -p /run/mysql-tls
cp /test-tls/server.crt /test-tls/server.key /test-tls/ca.crt /run/mysql-tls/
chown -R mysql:mysql /run/mysql-tls
chmod 700 /run/mysql-tls
chmod 600 /run/mysql-tls/server.key
exec /usr/local/bin/docker-entrypoint.sh mysqld --server-id=77 --log-bin=mysql-bin \
  --event-scheduler=ON --gtid-mode=ON --enforce-gtid-consistency=ON --binlog-format=ROW --binlog-row-image=FULL \
  --binlog-expire-logs-seconds=604800 --ssl-ca=/run/mysql-tls/ca.crt \
  --ssl-cert=/run/mysql-tls/server.crt --ssl-key=/run/mysql-tls/server.key
