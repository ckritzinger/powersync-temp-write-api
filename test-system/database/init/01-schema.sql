\set ON_ERROR_STOP on
\getenv write_password WRITE_DB_PASSWORD
\getenv replication_password REPLICATION_DB_PASSWORD

CREATE ROLE test_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'write_password';
CREATE ROLE powersync_role LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'replication_password';
REVOKE ALL ON DATABASE test_system FROM PUBLIC;
GRANT CONNECT ON DATABASE test_system TO test_writer, powersync_role;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO test_writer, powersync_role;

CREATE TABLE public.widgets (id uuid PRIMARY KEY, name text NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.widgets TO test_writer;
GRANT SELECT ON public.widgets TO powersync_role;
CREATE PUBLICATION powersync FOR TABLE public.widgets;
