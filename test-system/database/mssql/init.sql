IF DB_ID('test_system') IS NULL CREATE DATABASE test_system;
GO
IF SUSER_ID('test_writer') IS NULL CREATE LOGIN test_writer WITH PASSWORD = '$(WRITE_DB_PASSWORD)';
IF SUSER_ID('powersync_role') IS NULL CREATE LOGIN powersync_role WITH PASSWORD = '$(REPLICATION_DB_PASSWORD)';
GRANT VIEW SERVER PERFORMANCE STATE TO powersync_role;
GO
USE test_system;
GO
IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name=DB_NAME() AND is_cdc_enabled=1)
    EXEC sys.sp_cdc_enable_db;
IF OBJECT_ID('dbo.widgets') IS NULL
    CREATE TABLE dbo.widgets (id VARCHAR(36) NOT NULL PRIMARY KEY, name NVARCHAR(255) NOT NULL);
IF OBJECT_ID('dbo._powersync_checkpoints') IS NULL
    CREATE TABLE dbo._powersync_checkpoints (id INT IDENTITY(1,1) PRIMARY KEY, last_updated DATETIME NOT NULL DEFAULT GETDATE());
IF DATABASE_PRINCIPAL_ID('test_writer') IS NULL CREATE USER test_writer FOR LOGIN test_writer;
IF DATABASE_PRINCIPAL_ID('powersync_role') IS NULL CREATE USER powersync_role FOR LOGIN powersync_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.widgets TO test_writer;
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id=OBJECT_ID('dbo.widgets') AND is_tracked_by_cdc=1)
    EXEC sys.sp_cdc_enable_table @source_schema=N'dbo', @source_name=N'widgets', @role_name=N'cdc_reader', @supports_net_changes=0;
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id=OBJECT_ID('dbo._powersync_checkpoints') AND is_tracked_by_cdc=1)
    EXEC sys.sp_cdc_enable_table @source_schema=N'dbo', @source_name=N'_powersync_checkpoints', @role_name=N'cdc_reader', @supports_net_changes=0;
IF IS_ROLEMEMBER('cdc_reader','powersync_role') <> 1 ALTER ROLE cdc_reader ADD MEMBER powersync_role;
GRANT SELECT ON dbo.widgets TO powersync_role;
GRANT SELECT, INSERT, UPDATE ON dbo._powersync_checkpoints TO powersync_role;
GRANT SELECT ON SCHEMA::cdc TO powersync_role;
GRANT VIEW DEFINITION TO powersync_role;
GRANT VIEW DATABASE PERFORMANCE STATE TO powersync_role;
EXEC sys.sp_cdc_change_job @job_type=N'capture', @pollinginterval=1;
GO
