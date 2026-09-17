-- Runs only on the database's FIRST start. Editing it later does nothing until the volume is
-- dropped with `docker compose down -v`.

CREATE TABLE lists (
  id CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL,
  owner_id CHAR(36) NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE todos (
  id CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  description TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_by CHAR(36) NULL,
  completed_by CHAR(36) NULL,
  list_id CHAR(36) NOT NULL,
  photo_id CHAR(36) NULL,
  PRIMARY KEY (id)
);

-- Seed data, so the demo client has something to show on first run.
INSERT INTO lists (id, name, owner_id)
  VALUES ('75f89104-d95a-4f16-8309-5363f1bb377a', 'Getting Started', UUID());
INSERT INTO todos (id, description, list_id, completed)
  VALUES (UUID(), 'Run services locally', '75f89104-d95a-4f16-8309-5363f1bb377a', TRUE);
INSERT INTO todos (id, description, list_id, completed)
  VALUES (UUID(), 'Create a todo here. Query the todos table over a MySQL connection. Your todo should be synced', '75f89104-d95a-4f16-8309-5363f1bb377a', FALSE);

-- The replication user PowerSync connects as. REPLICATION SLAVE is what lets it read the binary
-- log; SELECT is what lets it take the initial snapshot.
CREATE USER 'powersync'@'%' IDENTIFIED BY 'powersyncpw';
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'powersync'@'%';
GRANT SELECT ON powersync_demo.* TO 'powersync'@'%';
FLUSH PRIVILEGES;
