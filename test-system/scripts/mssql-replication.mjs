// A service-config switch can leave the previous Postgres rules (public.widgets) replicating
// against SQL Server; browser tests must not start until Cloud actually streams dbo.widgets.
export function mssqlReplicationReady(status) {
  const rules = status?.active_sync_rules;
  if (!rules || status.deploying_sync_rules) return false;
  const tables = rules.connections?.flatMap(connection => connection.initial_replication_done ? connection.tables ?? [] : []) ?? [];
  const fatal = [...(rules.errors ?? []), ...tables.flatMap(table => table.errors ?? [])].some(error => error.level === 'fatal');
  return !fatal && tables.some(table => table.schema === 'dbo' && table.name === 'widgets');
}
