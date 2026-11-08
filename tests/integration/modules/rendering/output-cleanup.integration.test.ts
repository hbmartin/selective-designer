import { Result } from '@bloodyowl/boxed';
import { makeUserRow } from '@tests/server/db-fixtures';
import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { createFakeObjectStorage } from '@tests/support/fake-kernel-ports';
import { updateRenderResultFixture } from '@tests/support/render-result-fixture';
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

import { toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import { AppError } from '@/modules/kernel';
import {
  toDesignId,
  toImageId,
  toRenderId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import {
  toGeneratedId,
  toObjectKey,
  toRenderResultId,
} from '@/modules/kernel/domain/ids';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import { type OutputCleanupDeps } from '@/modules/rendering';
import {
  cleanupRenderOutput,
  createOutputCleanupStore,
  createRenderRepository,
  findCleanupRecoveryRequest,
  renderOutputCleanup,
  renderOutputCleanupAcknowledgmentRequest,
  renderOutputCleanupBlocked,
  renderOutputCleanupRecovery,
  renderResultTable,
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
      expect(okValue(await store.summary()).blockedTotal).toBe(1);
    }
  );
  it('fingerprints equivalent malformed objects independently of property ordering', async () => {
    okValue(await store.enqueue({ ...target, objectKey: { a: 1, b: 2 } }));
    okValue(await store.enqueue({ ...target, objectKey: { b: 2, a: 1 } }));
    expect(okValue(await store.summary()).blockedTotal).toBe(1);
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
    expect(okValue(await store.summary()).blockedTotal).toBe(0);
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
    if (first.type !== 'cleanup_page')
      throw new Error('Expected nonempty page');
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
  it('uses the tuple cursor while every earlier row remains eligible, including timestamp ties and milliseconds', async () => {
    await database.db.insert(renderOutputCleanup).values(
      Array.from({ length: 241 }, (_, i) => ({
        resultId: `result-${i}`,
        attempt: 1,
        objectKey: `results/result-${i}/1/raw.png`,
        createdAt: new Date('2000-01-01'),
        nextAttemptAt: new Date(Date.UTC(2000, 0, 1, 0, i % 3, 0, 123)),
      }))
    );
    const before = okValue(await store.cutoff()).before;
    const first = okValue(await store.list({ before, limit: 100 }));
    if (first.type !== 'cleanup_page') throw new Error('Expected page');
    const second = okValue(
      await store.list({ before, after: first.cursor, limit: 100 })
    );
    if (second.type !== 'cleanup_page') throw new Error('Expected page');
    const third = okValue(
      await store.list({ before, after: second.cursor, limit: 100 })
    );
    if (third.type !== 'cleanup_page') throw new Error('Expected page');
    expect([first.ids.length, second.ids.length, third.ids.length]).toEqual([
      100, 100, 41,
    ]);
    expect(new Set([...first.ids, ...second.ids, ...third.ids]).size).toBe(241);
    expect(
      okValue(await store.list({ before, after: third.cursor, limit: 100 }))
        .type
    ).toBe('cleanup_empty');
    expect(first.cursor.nextAttemptAt.endsWith('.123Z')).toBe(true);
  });
  const blockedTarget = async () => {
    okValue(
      await store.enqueue({
        ...target,
        resultId: okValue(toRenderResultId('incorrect-owner')),
      })
    );
    const records = okValue(await store.blocked({ limit: 100 })).records;
    expect(JSON.stringify(records)).not.toContain(target.objectKey);
    return records[0]!;
  };
  const repairInput = async (requestId = 'repair-1') => ({
    requestId,
    fingerprint: (await blockedTarget()).fingerprint,
    resultId: target.resultId,
    attempt: target.attempt,
  });
  it('retains safe locators only for privileged inspection and atomically requeues corrected ownership', async () => {
    const input = await repairInput();
    const inspected = okValue(await store.inspect(input.fingerprint));
    expect(inspected).toMatchObject({
      type: 'blocked_cleanup_found',
      locator: target.objectKey,
      recoveries: [],
    });
    expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
    expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toHaveLength(1);
    expect(okValue(await store.requeue({ ...input, attempt: 2 })).type).toBe(
      'cleanup_repair_conflict'
    );
    expect(
      okValue(await cleanupRenderOutput(depsFor(), target.objectKey)).type
    ).toBe('cleanup_completed');
    expect(
      await database.db.select().from(renderOutputCleanupBlocked)
    ).toHaveLength(1);
  });
  it('leaves historical fingerprint-only evidence unchanged and refuses unavailable locators', async () => {
    const input = await repairInput();
    await database.db
      .update(renderOutputCleanupBlocked)
      .set({ safeObjectKey: null });
    await blockedTarget();
    expect(okValue(await store.requeue(input)).type).toBe(
      'locator_unavailable'
    );
    expect(okValue(await store.inspect(input.fingerprint))).toMatchObject({
      locator: null,
    });
    expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
  });
  it('rejects mismatched ownership and unrelated namespaces before enqueue or storage', async () => {
    const input = await repairInput();
    expect(okValue(await store.requeue({ ...input, attempt: 2 })).type).toBe(
      'cleanup_target_mismatch'
    );
    okValue(
      await store.enqueue({ ...target, objectKey: 'region-masks/a.png' })
    );
    const records = okValue(await store.blocked({ limit: 100 })).records;
    for (const record of records) {
      const view = okValue(await store.inspect(record.fingerprint));
      if (
        view.type === 'blocked_cleanup_found' &&
        view.locator === 'region-masks/a.png'
      )
        expect(
          okValue(
            await store.requeue({
              ...input,
              requestId: 'unrelated',
              fingerprint: record.fingerprint,
            })
          ).type
        ).toBe('cleanup_target_mismatch');
    }
    expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toEqual([]);
  });
  it('preserves a live pending claim during repair and isolates concurrent repair requests', async () => {
    const input = await repairInput();
    const outcomes = await Promise.all([
      store.requeue(input),
      store.requeue({ ...input, requestId: 'repair-2' }),
    ]);
    expect(outcomes.map((outcome) => okValue(outcome).type).sort()).toEqual([
      'cleanup_already_pending',
      'cleanup_requeued',
    ]);
    okValue(
      await store.claim({ cleanupId: target.objectKey, claimId: 'current' })
    );
    expect(
      okValue(await store.requeue({ ...input, requestId: 'repair-3' })).type
    ).toBe('cleanup_already_pending');
    const [row] = await database.db.select().from(renderOutputCleanup);
    expect(row?.claimToken).toBe('current');
    expect(row?.attempts).toBe(1);
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toHaveLength(3);
  });
  it('explicitly rechecks retained objects, preserving old completion, and never reopens deleted tombstones', async () => {
    const input = await repairInput();
    await enqueue();
    const deps = depsFor();
    vi.spyOn(deps.resultOutputReferences, 'check').mockResolvedValue(
      Result.Ok({ type: 'output_referenced' })
    );
    okValue(await cleanupRenderOutput(deps, target.objectKey));
    const [old] = await database.db.select().from(renderOutputCleanup);
    expect(old?.outcome).toBe('output_retained');
    expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
    const [event] = await database.db
      .select()
      .from(renderOutputCleanupRecovery);
    expect(event?.previousOutcome).toBe('output_retained');
    expect(event?.previousCompletedAt).toEqual(old?.completedAt);
    okValue(await cleanupRenderOutput(depsFor(), target.objectKey));
    expect(
      okValue(await store.requeue({ ...input, requestId: 'after-delete' })).type
    ).toBe('cleanup_already_completed');
    expect(okValue(await list()).ids).toEqual([]);
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back a repair queue insert if its audit write fails',
    async () => {
      const input = await repairInput();
      await database.db.execute(
        sql`alter table render_output_cleanup_recovery add constraint reject_recovery check(false)`
      );
      try {
        expect((await store.requeue(input)).isError()).toBe(true);
        expect(await database.db.select().from(renderOutputCleanup)).toEqual(
          []
        );
        expect(
          await database.db.select().from(renderOutputCleanupRecovery)
        ).toEqual([]);
        expect(
          await database.db.select().from(renderOutputCleanupBlocked)
        ).toHaveLength(1);
      } finally {
        await database.db.execute(
          sql`alter table render_output_cleanup_recovery drop constraint reject_recovery`
        );
      }
    }
  );
  it('reconciles a lost commit reply using the recovery request identity', async () => {
    const input = await repairInput();
    const original = database.db.$runInTransaction!;
    vi.spyOn(database.db, '$runInTransaction').mockImplementationOnce(
      async (work, options) => {
        await original(work, options);
        throw new Error('lost commit reply');
      }
    );
    expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toHaveLength(1);
    expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
  });
  it('preserves an uncertain repair write when reconciliation is unavailable, then replays without duplicate work', async () => {
    const input = await repairInput();
    const original = database.db.$runInTransaction!;
    vi.spyOn(database.db, '$runInTransaction').mockImplementationOnce(
      async (work, options) => {
        await original(work, options);
        throw Object.assign(new Error('lost reply'), { code: 'EPIPE' });
      }
    );
    vi.spyOn(database.db, 'select').mockImplementationOnce(() => {
      throw Object.assign(new Error('read unavailable'), {
        code: 'ECONNRESET',
      });
    });
    const result = await store.requeue(input);
    expect(result.isError() && result.getError()).toMatchObject({
      cause: { code: 'EPIPE' },
      details: { reconciliation: { errorCodes: ['ECONNRESET'] } },
    });
    expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toHaveLength(1);
  });
  const seedAttempt = async (
    status: 'pending' | 'submitted' | 'succeeded' | 'failed' | 'skipped',
    attempt = 1
  ) => {
    const ownerId = okValue(toUserId('cleanup-owner'));
    const designId = okValue(toDesignId('cleanup-design'));
    const imageId = okValue(toImageId('cleanup-base'));
    await database.db.insert(userTable).values(makeUserRow({ id: ownerId }));
    okValue(
      await createDesignRepository({ db: database.db }).create({
        id: designId,
        ownerId,
        name: okValue(toDesignName('Cleanup')),
        copiedFromDesignId: null,
        baseImage: {
          id: imageId,
          kind: 'base',
          originalKey: okValue(toObjectKey('base-images/x.png')),
          originalContentType: 'image/png',
          original: { width: 10, height: 10 },
          workingKey: okValue(toObjectKey('working-images/x.png')),
          working: { width: 10, height: 10 },
        },
      })
    );
    okValue(
      await createRenderRepository({ db: database.db }).createRender({
        id: okValue(toRenderId('cleanup-render')),
        designId,
        renderSourceImageId: imageId,
        batchId: null,
        batchOptionItemId: null,
        attemptStartedAt: new Date('2026-11-07T00:00:00.000Z'),
        recipe: {
          renderSourceImageId: imageId,
          source: { workingKey: 'working-images/x.png', width: 10, height: 10 },
          edits: [],
          editMaskKey: null,
          prompt: '',
        },
        results: [
          {
            id: target.resultId,
            modelId: 'krea-3',
            status: 'pending',
            skipReason: null,
          },
        ],
      })
    );
    await updateRenderResultFixture(database.db, {
      resultId: target.resultId,
      changes: { status, attempt },
    });
  };
  it.each(['pending', 'submitted'] as const)(
    'rejects repair of a live %s attempt before queueing',
    async (status) => {
      await seedAttempt(status);
      const input = await repairInput();
      expect(okValue(await store.requeue(input)).type).toBe(
        'cleanup_attempt_active'
      );
      expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
      expect(
        await database.db.select().from(renderOutputCleanupRecovery)
      ).toEqual([]);
      expect(okValue(await store.summary())).toMatchObject({
        blockedTotal: 1,
        blockedOutstanding: 1,
      });
    }
  );
  it('quarantines an already queued active attempt before reference or storage access', async () => {
    await seedAttempt('submitted');
    await enqueue();
    const deps = depsFor();
    const reference = vi.spyOn(deps.resultOutputReferences, 'check');
    const deletion = vi.spyOn(deps.objectStorage, 'deleteObject');
    expect(okValue(await cleanupRenderOutput(deps, target.objectKey))).toEqual({
      type: 'cleanup_blocked',
      reasonCode: 'RENDER_OUTPUT_ATTEMPT_ACTIVE',
    });
    expect(reference).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
    const evidence = okValue(await store.blocked({ limit: 100 })).records[0]!;
    expect(evidence.reasonCode).toBe('RENDER_OUTPUT_ATTEMPT_ACTIVE');
    await updateRenderResultFixture(database.db, {
      resultId: target.resultId,
      changes: { status: 'failed' },
    });
    expect(okValue(await list()).ids).toEqual([]);
    expect(
      okValue(
        await store.requeue({
          requestId: 'after-terminal',
          fingerprint: evidence.fingerprint,
          ...target,
        })
      ).type
    ).toBe('cleanup_requeued');
  });
  it.each(['succeeded', 'failed', 'skipped'] as const)(
    'allows a terminal %s attempt but keeps referenced objects',
    async (status) => {
      await seedAttempt(status);
      const input = await repairInput();
      expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
      const deps = depsFor();
      vi.spyOn(deps.resultOutputReferences, 'check').mockResolvedValue(
        Result.Ok({ type: 'output_referenced' })
      );
      const deletion = vi.spyOn(deps.objectStorage, 'deleteObject');
      okValue(await cleanupRenderOutput(deps, target.objectKey));
      expect(deletion).not.toHaveBeenCalled();
      expect(
        (await database.db.select().from(renderOutputCleanup))[0]?.outcome
      ).toBe('output_retained');
    }
  );
  it('allows replaced attempts but rejects targets beyond the current attempt', async () => {
    await seedAttempt('submitted', 2);
    const input = await repairInput();
    expect(okValue(await store.requeue(input)).type).toBe('cleanup_requeued');
    await updateRenderResultFixture(database.db, {
      resultId: target.resultId,
      changes: { attempt: 1 },
    });
    const futureKey = okValue(toObjectKey('results/result-1/2/raw.png'));
    okValue(
      await store.enqueue({
        resultId: okValue(toRenderResultId('wrong')),
        attempt: 2,
        objectKey: futureKey,
      })
    );
    const record = okValue(await store.blocked({ limit: 100 })).records.find(
      (row) => row.attempt === 2
    )!;
    expect(
      okValue(
        await store.requeue({
          ...input,
          requestId: 'future',
          fingerprint: record.fingerprint,
          attempt: 2,
        })
      ).type
    ).toBe('cleanup_attempt_invalid');
  });
  it('hands off intervention responsibility without deleting blocked evidence', async () => {
    const input = await repairInput();
    expect(okValue(await store.summary()).blockedOutstanding).toBe(1);
    okValue(await store.requeue(input));
    expect(okValue(await store.summary())).toMatchObject({
      blockedTotal: 1,
      blockedOutstanding: 0,
      outstandingReasons: [],
    });
    expect(
      okValue(await store.blocked({ limit: 100, outstanding: true })).records
    ).toEqual([]);
    expect(
      okValue(await store.blocked({ limit: 100 })).records[0]?.intervention
    ).toBe('handed_off');
  });
  it('audits unavailable-locator retention and protects request identities across actions', async () => {
    const input = await repairInput();
    await database.db
      .update(renderOutputCleanupBlocked)
      .set({ safeObjectKey: null });
    expect(okValue(await store.acknowledge(input)).type).toBe(
      'cleanup_acknowledged'
    );
    expect(okValue(await store.acknowledge(input)).type).toBe(
      'cleanup_acknowledged'
    );
    expect(okValue(await store.requeue(input)).type).toBe(
      'cleanup_repair_conflict'
    );
    expect(okValue(await store.summary())).toMatchObject({
      blockedTotal: 1,
      blockedOutstanding: 0,
    });
    expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
    const [event] = await database.db
      .select()
      .from(renderOutputCleanupRecovery);
    expect(event).toMatchObject({
      outcome: 'cleanup_acknowledged',
      reasonCode: 'locator_unavailable_retained',
      resultId: null,
      attempt: null,
      objectKey: null,
    });
    expect(okValue(await store.inspect(input.fingerprint))).toMatchObject({
      record: { intervention: 'acknowledged' },
    });
  });
  it('pages blocked history and outstanding evidence without removing earlier rows', async () => {
    const records = Array.from({ length: 121 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'),
      resultId: 'wrong',
      attempt: 1,
      reasonCode: 'RENDER_OUTPUT_TARGET_INVALID',
      createdAt: new Date(
        index < 110 ? '2026-11-07T01:02:03.123Z' : '2026-11-07T01:02:02.122Z'
      ),
    }));
    await database.db.insert(renderOutputCleanupBlocked).values(records);
    const first = okValue(
      await store.blocked({ limit: 100, outstanding: true })
    );
    expect(first.records).toHaveLength(100);
    if (first.pagination.type !== 'blocked_more')
      throw new Error('Expected next page');
    const second = okValue(
      await store.blocked({
        limit: 100,
        outstanding: true,
        after: first.pagination.cursor,
      })
    );
    expect(second.records).toHaveLength(21);
    expect(second.pagination.type).toBe('blocked_end');
    expect(
      new Set(
        [...first.records, ...second.records].map((row) => row.fingerprint)
      ).size
    ).toBe(121);
    expect(first.pagination.cursor.createdAt.endsWith('.123Z')).toBe(true);
    expect(
      await database.db.select().from(renderOutputCleanupBlocked)
    ).toHaveLength(121);
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back quarantine when blocked bookkeeping cannot commit',
    async () => {
      await seedAttempt('submitted');
      await enqueue();
      await database.db.execute(
        sql`alter table render_output_cleanup_blocked add constraint reject_blocked check(false)`
      );
      try {
        const deps = depsFor();
        const deletion = vi.spyOn(deps.objectStorage, 'deleteObject');
        expect(
          (await cleanupRenderOutput(deps, target.objectKey)).isError()
        ).toBe(true);
        expect(deletion).not.toHaveBeenCalled();
        const [row] = await database.db.select().from(renderOutputCleanup);
        expect(row).toMatchObject({
          claimToken: null,
          leaseUntil: null,
          attempts: 0,
        });
        expect(
          await database.db.select().from(renderOutputCleanupBlocked)
        ).toEqual([]);
      } finally {
        await database.db.execute(
          sql`alter table render_output_cleanup_blocked drop constraint reject_blocked`
        );
      }
    }
  );
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back failed acknowledgment and keeps intervention outstanding',
    async () => {
      const input = await repairInput();
      await database.db
        .update(renderOutputCleanupBlocked)
        .set({ safeObjectKey: null });
      await database.db.execute(
        sql`alter table render_output_cleanup_recovery add constraint reject_ack check(false)`
      );
      try {
        expect((await store.acknowledge(input)).isError()).toBe(true);
        expect(okValue(await store.summary()).blockedOutstanding).toBe(1);
        expect(
          await database.db.select().from(renderOutputCleanupRecovery)
        ).toEqual([]);
      } finally {
        await database.db.execute(
          sql`alter table render_output_cleanup_recovery drop constraint reject_ack`
        );
      }
    }
  );
  it.each(['pending', 'submitted', 'non-render'] as const)(
    'acknowledges intentional retention of %s without touching the render or cleanup queue',
    async (kind) => {
      if (kind !== 'non-render') await seedAttempt(kind);
      const input = await repairInput();
      if (kind === 'non-render')
        await database.db
          .update(renderOutputCleanupBlocked)
          .set({ safeObjectKey: 'region-masks/keep.png' });
      const before = await database.db.select().from(renderResultTable);
      const acknowledged = okValue(await store.acknowledge(input));
      expect(acknowledged).toEqual({
        type: 'cleanup_acknowledged',
        requestId: input.requestId,
        canonicalRequestId: input.requestId,
      });
      expect(await database.db.select().from(renderResultTable)).toEqual(
        before
      );
      expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
      expect(okValue(await store.summary())).toMatchObject({
        blockedTotal: 1,
        blockedOutstanding: 0,
      });
      const view = okValue(await store.inspect(input.fingerprint));
      expect(view).toMatchObject({
        record: { intervention: 'acknowledged' },
        recoveries: [{ reasonCode: 'operator_retained' }],
      });
      expect(
        JSON.stringify(okValue(await store.blocked({ limit: 100 })))
      ).not.toContain('raw.png');
    }
  );
  it('coalesces concurrent acknowledgments while reserving every replay identity across actions', async () => {
    const input = await repairInput('first');
    const ids = ['first', 'second', 'third'];
    const results = await Promise.all(
      ids.map((requestId) => store.acknowledge({ ...input, requestId }))
    );
    const values = results.map(okValue);
    const [event] = await database.db
      .select()
      .from(renderOutputCleanupRecovery);
    expect(event).toBeDefined();
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toHaveLength(1);
    expect(
      await database.db.select().from(renderOutputCleanupAcknowledgmentRequest)
    ).toHaveLength(2);
    for (const [index, value] of values.entries()) {
      expect(value).toMatchObject({
        type: 'cleanup_acknowledged',
        requestId: ids[index],
        canonicalRequestId: event!.requestId,
      });
      expect(
        okValue(await store.acknowledge({ ...input, requestId: ids[index]! }))
      ).toEqual(value);
      expect(
        okValue(await store.requeue({ ...input, requestId: ids[index]! })).type
      ).toBe('cleanup_repair_conflict');
      expect(
        okValue(
          await store.acknowledge({
            fingerprint: 'f'.repeat(64),
            requestId: ids[index]!,
          })
        ).type
      ).toBe('cleanup_repair_conflict');
    }
  });
  it('preserves historical duplicate acknowledgments and aliases the earliest canonical event', async () => {
    const input = await repairInput();
    await database.db.insert(renderOutputCleanupRecovery).values(
      ['old-first', 'old-second'].map((requestId, index) => ({
        requestId,
        fingerprint: input.fingerprint,
        outcome: 'cleanup_acknowledged' as const,
        reasonCode: 'locator_unavailable_retained',
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      }))
    );
    const before = await database.db.select().from(renderOutputCleanupRecovery);
    expect(okValue(await store.acknowledge(input))).toMatchObject({
      canonicalRequestId: 'old-first',
    });
    expect(
      okValue(await store.acknowledge({ ...input, requestId: 'old-second' }))
    ).toMatchObject({ canonicalRequestId: 'old-first' });
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toEqual(before);
  });
  it('allows repair after acknowledgment, shows handoff, rejects fresh acknowledgment and preserves old replays', async () => {
    const input = await repairInput('ack');
    const acknowledged = okValue(await store.acknowledge(input));
    okValue(await store.acknowledge({ ...input, requestId: 'ack-alias' }));
    expect(
      okValue(await store.requeue({ ...input, requestId: 'repair' })).type
    ).toBe('cleanup_requeued');
    expect(okValue(await store.inspect(input.fingerprint))).toMatchObject({
      record: { intervention: 'handed_off' },
    });
    expect(
      okValue(await store.acknowledge({ ...input, requestId: 'fresh-ack' }))
        .type
    ).toBe('cleanup_already_handed_off');
    expect(okValue(await store.acknowledge(input))).toEqual(acknowledged);
    expect(
      okValue(await store.acknowledge({ ...input, requestId: 'ack-alias' }))
    ).toMatchObject({ canonicalRequestId: 'ack' });
    expect(await database.db.select().from(renderOutputCleanup)).toHaveLength(
      1
    );
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toHaveLength(2);
  });
  it('correlates intervention state independently for acknowledged, handed-off and outstanding fingerprints', async () => {
    const identities = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      fingerprint: id.repeat(64),
      resultId: `result-${id}`,
      attempt: 1,
      safeObjectKey: `results/result-${id}/1/raw.png`,
      reasonCode: 'render_output_target_invalid',
      createdAt: new Date('2026-11-07T00:00:00.123Z'),
    }));
    await database.db.insert(renderOutputCleanupBlocked).values(identities);
    okValue(
      await store.acknowledge({
        requestId: 'keep-a',
        fingerprint: identities[0]!.fingerprint,
      })
    );
    okValue(
      await store.requeue({
        requestId: 'repair-b',
        fingerprint: identities[1]!.fingerprint,
        resultId: okValue(toRenderResultId('result-b')),
        attempt: 1,
      })
    );
    okValue(
      await store.acknowledge({
        requestId: 'keep-d',
        fingerprint: identities[3]!.fingerprint,
      })
    );
    okValue(
      await store.requeue({
        requestId: 'repair-d',
        fingerprint: identities[3]!.fingerprint,
        resultId: okValue(toRenderResultId('result-d')),
        attempt: 1,
      })
    );
    // Historical duplicate acknowledgments remain evidence of retention, never repair handoff.
    await database.db.insert(renderOutputCleanupRecovery).values(
      ['keep-e-first', 'keep-e-second'].map((requestId, index) => ({
        requestId,
        fingerprint: identities[4]!.fingerprint,
        outcome: 'cleanup_acknowledged' as const,
        reasonCode: 'operator_retained',
        createdAt: new Date(Date.UTC(2026, 10, 7, 0, 0, index)),
      }))
    );
    const statements: string[] = [];
    const query = database.db.$client.query.bind(database.db.$client);
    vi.spyOn(database.db.$client, 'query').mockImplementation(
      async (text, values) => {
        statements.push(
          typeof text === 'string' ? text : (text as { text: string }).text
        );
        return query(text, values);
      }
    );
    const listed = okValue(await store.blocked({ limit: 100 }));
    expect(
      listed.records.map(({ fingerprint, intervention }) => ({
        fingerprint,
        intervention,
      }))
    ).toEqual([
      { fingerprint: identities[0]!.fingerprint, intervention: 'acknowledged' },
      { fingerprint: identities[1]!.fingerprint, intervention: 'handed_off' },
      { fingerprint: identities[2]!.fingerprint, intervention: 'outstanding' },
      { fingerprint: identities[3]!.fingerprint, intervention: 'handed_off' },
      { fingerprint: identities[4]!.fingerprint, intervention: 'acknowledged' },
    ]);
    for (const record of listed.records) {
      expect(okValue(await store.inspect(record.fingerprint))).toMatchObject({
        record: { intervention: record.intervention },
      });
    }
    const projections = statements.filter((statement) =>
      statement.includes("then 'handed_off'")
    );
    expect(projections).toHaveLength(1);
    for (const statement of projections) {
      expect(statement).toContain(
        '"cleanup_intervention_event"."fingerprint" = "render_output_cleanup_blocked"."fingerprint"'
      );
      expect(statement).not.toContain('"fingerprint" = "fingerprint"');
    }
    const historyReads = statements.filter(
      (statement) =>
        statement.includes('from "render_output_cleanup_recovery"') &&
        !statement.includes('exists')
    );
    expect(historyReads).toHaveLength(5);
    const evidenceReads = statements.filter(
      (statement) =>
        statement.includes('from "render_output_cleanup_blocked"') &&
        !statement.includes('exists')
    );
    expect(evidenceReads).toHaveLength(5);
    expect(okValue(await store.summary())).toMatchObject({
      blockedTotal: 5,
      blockedOutstanding: 1,
      outstandingReasons: [{ code: 'render_output_target_invalid', count: 1 }],
    });
    expect(
      okValue(
        await store.blocked({ limit: 100, outstanding: true })
      ).records.map(({ fingerprint }) => fingerprint)
    ).toEqual([identities[2]!.fingerprint]);
  });
  it('resolves historical aliases to the earliest acknowledgment in two reads and rejects invalid targets', async () => {
    const input = await repairInput('old-first');
    await database.db.insert(renderOutputCleanupRecovery).values(
      ['old-first', 'old-second'].map((requestId, index) => ({
        requestId,
        fingerprint: input.fingerprint,
        outcome: 'cleanup_acknowledged' as const,
        reasonCode: 'operator_retained',
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      }))
    );
    await database.db.insert(renderOutputCleanupAcknowledgmentRequest).values({
      requestId: 'historical-alias',
      canonicalRequestId: 'old-second',
      fingerprint: input.fingerprint,
      createdAt: new Date(),
    });
    const query = database.db.$client.query.bind(database.db.$client);
    const reads = vi
      .spyOn(database.db.$client, 'query')
      .mockImplementation((text, values) => query(text, values));
    expect(
      await findCleanupRecoveryRequest(database.db, 'historical-alias')
    ).toMatchObject({ requestId: 'old-first' });
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockClear();
    expect(
      await findCleanupRecoveryRequest(database.db, 'old-second')
    ).toMatchObject({ requestId: 'old-first' });
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockClear();
    expect(
      await findCleanupRecoveryRequest(database.db, 'unknown-request')
    ).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockRestore();
    await database.db.insert(renderOutputCleanupAcknowledgmentRequest).values({
      requestId: 'mismatched-alias',
      canonicalRequestId: 'old-first',
      fingerprint: 'f'.repeat(64),
      createdAt: new Date(),
    });
    await expect(
      findCleanupRecoveryRequest(database.db, 'mismatched-alias')
    ).rejects.toMatchObject({ code: 'RENDER_OUTPUT_CLEANUP_FAILED' });
    okValue(await store.requeue({ ...input, requestId: 'repair' }));
    await database.db.insert(renderOutputCleanupAcknowledgmentRequest).values({
      requestId: 'repair-alias',
      canonicalRequestId: 'repair',
      fingerprint: input.fingerprint,
      createdAt: new Date(),
    });
    await expect(
      findCleanupRecoveryRequest(database.db, 'repair-alias')
    ).rejects.toMatchObject({ code: 'RENDER_OUTPUT_CLEANUP_FAILED' });
  });
  it('serializes acknowledgment against repair without canceling a handoff', async () => {
    const input = await repairInput();
    const [ack, repair] = await Promise.all([
      store.acknowledge({ ...input, requestId: 'ack-race' }),
      store.requeue(input),
    ]);
    expect(['cleanup_acknowledged', 'cleanup_already_handed_off']).toContain(
      okValue(ack).type
    );
    expect(okValue(repair).type).toBe('cleanup_requeued');
    expect(okValue(await store.inspect(input.fingerprint))).toMatchObject({
      record: { intervention: 'handed_off' },
    });
    expect(okValue(await store.summary())).toMatchObject({
      blockedTotal: 1,
      blockedOutstanding: 0,
    });
  });
  it('reconciles lost alias commits and preserves uncertainty until replay can confirm the canonical event', async () => {
    const input = await repairInput('canonical');
    okValue(await store.acknowledge(input));
    const run = database.db.$runInTransaction!;
    const loseReply = () =>
      vi
        .spyOn(database.db, '$runInTransaction')
        .mockImplementationOnce(async (work, options) => {
          await run(work, options);
          throw Object.assign(new Error('reply lost'), { code: 'EPIPE' });
        });
    loseReply();
    expect(
      okValue(await store.acknowledge({ ...input, requestId: 'alias-1' }))
    ).toMatchObject({ canonicalRequestId: 'canonical' });
    loseReply();
    vi.spyOn(database.db, 'select').mockImplementationOnce(() => {
      throw Object.assign(new Error('unavailable'), { code: 'ECONNRESET' });
    });
    expect(
      (await store.acknowledge({ ...input, requestId: 'alias-2' })).isError()
    ).toBe(true);
    expect(
      okValue(await store.acknowledge({ ...input, requestId: 'alias-2' }))
    ).toMatchObject({ canonicalRequestId: 'canonical' });
    expect(
      await database.db.select().from(renderOutputCleanupRecovery)
    ).toHaveLength(1);
    expect(
      await database.db.select().from(renderOutputCleanupAcknowledgmentRequest)
    ).toHaveLength(2);
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back alias bookkeeping failure without duplicating acknowledgment',
    async () => {
      const input = await repairInput('canonical');
      okValue(await store.acknowledge(input));
      await database.db.execute(
        sql`alter table render_output_cleanup_acknowledgment_request add constraint reject_alias check(false)`
      );
      try {
        expect(
          (
            await store.acknowledge({ ...input, requestId: 'failed-alias' })
          ).isError()
        ).toBe(true);
        expect(
          await database.db
            .select()
            .from(renderOutputCleanupAcknowledgmentRequest)
        ).toEqual([]);
        expect(
          await database.db.select().from(renderOutputCleanupRecovery)
        ).toHaveLength(1);
      } finally {
        await database.db.execute(
          sql`alter table render_output_cleanup_acknowledgment_request drop constraint reject_alias`
        );
      }
    }
  );
});
