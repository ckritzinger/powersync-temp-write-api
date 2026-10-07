const admin = db.getSiblingDB('admin');
if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) throw new Error('Fixture admin authentication failed');
try { rs.status(); } catch (error) {
  if (error.code !== 94) throw error;
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] });
}
let primary = false;
for (let i = 0; i < 60; i++) {
  if (admin.runCommand({ hello: 1 }).isWritablePrimary) { primary = true; break; }
  sleep(1000);
}
if (!primary) throw new Error('Replica set did not become primary');
const source = db.getSiblingDB('test_system');
const validator = { $jsonSchema: { bsonType: 'object', required: ['_id', 'name'], properties: {
  _id: { bsonType: 'string' }, name: { bsonType: 'string' }
} } };
if (!source.getCollectionNames().includes('widgets')) source.createCollection('widgets', {
  validator, validationLevel: 'strict', validationAction: 'error', changeStreamPreAndPostImages: { enabled: true }
});
else source.runCommand({ collMod: 'widgets', validator, validationLevel: 'strict', validationAction: 'error',
  changeStreamPreAndPostImages: { enabled: true } });
if (!source.getCollectionNames().includes('_powersync_checkpoints')) source.createCollection('_powersync_checkpoints');
const role = 'powersync_replication';
const privileges = [
  { resource: { db: 'test_system', collection: '' }, actions: ['listCollections', 'find', 'changeStream'] },
  { resource: { db: 'test_system', collection: '_powersync_checkpoints' }, actions: ['createCollection', 'dropCollection', 'find', 'changeStream', 'insert', 'update', 'remove'] }
];
if (!source.getRole(role)) source.createRole({ role, privileges, roles: [] });
else source.updateRole(role, { privileges, roles: [] });
for (const user of [
  { user: 'test_writer', pwd: process.env.WRITE_DB_PASSWORD, roles: [{ role: 'readWrite', db: 'test_system' }] },
  { user: 'powersync_role', pwd: process.env.REPLICATION_DB_PASSWORD, roles: [{ role, db: 'test_system' }] }
]) {
  if (!source.getUser(user.user)) source.createUser(user);
  // Existing credentials are preserved; a mismatched env will fail the verification step.
}
print('MongoDB replica set, validator and isolated roles ready.');
