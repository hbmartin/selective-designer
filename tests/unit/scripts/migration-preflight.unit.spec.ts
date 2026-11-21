import { spawnSync } from 'node:child_process';
import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import { expect, it } from 'vitest';
import { pnpmCommand, resolvePnpmCliPath } from '../../../scripts/lib/pnpm.mjs';

it.each([undefined, 'development'])(
  'enforces production TLS from ambient NODE_ENV=%s without connecting',
  (nodeEnv) => {
    const databaseUrl = makeTestDatabaseUrl({ host: 'maintenance.invalid' });
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_DRIVER: 'node-pg',
      DATABASE_MIGRATION_URL: databaseUrl,
      DATABASE_MIGRATION_DRIVER: 'node-pg',
      NODE_ENV: nodeEnv,
    };
    const command = pnpmCommand(resolvePnpmCliPath(), [
      'db:validate-migration-config',
    ]);
    const result = spawnSync(command.file, command.args, {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('authenticated TLS');
    expect(result.stderr).not.toContain(databaseUrl);
  },
  30_000
);
it.each(['maintenance.invalid', '127.0.0.1'])(
  'validates an allowed %s configuration without opening a connection',
  (host) => {
    const databaseUrl = makeTestDatabaseUrl({
      host,
      searchParams:
        host === 'maintenance.invalid' ? { sslmode: 'verify-full' } : {},
    });
    const command = pnpmCommand(resolvePnpmCliPath(), [
      'db:validate-migration-config',
    ]);
    const result = spawnSync(command.file, command.args, {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATABASE_DRIVER: 'node-pg',
        DATABASE_MIGRATION_URL: databaseUrl,
        DATABASE_MIGRATION_DRIVER: 'node-pg',
        NODE_ENV: 'development',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
  },
  30_000
);
