import { updateRenderResultFixture } from '@tests/support/render-result-fixture';
import { makeUserRow } from '@tests/server/db-fixtures';
import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { okValue } from '@tests/support/result';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import {
  toDesignId,
  toImageId,
  toObjectKey,
  toRenderId,
  toRenderResultId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import {
  image as imageTable,
  user as userTable,
} from '@/modules/kernel/infrastructure/db/schema';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { RenderRecipe } from '@/modules/rendering';
import { createRenderRepository } from '@/modules/rendering/testing';

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
    repository = createRenderRepository({ db: database.db });
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
          submittedAt: startedAt,
        })
      );
    }
    return { input, startedAt };
  };
  const checkpointFor = (startedAt: Date) => ({
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
  it('fails an unclaimed pending attempt without weakening claimed or submitted fences', async () => {
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
            submittedAt: next,
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
});
