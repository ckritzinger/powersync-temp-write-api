import { compose } from './phase-three.mjs';
export function mongoSource(expression) {
  const code = `const admin=db.getSiblingDB('admin'); if(!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD)) throw new Error('Fixture authentication failed'); const source=db.getSiblingDB('test_system'); print(JSON.stringify(${expression}));`;
  return JSON.parse(compose(['exec', '-T', 'mongodb', 'mongosh', '--quiet', '--tls', '--tlsCAFile', '/run/mongo-tls/ca.crt', '--eval', code],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim());
}
