import { runBlockedSubmissions } from '@tests/support/blocked-submissions';
import type { Auth } from '@/modules/auth/infrastructure/better-auth/auth';
import { SessionGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/session-gateway-better-auth';
import { authIdentity } from '@/modules/auth/infrastructure/drizzle/schema';
import { createNoOpTelemetry } from '@/platform/telemetry';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createAccountRepository } from '@/modules/auth/infrastructure/drizzle/account-repository-drizzle';
import { testAccountName } from '@tests/support/branded-values';
import { toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { makeUserRow } from '@tests/server/db-fixtures';
import { makeStrongTestSecret } from '@tests/support/test-secrets';
import { POSTGRES_TESTCONTAINER_IMAGE } from '@tests/server/docker-images';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createDbClient,
  type Database,
} from '@/modules/kernel/infrastructure/db/client';
import {
  createMigrationDbClient,
  migrateDatabase,
} from '@/modules/kernel/infrastructure/db/migrate';
import { tryAcquirePostgresAdvisoryLock } from '@/modules/kernel/infrastructure/db/postgres-advisory-lock';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';

type TableRow = {
  schemaname: string;
  tablename: string;
};

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function truncateDatabase(db: Database) {
  const result = await db.$client.query<TableRow>(
    "SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '__drizzle_migrations' ORDER BY tablename"
  );
  const tableNames = result.rows.map(
    ({ schemaname, tablename }) =>
      `${quoteIdentifier(schemaname)}.${quoteIdentifier(tablename)}`
  );

  if (tableNames.length === 0) return;
  await db.$client.query(
    `TRUNCATE TABLE ${tableNames.join(', ')} RESTART IDENTITY CASCADE`
  );
}

function getInitializedDb(db: Database | undefined) {
  if (!db) throw new Error('PostgreSQL test database was not initialized.');
  return db;
}

async function submitWithContention(
  initializedDb: Database,
  connections: Database[],
  submissions: Parameters<
    ReturnType<typeof createAccountRepository>['submitOnboarding']
  >[1][],
  observe: (waiting: () => Promise<number | undefined>) => Promise<void>
) {
  return runBlockedSubmissions({
    block: (announceLock, release) =>
      initializedDb.transaction(async (tx) => {
        await tx
          .select({ id: userTable.id })
          .from(userTable)
          .where(eq(userTable.id, 'user-1'))
          .for('update');
        announceLock();
        await release;
      }),
    submissions: connections.map(
      (connection, index) => () =>
        createAccountRepository({ db: connection }).submitOnboarding(
          unwrapParseResult(toUserId('user-1')),
          submissions[index]!
        )
    ),
    observe: () =>
      observe(async () => {
        const waiting = await initializedDb.$client.query<{ count: number }>(
          "select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike 'update %'"
        );
        return waiting.rows[0]?.count;
      }),
  });
}

