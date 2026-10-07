import { compose } from './phase-three.mjs';
export function mssqlQuery(sql) {
  return compose(['exec', '-T', 'mssql', 'sh', '-c', 'SQLCMDPASSWORD="$MSSQL_SA_PASSWORD" exec /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -d test_system -b -y 0 -w 65535'],
    { input: `SET NOCOUNT ON;\n${sql}\nGO\n`, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }).trim();
}
function uuid(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Expected fixture UUID'); return `'${id}'`; }
export function mssqlDocument(id) {
  const rows = JSON.parse(mssqlQuery(`SELECT id,name FROM dbo.widgets WHERE id=${uuid(id)} FOR JSON PATH;`) || '[]');
  return rows[0] ?? null;
}
export function mssqlCount(id) { return Number(mssqlQuery(`SELECT COUNT(*) FROM dbo.widgets WHERE id=${uuid(id)};`)); }
export function mssqlDelete(ids) { if (ids.length) mssqlQuery(`DELETE FROM dbo.widgets WHERE id IN (${ids.map(uuid).join(',')});`); }
