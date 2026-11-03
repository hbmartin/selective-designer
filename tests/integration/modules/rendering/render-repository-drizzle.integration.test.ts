import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
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
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
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
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  let repository: ReturnType<typeof createRenderRepository>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
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
  });

  it('updates results, preferred result and scheme names', async () => {
    await repository.createRender({
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
    await repository.updateResult({
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
});
