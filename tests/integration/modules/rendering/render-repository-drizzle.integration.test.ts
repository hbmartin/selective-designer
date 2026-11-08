import { makeUserRow } from '@tests/server/db-fixtures';
import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { makeProviderReceipt } from '@tests/support/provider-receipt';
import { updateRenderResultFixture } from '@tests/support/render-result-fixture';
import { errorValue, okValue } from '@tests/support/result';
import { sql } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import type { AppError } from '@/modules/kernel';
import { errorCauses } from '@/modules/kernel/domain/errors/error-causes';
import {
  toDesignId,
  toImageId,
  toObjectKey,
  toRenderId,
  toRenderResultId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { providerCallReceipt } from '@/modules/kernel/infrastructure/db/schema';
import {
  image as imageTable,
  user as userTable,
} from '@/modules/kernel/infrastructure/db/schema';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { RenderRecipe } from '@/modules/rendering';
import {
  createRenderRepository,
  renderOutputCleanup,
  renderOutputCleanupBlocked,
} from '@/modules/rendering/testing';

const ownerId = unwrapParseResult(toUserId('owner-1'));
const designId = unwrapParseResult(toDesignId('design-1'));
const imageId = unwrapParseResult(toImageId('base-1'));
const key = (value: string) => unwrapParseResult(toObjectKey(value));
const renderId = (value: string) => unwrapParseResult(toRenderId(value));
const resultId = (value: string) => unwrapParseResult(toRenderResultId(value));

const recipe: RenderRecipe = {
  renderSourceImageId: imageId,
  source: { workingKey: 'working-images/b.png', width: 100, height: 50 },
  edits: [
    {
      kind: 'placement',
      id: 'e1',
      item: {
        itemId: 'item-1',
        itemVersionId: 'version-1',
        name: 'Chair',
        kind: 'product',
        referenceKey: 'item-cutouts/1.png',
      },
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      rotationDeg: 15,
      note: '',
    },
  ],
  prompt: 'Dusk',
  editMaskKey: 'edit-masks/m.png',
};

describe('RenderRepositoryDrizzle', () => {
  let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;
  let repository: ReturnType<typeof createRenderRepository>;

  beforeAll(async () => {
    database = await createRecoveryTestDatabase();
    repository = createRenderRepository({
      db: database.db,
      clock: { now: () => new Date() },
    });
  });

  beforeEach(async () => {
    await database.truncate();
    await database.db.insert(userTable).values(makeUserRow({ id: ownerId }));
    await createDesignRepository({ db: database.db }).create({
      id: designId,
      ownerId,
      name: okValue(toDesignName('Villa')),
      copiedFromDesignId: null,
      baseImage: {
        id: imageId,
        kind: 'base',
        originalKey: key('base-images/b.png'),
        originalContentType: 'image/png',
        original: { width: 100, height: 50 },
        workingKey: key('working-images/b.png'),
        working: { width: 100, height: 50 },
      },
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  it('saves drafts with optimistic revisions', async () => {
    expect(okValue(await repository.findDraft(imageId)).type).toBe(
      'draft_missing'
    );
    const editSet = { edits: [], prompt: 'first' };
    const first = okValue(
      await repository.saveDraft({
        designId,
        renderSourceImageId: imageId,
        editSet,
        expectedRevision: 0,
      })
    );
    expect(first).toMatchObject({
      type: 'draft_saved',
      draft: { revision: 1, editSet },
    });

    const stale = okValue(
      await repository.saveDraft({
        designId,
        renderSourceImageId: imageId,
        editSet: { edits: [], prompt: 'stale' },
        expectedRevision: 0,
      })
    );
    expect(stale).toMatchObject({
      type: 'draft_conflict',
      draft: { revision: 1 },
    });

    const second = okValue(
      await repository.saveDraft({
        designId,
        renderSourceImageId: imageId,
        editSet: { edits: [], prompt: 'second' },
        expectedRevision: 1,
      })
    );
    expect(second).toMatchObject({
      type: 'draft_saved',
      draft: { revision: 2 },
    });
  });

  it('stores renders with results in catalog order and round-trips the recipe', async () => {
    const created = okValue(
      await repository.createRender({
        attemptStartedAt: new Date('2026-11-02T12:00:00Z'),
        id: renderId('render-1'),
        designId,
        renderSourceImageId: imageId,
        batchId: null,
        batchOptionItemId: null,
        recipe,
        results: [
          {
            id: resultId('z-gpt'),
            modelId: 'gpt-image-2',
            status: 'pending',
            skipReason: null,
          },
          {
            id: resultId('a-krea'),
            modelId: 'krea-3',
            status: 'pending',
            skipReason: null,
          },
          {
            id: resultId('m-ideo'),
            modelId: 'ideogram-4-5',
            status: 'skipped',
            skipReason: 'too_many_references:4/3',
          },
        ],
      })
    );
    expect(created.render.recipe).toEqual(recipe);
    expect(created.render.results.map((r) => r.modelId)).toEqual([
      'krea-3',
      'ideogram-4-5',
      'gpt-image-2',
    ]);
    expect(created.render.results[1]).toMatchObject({
      status: 'skipped',
      skipReason: 'too_many_references:4/3',
      attempt: 1,
      settings: {},
    });

    const configured = createRenderRepository({
      clock: { now: () => new Date() },
      db: database.db,
      modelOrder: ['gpt-image-2', 'krea-3'],
    });
    const history = okValue(await configured.listRenders(designId));
    expect(history.renders[0]?.results.map((result) => result.modelId)).toEqual(
      ['gpt-image-2', 'krea-3', 'ideogram-4-5']
    );
  });

  it('updates results, preferred result and scheme names', async () => {
    await repository.createRender({
      attemptStartedAt: new Date('2026-11-02T12:00:00Z'),
      id: renderId('render-1'),
      designId,
      renderSourceImageId: imageId,
      batchId: null,
      batchOptionItemId: null,
      recipe,
      results: [
        {
          id: resultId('r1'),
          modelId: 'krea-3',
          status: 'pending',
          skipReason: null,
        },
      ],
    });
    const completedAt = new Date('2026-11-02T12:00:00.000Z');
    await updateRenderResultFixture(database.db, {
      resultId: resultId('r1'),
      changes: {
        status: 'succeeded',
        providerRequestId: 'req-1',
        settings: { quality: 'high', regions_count: 1 },
        costUsdMicros: 170_000,
        costSource: 'price_table',
        framingChanged: true,
        completedAt,
      },
    });
    await repository.setPreferredResult({
      renderId: renderId('render-1'),
      resultId: resultId('r1'),
    });
    await repository.setSchemeName({
      designId,
      resultId: resultId('r1'),
      name: 'Scheme A',
    });

    const found = okValue(await repository.findResult(resultId('r1')));
    expect(found.type).toBe('result_found');
    if (found.type !== 'result_found') return;
    expect(found.render.preferredResultId).toBe('r1');
    expect(found.result).toMatchObject({
      status: 'succeeded',
      providerRequestId: 'req-1',
      settings: { quality: 'high', regions_count: 1 },
      costUsdMicros: 170_000,
      costSource: 'price_table',
      framingChanged: true,
      schemeName: 'Scheme A',
      completedAt,
    });
    expect(okValue(await repository.findResult(resultId('missing'))).type).toBe(
      'result_not_found'
    );
  });

  it('lists a design’s renders newest first', async () => {
    for (const id of ['render-1', 'render-2']) {
      // oxlint-disable-next-line no-await-in-loop -- ordered inserts.
      await repository.createRender({
        attemptStartedAt: new Date('2026-11-02T12:00:00Z'),
        id: renderId(id),
        designId,
        renderSourceImageId: imageId,
        batchId: null,
        batchOptionItemId: null,
        recipe,
        results: [],
      });
      // oxlint-disable-next-line no-await-in-loop -- distinct timestamps.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const listed = okValue(await repository.listRenders(designId));
    expect(listed.renders.map((r) => r.id)).toEqual(['render-2', 'render-1']);
  });

  it('finds the render that produced an image and scores preferred results', async () => {
    const resultImageId = unwrapParseResult(toImageId('result-1'));
    await database.db.insert(imageTable).values({
      id: resultImageId,
      designId,
      kind: 'result',
      originalKey: 'results/r/1/raw.png',
      originalContentType: 'image/png',
      originalWidth: 100,
      originalHeight: 50,
      workingKey: 'results/r/1/raw.png',
      workingWidth: 100,
      workingHeight: 50,
    });
    await repository.createRender({
      attemptStartedAt: new Date('2026-11-02T12:00:00Z'),
      id: renderId('render-1'),
      designId,
      renderSourceImageId: imageId,
      batchId: null,
      batchOptionItemId: null,
      recipe,
      results: [
        {
          id: resultId('krea'),
          modelId: 'krea-3',
          status: 'pending',
          skipReason: null,
        },
        {
          id: resultId('gpt'),
          modelId: 'gpt-image-2',
          status: 'pending',
          skipReason: null,
        },
      ],
    });
    await updateRenderResultFixture(database.db, {
      resultId: resultId('krea'),
      changes: { status: 'succeeded', outputImageId: resultImageId },
    });
    await updateRenderResultFixture(database.db, {
      resultId: resultId('gpt'),
      changes: { status: 'succeeded' },
    });
    await repository.setPreferredResult({
      renderId: renderId('render-1'),
      resultId: resultId('krea'),
    });

    const produced = okValue(
      await repository.findRenderByOutputImage(resultImageId)
    );
    expect(produced.type === 'render_found' && produced.render.id).toBe(
      'render-1'
    );
    expect(
      okValue(await repository.findRenderByOutputImage(imageId)).type
    ).toBe('render_not_found');

    expect(okValue(await repository.scorecard(ownerId)).rows).toEqual([
      {
        modelId: 'krea-3',
        succeeded: 1,
        preferred: 1,
        rendersWithPreference: 1,
      },
      {
        modelId: 'gpt-image-2',
        succeeded: 1,
        preferred: 0,
        rendersWithPreference: 1,
      },
    ]);
    expect(
      okValue(
        await repository.scorecard(unwrapParseResult(toUserId('someone-else')))
      ).rows
    ).toEqual([]);
  });
  const newAttempt = async (status: 'pending' | 'submitted' = 'pending') => {
    const startedAt = new Date('2026-11-05T00:00:00Z');
    const input = {
      resultId: resultId('recovery'),
      attempt: 1,
      workflowRunId: 'worker-1',
      providerRequestId: 'request-1',
    };
    okValue(
      await repository.createRender({
        id: renderId('recovery'),
        designId,
        renderSourceImageId: imageId,
        batchId: null,
        batchOptionItemId: null,
        recipe,
        attemptStartedAt: startedAt,
        results: [
          {
            id: input.resultId,
            modelId: 'krea-3',
            status: 'pending',
            skipReason: null,
          },
        ],
      })
    );
    if (status === 'submitted') {
      okValue(await repository.claimExecution(input));
      okValue(
        await repository.saveSubmission({
          ...input,
          settings: {},
          prompt: '',
          attemptDeadlineAt: '2026-11-06T19:30:00.000Z',
          submittedAt: startedAt.toISOString(),
          accountingIdentity: {
            invocationId: 'test-invocation',
            providerRequestId: input.providerRequestId,
            receipt: makeProviderReceipt({
              designId,
              subjectId: input.resultId,
              providerRequestId: input.providerRequestId,
              startedAt: startedAt.toISOString(),
            }),
          },
        })
      );
    }
    return { input, startedAt };
  };
  const checkpointFor = (startedAt: Date) => ({
    receipt: makeProviderReceipt({
      designId,
      subjectId: 'recovery',
      providerRequestId: 'request-1',
    }),
    source: {
      kind: 'url' as const,
      url: 'https://provider.test/image?private=token',
    },
    objectKey: key('results/recovery/1/raw.img'),
    contentType: null,
    modelVersion: 'v1',
    costUsdMicros: 123,
    costSource: 'reported' as const,
    completedAt: startedAt.toISOString(),
  });
  it('rejects unowned failure writes and preserves claimed fences', async () => {
    const { input, startedAt } = await newAttempt();
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          providerRequestId: undefined,
          reason: 'claim unavailable',
          now: startedAt,
        })
      ).type
    ).toBe('result_attempt_superseded');
    okValue(await repository.claimExecution(input));
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          providerRequestId: undefined,
          reason: 'owned failure',
          now: startedAt,
        })
      ).type
    ).toBe('result_marked_failed');
    const replacement = {
      resultId: input.resultId,
      expectedAttempt: 1,
      startedAt,
      expiredBeforeMs: 0,
    };
    expect(okValue(await repository.retryAttempt(replacement)).type).toBe(
      'result_retry_claimed'
    );
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          providerRequestId: undefined,
          reason: 'late',
          now: startedAt,
        })
      ).type
    ).toBe('result_attempt_superseded');
    okValue(
      await repository.claimExecution({
        ...input,
        attempt: 2,
        workflowRunId: 'replacement',
      })
    );
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          attempt: 2,
          providerRequestId: undefined,
          reason: 'wrong owner',
          now: startedAt,
        })
      ).type
    ).toBe('result_attempt_superseded');
  });
  it.each(['pending', 'submitted'] as const)(
    'claims expired %s retries once and rejects every stale write',
    async (status) => {
      const { input, startedAt } = await newAttempt(status);
      const next = new Date(startedAt.getTime() + 30 * 60_000);
      expect(
        okValue(
          await repository.retryAttempt({
            resultId: input.resultId,
            expectedAttempt: 1,
            startedAt: next,
            expiredBeforeMs: startedAt.getTime() - 1,
          })
        ).type
      ).toBe('result_attempt_superseded');
      const outcomes = await Promise.all(
        [1, 2].map(() =>
          repository.retryAttempt({
            resultId: input.resultId,
            expectedAttempt: 1,
            startedAt: next,
            expiredBeforeMs: startedAt.getTime(),
          })
        )
      );
      expect(outcomes.map((value) => okValue(value).type).sort()).toEqual([
        'result_attempt_superseded',
        'result_retry_claimed',
      ]);
      const context = okValue(
        await repository.publicationContext(input.resultId)
      );
      expect(context).toMatchObject({
        context: {
          result: { status: 'pending', attempt: 2, attemptStartedAt: next },
          checkpoint: null,
          workflowRunId: null,
        },
      });
      expect(okValue(await repository.claimExecution(input)).type).toBe(
        'result_attempt_superseded'
      );
      expect(
        okValue(
          await repository.saveSubmission({
            ...input,
            settings: {},
            prompt: '',
            attemptDeadlineAt: '2026-11-06T19:30:00.000Z',
            submittedAt: next.toISOString(),
            accountingIdentity: {
              invocationId: 'test-invocation',
              providerRequestId: input.providerRequestId,
              receipt: makeProviderReceipt({
                designId,
                subjectId: input.resultId,
                providerRequestId: input.providerRequestId,
                startedAt: startedAt.toISOString(),
              }),
            },
          })
        ).type
      ).toBe('result_attempt_superseded');
      expect(
        okValue(
          await repository.saveOutput({
            ...input,
            checkpoint: checkpointFor(startedAt),
          })
        ).type
      ).toBe('result_attempt_superseded');
      expect(
        okValue(
          await repository.failResultAttempt({
            ...input,
            reason: 'late',
            now: next,
          })
        ).type
      ).toBe('result_attempt_superseded');
      expect(
        okValue(
          await repository.completeResultAttempt({
            ...input,
            imageId,
            completion: {
              modelVersion: null,
              costUsdMicros: 1,
              costSource: 'reported',
              completedAt: next,
              framingChanged: false,
            },
          })
        ).type
      ).toBe('result_attempt_superseded');
    }
  );
  it.each(['succeeded', 'failed'] as const)(
    'retires source URLs only on future %s transitions and retains references',
    async (status) => {
      const { input, startedAt } = await newAttempt('submitted');
      const checkpoint = checkpointFor(startedAt);
      okValue(await repository.saveOutput({ ...input, checkpoint }));
      if (status === 'succeeded')
        okValue(
          await repository.completeResultAttempt({
            ...input,
            imageId,
            completion: {
              modelVersion: 'v1',
              costUsdMicros: 123,
              costSource: 'reported',
              completedAt: startedAt,
              framingChanged: false,
            },
          })
        );
      else
        okValue(
          await repository.failResultAttempt({
            ...input,
            reason: 'source failed',
            now: startedAt,
          })
        );
      const context = okValue(
        await repository.publicationContext(input.resultId)
      );
      expect(context).toMatchObject({
        context: { checkpoint: { ...checkpoint, source: { kind: 'retired' } } },
      });
      expect(JSON.stringify(context)).not.toContain('private=token');
      expect(
        okValue(await repository.referencedOutputKeys([checkpoint.objectKey]))
          .keys
      ).toEqual([checkpoint.objectKey]);
      expect(
        okValue(await repository.saveOutput({ ...input, checkpoint })).type
      ).toBe(
        status === 'succeeded'
          ? 'result_already_completed'
          : 'result_attempt_superseded'
      );
    }
  );
  it('does not rewrite a pre-existing terminal checkpoint', async () => {
    const { input, startedAt } = await newAttempt('submitted');
    const checkpoint = checkpointFor(startedAt);
    okValue(await repository.saveOutput({ ...input, checkpoint }));
    await updateRenderResultFixture(database.db, {
      resultId: input.resultId,
      changes: { status: 'succeeded', outputImageId: imageId },
    });
    expect(
      okValue(await repository.publicationContext(input.resultId))
    ).toMatchObject({ context: { checkpoint } });
    expect(
      okValue(await repository.saveOutput({ ...input, checkpoint })).type
    ).toBe('result_already_completed');
  });
  it('serializes completion against an expired retry claim', async () => {
    const { input, startedAt } = await newAttempt('submitted');
    const values = await Promise.all([
      repository.completeResultAttempt({
        ...input,
        imageId,
        completion: {
          modelVersion: null,
          costUsdMicros: 1,
          costSource: 'reported',
          completedAt: startedAt,
          framingChanged: false,
        },
      }),
      repository.retryAttempt({
        resultId: input.resultId,
        expectedAttempt: 1,
        startedAt: new Date(startedAt.getTime() + 30 * 60_000),
        expiredBeforeMs: startedAt.getTime(),
      }),
    ]);
    expect(
      [okValue(values[0]).type, okValue(values[1]).type].filter(
        (type) => type !== 'result_attempt_superseded'
      )
    ).toHaveLength(1);
  });
  it('applies the migration default when a legacy writer omits the attempt timestamp', async () => {
    const { input } = await newAttempt();
    const before = Date.now();
    await database.db.$client.query(
      'INSERT INTO render_result (id, "renderId", "modelId", status) SELECT $1, "renderId", "modelId", status FROM render_result WHERE id = $2',
      ['legacy-default', input.resultId]
    );
    const legacy = okValue(
      await repository.publicationContext(resultId('legacy-default'))
    );
    expect(legacy.type).toBe('publication_context');
    if (legacy.type !== 'publication_context') return;
    expect(
      legacy.context.result.attemptStartedAt.getTime()
    ).toBeGreaterThanOrEqual(before - 1);
    expect(
      legacy.context.result.attemptStartedAt.getTime()
    ).toBeLessThanOrEqual(Date.now());
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back the receipt when checkpoint persistence is rejected',
    async () => {
      const { input, startedAt } = await newAttempt('submitted');
      await database.db.execute(
        sql`alter table render_result add constraint accounting_checkpoint_down check ("outputCheckpoint" is null)`
      );
      try {
        expect(
          (
            await repository.saveOutput({
              ...input,
              checkpoint: checkpointFor(startedAt),
            })
          ).isError()
        ).toBe(true);
        expect(
          await database.db.select().from(providerCallReceipt)
        ).toHaveLength(0);
        expect(
          okValue(await repository.publicationContext(input.resultId))
        ).toMatchObject({ context: { checkpoint: null } });
      } finally {
        await database.db.execute(
          sql`alter table render_result drop constraint accounting_checkpoint_down`
        );
      }
    }
  );
  it('retains losing paid receipts across Retry and parent deletion', async () => {
    const { input, startedAt } = await newAttempt('submitted');
    const first = checkpointFor(startedAt);
    okValue(await repository.saveOutput({ ...input, checkpoint: first }));
    const retry = okValue(
      await repository.retryAttempt({
        resultId: input.resultId,
        expectedAttempt: 1,
        startedAt: new Date(startedAt.getTime() + 31 * 60_000),
        expiredBeforeMs: startedAt.getTime(),
      })
    );
    expect(retry).toMatchObject({
      type: 'result_retry_claimed',
      cleanupId: first.objectKey,
    });
    expect(await database.db.select().from(renderOutputCleanup)).toMatchObject([
      { objectKey: first.objectKey, resultId: input.resultId, attempt: 1 },
    ]);
    const losing = {
      ...first,
      receipt: makeProviderReceipt({
        designId,
        subjectId: 'recovery',
        providerRequestId: 'second-paid-response',
        costUsdMicros: 456,
      }),
    };
    expect(
      okValue(await repository.saveOutput({ ...input, checkpoint: losing }))
        .type
    ).toBe('result_attempt_superseded');
    expect(await database.db.select().from(providerCallReceipt)).toHaveLength(
      2
    );
    await database.db.execute(sql`delete from design where id = ${designId}`);
    expect(await database.db.select().from(renderOutputCleanup)).toHaveLength(
      1
    );
    expect(await database.db.select().from(providerCallReceipt)).toHaveLength(
      2
    );
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back Retry and checkpoint clearing when cleanup enqueue fails',
    async () => {
      const { input, startedAt } = await newAttempt('submitted');
      okValue(
        await repository.saveOutput({
          ...input,
          checkpoint: checkpointFor(startedAt),
        })
      );
      await database.db.execute(
        sql`alter table render_output_cleanup add constraint reject_cleanup check (attempt < 0)`
      );
      try {
        expect(
          (
            await repository.retryAttempt({
              resultId: input.resultId,
              expectedAttempt: 1,
              startedAt: new Date(startedAt.getTime() + 31 * 60000),
              expiredBeforeMs: startedAt.getTime(),
            })
          ).isError()
        ).toBe(true);
        expect(
          okValue(await repository.publicationContext(input.resultId))
        ).toMatchObject({
          context: {
            result: { attempt: 1, status: 'submitted' },
            checkpoint: { objectKey: checkpointFor(startedAt).objectKey },
          },
        });
      } finally {
        await database.db.execute(
          sql`alter table render_output_cleanup drop constraint reject_cleanup`
        );
      }
    }
  );
  it.each([
    'region-masks/private.png',
    'https://signed.example/output?token=private',
    null,
    { source: 'private' },
    undefined,
  ])(
    'allows Retry while atomically recording blocked checkpoint evidence: %j',
    async (objectKey) => {
      const { input, startedAt } = await newAttempt('submitted');
      okValue(
        await repository.saveOutput({
          ...input,
          checkpoint: checkpointFor(startedAt),
        })
      );
      if (objectKey === undefined)
        await database.db.execute(
          sql`update render_result set "outputCheckpoint" = "outputCheckpoint" - 'objectKey' where id = ${input.resultId}`
        );
      else
        await database.db.execute(
          sql`update render_result set "outputCheckpoint" = jsonb_set("outputCheckpoint", '{objectKey}', ${JSON.stringify(objectKey)}::jsonb) where id = ${input.resultId}`
        );
      expect(
        okValue(
          await repository.retryAttempt({
            resultId: input.resultId,
            expectedAttempt: 1,
            startedAt: new Date(startedAt.getTime() + 31 * 60000),
            expiredBeforeMs: startedAt.getTime(),
          })
        )
      ).toMatchObject({
        type: 'result_retry_claimed',
        attempt: 2,
        cleanupId: null,
      });
      const evidence = await database.db
        .select()
        .from(renderOutputCleanupBlocked);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.safeObjectKey).toBe(
        objectKey === 'region-masks/private.png' ? objectKey : null
      );
      expect(JSON.stringify(evidence)).not.toContain('token=private');
      expect(await database.db.select().from(renderOutputCleanup)).toEqual([]);
    }
  );
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'rolls back Retry when blocked evidence cannot be saved',
    async () => {
      const { input, startedAt } = await newAttempt('submitted');
      okValue(
        await repository.saveOutput({
          ...input,
          checkpoint: checkpointFor(startedAt),
        })
      );
      await database.db.execute(
        sql`update render_result set "outputCheckpoint" = jsonb_set("outputCheckpoint", '{objectKey}', '"unsafe"'::jsonb) where id = ${input.resultId}`
      );
      await database.db.execute(
        sql`alter table render_output_cleanup_blocked add constraint reject_retry_blocked check (false)`
      );
      try {
        expect(
          (
            await repository.retryAttempt({
              resultId: input.resultId,
              expectedAttempt: 1,
              startedAt: new Date(startedAt.getTime() + 31 * 60000),
              expiredBeforeMs: startedAt.getTime(),
            })
          ).isError()
        ).toBe(true);
        expect(
          okValue(await repository.publicationContext(input.resultId))
        ).toMatchObject({
          context: {
            result: { attempt: 1, status: 'submitted' },
            checkpoint: { objectKey: 'unsafe' },
          },
        });
      } finally {
        await database.db.execute(
          sql`alter table render_output_cleanup_blocked drop constraint reject_retry_blocked`
        );
      }
    }
  );
  it('fails only the owner when a journaled request was not persisted', async () => {
    const { input, startedAt } = await newAttempt();
    okValue(await repository.claimExecution(input));
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          workflowRunId: 'intruder',
          submissionPersistenceFailure: true,
          reason: 'identity',
          now: startedAt,
        })
      ).type
    ).toBe('result_attempt_superseded');
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          submissionPersistenceFailure: true,
          reason: 'identity',
          now: startedAt,
        })
      ).type
    ).toBe('result_marked_failed');
  });
  it.each(['pending', 'submitted'] as const)(
    'replays a %s failure without rewriting the first completion',
    async (status) => {
      const { input, startedAt } = await newAttempt(status);
      okValue(await repository.claimExecution(input));
      const checkpoint = checkpointFor(startedAt);
      if (status === 'submitted')
        okValue(await repository.saveOutput({ ...input, checkpoint }));
      const context = {
        ...input,
        reason: 'first failure',
        now: startedAt,
        ...(status === 'pending'
          ? { submissionPersistenceFailure: true as const }
          : {}),
      };
      expect(okValue(await repository.failResultAttempt(context)).type).toBe(
        'result_marked_failed'
      );
      const first = okValue(
        await repository.publicationContext(input.resultId)
      );
      expect(
        okValue(
          await repository.failResultAttempt({
            ...context,
            now: new Date(startedAt.getTime() + 5000),
          })
        ).type
      ).toBe('result_marked_failed');
      expect(
        okValue(await repository.publicationContext(input.resultId))
      ).toEqual(first);
      for (const wrong of [
        { reason: 'different failure' },
        { workflowRunId: 'other' },
        { attempt: 2 },
        { providerRequestId: 'other', submissionPersistenceFailure: undefined },
      ]) {
        expect(
          okValue(await repository.failResultAttempt({ ...context, ...wrong }))
            .type
        ).toBe('result_attempt_superseded');
      }
    }
  );
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL).each([false, true])(
    'reconciles a committed failure reply with unavailable read=%s',
    async (unavailable) => {
      const { input, startedAt } = await newAttempt('submitted');
      const context = { ...input, reason: 'timed_out', now: startedAt };
      const query = database.db.$client.query.bind(database.db.$client);
      const lost = Object.assign(new Error('private lost write reply'), {
        code: 'EPIPE',
      });
      let wrote = false;
      const spy = vi
        .spyOn(database.db.$client, 'query')
        .mockImplementation(async (text, values) => {
          const statement =
            typeof text === 'string' ? text : (text as { text: string }).text;
          if (
            unavailable &&
            wrote &&
            statement.startsWith('select') &&
            statement.includes('"render_result"')
          )
            throw new Error('read unavailable');
          const result = await query(text, values);
          if (!wrote && statement.startsWith('update "render_result"')) {
            wrote = true;
            throw lost;
          }
          return result;
        });
      try {
        const saved = await repository.failResultAttempt(context);
        if (unavailable)
          expect([...errorCauses(errorValue(saved))]).toContain(lost);
        else expect(okValue(saved).type).toBe('result_marked_failed');
      } finally {
        spy.mockRestore();
      }
      expect(
        okValue(
          await repository.failResultAttempt({
            ...context,
            now: new Date(startedAt.getTime() + 5000),
          })
        ).type
      ).toBe('result_marked_failed');
      expect(
        okValue(await repository.publicationContext(input.resultId))
      ).toMatchObject({
        context: {
          result: { completedAt: startedAt, errorMessage: 'timed_out' },
        },
      });
    }
  );
  it('requires the expected request before failing submitted work', async () => {
    const { input, startedAt } = await newAttempt('submitted');
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          providerRequestId: undefined,
          reason: 'unknown request',
          now: startedAt,
        })
      ).type
    ).toBe('result_attempt_superseded');
    expect(
      okValue(
        await repository.failResultAttempt({
          ...input,
          providerRequestId: 'other-request',
          submissionPersistenceFailure: true,
          reason: 'identity',
          now: startedAt,
        })
      ).type
    ).toBe('result_attempt_superseded');
  });
  it('replays a lost checkpoint commit reply with one durable receipt', async () => {
    const { input, startedAt } = await newAttempt('submitted');
    const original = database.db.$runInTransaction!;
    database.db.$runInTransaction = async (work, options) => {
      await original(work, options);
      throw new Error('lost commit reply');
    };
    try {
      expect(
        (
          await repository.saveOutput({
            ...input,
            checkpoint: checkpointFor(startedAt),
          })
        ).isError()
      ).toBe(true);
    } finally {
      database.db.$runInTransaction = original;
    }
    expect(
      okValue(
        await repository.saveOutput({
          ...input,
          checkpoint: checkpointFor(startedAt),
        })
      ).type
    ).toBe('result_output_saved');
    expect(await database.db.select().from(providerCallReceipt)).toHaveLength(
      1
    );
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'reconciles lost submission replies and safely replays after unavailable checks',
    async () => {
      const { input, startedAt } = await newAttempt();
      okValue(await repository.claimExecution(input));
      const submission = {
        ...input,
        settings: {},
        prompt: 'test',
        attemptDeadlineAt: '2026-11-06T19:30:00.000Z',
        submittedAt: startedAt.toISOString(),
        accountingIdentity: {
          invocationId: 'accepted-invocation',
          providerRequestId: input.providerRequestId,
          receipt: makeProviderReceipt({
            designId,
            subjectId: input.resultId,
            providerRequestId: input.providerRequestId,
            startedAt: startedAt.toISOString(),
            status: 'submitted',
            costUsdMicros: undefined,
            costSource: 'unavailable',
            completedAt: undefined,
          }),
        },
      };
      const query = database.db.$client.query.bind(database.db.$client);
      const lost = Object.assign(new Error('submission reply lost'), {
        code: 'EPIPE',
      });
      let wrote = false;
      const spy = vi
        .spyOn(database.db.$client, 'query')
        .mockImplementation(async (text, values) => {
          const statement =
            typeof text === 'string' ? text : (text as { text: string }).text;
          if (
            wrote &&
            statement.startsWith('select') &&
            statement.includes('"render_result"')
          )
            throw Object.assign(new Error('reconciliation unavailable'), {
              code: 'ECONNRESET',
            });
          const result = await query(text, values);
          if (!wrote && statement.startsWith('update "render_result"')) {
            wrote = true;
            throw lost;
          }
          return result;
        });
      try {
        const saved = await repository.saveSubmission(submission);
        expect(saved.isError()).toBe(true);
        expect(saved.isError() && saved.getError()).toMatchObject({
          certainty: 'unknown',
        });
        if (saved.isError())
          expect([...errorCauses(saved.getError())]).toContain(lost);
      } finally {
        spy.mockRestore();
      }
      expect(
        okValue(
          await repository.reconcileSubmission({
            ...submission,
            attemptDeadlineAt: 'invalid',
          })
        )
      ).toEqual({
        type: 'result_submitted',
        providerRequestId: input.providerRequestId,
      });
      expect(okValue(await repository.saveSubmission(submission)).type).toBe(
        'result_submitted'
      );
      expect(
        okValue(await repository.publicationContext(input.resultId))
      ).toMatchObject({
        context: {
          result: {
            status: 'submitted',
            attempt: 1,
            providerRequestId: 'request-1',
          },
          accountingIdentity: { invocationId: 'accepted-invocation' },
        },
      });
    }
  );
  const journaled = (
    input: Awaited<ReturnType<typeof newAttempt>>['input'],
    startedAt: Date
  ) => ({
    ...input,
    settings: {},
    prompt: 'test',
    attemptDeadlineAt: 'invalid',
    submittedAt: startedAt.toISOString(),
    accountingIdentity: {
      invocationId: 'accepted-invocation',
      providerRequestId: input.providerRequestId,
      receipt: makeProviderReceipt({
        designId,
        subjectId: input.resultId,
        providerRequestId: input.providerRequestId,
        startedAt: startedAt.toISOString(),
        status: 'submitted',
        costUsdMicros: undefined,
        costSource: 'unavailable',
        completedAt: undefined,
      }),
    },
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL).each([
    ['unreadable', '275760-09-14 00:00:00'],
    ['computed deadline overflow', '275760-09-12 23:59:00'],
  ])(
    'rejects %s recovery timestamps without transient retries',
    async (_description, timestamp) => {
      const { input, startedAt } = await newAttempt();
      okValue(await repository.claimExecution(input));
      await database.db.execute(
        sql`update render_result set "attemptStartedAt" = ${timestamp}::timestamp where id = ${input.resultId}`
      );
      for (const read of [
        await repository.findResult(input.resultId),
        await repository.publicationContext(input.resultId),
      ])
        expect(errorValue<unknown, AppError>(read)).toMatchObject({
          code: 'RENDER_ROW_INVALID',
          retryable: false,
        });
      const result = await repository.reconcileSubmission(
        journaled(input, startedAt)
      );
      expect(errorValue<unknown, AppError>(result)).toMatchObject({
        code: 'RENDER_ROW_INVALID',
        category: 'system',
        status: 500,
        retryable: false,
      });
    }
  );
  it('rejects implausibly future active rows without rejecting finite terminal history', async () => {
    const { input } = await newAttempt();
    okValue(await repository.claimExecution(input));
    await database.db.execute(
      sql`update render_result set "attemptStartedAt" = '2099-01-01 00:00:00'::timestamp where id = ${input.resultId}`
    );
    for (const result of [
      await repository.findResult(input.resultId),
      await repository.findRender(renderId('recovery')),
      await repository.listRenders(designId),
      await repository.publicationContext(input.resultId),
    ]) {
      expect(errorValue<unknown, AppError>(result)).toMatchObject({
        code: 'RENDER_ROW_INVALID',
        retryable: false,
      });
    }
    await updateRenderResultFixture(database.db, {
      resultId: input.resultId,
      changes: { status: 'succeeded' },
    });
    expect(okValue(await repository.findResult(input.resultId)).type).toBe(
      'result_found'
    );
  });
  it('uses the injected clock at the exact five-minute future tolerance', async () => {
    const { input, startedAt } = await newAttempt();
    okValue(await repository.claimExecution(input));
    const current = createRenderRepository({
      db: database.db,
      clock: { now: () => startedAt },
    });
    await database.db.execute(
      sql`update render_result set "attemptStartedAt" = '2026-11-05 00:05:00'::timestamp where id = ${input.resultId}`
    );
    expect(okValue(await current.findResult(input.resultId)).type).toBe(
      'result_found'
    );
    expect(
      okValue(await current.reconcileSubmission(journaled(input, startedAt)))
    ).toMatchObject({
      type: 'submission_recovery_window',
      attemptDeadlineAt: '2026-11-05T00:35:00.000Z',
    });
    await database.db.execute(
      sql`update render_result set "attemptStartedAt" = '2026-11-05 00:05:00.001'::timestamp where id = ${input.resultId}`
    );
    expect(errorValue(await current.findResult(input.resultId))).toMatchObject({
      code: 'RENDER_ROW_INVALID',
      retryable: false,
    });
    expect(
      errorValue(await current.reconcileSubmission(journaled(input, startedAt)))
    ).toMatchObject({ code: 'RENDER_ROW_INVALID', retryable: false });
  });
  it('restores only the matching owned attempt original cutoff and stops replaced or deleted attempts', async () => {
    const { input, startedAt } = await newAttempt();
    okValue(await repository.claimExecution(input));
    const submission = journaled(input, startedAt);
    expect(okValue(await repository.reconcileSubmission(submission))).toEqual({
      type: 'submission_recovery_window',
      attemptDeadlineAt: '2026-11-05T00:30:00.000Z',
    });
    expect(
      okValue(
        await repository.reconcileSubmission({
          ...submission,
          workflowRunId: 'other',
        })
      ).type
    ).toBe('result_attempt_superseded');
    okValue(
      await repository.retryAttempt({
        resultId: input.resultId,
        expectedAttempt: 1,
        startedAt: new Date('2026-11-07T01:00:00Z'),
        expiredBeforeMs: Date.parse('2026-11-07T00:30:00Z'),
      })
    );
    expect(okValue(await repository.reconcileSubmission(submission)).type).toBe(
      'result_attempt_superseded'
    );
    await database.db.delete(imageTable);
    expect(okValue(await repository.reconcileSubmission(submission)).type).toBe(
      'result_attempt_superseded'
    );
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'reports a tested constraint rejection distinctly from an uncertain lost reply',
    async () => {
      const { input, startedAt } = await newAttempt();
      okValue(await repository.claimExecution(input));
      await database.db.execute(
        sql`alter table render_result add constraint reject_submission check(status <> 'submitted')`
      );
      try {
        const result = await repository.saveSubmission(
          journaled(input, startedAt)
        );
        expect(result.isError() && result.getError()).toMatchObject({
          certainty: 'rejected',
          retryable: false,
        });
        expect(
          okValue(
            await repository.reconcileSubmission(journaled(input, startedAt))
          ).type
        ).toBe('submission_recovery_window');
      } finally {
        await database.db.execute(
          sql`alter table render_result drop constraint reject_submission`
        );
      }
    }
  );
  it('requires every saved-submission attribute before reporting matching persistence evidence', async () => {
    const { input, startedAt } = await newAttempt();
    okValue(await repository.claimExecution(input));
    const submission = journaled(input, startedAt);
    okValue(await repository.saveSubmission(submission));
    expect(okValue(await repository.reconcileSubmission(submission))).toEqual({
      type: 'result_submitted',
      providerRequestId: input.providerRequestId,
    });
    for (const changed of [
      { prompt: 'other' },
      { settings: { changed: true } },
      { submittedAt: new Date(startedAt.getTime() + 1).toISOString() },
      {
        accountingIdentity: {
          ...submission.accountingIdentity,
          invocationId: 'other',
        },
      },
      { providerRequestId: 'other' },
      { workflowRunId: 'other' },
      { attempt: 2 },
    ])
      expect(
        okValue(
          await repository.reconcileSubmission({ ...submission, ...changed })
        )
      ).toEqual({ type: 'result_attempt_superseded' });
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'uses a single snapshot when a submission commits during reconciliation',
    async () => {
      const { input, startedAt } = await newAttempt();
      okValue(await repository.claimExecution(input));
      const submission = journaled(input, startedAt);
      const query = database.db.$client.query.bind(database.db.$client);
      let reads = 0;
      let committed = false;
      const spy = vi
        .spyOn(database.db.$client, 'query')
        .mockImplementation(async (text, values) => {
          const statement =
            typeof text === 'string' ? text : (text as { text: string }).text;
          const result = await query(text, values);
          if (
            statement.startsWith('select') &&
            statement.includes('"render_result"')
          ) {
            reads++;
            if (!committed) {
              committed = true;
              // The SELECT snapshot is pending, then the other connection's UPDATE commits before return.
              okValue(await repository.saveSubmission(submission));
            }
          }
          return result;
        });
      try {
        expect(
          okValue(await repository.reconcileSubmission(submission)).type
        ).toBe('submission_recovery_window');
        expect(reads).toBe(1);
        expect(
          okValue(await repository.reconcileSubmission(submission))
        ).toEqual({
          type: 'result_submitted',
          providerRequestId: input.providerRequestId,
        });
      } finally {
        spy.mockRestore();
      }
    }
  );
  it.each(['status', 'modelId'])(
    'marks invalid persisted %s as non-retryable for result and parent reads',
    async (column) => {
      const { input } = await newAttempt();
      await database.db.execute(
        sql`update render_result set ${sql.identifier(column)} = 'corrupt' where id = ${input.resultId}`
      );
      const result = await repository.findResult(input.resultId);
      expect(result.isError() && result.getError()).toMatchObject({
        code: 'RENDER_ROW_INVALID',
        retryable: false,
      });
      const render = await repository.findRender(renderId('recovery'));
      expect(render.isError() && render.getError()).toMatchObject({
        code: 'RENDER_ROW_INVALID',
        retryable: false,
      });
    }
  );
});
