import { validateMigrationConfig } from '@/modules/kernel/backend';

try {
  validateMigrationConfig();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Invalid migration configuration'
  );
  process.exitCode = 1;
}
