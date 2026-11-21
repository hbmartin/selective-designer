import { makeTestDatabaseUrl } from './test-database-url';

const host = '127.0.0.1';
const port = 54329;
const databaseName = 'postgres';

/** The webserver owns this disposable database; never select an ambient app URL. */
export function resolveE2EDatabase(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl =
    env.E2E_DATABASE_URL?.trim() ||
    makeTestDatabaseUrl({ host, port, databaseName, credentialLabel: 'e2e' });
  let parsed: URL;
  const invalidTarget = () =>
    new Error('E2E database must use the disposable loopback PGlite endpoint');
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw invalidTarget();
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== host ||
    parsed.port !== String(port) ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search ||
    parsed.hash
  ) {
    throw invalidTarget();
  }
  return {
    databaseUrl,
    driver: 'node-pg' as const,
    port,
    environment: {
      E2E_DATABASE_URL: databaseUrl,
      DATABASE_URL: databaseUrl,
      DATABASE_DRIVER: 'node-pg',
      DATABASE_MIGRATION_URL: databaseUrl,
      DATABASE_MIGRATION_DRIVER: 'node-pg',
    },
  };
}

export function configureE2EDatabase(env: NodeJS.ProcessEnv = process.env) {
  const config = resolveE2EDatabase(env);
  Object.assign(env, config.environment);
  return config;
}
