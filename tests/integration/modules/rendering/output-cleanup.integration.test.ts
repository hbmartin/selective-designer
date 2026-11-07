import { Result } from '@bloodyowl/boxed';
import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { createFakeObjectStorage } from '@tests/support/fake-kernel-ports';
import { okValue } from '@tests/support/result';
import { inArray, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AppError } from '@/modules/kernel';
import {
  toGeneratedId,
  toObjectKey,
  toRenderResultId,
} from '@/modules/kernel/domain/ids';
import { type OutputCleanupDeps } from '@/modules/rendering';
import {
  cleanupRenderOutput,
  createOutputCleanupStore,
  renderOutputCleanup,
  renderOutputCleanupBlocked,
} from '@/modules/rendering/testing';

describe('durable render output cleanup', () => {
  let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;
  let store: ReturnType<typeof createOutputCleanupStore>;
  const target = {
    resultId: okValue(toRenderResultId('result-1')),
    attempt: 1,
    objectKey: okValue(toObjectKey('results/result-1/1/raw.png')),
  };
  beforeAll(async () => {
    database = await createRecoveryTestDatabase();
    store = createOutputCleanupStore({ db: database.db });
  });
  beforeEach(async () => {
    await database.truncate();
  });
  afterAll(async () => {
    await database?.close();
  });
  afterEach(() => vi.restoreAllMocks());
  const enqueue = async () => {
    const row = okValue(await store.enqueue(target));
    if (row.type !== 'cleanup_queued')
      throw new Error('Expected valid queue entry');
    return row;
  };
  const list = async () =>
    store.list({ before: okValue(await store.cutoff()).before, limit: 100 });
  const expire = () =>
    database.db.update(renderOutputCleanup).set({
      leaseUntil: sql`(statement_timestamp() at time zone 'UTC') - interval '1 second'`,
      nextAttemptAt: sql`(statement_timestamp() at time zone 'UTC') - interval '1 second'`,
    });
  const depsFor = (): OutputCleanupDeps => ({
    store,
    idGenerator: { createId: () => toGeneratedId('claim') },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    objectStorage: createFakeObjectStorage().storage,
    resultOutputReferences: {
      check: async () => Result.Ok({ type: 'output_unreferenced' }),
    },
  });
  it('deduplicates, fences concurrent claims, and permits replacement only after the database lease expires', async () => {
    const queued = await enqueue();
    await enqueue();
    expect(okValue(await list()).ids).toEqual([queued.cleanupId]);
    const claims = await Promise.all(
      ['a', 'b'].map((claimId) =>
        store.claim({ cleanupId: queued.cleanupId, claimId })
      )
    );
    expect(claims.map((r) => okValue(r).type).sort()).toEqual([
      'cleanup_claimed',
      'cleanup_unavailable',
    ]);
    expect(
      okValue(
        await store.claim({ cleanupId: queued.cleanupId, claimId: 'early' })
      ).type
    ).toBe('cleanup_unavailable');
    await expire();
    expect(
      okValue(
        await store.claim({
          cleanupId: queued.cleanupId,
          claimId: 'replacement',
        })
      ).type
    ).toBe('cleanup_claimed');
    expect(
      okValue(
        await store.settle({
          cleanupId: queued.cleanupId,
          claimId: 'a',
          outcome: 'output_deleted',
        })
      ).type
    ).toBe('cleanup_superseded');
  });
  it.each([
    'item-cutouts/x.png',
    'region-masks/x.png',
    'results/other/1/raw.png',
    'results/result-1/2/raw.png',
    'results/result-1/1/../raw.png',
    ' results/result-1/1/raw.png',
    'https://secret.example/x?token=private',
    undefined,
    null,
    { url: 'private' },
  ])(
    'durably blocks unsafe evidence without saving raw input: %j',
    async (objectKey) => {
      expect(okValue(await store.enqueue({ ...target, objectKey }))).toEqual({
        type: 'cleanup_blocked',
        reasonCode: 'RENDER_OUTPUT_TARGET_INVALID',
      });
      okValue(await store.enqueue({ ...target, objectKey }));
      expect(okValue(await list()).ids).toEqual([]);
      const evidence = await database.db
        .select()
        .from(renderOutputCleanupBlocked);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(evidence)).not.toContain('private');
      expect(JSON.stringify(evidence)).not.toContain('https:');
      expect(okValue(await store.summary()).blocked).toBe(1);
    }
  );
  it('fingerprints equivalent malformed objects independently of property ordering', async () => {
    okValue(await store.enqueue({ ...target, objectKey: { a: 1, b: 2 } }));
    okValue(await store.enqueue({ ...target, objectKey: { b: 2, a: 1 } }));
    expect(okValue(await store.summary()).blocked).toBe(1);
  });
  it('quarantines a corrupt claimed row atomically before any storage or reference access', async () => {
    const objectKey = 'https://secret.example/x?token=private';
    await database.db.insert(renderOutputCleanup).values({
      ...target,
      resultId: objectKey,
      objectKey,
      createdAt: new Date('2000-01-01'),
      nextAttemptAt: new Date('2000-01-01'),
    });
    const deps = depsFor();
    const refs = vi.spyOn(deps.resultOutputReferences, 'check');
    const remove = vi.spyOn(deps.objectStorage, 'deleteObject');
    expect(okValue(await cleanupRenderOutput(deps, objectKey)).type).toBe(
      'cleanup_blocked'
    );
    expect(refs).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
    const [blocked] = await database.db
      .select()
      .from(renderOutputCleanupBlocked);
    expect(blocked?.resultId).toBeNull();
    expect(JSON.stringify(blocked)).not.toContain('secret');
    expect(okValue(await cleanupRenderOutput(deps, objectKey)).type).toBe(
      'cleanup_unavailable'
    );
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back quarantine if recording its evidence fails, leaving no acquired lease',
    async () => {
      const objectKey = 'region-masks/unsafe.png';
      await database.db.insert(renderOutputCleanup).values({
        ...target,
        objectKey,
        createdAt: new Date('2000-01-01'),
        nextAttemptAt: new Date('2000-01-01'),
      });
      await database.db.execute(
        sql`alter table render_output_cleanup_blocked add constraint reject_blocked check (false)`
      );
      try {
        expect(
          (await store.claim({ cleanupId: objectKey, claimId: 'a' })).isError()
        ).toBe(true);
        const [row] = await database.db.select().from(renderOutputCleanup);
        expect(row?.claimToken).toBeNull();
        expect(row?.attempts).toBe(0);
      } finally {
        await database.db.execute(
          sql`alter table render_output_cleanup_blocked drop constraint reject_blocked`
        );
      }
    }
  );
  it('uses database time and retains completed deduplication records', async () => {
    const queued = await enqueue();
    const deps = depsFor();
    expect(
      okValue(await cleanupRenderOutput(deps, queued.cleanupId)).type
    ).toBe('cleanup_completed');
    const [row] = await database.db.select().from(renderOutputCleanup);
    expect(row?.completedAt?.getUTCFullYear()).toBeGreaterThan(2020);
    await enqueue();
    expect(okValue(await list()).ids).toEqual([]);
  });
  it('retains globally referenced objects and completes idempotently', async () => {
    const queued = await enqueue();
    const deps = depsFor();
    vi.spyOn(deps.resultOutputReferences, 'check').mockResolvedValue(
      Result.Ok({ type: 'output_referenced' })
    );
    const remove = vi.spyOn(deps.objectStorage, 'deleteObject');
    expect(
      okValue(await cleanupRenderOutput(deps, queued.cleanupId)).type
    ).toBe('cleanup_completed');
    expect(remove).not.toHaveBeenCalled();
  });
  it('preserves the original reference failure when acknowledgment fails and later recovers a lost acknowledgment', async () => {
    const queued = await enqueue();
    const deps = depsFor();
    const original = new AppError({
      code: 'REFERENCE_DOWN',
      category: 'system',
      status: 503,
    });
    const check = vi
      .spyOn(deps.resultOutputReferences, 'check')
      .mockResolvedValueOnce(Result.Error(original));
    const settle = vi
      .spyOn(store, 'settle')
      .mockResolvedValueOnce(
        Result.Error(
          new AppError({ code: 'ACK_DOWN', category: 'system', status: 503 })
        )
      );
    const result = await cleanupRenderOutput(deps, queued.cleanupId);
    expect(result.isError() && result.getError()).toBe(original);
    settle.mockRestore();
    check.mockRestore();
    await expire();
    expect(
      okValue(await cleanupRenderOutput(deps, queued.cleanupId)).type
    ).toBe('cleanup_completed');
  });
  it('retries transient deletion failures without terminalizing them', async () => {
    const queued = await enqueue();
    const deps = depsFor();
    vi.spyOn(deps.objectStorage, 'deleteObject').mockResolvedValueOnce(
      Result.Error(
        new AppError({ code: 'DELETE_DOWN', category: 'system', status: 503 })
      )
    );
    expect((await cleanupRenderOutput(deps, queued.cleanupId)).isError()).toBe(
      true
    );
    const [row] = await database.db.select().from(renderOutputCleanup);
    expect(row?.completedAt).toBeNull();
    expect(row?.claimToken).toBeNull();
    expect(okValue(await store.summary()).blocked).toBe(0);
    await expire();
    expect(
      okValue(await cleanupRenderOutput(deps, queued.cleanupId)).type
    ).toBe('cleanup_completed');
  });
  it('pages by the indexed time/key tuple without skipping ties when the first page is settled', async () => {
    await database.db.insert(renderOutputCleanup).values(
      Array.from({ length: 121 }, (_, i) => ({
        resultId: `result-${i}`,
        attempt: 1,
        objectKey: `results/result-${i}/1/raw.png`,
        createdAt: new Date('2000-01-01'),
        nextAttemptAt: new Date(Date.UTC(2000, 0, 1, 0, i % 3)),
      }))
    );
    const before = okValue(await store.cutoff()).before;
    const first = okValue(await store.list({ before, limit: 100 }));
    expect(first.ids).toHaveLength(100);
    await database.db
      .update(renderOutputCleanup)
      .set({
        nextAttemptAt: sql`(statement_timestamp() at time zone 'UTC') + interval '5 seconds'`,
        completedAt: sql`(statement_timestamp() at time zone 'UTC')`,
      })
      .where(inArray(renderOutputCleanup.objectKey, first.ids));
    const second = okValue(
      await store.list({ before, after: first.cursor, limit: 100 })
    );
    expect(second.ids).toHaveLength(21);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(121);
  });
});
