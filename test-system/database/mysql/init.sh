#!/bin/sh
set -eu
# Credentials are fixture-generated hex, validated before startup. Never pass them as CLI arguments.
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS test_system;
CREATE TABLE IF NOT EXISTS test_system.widgets (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL) ENGINE=InnoDB;
-- A later source event makes idle-source managed checkpoints observable.
CREATE TABLE IF NOT EXISTS test_system.powersync_fixture_heartbeat (id INT PRIMARY KEY, seq BIGINT NOT NULL) ENGINE=InnoDB;
INSERT IGNORE INTO test_system.powersync_fixture_heartbeat VALUES (1,0);
CREATE EVENT IF NOT EXISTS test_system.fixture_checkpoint_tick ON SCHEDULE EVERY 2 SECOND
DO UPDATE test_system.powersync_fixture_heartbeat SET seq=seq+1 WHERE id=1;
CREATE USER IF NOT EXISTS 'test_writer'@'%' IDENTIFIED BY '$WRITE_DB_PASSWORD' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON test_system.widgets TO 'test_writer'@'%';
CREATE USER IF NOT EXISTS 'powersync_role'@'%' IDENTIFIED WITH mysql_native_password BY '$REPLICATION_DB_PASSWORD';
GRANT SELECT ON test_system.widgets TO 'powersync_role'@'%';
-- Older binlog readers resolve metadata before filtering unrelated tables.
GRANT SELECT ON test_system.powersync_fixture_heartbeat TO 'powersync_role'@'%';
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'powersync_role'@'%';
SQL
