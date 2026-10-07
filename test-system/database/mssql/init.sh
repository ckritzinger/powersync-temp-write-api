#!/bin/sh
set -eu
# sqlcmd scripting variables read the fixture's environment. No secrets in argv.
export SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"
exec /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -b -i /fixture/init.sql
