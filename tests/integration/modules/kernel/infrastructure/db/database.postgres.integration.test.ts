import { eq } from 'drizzle-orm';
import { createAccountRepository } from '@/modules/auth/infrastructure/drizzle/account-repository-drizzle';
import { testAccountName } from '@tests/support/branded-values';
import { toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { makeUserRow } from '@tests/server/db-fixtures';
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

describe('PostgreSQL database integration', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let db: Database | undefined;
  let databaseUrl: string;

  beforeAll(async () => {
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
      let unlock!: () => void;
      let announceLock!: () => void;
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        announceLock = resolve;
      });
      const blocker = initializedDb.transaction(async (tx) => {
        await tx
          .select({ id: userTable.id })
          .from(userTable)
          .where(eq(userTable.id, 'user-1'))
          .for('update');
        announceLock();
        await release;
      });
      await locked;
      const pending = Promise.all(
        [initializedDb, other].map((connection, index) =>
          createAccountRepository({ db: connection }).submitOnboarding(
            unwrapParseResult(toUserId('user-1')),
            submissions[index]!
          )
        )
      );
      try {
        await expect
          .poll(
            async () => {
              const waiting = await initializedDb.$client.query<{
                count: number;
              }>(
                "select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike 'update %'"
              );
              return waiting.rows[0]?.count;
            },
            { timeout: 10_000 }
          )
          .toBe(2);
      } finally {
        unlock();
        await blocker;
      }
      const results = await pending;
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
