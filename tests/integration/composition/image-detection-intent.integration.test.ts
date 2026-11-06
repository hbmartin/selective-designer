import { Result } from '@bloodyowl/boxed';
import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { createFakeObjectStorage } from '@tests/support/fake-kernel-ports';
import { updateRenderResultFixture } from '@tests/support/render-result-fixture';
import { okValue } from '@tests/support/result';
import { getTableName } from 'drizzle-orm';
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
  renderImageIdentity,
  writeImageWithDetection,
  writeRenderImageWithDetection,
} from '@/composition/image-detection-intent';
import {
  createResultImages,
  createResultOutputReferences,
} from '@/composition/rendering-pipeline';
import { toDesignName } from '@/modules/design';
import * as designBackend from '@/modules/design/backend';
import { createDesignRepository } from '@/modules/design/testing';
import {
  AppError,
  toDesignId,
  toGeneratedId,
  toImageId,
  toItemId,
  toItemVersionId,
  toObjectKey,
  toProviderCallId,
  toRenderId,
  toRenderResultId,
  toUserId,
} from '@/modules/kernel';
import {
  createProviderAccounting,
  createProviderCallLog,
} from '@/modules/kernel/backend';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import {
  type BackgroundRemover,
  createMoodboardPipelineUseCases,
  toItemCategory,
  toItemName,
} from '@/modules/moodboard';
import { createItemRepository } from '@/modules/moodboard/testing';
import {
  createRenderingPipelineUseCases,
  type ImageModelAdapter,
  type MaskCompositor,
} from '@/modules/rendering';
import { createRenderRepository } from '@/modules/rendering/testing';
import {
  createSegmentationUseCases,
  RegionWriteError,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/testing';

import { createRecoveryTestDatabase } from '../../server/recovery-database';

const ownerId = okValue(toUserId('owner'));
const designId = okValue(toDesignId('design'));
const image = (id = 'result') => ({
  id: okValue(toImageId(id)),
  designId,
  kind: 'base' as const,
  originalKey: okValue(toObjectKey('renders/result.png')),
  originalContentType: 'image/png',
  original: { width: 100, height: 100 },
  workingKey: okValue(toObjectKey('renders/result.png')),
  working: { width: 100, height: 100 },
});

const nativeUrl = process.env.RECOVERY_TEST_DATABASE_URL;
// The socket emulator cannot safely replay SQL error responses. Its path
// rolls back real transactions with driver-shaped failures; native PostgreSQL
// uses a trigger to raise the same errors inside the server.
async function installIntentFault(
  db: Awaited<ReturnType<typeof createPgliteTestDatabase>>['db'],
  code: string,
  failures: number,
  table: 'active_detection' | 'region' = 'active_detection'
) {
  if (!nativeUrl) {
    const transact = db.$runInTransaction!;
    let remaining = failures;
    const spy = vi
      .spyOn(db, '$runInTransaction')
      .mockImplementation((work, options) =>
        transact(async (tx) => {
          let targeted = false;
          const insert = tx.insert;
          tx.insert = ((...args: Parameters<typeof tx.insert>) => {
            if (getTableName(args[0]) === table) targeted = true;
            return insert.apply(tx, args);
          }) as typeof tx.insert;
          const result = await work(tx);
          if (targeted && remaining-- > 0)
            throw new AppError({
              code: 'WRAPPED_DRIVER_ERROR',
              category: 'system',
              status: 500,
              cause: new Error('query failed', {
                cause: Object.assign(new Error('injected rollback'), { code }),
              }),
            });
          return result;
        }, options)
      );
    return async () => {
      spy.mockRestore();
    };
  }
  await db.$client.query('CREATE SEQUENCE image_write_fault_sequence');
  await db.$client
    .query(`CREATE FUNCTION fail_image_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF nextval('image_write_fault_sequence') <= ${failures} THEN RAISE EXCEPTION 'injected rollback' USING ERRCODE = '${code}'; END IF;
    RETURN NEW; END $$`);
  await db.$client.query(
    `CREATE TRIGGER image_write_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_image_intent()`
  );
  return async () => {
    await db.$client.query(
      `DROP TRIGGER IF EXISTS image_write_fault ON ${table}`
    );
    await db.$client.query('DROP FUNCTION IF EXISTS fail_image_intent()');
    await db.$client.query(
      'DROP SEQUENCE IF EXISTS image_write_fault_sequence'
    );
  };
}

describe('atomic image and detection writes', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  beforeAll(async () => {
    database = await createRecoveryTestDatabase();
  });
  beforeEach(async () => {
    await database.truncate();
    await database.db.insert(userTable).values(makeUserRow({ id: ownerId }));
  });
  afterAll(async () => {
    await database?.close();
  });

  const setup = () => {
    const createId = vi.fn(() => toGeneratedId('stable-write'));
    const kernel = {
      db: database.db,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      clock: { now: () => new Date('2026-11-05T00:00:00Z') },
      idGenerator: { createId },
    };
    const wait = vi.fn(async () => {});
    return {
      kernel,
      createId,
      wait,
      input: {
        id: designId,
        ownerId,
        name: okValue(toDesignName('Villa')),
        copiedFromDesignId: null,
        baseImage: image(),
      },
    };
  };

  it.each(['40001', '40P01', '55P03'])(
    'retries complete transactions after PostgreSQL %s rollbacks',
    async (code) => {
      const cleanup = await installIntentFault(database.db, code, 2);
      const ctx = setup();
      try {
        const result = await writeImageWithDetection(ctx.kernel, ctx.input, {
          delay: ctx.wait,
        });
        expect(okValue(result).design.baseImage.id).toBe(image().id);
        expect(ctx.createId).toHaveBeenCalledOnce();
        expect(ctx.wait.mock.calls).toEqual([[100], [300]]);
        expect(
          okValue(
            await createRegionRepository({ db: database.db }).matchImageWrite(
              image().id,
              'stable-write'
            )
          )
        ).toEqual({ type: 'image_write_matched' });
        const rows = okValue(
          await createDesignRepository({ db: database.db }).listImages({
            designId,
            kind: 'base',
          })
        );
        expect(rows.images).toHaveLength(1);
      } finally {
        await cleanup();
      }
    }
  );

  it('rolls back the image and intent after retry exhaustion', async () => {
    const cleanup = await installIntentFault(database.db, '40001', 3);
    const ctx = setup();
    try {
      expect(
        (
          await writeImageWithDetection(ctx.kernel, ctx.input, {
            delay: ctx.wait,
          })
        ).isError()
      ).toBe(true);
      expect(ctx.wait.mock.calls).toEqual([[100], [300]]);
      expect(
        okValue(
          await createDesignRepository({ db: database.db }).findImage(
            image().id
          )
        ).type
      ).toBe('image_not_found');
      expect(
        okValue(
          await createRegionRepository({ db: database.db }).findDetection(
            image().id
          )
        ).type
      ).toBe('no_detection');
    } finally {
      await cleanup();
    }
  });

  it('does not retry a constraint rejection or a configuration failure', async () => {
    const cleanup = await installIntentFault(database.db, '23514', 1);
    const ctx = setup();
    try {
      expect(
        (
          await writeImageWithDetection(ctx.kernel, ctx.input, {
            delay: ctx.wait,
          })
        ).isError()
      ).toBe(true);
      expect(ctx.wait).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
    const error = new AppError({
      code: 'CONFIGURATION_ERROR',
      category: 'system',
      status: 500,
    });
    const reject = vi
      .spyOn(database.db, '$runInTransaction')
      .mockRejectedValueOnce(error);
    const result = await writeImageWithDetection(ctx.kernel, ctx.input, {
      delay: ctx.wait,
    });
    expect(result.isError() && result.getError()).toBe(error);
    expect(ctx.wait).not.toHaveBeenCalled();
    reject.mockRestore();
  });

  it.each([undefined, 'EPIPE', '08006'])(
    'reconciles a committed image after a lost commit response with code %s',
    async (code) => {
      const ctx = setup();
      const transact = database.db.$runInTransaction!;
      const lost = Object.assign(new Error('commit response lost'), { code });
      let first = true;
      const spy = vi
        .spyOn(database.db, '$runInTransaction')
        .mockImplementation(async (work, options) => {
          const result = await transact(work, options);
          if (first) {
            first = false;
            throw lost;
          }
          return result;
        });
      try {
        expect(
          okValue(
            await writeImageWithDetection(ctx.kernel, ctx.input, {
              delay: ctx.wait,
            })
          ).design.baseImage.id
        ).toBe(image().id);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(ctx.wait).not.toHaveBeenCalled();
        expect(spy.mock.calls[1]?.[1]).toEqual({
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        });
      } finally {
        spy.mockRestore();
      }
    }
  );

  it.each([
    'rollback',
    'unavailable',
    'wrong identity',
    'wrong image',
  ] as const)(
    'preserves the original failure when reconciliation finds %s',
    async (scenario) => {
      const ctx = setup();

      const transact = database.db.$runInTransaction!;
      const lost = new Error('original commit diagnostic');
      let first = true;
      const spy = vi
        .spyOn(database.db, '$runInTransaction')
        .mockImplementation(async (work, options) => {
          if (first) {
            first = false;
            if (scenario === 'rollback')
              return transact(async (tx) => {
                await work(tx);
                throw lost;
              }, options);
            await transact(work, options);
            if (scenario === 'wrong image')
              await database.db.$client.query(
                "UPDATE image SET \"workingKey\" = 'another-key' WHERE id = 'result'"
              );
            if (scenario === 'wrong identity')
              await database.db.$client.query(
                'UPDATE active_detection SET "imageWriteId" = \'another-write\' WHERE "imageId" = \'result\''
              );
            throw lost;
          }
          if (scenario === 'unavailable')
            throw new Error('reconciliation unavailable');
          return transact(work, options);
        });
      try {
        const result = await writeImageWithDetection(ctx.kernel, ctx.input, {
          delay: ctx.wait,
        });
        expect(result.isError() && result.getError().cause).toBe(lost);
        expect(spy).toHaveBeenCalledTimes(4);
        expect(ctx.wait.mock.calls).toEqual([[100], [300]]);
      } finally {
        spy.mockRestore();
      }
    }
  );
  const renderSetup = async () => {
    const ctx = setup();
    okValue(await writeImageWithDetection(ctx.kernel, ctx.input));
    const renders = { ...createRenderRepository({ db: database.db }) };
    const resultId = okValue(toRenderResultId('render-result'));
    const sourceId = image().id;
    okValue(
      await renders.createRender({
        attemptStartedAt: new Date('2026-11-02T12:00:00Z'),
        id: okValue(toRenderId('render')),
        designId,
        renderSourceImageId: sourceId,
        batchId: null,
        batchOptionItemId: null,
        recipe: {
          renderSourceImageId: sourceId,
          source: { workingKey: 'source.png', width: 1, height: 1 },
          edits: [],
          prompt: '',
          editMaskKey: 'mask.png',
        },
        results: [
          {
            id: resultId,
            modelId: 'krea-3',
            status: 'pending',
            skipReason: null,
          },
        ],
      })
    );
    okValue(
      await updateRenderResultFixture(ctx.kernel.db, {
        resultId,
        changes: { status: 'submitted', providerRequestId: 'paid-request' },
      })
    );
    const storage = createFakeObjectStorage();
    const bytes = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const kernel = {
      ...ctx.kernel,
      objectStorage: storage.storage,
      providerAccounting: createProviderAccounting({
        db: database.db,
        clock: ctx.kernel.clock,
        logger: ctx.kernel.logger,
      }),
    };
    const scheduler = {
      schedule: vi.fn(async () =>
        Result.Ok({ type: 'auto_detection_scheduled' as const })
      ),
    };
    const resultImages = createResultImages(kernel, scheduler);
    const poll = vi.fn<ImageModelAdapter['poll']>().mockResolvedValue(
      Result.Ok({
        type: 'model_completed',
        outputUrl: null,
        outputBytes: { bytes, contentType: 'image/png' },
        modelVersion: 'v1',
        costUsdMicros: 123,
        costSource: 'reported',
      })
    );
    const pipeline = createRenderingPipelineUseCases({
      ...kernel,
      renderRepository: renders,
      resultImages,
      resultOutputReferences: createResultOutputReferences(
        createDesignRepository({ db: ctx.kernel.db }),
        renders
      ),
      renderInputs: { sourceImage: vi.fn(), item: vi.fn(), region: vi.fn() },
      maskCompositor: {
        composeEditMask: vi.fn<MaskCompositor['composeEditMask']>(),
        maskForModel: vi.fn<MaskCompositor['maskForModel']>(),
      },
      imageModels: {
        adapterFor: () => ({
          submit: vi.fn<ImageModelAdapter['submit']>(),
          poll,
        }),
      },
    });
    const identity = {
      resultId,
      attempt: 1,
      providerRequestId: 'paid-request',
      workflowRunId: 'workflow-1',
    };
    okValue(await renders.claimExecution(identity));
    return {
      ...ctx,
      kernel,
      renders,
      resultImages,
      storage,
      scheduler,
      pipeline,
      poll,
      bytes,
      identity,
    };
  };

  it('reuses existing accounting when recovering a pre-receipt render attempt', async () => {
    const ctx = await renderSetup();
    const legacyId = okValue(
      toProviderCallId(
        `render:${ctx.identity.resultId}:${ctx.identity.attempt}`
      )
    );
    okValue(
      await createProviderCallLog({ db: database.db }).record({
        id: legacyId,
        userId: undefined,
        designId,
        purpose: 'render',
        provider: 'fal',
        endpoint: 'krea/v3/edit',
        subjectId: ctx.identity.resultId,
        providerRequestId: ctx.identity.providerRequestId,
        status: 'succeeded',
        costUsdMicros: 123,
        costSource: 'reported',
        details: {},
        startedAt: ctx.kernel.clock.now(),
        completedAt: ctx.kernel.clock.now(),
      })
    );
    const before = (
      await database.db.$client.query('SELECT * FROM provider_call')
    ).rows;
    expect(okValue(await ctx.pipeline.poll(ctx.identity)).type).toBe(
      'result_succeeded'
    );
    expect(
      (await database.db.$client.query('SELECT * FROM provider_call')).rows
    ).toEqual(before);
    expect(
      (await database.db.$client.query('SELECT id FROM provider_call_receipt'))
        .rows
    ).toHaveLength(1);
  });

  it.skipIf(!nativeUrl)(
    'publishes paid output while cost-log delivery remains unavailable',
    async () => {
      const ctx = await renderSetup();
      await database.db.$client.query(
        `ALTER TABLE provider_call ADD CONSTRAINT accounting_publication_test_down CHECK (status <> 'succeeded')`
      );
      try {
        expect(okValue(await ctx.pipeline.poll(ctx.identity)).type).toBe(
          'result_succeeded'
        );
        expect(ctx.poll).toHaveBeenCalledOnce();
        const { rows } = await database.db.$client.query(
          'SELECT id, "deliveredAt" FROM provider_call_receipt'
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.deliveredAt).toBeNull();
        expect(
          (await database.db.$client.query('SELECT id FROM provider_call')).rows
        ).toHaveLength(0);
      } finally {
        await database.db.$client.query(
          'ALTER TABLE provider_call DROP CONSTRAINT accounting_publication_test_down'
        );
      }
      const { rows } = await database.db.$client.query(
        'SELECT id FROM provider_call_receipt'
      );
      expect(
        okValue(
          await ctx.kernel.providerAccounting.deliver(
            okValue(toProviderCallId(String(rows[0]?.id)))
          )
        ).type
      ).toBe('receipt_delivered');
      expect(ctx.poll).toHaveBeenCalledOnce();
    }
  );

  it('recovers a stored URL render after publication failed and the provider URL expired', async () => {
    const ctx = await renderSetup();
    const url = 'https://provider.test/raw';
    ctx.storage.addRemoteSource(url, {
      bytes: ctx.bytes,
      contentType: 'image/png',
    });
    ctx.poll.mockResolvedValue(
      Result.Ok({
        type: 'model_completed',
        outputUrl: url,
        outputBytes: null,
        modelVersion: 'v1',
        costUsdMicros: 123,
        costSource: 'reported',
      })
    );
    const cleanup = await installIntentFault(database.db, '23514', 1);
    try {
      expect((await ctx.pipeline.poll(ctx.identity)).isError()).toBe(true);
    } finally {
      await cleanup();
    }
    const context = okValue(
      await ctx.renders.publicationContext(ctx.identity.resultId)
    );
    expect(context).toMatchObject({
      type: 'publication_context',
      context: {
        checkpoint: { source: { kind: 'url', url } },
        result: { status: 'submitted' },
      },
    });
    ctx.poll.mockRejectedValue(new Error('provider result expired'));
    const copy = vi
      .spyOn(ctx.storage.storage, 'copyNewObjectFromUrl')
      .mockRejectedValue(new Error('source URL expired'));
    expect(okValue(await ctx.pipeline.poll(ctx.identity))).toEqual({
      type: 'result_succeeded',
    });
    expect(copy).not.toHaveBeenCalled();
    expect(ctx.poll).toHaveBeenCalledOnce();
    expect(
      ctx.storage.objects.get(`results/${ctx.identity.resultId}/1/raw.img`)
        ?.bytes
    ).toEqual(ctx.bytes);
    expect(
      (await database.db.$client.query('SELECT id FROM provider_call')).rows
    ).toHaveLength(1);
  });

  it('recovers a checkpoint whose successful database reply was lost', async () => {
    const ctx = await renderSetup();
    const save = ctx.renders.saveOutput;
    const lost = new AppError({
      code: 'REPLY_LOST',
      category: 'system',
      status: 502,
      cause: { code: 'EPIPE' },
    });
    const spy = vi
      .spyOn(ctx.renders, 'saveOutput')
      .mockImplementationOnce(async (input) => {
        okValue(await save(input));
        return Result.Error(lost);
      });
    try {
      expect((await ctx.pipeline.poll(ctx.identity)).isError()).toBe(true);
    } finally {
      spy.mockRestore();
    }
    ctx.poll.mockRejectedValue(new Error('must load the durable checkpoint'));
    expect(okValue(await ctx.pipeline.poll(ctx.identity))).toEqual({
      type: 'result_succeeded',
    });
    expect(ctx.poll).toHaveBeenCalledOnce();
  });

  it('atomically claims retries, clears recovery state, and fences stale execution failures', async () => {
    const ctx = await renderSetup();
    const duplicate = okValue(
      await ctx.renders.claimExecution({
        ...ctx.identity,
        workflowRunId: 'duplicate',
      })
    );
    expect(duplicate.type).toBe('result_attempt_superseded');
    okValue(
      await ctx.renders.saveOutput({
        ...ctx.identity,
        checkpoint: {
          source: { kind: 'url', url: 'https://provider.test/old' },
          objectKey: okValue(toObjectKey('results/old.img')),
          contentType: null,
          modelVersion: null,
          costUsdMicros: 1,
          costSource: 'reported',
          completedAt: new Date().toISOString(),
        },
      })
    );
    okValue(
      await ctx.renders.failResultAttempt({
        ...ctx.identity,
        reason: 'failed',
        now: new Date(),
      })
    );
    const claims = await Promise.all(
      [1, 2].map(() =>
        ctx.renders.retryAttempt({
          startedAt: new Date(),
          expiredBeforeMs: 0,
          resultId: ctx.identity.resultId,
          expectedAttempt: 1,
        })
      )
    );
    expect(claims.map((value) => okValue(value).type).sort()).toEqual([
      'result_attempt_superseded',
      'result_retry_claimed',
    ]);
    const current = okValue(
      await ctx.renders.publicationContext(ctx.identity.resultId)
    );
    expect(current).toMatchObject({
      type: 'publication_context',
      context: {
        checkpoint: null,
        workflowRunId: null,
        result: { attempt: 2, status: 'pending' },
      },
    });
    expect(
      okValue(
        await ctx.renders.failResultAttempt({
          ...ctx.identity,
          reason: 'old timeout',
          now: new Date(),
        })
      ).type
    ).toBe('result_attempt_superseded');
    expect(
      okValue(
        await ctx.renders.saveSubmission({
          ...ctx.identity,
          providerRequestId: 'stale',
          settings: {},
          prompt: '',
          submittedAt: new Date(),
        })
      ).type
    ).toBe('result_attempt_superseded');
  });

  it.each(['source read', 'publication', 'checkpoint reply'] as const)(
    'recovers cutout %s against persisted PostgreSQL checkpoints',
    async (phase) => {
      const ctx = await renderSetup();
      const items = { ...createItemRepository({ db: database.db }) };
      const versionId = okValue(toItemVersionId('cutout-version'));
      const attempt = { versionId, attemptId: 'cutout-attempt' };
      okValue(
        await items.create({
          id: okValue(toItemId('cutout-item')),
          designId,
          kind: 'product',
          name: okValue(toItemName('Chair')),
          category: okValue(toItemCategory('Furniture')),
          vendor: null,
          productUrl: null,
          version: {
            id: versionId,
            photo: {
              key: image().workingKey,
              contentType: 'image/png',
              width: 100,
              height: 100,
            },
            cutoutKey: null,
            maskKey: null,
            cutoutStatus: 'pending',
            cutoutAttempt: { id: attempt.attemptId, startedAt: new Date() },
          },
        })
      );
      const url = 'https://provider.test/cutout';
      ctx.storage.addRemoteSource(url, {
        bytes: ctx.bytes,
        contentType: 'image/png',
      });
      const remove = vi
        .fn<BackgroundRemover['removeBackground']>()
        .mockResolvedValue(
          Result.Ok({
            type: 'background_removed',
            result: { kind: 'url', url },
            provider: 'fal',
            endpoint: 'birefnet',
            providerRequestId: 'paid-cutout',
            costUsdMicros: 321,
            costSource: 'reported',
          })
        );
      const pipeline = createMoodboardPipelineUseCases({
        ...ctx.kernel,
        itemRepository: items,
        designAccess: {
          ownerOf: async () => Result.Ok({ type: 'owner', userId: ownerId }),
          isOwnedBy: vi.fn(),
        },
        backgroundRemover: { removeBackground: remove },
      });
      const error = new AppError({
        code: 'REPLY_LOST',
        category: 'system',
        status: 502,
        cause: { code: 'EPIPE' },
      });
      const copy = vi.spyOn(ctx.storage.storage, 'copyNewObjectFromUrl');
      if (phase === 'source read')
        copy.mockResolvedValueOnce(Result.Error(error));
      if (phase === 'publication')
        vi.spyOn(items, 'finishCutoutAttempt').mockResolvedValueOnce(
          Result.Error(error)
        );
      if (phase === 'checkpoint reply') {
        const save = items.saveCutoutOutput;
        vi.spyOn(items, 'saveCutoutOutput').mockImplementationOnce(
          async (input) => {
            okValue(await save(input));
            return Result.Error(error);
          }
        );
      }
      const failed = await pipeline.removeBackground(attempt);
      expect(failed.isError() && failed.getError()).toBe(error);
      expect(okValue(await items.findVersion(versionId))).toMatchObject({
        cutoutOutput: { source: { kind: 'url', url } },
      });
      remove.mockRejectedValue(
        new Error('must never purchase the checkpointed work again')
      );
      if (phase === 'publication')
        copy.mockRejectedValue(new Error('source URL expired'));
      expect(okValue(await pipeline.removeBackground(attempt))).toEqual({
        type: 'cutout_ready',
      });
      expect(remove).toHaveBeenCalledOnce();
      expect(
        (
          await database.db.$client.query(
            'SELECT status, "costUsdMicros" FROM provider_call WHERE purpose = \'background_removal\''
          )
        ).rows
      ).toEqual([{ status: 'succeeded', costUsdMicros: '321' }]);
      expect(
        ctx.storage.objects.get(
          `item-cutouts/${versionId}/${attempt.attemptId}.png`
        )?.bytes
      ).toEqual(ctx.bytes);
    }
  );

  it('reuses a committed render after every immediate reconciliation read failed', async () => {
    const ctx = await renderSetup();
    // Prepare a paid checkpoint and accounting before injecting a lost publication reply.
    const prepareFault = await installIntentFault(database.db, '23514', 1);
    try {
      expect((await ctx.pipeline.poll(ctx.identity)).isError()).toBe(true);
    } finally {
      await prepareFault();
    }
    const transact = database.db.$runInTransaction!;
    const lost = Object.assign(new Error('lost reply'), { code: 'EPIPE' });
    let committed = false;
    const spy = vi
      .spyOn(database.db, '$runInTransaction')
      .mockImplementation(async (work, options) => {
        if (committed) throw new Error('database unavailable');
        await transact(work, options);
        committed = true;
        throw lost;
      });
    try {
      const outcome = await ctx.pipeline.poll(ctx.identity);
      expect(outcome.isError() && outcome.getError().cause).toBe(lost);
      expect(ctx.scheduler.schedule).not.toHaveBeenCalled();
      expect(ctx.kernel.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'image.write.unresolved' })
      );
    } finally {
      spy.mockRestore();
    }
    const copy = vi.spyOn(ctx.storage.storage, 'createObject');
    expect(okValue(await ctx.pipeline.poll(ctx.identity))).toEqual({
      type: 'result_succeeded',
    });
    expect(ctx.poll).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
    const images = okValue(
      await createDesignRepository({ db: database.db }).listImages({
        designId,
        kind: 'result',
      })
    );
    expect(images.images).toHaveLength(1);
    expect(images.images[0]?.id).toBe(
      renderImageIdentity(ctx.identity).imageId
    );
    expect(ctx.scheduler.schedule).toHaveBeenCalledOnce();
    const calls = await database.db.$client.query(
      'SELECT status, "costUsdMicros" FROM provider_call'
    );
    expect(calls.rows).toEqual([{ status: 'succeeded', costUsdMicros: '123' }]);
  });

  it.skipIf(!nativeUrl)(
    'serializes simultaneous completions and preserves the winning object and intent',
    async () => {
      const ctx = await renderSetup();
      const results = await Promise.all([
        ctx.pipeline.poll(ctx.identity),
        ctx.pipeline.poll(ctx.identity),
      ]);
      expect(results.every((value) => value.isOk())).toBe(true);
      const images = okValue(
        await createDesignRepository({ db: database.db }).listImages({
          designId,
          kind: 'result',
        })
      );
      expect(images.images).toHaveLength(1);
      expect(
        ctx.storage.objects.get(`results/${ctx.identity.resultId}/1/raw.png`)
          ?.bytes
      ).toEqual(ctx.bytes);
      const intent = okValue(
        await createRegionRepository({ db: database.db }).findDetection(
          images.images[0]!.id
        )
      );
      expect(intent).toMatchObject({
        imageWriteId: renderImageIdentity(ctx.identity).writeId,
      });
    }
  );

  it('keeps separate images for explicitly retried attempts and rejects a stale completion', async () => {
    const ctx = await renderSetup();
    okValue(await ctx.pipeline.poll(ctx.identity));
    okValue(
      await updateRenderResultFixture(ctx.kernel.db, {
        resultId: ctx.identity.resultId,
        changes: {
          attempt: 2,
          status: 'submitted',
          providerRequestId: 'second-paid-request',
          outputImageId: null,
        },
      })
    );
    expect(
      okValue(await ctx.resultImages.findRegistered(ctx.identity))
    ).toEqual({ type: 'result_attempt_superseded' });
    const stale = await writeRenderImageWithDetection(ctx.kernel, {
      ...ctx.identity,
      designId,
      image: { ...image(), kind: 'result' },
      carryFromImageId: image().id,
      completion: {
        modelVersion: null,
        costUsdMicros: 1,
        costSource: 'reported',
        completedAt: ctx.kernel.clock.now(),
        framingChanged: false,
      },
    });
    expect(okValue(stale)).toEqual({ type: 'result_attempt_superseded' });
    const second = {
      ...ctx.identity,
      attempt: 2,
      providerRequestId: 'second-paid-request',
      workflowRunId: 'workflow-2',
    };
    await database.db.$client.query(
      'UPDATE render_result SET "workflowRunId" = NULL, "outputCheckpoint" = NULL WHERE id = $1',
      [ctx.identity.resultId]
    );
    okValue(await ctx.renders.claimExecution(second));
    okValue(await ctx.pipeline.poll(second));
    const images = okValue(
      await createDesignRepository({ db: database.db }).listImages({
        designId,
        kind: 'result',
      })
    );
    expect(images.images).toHaveLength(2);
    const failed = okValue(
      await ctx.renders.failResultAttempt({
        ...ctx.identity,
        reason: 'late failure',
        now: ctx.kernel.clock.now(),
      })
    );
    expect(failed.type).toBe('result_attempt_superseded');
    const current = okValue(
      await ctx.renders.findResult(ctx.identity.resultId)
    );
    expect(current).toMatchObject({
      result: { attempt: 2, status: 'succeeded', costUsdMicros: 123 },
    });
  });

  it('rolls back render completion, image and intent together while retaining paid cost', async () => {
    const ctx = await renderSetup();
    const cleanup = await installIntentFault(database.db, '23514', 1);
    try {
      expect((await ctx.pipeline.poll(ctx.identity)).isError()).toBe(true);
      expect(
        okValue(await ctx.renders.findResult(ctx.identity.resultId))
      ).toMatchObject({ result: { status: 'submitted', outputImageId: null } });
      expect(
        okValue(
          await createDesignRepository({ db: database.db }).findImage(
            renderImageIdentity(ctx.identity).imageId
          )
        ).type
      ).toBe('image_not_found');
      expect(
        okValue(
          await createRegionRepository({ db: database.db }).findDetection(
            renderImageIdentity(ctx.identity).imageId
          )
        ).type
      ).toBe('no_detection');
      expect(
        (await database.db.$client.query('SELECT status FROM provider_call'))
          .rows
      ).toEqual([{ status: 'succeeded' }]);
    } finally {
      await cleanup();
    }
  });

  it('rejects a mismatched saved image before committing its intent', async () => {
    const ctx = setup();
    const original = designBackend.createDesignRepository;
    const spy = vi
      .spyOn(designBackend, 'createDesignRepository')
      .mockImplementation((input) => {
        const repository = original(input);
        return {
          ...repository,
          async create(value) {
            return (await repository.create(value)).map((saved) => ({
              ...saved,
              design: {
                ...saved.design,
                baseImage: {
                  ...saved.design.baseImage,
                  id: okValue(toImageId('wrong-image')),
                },
              },
            }));
          },
        };
      });
    try {
      expect(
        (await writeImageWithDetection(ctx.kernel, ctx.input)).isError()
      ).toBe(true);
      expect(
        okValue(await original({ db: database.db }).findImage(image().id)).type
      ).toBe('image_not_found');
    } finally {
      spy.mockRestore();
    }
  });
  it
    .skipIf(!nativeUrl)
    .each(['40001', '40P01', '55P03', 'XX000', '53000', '58030'])(
    'preserves cleanup certainty for server-reported %s',
    async (code) => {
      const ctx = await renderSetup();
      const regions = createRegionRepository({ db: database.db });
      const useCases = createSegmentationUseCases({
        ...ctx.kernel,
        regionRepository: regions,
        imageAccess: {
          find: async () =>
            Result.Ok({
              type: 'image_found',
              image: {
                imageId: image().id,
                designId,
                ownerId,
                workingKey: image().workingKey,
                width: 100,
                height: 100,
              },
            }),
        },
        permissionChecker: {
          hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
        },
        uploadIntentStore: { consume: vi.fn(), remember: vi.fn() },
        detectionRetry: { retry: vi.fn() },
        segmenter: {
          segment: async () =>
            Result.Ok({
              type: 'segmented',
              provider: 'fake',
              endpoint: 'sam',
              costUsdMicros: 10,
              costSource: 'reported',
              providerRequestId: 'sam-paid',
              masks: [
                {
                  mask: { kind: 'bytes', bytes: Uint8Array.of(1) },
                  box: [0, 0, 1, 1],
                  score: 1,
                },
              ],
            }),
        },
      });
      const cleanup = await installIntentFault(database.db, code, 1, 'region');
      try {
        const result = await useCases.segment({
          currentUserId: ownerId,
          imageId: image().id,
          prompt: { type: 'text', text: 'chair' },
          label: 'chair',
        });
        expect(result.isError() && result.getError()).toBeInstanceOf(
          RegionWriteError
        );
        expect(result.isError() && result.getError()).toMatchObject({
          publication: ['40001', '40P01', '55P03'].includes(code)
            ? 'rejected'
            : 'unknown',
        });
        expect(ctx.storage.objects.size).toBe(
          ['40001', '40P01', '55P03'].includes(code) ? 0 : 1
        );
        expect(
          (await database.db.$client.query('SELECT id FROM region')).rows
        ).toEqual([]);
      } finally {
        await cleanup();
      }
    }
  );
});
