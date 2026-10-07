import { compose } from './phase-three.mjs';
export function mysqlQuery(sql) {
  return compose(['exec', '-T', 'mysql', 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=socket -uroot --batch --raw --skip-column-names test_system'],
    { input: sql + '\n', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }).trim();
}
function uuid(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Expected fixture UUID'); return `'${id}'`; }
export function mysqlDocument(id) {
  const result = mysqlQuery(`SELECT JSON_OBJECT('id',id,'name',name) FROM widgets WHERE id=${uuid(id)};`);
  return result ? JSON.parse(result) : null;
}
export function mysqlCount(id) { return Number(mysqlQuery(`SELECT COUNT(*) FROM widgets WHERE id=${uuid(id)};`)); }
export function mysqlDelete(ids) { if (ids.length) mysqlQuery(`DELETE FROM widgets WHERE id IN (${ids.map(uuid).join(',')});`); }
