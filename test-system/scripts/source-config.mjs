export function sourceType(runtime) {
  const type = runtime.DATABASE_TYPE ?? 'postgres';
  if (!['postgres', 'mongodb', 'mysql', 'mssql'].includes(type)) throw new Error('Supported fixture sources are postgres, mongodb, mysql and mssql.');
  return type;
}

export function connectionForSource(source, endpoint, credentials, ca) {
  if (source === 'mongodb') return {
    type: 'mongodb', name: 'test-system-mongodb',
    // Cloud's MongoDB schema has no custom-CA field. Encrypt the disposable fixture
    // connection with TLS; local writer connections validate the fixture CA.
    uri: `mongodb://${endpoint.hostname}:${endpoint.port}/test_system?authSource=test_system&replicaSet=rs0&directConnection=true&tls=true&tlsAllowInvalidCertificates=true`,
    database: 'test_system', username: 'powersync_role', password: { secret: credentials.REPLICATION_DB_PASSWORD }, post_images: 'read_only'
  };
  if (source === 'mssql') return { type: 'mssql', name: 'test-system-mssql', hostname: endpoint.hostname, port: endpoint.port, database: 'test_system', schema: 'dbo', username: 'powersync_role', password: { secret: credentials.REPLICATION_DB_PASSWORD }, additionalConfig: { trustServerCertificate: true, pollingIntervalMs: 500 } };
  if (source === 'mysql') return { type: 'mysql', name: 'test-system-mysql', hostname: endpoint.hostname, port: endpoint.port, database: 'test_system', username: 'powersync_role', password: { secret: credentials.REPLICATION_DB_PASSWORD } };
  if (source !== 'postgres') throw new Error('Unsupported source type.');
  return { type: 'postgresql', name: 'test-system', hostname: endpoint.hostname, port: endpoint.port,
    database: 'test_system', username: 'powersync_role', password: { secret: credentials.REPLICATION_DB_PASSWORD }, sslmode: 'verify-full', cacert: ca };
}