describe('PostgreSQL database integration', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let db: Database | undefined;
  let databaseUrl: string;

  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', makeStrongTestSecret('postgres-auth'));
    container = await new PostgreSqlContainer(
      POSTGRES_TESTCONTAINER_IMAGE
    ).start();
    databaseUrl = container.getConnectionUri();
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'node-pg');
    const migrationDb = await createMigrationDbClient({
      databaseUrl,
      driver: 'node-pg',
    });
    try {
      await migrateDatabase(migrationDb);
    } finally {
      await migrationDb.$close();
    }
    db = createDbClient({ driver: 'node-pg', url: databaseUrl });
  });

  beforeEach(async () => {
    if (!db) throw new Error('PostgreSQL test database was not initialized.');
    await truncateDatabase(db);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$close();
    await container?.stop();
  });

  it('allows exactly one concurrent onboarding confirmation and preserves its complete pair', async () => {
    const initializedDb = getInitializedDb(db);
    await initializedDb.insert(userTable).values(makeUserRow());
    const other = createDbClient({ driver: 'node-pg', url: databaseUrl });
    try {
      const submissions = [
        {
          name: testAccountName('First Candidate'),
          onboardedAt: new Date('2026-01-01T12:00:00Z'),
        },
        {
          name: testAccountName('Second Candidate'),
          onboardedAt: new Date('2026-01-02T12:00:00Z'),
        },
      ];
      const results = await submitWithContention(
        initializedDb,
        [initializedDb, other],
        submissions,
        async (waiting) => {
          await expect.poll(waiting, { timeout: 10_000 }).toBe(2);
        }
      );
      const outcomes = results.map((result) => {
        if (result.isError()) throw result.getError();
        return result.get().type;
      });
      expect(outcomes.toSorted()).toEqual([
        'account_already_onboarded',
        'account_updated',
      ]);
      const winner = submissions[outcomes.indexOf('account_updated')];
      const before = await initializedDb.query.user.findFirst({
        where: (table, { eq }) => eq(table.id, 'user-1'),
      });
      expect(before).toMatchObject(winner!);
      await createAccountRepository({ db: other }).submitOnboarding(
        unwrapParseResult(toUserId('user-1')),
        submissions[1]!
      );
      expect(
        await initializedDb.query.user.findFirst({
          where: (table, { eq }) => eq(table.id, 'user-1'),
        })
      ).toEqual(before);
    } finally {
      await other.$close();
    }
  });

  it('drains blocked submissions even when the lock-wait assertion fails', async () => {
    const initializedDb = getInitializedDb(db);
    await initializedDb.insert(userTable).values(makeUserRow());
    const other = createDbClient({ driver: 'node-pg', url: databaseUrl });
    try {
      const submissions = [1, 2].map((index) => ({
        name: testAccountName(`Candidate ${index}`),
        onboardedAt: new Date(),
      }));
      await expect(
        submitWithContention(
          initializedDb,
          [initializedDb, other],
          submissions,
          async (waiting) => {
            await expect.poll(waiting, { timeout: 10_000 }).toBe(2);
            await expect.poll(waiting, { timeout: 25 }).toBe(3);
          }
        )
      ).rejects.toThrow('expected 2 to be 3');
      const pool = other.$client as Pool;
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
      expect(
        (
          await initializedDb.query.user.findFirst({
            where: eq(userTable.id, 'user-1'),
          })
        )?.onboardedAt
      ).toBeInstanceOf(Date);
    } finally {
      await other.$close();
    }
  });

  it('propagates lock-holder failure before readiness without waiting forever', async () => {
    const initializedDb = getInitializedDb(db);
    const failure = new Error('Lock holder could not start');
    const transaction = vi
      .spyOn(initializedDb, 'transaction')
      .mockRejectedValueOnce(failure);
    const observe = vi.fn(async () => {});
    try {
      await expect(
        submitWithContention(initializedDb, [], [], observe)
      ).rejects.toBe(failure);
      expect(observe).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it('reports a real lock-holder rollback after release and drains both updates', async () => {
    const initializedDb = getInitializedDb(db);
    await initializedDb.insert(userTable).values(makeUserRow());
    const other = createDbClient({ driver: 'node-pg', url: databaseUrl });
    const failure = new Error('Lock holder rolled back');
    const original = initializedDb.transaction.bind(initializedDb);
    const transaction = vi
      .spyOn(initializedDb, 'transaction')
      .mockImplementationOnce((callback, config) =>
        original(async (tx) => {
          await callback(tx);
          throw failure;
        }, config)
      );
    try {
      await expect(
        submitWithContention(
          initializedDb,
          [initializedDb, other],
          [1, 2].map((index) => ({
            name: testAccountName(`Candidate ${index}`),
            onboardedAt: new Date(),
          })),
          async (waiting) => {
            await expect.poll(waiting, { timeout: 10_000 }).toBe(2);
          }
        )
      ).rejects.toBe(failure);
      const pool = other.$client as Pool;
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
    } finally {
      transaction.mockRestore();
      await other.$close();
    }
  });

  it('uses the user primary-key index for the actual mapped and fallback session queries', async () => {
    const initializedDb = getInitializedDb(db);
    await initializedDb.$client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") select 'user-' || g, 'Person ' || g, 'person-' || g || '@example.com', true, now(), now() from generate_series(1,20000) g`
    );
    await initializedDb.insert(authIdentity).values({
      provider: 'better-auth',
      providerUserId: 'provider-id',
      userId: 'user-19998',
    });
    await initializedDb.$client.query('ANALYZE "user"');
    await initializedDb.$client.query('ANALYZE auth_identity');
    for (const providerId of ['provider-id', 'user-19998']) {
      const auth = {
        api: {
          getSession: async () => ({
            user: { id: providerId, email: 'provider@example.com' },
            session: {
              id: 'session',
              createdAt: new Date(),
              expiresAt: new Date('2099-01-01'),
            },
          }),
        },
      } as unknown as Auth;
      const observed = vi.spyOn(initializedDb.$client, 'query');
      let call: unknown[] | undefined;
      try {
        const gateway = new SessionGatewayBetterAuth(
          auth,
          initializedDb,
          undefined,
          createNoOpTelemetry()
        );
        const result = await gateway.getSession({ headers: new Headers() });
        if (result.isError()) throw result.getError();
        expect(result.get().type).toBe('auth_session_found');
        const calls: unknown[][] = observed.mock.calls;
        call = calls.find(
          ([config]) =>
            typeof config === 'object' &&
            config !== null &&
            'text' in config &&
            typeof config.text === 'string' &&
            config.text.includes('coalesce(')
        );
      } finally {
        observed.mockRestore();
      }
      expect(call).toBeDefined();
      const query = call![0] as { text: string };
      const explained = await initializedDb.$client.query(
        'EXPLAIN (ANALYZE, FORMAT JSON) ' + query.text,
        call![1] as unknown[]
      );
      type Plan = {
        'Node Type': string;
        'Relation Name'?: string;
        'Actual Rows'?: number;
        Plans?: Plan[];
      };
      const nodes = (plan: Plan): Plan[] => [
        plan,
        ...(plan.Plans ?? []).flatMap(nodes),
      ];
      const payload = explained.rows[0]?.['QUERY PLAN'] as { Plan: Plan }[];
      const plans = nodes(payload[0]!.Plan);
      const userScans = plans.filter(
        (plan) => plan['Relation Name'] === 'user'
      );
      expect(userScans).toHaveLength(1);
      expect(userScans[0]?.['Node Type']).toBe('Index Scan');
      expect(userScans[0]?.['Actual Rows']).toBe(1);
    }
  });

  it('applies migrations and commits transactions', async () => {
    const initializedDb = getInitializedDb(db);

    await initializedDb.transaction(async (tx) => {
      await tx
        .insert(userTable)
        .values(
          makeUserRow({ id: 'user-commit', email: 'commit@example.com' })
        );
    });

    await expect(
      initializedDb.query.user.findFirst({
        where: (user, { eq }) => eq(user.id, 'user-commit'),
      })
    ).resolves.toMatchObject({ id: 'user-commit' });
  });

  it('can rerun migrations on an up-to-date database without duplicating journal entries', async () => {
    const initializedDb = getInitializedDb(db);
    const before = await initializedDb.$client.query(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations'
    );
    const migrationDb = await createMigrationDbClient({
      databaseUrl,
      driver: 'node-pg',
    });
    try {
      await migrateDatabase(migrationDb);
      await migrateDatabase(migrationDb);
    } finally {
      await migrationDb.$close();
    }
    const after = await initializedDb.$client.query(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations'
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('rolls back failed transactions', async () => {
    const initializedDb = getInitializedDb(db);

    await expect(
      initializedDb.transaction(async (tx) => {
        await tx
          .insert(userTable)
          .values(
            makeUserRow({ id: 'user-rollback', email: 'rollback@example.com' })
          );
        throw new Error('rollback requested');
      })
    ).rejects.toThrow('rollback requested');

    await expect(
      initializedDb.query.user.findFirst({
        where: (user, { eq }) => eq(user.id, 'user-rollback'),
      })
    ).resolves.toBeUndefined();
  });

  it('acquires, contends, and releases advisory locks', async () => {
    const firstLease = await tryAcquirePostgresAdvisoryLock({
      namespace: 'db-test',
      key: 'shared-lock',
    });
    expect(firstLease).toBeDefined();

    const contendedLease = await tryAcquirePostgresAdvisoryLock({
      namespace: 'db-test',
      key: 'shared-lock',
    });
    expect(contendedLease).toBeUndefined();

    await firstLease?.release();

    const secondLease = await tryAcquirePostgresAdvisoryLock({
      namespace: 'db-test',
      key: 'shared-lock',
    });
    expect(secondLease).toBeDefined();
    await secondLease?.release();
  });
});
