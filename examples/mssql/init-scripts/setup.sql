-- Safe to run more than once: the setup container may retry while SQL Server finishes starting.
--
-- SQL Server replicates through Change Data Capture rather than log streaming, so this does more
-- than create tables. CDC must be enabled at database level, then per table, and PowerSync needs
-- its own checkpoints table with CDC enabled on it too.

IF DB_ID('powersync_demo') IS NULL
  EXEC('CREATE DATABASE powersync_demo');
GO

USE powersync_demo;
GO

-- CDC at database level. Everything below depends on this.
IF (SELECT is_cdc_enabled FROM sys.databases WHERE name = 'powersync_demo') = 0
  EXEC sys.sp_cdc_enable_db;
GO

-- PowerSync's own checkpoints table. Not your data — it is how the connector tracks position.
IF OBJECT_ID('dbo._powersync_checkpoints', 'U') IS NULL
  CREATE TABLE dbo._powersync_checkpoints (
    id INT IDENTITY PRIMARY KEY,
    last_updated DATETIME NOT NULL DEFAULT GETUTCDATE()
  );
GO

IF OBJECT_ID('dbo.lists', 'U') IS NULL
  CREATE TABLE dbo.lists (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    name NVARCHAR(MAX) NOT NULL,
    owner_id UNIQUEIDENTIFIER NOT NULL
  );
GO

IF OBJECT_ID('dbo.todos', 'U') IS NULL
  CREATE TABLE dbo.todos (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    completed_at DATETIME2 NULL,
    description NVARCHAR(MAX) NOT NULL,
    completed BIT NOT NULL DEFAULT 0,
    created_by UNIQUEIDENTIFIER NULL,
    completed_by UNIQUEIDENTIFIER NULL,
    list_id UNIQUEIDENTIFIER NOT NULL,
    photo_id UNIQUEIDENTIFIER NULL
  );
GO

-- Seed data, so the demo client has something to show on first run.
IF NOT EXISTS (SELECT 1 FROM dbo.lists WHERE id = '75F89104-D95A-4F16-8309-5363F1BB377A')
BEGIN
  INSERT INTO dbo.lists (id, name, owner_id)
    VALUES ('75F89104-D95A-4F16-8309-5363F1BB377A', 'Getting Started', NEWID());
  INSERT INTO dbo.todos (id, description, list_id, completed)
    VALUES (NEWID(), 'Run services locally', '75F89104-D95A-4F16-8309-5363F1BB377A', 1);
  INSERT INTO dbo.todos (id, description, list_id, completed)
    VALUES (NEWID(), 'Create a todo here. Query the todos table over a SQL Server connection. Your todo should be synced', '75F89104-D95A-4F16-8309-5363F1BB377A', 0);
END
GO

-- CDC per table. @role_name creates the cdc_reader role if it does not exist.
-- NOTE: this captures the table's shape AS IT IS NOW. Alter a table later and replication does not
-- adopt the change on its own — see this example's README.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = '_powersync_checkpoints' AND is_tracked_by_cdc = 1)
  EXEC sys.sp_cdc_enable_table @source_schema = N'dbo', @source_name = N'_powersync_checkpoints',
                               @role_name = N'cdc_reader', @supports_net_changes = 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'lists' AND is_tracked_by_cdc = 1)
  EXEC sys.sp_cdc_enable_table @source_schema = N'dbo', @source_name = N'lists',
                               @role_name = N'cdc_reader', @supports_net_changes = 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'todos' AND is_tracked_by_cdc = 1)
  EXEC sys.sp_cdc_enable_table @source_schema = N'dbo', @source_name = N'todos',
                               @role_name = N'cdc_reader', @supports_net_changes = 0;
GO

-- The restricted user PowerSync replicates as. The write API connects as sa in this example.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'powersync_user')
  CREATE LOGIN [powersync_user] WITH PASSWORD = 'Powersync_demo_pw1', CHECK_POLICY = ON;
GO
-- VIEW SERVER PERFORMANCE STATE is a SERVER-level permission and must be granted in master to
-- the login, not in the user database. Granting only the database-level equivalent leaves
-- replication failing with "The user does not have permission to perform this action."
USE master;
GO
GRANT VIEW SERVER PERFORMANCE STATE TO [powersync_user];
GO

USE powersync_demo;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'powersync_user')
  CREATE USER [powersync_user] FOR LOGIN [powersync_user];
GO

GRANT SELECT ON dbo.lists TO [powersync_user];
GRANT SELECT ON dbo.todos TO [powersync_user];
GRANT SELECT, INSERT, UPDATE ON dbo._powersync_checkpoints TO [powersync_user];
GRANT SELECT ON SCHEMA::cdc TO [powersync_user];
GRANT VIEW DATABASE PERFORMANCE STATE TO [powersync_user];
ALTER ROLE cdc_reader ADD MEMBER powersync_user;
GO
