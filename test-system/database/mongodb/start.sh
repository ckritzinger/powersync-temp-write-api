#!/bin/sh
set -eu
mkdir -p /run/mongo-tls
cat /test-tls/server.crt /test-tls/server.key > /run/mongo-tls/server.pem
cp /test-tls/ca.crt /run/mongo-tls/ca.crt
cp /test-keyfile /run/mongo-tls/keyfile
chown -R mongodb:mongodb /run/mongo-tls
chmod 700 /run/mongo-tls
chmod 600 /run/mongo-tls/server.pem /run/mongo-tls/keyfile
chmod 644 /run/mongo-tls/ca.crt
exec /usr/local/bin/docker-entrypoint.sh mongod --bind_ip_all --replSet rs0 \
  --keyFile /run/mongo-tls/keyfile --tlsMode requireTLS \
  --tlsCertificateKeyFile /run/mongo-tls/server.pem --tlsCAFile /run/mongo-tls/ca.crt \
  --tlsAllowConnectionsWithoutCertificates
