import { Result } from '@bloodyowl/boxed';
import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { createFakeObjectStorage } from '@tests/support/fake-kernel-ports';
import { okValue } from '@tests/support/result';
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
import {
  cleanupRenderOutput,
  type OutputCleanupDeps,
} from '@/modules/rendering';
import { createOutputCleanupStore } from '@/modules/rendering/testing';

describe('durable render output cleanup', () => {
  let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;
  let store: ReturnType<typeof createOutputCleanupStore>;
  const now = new Date('2026-11-06T19:00:00Z');
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

  it('deduplicates independent cleanup work and fences claims through lease expiry', async () => {
    const queued = okValue(await store.enqueue(target, now));
    okValue(await store.enqueue(target, now));
    expect(okValue(await store.list({ before: now, limit: 100 })).ids).toEqual([
      queued.cleanupId,
    ]);
    const claims = await Promise.all(
      ['a', 'b'].map((claimId) =>
        store.claim({ cleanupId: queued.cleanupId, claimId, now })
      )
    );
    expect(claims.map((r) => okValue(r).type).sort()).toEqual([
      'cleanup_claimed',
      'cleanup_unavailable',
    ]);
    expect(
      okValue(
        await store.claim({
          cleanupId: queued.cleanupId,
          claimId: 'early',
          now: new Date(now.getTime() + 299999),
        })
      ).type
    ).toBe('cleanup_unavailable');
    expect(
      okValue(
        await store.claim({
          cleanupId: queued.cleanupId,
          claimId: 'replacement',
          now: new Date(now.getTime() + 300000),
        })
      ).type
    ).toBe('cleanup_claimed');
    expect(
      okValue(
        await store.settle({
          cleanupId: queued.cleanupId,
          claimId: 'a',
          now,
          outcome: 'output_deleted',
        })
      ).type
    ).toBe('cleanup_superseded');
  });

  it.each([
    'item-cutouts/x.png',
    'region-masks/x.png',
    'item-photos/x.png',
    'results/other/1/raw.png',
    'results/result-1/2/raw.png',
    'results/result-1/1/../raw.png',
  ])('rejects an unrelated or malformed key %s', async (value) => {
    expect(
      (
        await store.enqueue(
          { ...target, objectKey: okValue(toObjectKey(value)) },
          now
        )
      ).isError()
    ).toBe(true);
    expect(okValue(await store.list({ before: now, limit: 100 })).ids).toEqual(
      []
    );
  });

  const depsFor = (): OutputCleanupDeps => ({
    store,
    clock: { now: () => now },
    idGenerator: { createId: () => toGeneratedId('claim') },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    objectStorage: createFakeObjectStorage().storage,
    resultOutputReferences: {
      check: async () => Result.Ok({ type: 'output_unreferenced' }),
    },
  });

  it('completes missing objects idempotently and retains referenced objects', async () => {
    const queued = okValue(await store.enqueue(target, now));
    const deps = depsFor();
    const check = vi
      .spyOn(deps.resultOutputReferences, 'check')
      .mockResolvedValue(Result.Ok({ type: 'output_referenced' }));
    const remove = vi.spyOn(deps.objectStorage, 'deleteObject');
    expect(
      okValue(await cleanupRenderOutput(deps, queued.cleanupId)).type
    ).toBe('cleanup_completed');
    expect(remove).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith(target.objectKey);
    expect(
      okValue(await cleanupRenderOutput(deps, queued.cleanupId)).type
    ).toBe('cleanup_unavailable');
  });

  it('preserves the original error when reference checking and settlement fail', async () => {
    const queued = okValue(await store.enqueue(target, now));
    const deps = depsFor();
    const original = new AppError({
      code: 'REFERENCE_DOWN',
      category: 'system',
      status: 503,
    });
    vi.spyOn(deps.resultOutputReferences, 'check').mockResolvedValue(
      Result.Error(original)
    );
    vi.spyOn(deps.store, 'settle').mockResolvedValueOnce(
      Result.Error(
        new AppError({ code: 'ACK_DOWN', category: 'system', status: 503 })
      )
    );
    const remove = vi.spyOn(deps.objectStorage, 'deleteObject');
    const result = await cleanupRenderOutput(deps, queued.cleanupId);
    expect(result.isError()).toBe(true);
    if (result.isError()) expect(result.getError()).toBe(original);
    expect(remove).not.toHaveBeenCalled();
  });
  it('completes a missing object and can reconcile a lost acknowledgment after lease expiry', async () => {
    const queued = okValue(await store.enqueue(target, now));
    const deps = depsFor();
    const originalSettle = store.settle.bind(store);
    vi.spyOn(store, 'settle').mockResolvedValueOnce(
      Result.Error(
        new AppError({ code: 'ACK_DOWN', category: 'system', status: 503 })
      )
    );
    const remove = vi.spyOn(deps.objectStorage, 'deleteObject');
    expect((await cleanupRenderOutput(deps, queued.cleanupId)).isError()).toBe(
      true
    );
    expect(remove).toHaveBeenCalledWith(target.objectKey);
    vi.spyOn(store, 'settle').mockImplementation(originalSettle);
    deps.clock = { now: () => new Date(now.getTime() + 300000) };
    expect(
      okValue(await cleanupRenderOutput(deps, queued.cleanupId)).type
    ).toBe('cleanup_completed');
    expect(
      okValue(
        await store.list({
          before: new Date(now.getTime() + 600000),
          limit: 100,
        })
      ).ids
    ).toEqual([]);
  });
});
