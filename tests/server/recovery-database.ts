import {
  createMigrationDbClient,
  migrateDatabase,
} from '@/modules/kernel/infrastructure/db/migrate';
import { createPgliteTestDatabase } from './pglite';

/** Only explicitly named disposable loopback databases may be truncated. */
export async function createRecoveryTestDatabase() {
  const databaseUrl = process.env.RECOVERY_TEST_DATABASE_URL;
  if (!databaseUrl) return createPgliteTestDatabase();
  const target = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !target.pathname.startsWith('/selective_designer_recovery_test_') ||
    target.search
  )
    throw new Error(
      'Recovery tests require a direct disposable loopback selective_designer_recovery_test_ database.'
    );
  const migration = await createMigrationDbClient({
    databaseUrl,
    driver: 'node-pg',
  });
  try {
    await migrateDatabase(migration);
  } finally {
    await migration.$close();
  }
  return createPgliteTestDatabase({ databaseUrl });
}
