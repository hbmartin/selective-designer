import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertTarget: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  createUsers: vi.fn(),
}));

vi.mock('@/modules/kernel/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/kernel/backend')>()),
  assertLocalSeedTarget: mocks.assertTarget,
  getDefaultDbClient: mocks.connect,
}));

vi.mock('../../../drizzle/seed/user', () => ({
  createUsers: mocks.createUsers,
}));

describe('demo seed command', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(async () => {
    exitCode = process.exitCode;
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL_ENV', undefined);
    vi.stubEnv('DATABASE_DRIVER', 'node-pg');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    const { assertLocalSeedTarget } =
      await import('@/modules/kernel/infrastructure/config/database');
    mocks.assertTarget.mockImplementation(assertLocalSeedTarget);
    mocks.connect.mockReturnValue({ $close: mocks.close });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ['NODE_ENV', 'production'],
    ['VERCEL_ENV', 'production'],
    ['DATABASE_DRIVER', 'neon-websocket'],
    ['DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' })],
    [
      'DATABASE_URL',
      makeTestDatabaseUrl({ searchParams: { host: 'db.example.com' } }),
    ],
    [
      'DATABASE_URL',
      makeTestDatabaseUrl({ searchParams: { hostaddr: '192.0.2.1' } }),
    ],
  ])(
    'rejects an unsafe %s before acquiring a connection',
    async (key, value) => {
      vi.stubEnv(key, value);
      await import('../../../drizzle/seed/index');
      expect(process.exitCode).toBe(1);
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.createUsers).not.toHaveBeenCalled();
    }
  );

  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'accepts direct %s PostgreSQL',
    async (host) => {
      vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host }));
      await import('../../../drizzle/seed/index');
      expect(mocks.connect).toHaveBeenCalledOnce();
      expect(mocks.createUsers).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledOnce();
    }
  );

  it('reports the seed failure before the close failure and omits SQL details', async () => {
    mocks.createUsers.mockRejectedValueOnce(
      new Error('SQL contains sensitive parameters', {
        cause: Object.assign(new Error('private row contents'), {
          code: '23505',
        }),
      })
    );
    mocks.close.mockRejectedValueOnce(
      Object.assign(new Error('private connection details'), {
        code: 'ECONNRESET',
      })
    );

    await import('../../../drizzle/seed/index');

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenNthCalledWith(
      1,
      'Database seed failed. (23505)'
    );
    expect(console.error).toHaveBeenNthCalledWith(
      2,
      'Closing the seed database connection failed. (ECONNRESET)'
    );
  });
});
