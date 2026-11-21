import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import {
  pinnedTestPnpmEnvironment,
  resolvePinnedTestPnpm,
} from '@tests/support/pinned-test-pnpm';
import { expect, it } from 'vitest';
import { pnpmCommand } from '../../../scripts/lib/pnpm.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
) as { packageManager: string };
const executable = resolvePinnedTestPnpm(manifest.packageManager);

for (const npmExecPath of [undefined, '/unrelated/npm.cjs']) {
  it.each([undefined, 'development'])(
    `enforces production TLS from ambient NODE_ENV=%s (npm_execpath=${npmExecPath}) without connecting`,

    (nodeEnv) => {
      const databaseUrl = makeTestDatabaseUrl({ host: 'maintenance.invalid' });
      const env = {
        ...pinnedTestPnpmEnvironment(process.env),
        npm_execpath: npmExecPath,
        DATABASE_URL: databaseUrl,
        DATABASE_DRIVER: 'node-pg',
        DATABASE_MIGRATION_URL: databaseUrl,
        DATABASE_MIGRATION_DRIVER: 'node-pg',
        NODE_ENV: nodeEnv,
      };
      const command = pnpmCommand(executable, ['db:validate-migration-config']);
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
    `validates an allowed %s configuration (npm_execpath=${npmExecPath}) without opening a connection`,
    (host) => {
      const databaseUrl = makeTestDatabaseUrl({
        host,
        searchParams:
          host === 'maintenance.invalid' ? { sslmode: 'verify-full' } : {},
      });
      const command = pnpmCommand(executable, ['db:validate-migration-config']);
      const result = spawnSync(command.file, command.args, {
        env: {
          ...pinnedTestPnpmEnvironment(process.env),
          npm_execpath: npmExecPath,
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
}
