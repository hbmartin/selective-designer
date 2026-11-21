import {
  configureE2EDatabase,
  resolveE2EDatabase,
} from '@tests/server/e2e-database-config';
import { describe, expect, it } from 'vitest';

describe('disposable E2E database configuration', () => {
  it('overrides ambient application and migration bindings and shares one URL', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://remote.invalid/production',
      DATABASE_DRIVER: 'neon-http',
      DATABASE_MIGRATION_URL: 'postgres://remote.invalid/maintenance',
      DATABASE_MIGRATION_DRIVER: 'neon-websocket',
    };
    const config = configureE2EDatabase(env);
    expect(new URL(config.databaseUrl).hostname).toBe('127.0.0.1');
    expect(env.DATABASE_URL).toBe(config.databaseUrl);
    expect(env.DATABASE_MIGRATION_URL).toBe(config.databaseUrl);
    expect(env.DATABASE_DRIVER).toBe('node-pg');
    expect(env.DATABASE_MIGRATION_DRIVER).toBe('node-pg');
    expect(resolveE2EDatabase(env)).toEqual(config);
  });
  it.each(['', '   ', undefined])(
    'uses the disposable default for blank input %s',
    (value) => {
      expect(
        new URL(resolveE2EDatabase({ E2E_DATABASE_URL: value }).databaseUrl)
          .host
      ).toBe('127.0.0.1:54329');
    }
  );
  it.each([
    'not a URL',
    'postgres://',
    'postgres://remote.invalid:54329/postgres',
    'postgres://127.0.0.1:5432/postgres',
    'postgres://127.0.0.1:54329/production',
    'https://127.0.0.1:54329/postgres',
    'postgres://127.0.0.1:54329/postgres?host=remote.invalid',
  ])('rejects a foreign E2E binding %s', (url) => {
    expect(() => resolveE2EDatabase({ E2E_DATABASE_URL: url })).toThrow(
      'disposable loopback'
    );
  });
});
