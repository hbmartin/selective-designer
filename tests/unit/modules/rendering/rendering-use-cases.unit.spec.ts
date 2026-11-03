import { Result } from '@bloodyowl/boxed';
import {
  createFakeObjectStorage,
  createFakeProviderCallLog,
} from '@tests/support/fake-kernel-ports';
import { createFakeRenderRepository } from '@tests/support/fake-render-repository';
import { okValue } from '@tests/support/result';
import { decode, encode } from 'fast-png';
import { describe, expect, it } from 'vitest';

import {
  type ImageId,
  type RenderId,
  type RenderResultId,
  toDesignId,
  toGeneratedId,
  toImageId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  createRenderingPipelineUseCases,
  createRenderingUseCases,
  type EditSet,
  type ImageModelAdapter,
  type InputItem,
  type InputRegion,
  type ModelId,
  modelIds,
  type ModelPoll,
  type ModelRequest,
  type RenderInputs,
  type SourceImage,
} from '@/modules/rendering';
import { createPngMaskCompositor } from '@/modules/rendering/testing';

const now = new Date('2026-11-02T12:00:00.000Z');
const ownerId = unwrapParseResult(toUserId('owner-1'));
const strangerId = unwrapParseResult(toUserId('owner-2'));
const designId = unwrapParseResult(toDesignId('design-1'));
const baseImageId: ImageId = unwrapParseResult(toImageId('base-1'));
const key = (value: string) => unwrapParseResult(toObjectKey(value));
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const box = { x: 0.25, y: 0.25, width: 0.25, height: 0.5 };
const placement = (id: string, itemId: string) => ({
  kind: 'placement' as const,
  id,
  itemId,
  box,
  rotationDeg: 0,
  note: '',
});

/** A scripted model: records requests, answers polls from a queue. */
const scriptedModel = (polls: ModelPoll[] = []) => {
  const requests: ModelRequest[] = [];
  const adapter: ImageModelAdapter = {
    async submit(request) {
      requests.push(request);
      return Result.Ok({
        type: 'model_submitted',
        providerRequestId: `req-${requests.length}`,
        settings: { quality: 'high' },
      });
    },
    async poll() {
      return Result.Ok(polls.shift() ?? { type: 'model_pending' });
    },
  };
  return { adapter, requests };
};

const setup = (options: { enabledModelIds?: readonly string[] } = {}) => {
  let counter = 0;
  const storage = createFakeObjectStorage();
  const calls = createFakeProviderCallLog();
  const renders = createFakeRenderRepository(() => now);
  const images = new Map<string, SourceImage>([
    [
      baseImageId,
      {
        imageId: baseImageId,
        designId,
        ownerId,
        workingKey: key('working-images/base.png'),
        width: 40,
        height: 20,
      },
    ],
  ]);
  const items = new Map<string, InputItem>();
  const regions = new Map<string, InputRegion>();
  const addItem = (itemId: string, overrides: Partial<InputItem> = {}) =>
    items.set(itemId, {
      itemId,
      designId,
      itemVersionId: `${itemId}-v1`,
      name: `Item ${itemId}`,
      kind: 'product',
      referenceKey: key(`item-cutouts/${itemId}.png`),
      ...overrides,
    });
  const renderInputs: RenderInputs = {
    async sourceImage(imageId) {
      const image = images.get(imageId);
      return Result.Ok(image ? { type: 'found', image } : { type: 'missing' });
    },
    async item(itemId) {
      const item = items.get(itemId);
      return Result.Ok(item ? { type: 'found', item } : { type: 'missing' });
    },
    async region(regionId) {
      const region = regions.get(regionId);
      return Result.Ok(
        region ? { type: 'found', region } : { type: 'missing' }
      );
    },
  };
  const scheduled: { renders: string[]; results: string[] } = {
    renders: [],
    results: [],
  };
  const maskCompositor = createPngMaskCompositor({
    objectStorage: storage.storage,
  });
  const idGenerator = {
    createId: () => {
      counter += 1;
      return toGeneratedId(`id${counter}`);
    },
  };
  const useCases = createRenderingUseCases({
    renderRepository: renders.repository,
    renderInputs,
    maskCompositor,
    renderScheduler: {
      async scheduleRender(renderId) {
        scheduled.renders.push(renderId);
        return Result.Ok({ type: 'render_scheduled' });
      },
      async scheduleResult(resultId) {
        scheduled.results.push(resultId);
        return Result.Ok({ type: 'render_scheduled' });
      },
    },
    permissionChecker: {
      hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
    },
    objectStorage: storage.storage,
    enabledModelIds: options.enabledModelIds ?? modelIds,
    idGenerator,
    clock: { now: () => now },
    logger,
  });
  const models = new Map<ModelId, ReturnType<typeof scriptedModel>>();
  const registered: { objectKey: string; renderSourceImageId: string }[] = [];
  const resultSize = { width: 40, height: 20 };
  const pipeline = createRenderingPipelineUseCases({
    renderRepository: renders.repository,
    renderInputs,
    maskCompositor,
    imageModels: {
      adapterFor(modelId) {
        let model = models.get(modelId);
        if (!model) {
          model = scriptedModel();
          models.set(modelId, model);
        }
        return model.adapter;
      },
    },
    resultImages: {
      async register(input) {
        registered.push(input);
        const imageId = unwrapParseResult(
          toImageId(`result-${registered.length}`)
        );
        images.set(imageId, {
          imageId,
          designId,
          ownerId,
          workingKey: input.objectKey,
          ...resultSize,
        });
        return Result.Ok({
          type: 'result_image_registered',
          imageId,
          ...resultSize,
        });
      },
    },
    objectStorage: storage.storage,
    providerCallLog: calls.log,
    idGenerator,
    clock: { now: () => now },
    logger,
  });

  const saveDraft = async (editSet: EditSet, revision = 0) =>
    okValue(
      await useCases.saveDraft({
        currentUserId: ownerId,
        imageId: baseImageId,
        editSet,
        revision,
      })
    );

  const submit = async (revision = 1) =>
    okValue(
      await useCases.submitRender({
        currentUserId: ownerId,
        imageId: baseImageId,
        revision,
      })
    );

  return {
    useCases,
    pipeline,
    storage,
    calls,
    renders,
    items,
    regions,
    addItem,
    scheduled,
    models,
    registered,
    resultSize,
    saveDraft,
    submit,
  };
};

const renderedIds = (outcome: { type: string; renderIds?: string[] }) => {
  expect(outcome.type).toBe('render_submitted');
  return (outcome.renderIds ?? []) as RenderId[];
};

describe('render sources', () => {
  it('signs the working image for its owner and hides it from others', async () => {
    const ctx = setup();
    expect(
      okValue(
        await ctx.useCases.getRenderSource({
          currentUserId: ownerId,
          imageId: baseImageId,
        })
      )
    ).toEqual({
      type: 'render_source',
      source: {
        imageId: baseImageId,
        designId,
        url: expect.stringContaining('working-images/base.png'),
        width: 40,
        height: 20,
      },
    });
    expect(
      okValue(
        await ctx.useCases.getRenderSource({
          currentUserId: strangerId,
          imageId: baseImageId,
        })
      )
    ).toEqual({ type: 'image_not_found' });
  });
});

describe('drafts', () => {
  it('starts empty at revision 0 and is private to the owner', async () => {
    const ctx = setup();
    expect(
      okValue(
        await ctx.useCases.getDraft({
          currentUserId: ownerId,
          imageId: baseImageId,
        })
      )
    ).toMatchObject({
      type: 'draft',
      draft: { revision: 0, editSet: { edits: [] } },
    });
    expect(
      okValue(
        await ctx.useCases.getDraft({
          currentUserId: strangerId,
          imageId: baseImageId,
        })
      )
    ).toEqual({ type: 'image_not_found' });
  });

  it('autosaves with optimistic revisions and reports conflicts', async () => {
    const ctx = setup();
    expect(await ctx.saveDraft({ edits: [], prompt: 'a' })).toMatchObject({
      type: 'draft_saved',
      draft: { revision: 1 },
    });
    expect(
      await ctx.saveDraft({ edits: [], prompt: 'stale' }, 0)
    ).toMatchObject({
      type: 'draft_conflict',
      draft: { revision: 1, editSet: { prompt: 'a' } },
    });
  });
});

describe('submitting renders', () => {
  it('refuses a stale draft revision', async () => {
    const ctx = setup();
    await ctx.saveDraft({ edits: [], prompt: 'Warm light' });
    expect(await ctx.submit(0)).toEqual({ type: 'draft_out_of_date' });
  });

  it('refuses an empty draft', async () => {
    const ctx = setup();
    await ctx.saveDraft({ edits: [], prompt: '  ' });
    expect(await ctx.submit()).toEqual({ type: 'nothing_to_render' });
  });

  it('reports items whose cut-out is not ready', async () => {
    const ctx = setup();
    ctx.addItem('chair', { referenceKey: null });
    await ctx.saveDraft({ edits: [placement('e1', 'chair')], prompt: '' });
    expect(await ctx.submit()).toEqual({
      type: 'item_not_ready',
      editId: 'e1',
      itemName: 'Item chair',
    });
  });

  it('snapshots an immutable recipe, composes the edit mask and fans out', async () => {
    const ctx = setup();
    ctx.addItem('chair');
    await ctx.saveDraft({ edits: [placement('e1', 'chair')], prompt: 'Dusk' });
    const [renderId] = renderedIds(await ctx.submit());
    expect(ctx.scheduled.renders).toEqual([renderId]);

    const render = ctx.renders.renders[0];
    expect(render?.results.map((r) => [r.modelId, r.status])).toEqual(
      modelIds.map((id) => [id, 'pending'])
    );
    expect(render?.recipe.edits[0]).toMatchObject({
      kind: 'placement',
      item: {
        itemVersionId: 'chair-v1',
        referenceKey: 'item-cutouts/chair.png',
      },
    });
    const maskKey = render?.recipe.editMaskKey ?? '';
    expect(maskKey).toMatch(/^edit-masks\/.+\.png$/u);
    const mask = decode(
      ctx.storage.objects.get(maskKey)?.bytes ?? new Uint8Array()
    );
    expect([mask.width, mask.height]).toEqual([40, 20]);
    // Inside the placement box (x 10–20, y 5–15) is white; far corner is black.
    expect(mask.data[10 * 40 + 15]).toBe(255);
    expect(mask.data[0]).toBe(0);

    // Later item changes do not reach the submitted recipe.
    ctx.addItem('chair', {
      itemVersionId: 'chair-v2',
      referenceKey: key('item-cutouts/v2.png'),
    });
    expect(ctx.renders.renders[0]?.recipe.edits[0]).toMatchObject({
      item: { itemVersionId: 'chair-v1' },
    });
  });

  it('skips models that cannot take every reference, with the reason', async () => {
    const ctx = setup();
    for (const id of ['a', 'b', 'c', 'd']) ctx.addItem(id);
    await ctx.saveDraft({
      edits: ['a', 'b', 'c', 'd'].map((id) => placement(`e-${id}`, id)),
      prompt: '',
    });
    renderedIds(await ctx.submit());
    const ideogram = ctx.renders.renders[0]?.results.find(
      (r) => r.modelId === 'ideogram-4-5'
    );
    expect(ideogram).toMatchObject({
      status: 'skipped',
      skipReason: 'too_many_references:4/3',
    });
  });

  it('does not create a render when no enabled model can take it', async () => {
    const ctx = setup({ enabledModelIds: ['ideogram-4-5'] });
    for (const id of ['a', 'b', 'c', 'd']) ctx.addItem(id);
    await ctx.saveDraft({
      edits: ['a', 'b', 'c', 'd'].map((id) => placement(`e-${id}`, id)),
      prompt: '',
    });
    expect(await ctx.submit()).toEqual({ type: 'no_models_can_render' });
    expect(ctx.renders.renders).toHaveLength(0);
  });

  it('creates one render per batch option, varying only that placement', async () => {
    const ctx = setup();
    for (const id of ['sofa', 'chair-a', 'chair-b']) ctx.addItem(id);
    await ctx.saveDraft({
      edits: [placement('e1', 'sofa'), placement('e2', 'chair-a')],
      prompt: '',
    });
    const ids = renderedIds(
      okValue(
        await ctx.useCases.submitBatch({
          currentUserId: ownerId,
          imageId: baseImageId,
          revision: 1,
          placementEditId: 'e2',
          optionItemIds: ['chair-a', 'chair-b'],
        })
      )
    );
    expect(ids).toHaveLength(2);
    const [second, first] = ctx.renders.renders;
    expect(first?.batchId).toBe(second?.batchId);
    expect(first?.batchId).not.toBeNull();
    expect([first?.batchOptionItemId, second?.batchOptionItemId]).toEqual([
      'chair-a',
      'chair-b',
    ]);
    expect(
      second?.recipe.edits.map((e) =>
        e.kind === 'placement' ? e.item.itemId : ''
      )
    ).toEqual(['sofa', 'chair-b']);
  });

  it('previews the plan with small-item warnings without saving anything', async () => {
    const ctx = setup();
    ctx.addItem('lamp');
    const outcome = okValue(
      await ctx.useCases.previewPlan({
        currentUserId: ownerId,
        imageId: baseImageId,
        editSet: {
          edits: [
            {
              ...placement('e1', 'lamp'),
              box: { x: 0, y: 0, width: 0.1, height: 0.1 },
            },
          ],
          prompt: '',
        },
      })
    );
    expect(outcome.type).toBe('render_plan');
    if (outcome.type !== 'render_plan') return;
    expect(outcome.plan.warnings.length).toBe(4);
    expect(ctx.renders.renders).toHaveLength(0);
  });
});

describe('render pipeline', () => {
  const submitted = async () => {
    const ctx = setup();
    ctx.addItem('chair');
    await ctx.saveDraft({ edits: [placement('e1', 'chair')], prompt: '' });
    const [renderId] = renderedIds(await ctx.submit());
    const resultFor = (modelId: ModelId) => {
      const result = ctx.renders.renders[0]?.results.find(
        (r) => r.modelId === modelId
      );
      if (!result) throw new Error(`no result for ${modelId}`);
      return result;
    };
    return { ctx, renderId: renderId as RenderId, resultFor };
  };

  it('lists runnable results', async () => {
    const { ctx, renderId } = await submitted();
    expect(
      okValue(await ctx.pipeline.runnable(renderId)).resultIds
    ).toHaveLength(4);
  });

  it('submits once, even when the step is retried', async () => {
    const { ctx, resultFor } = await submitted();
    const result = resultFor('krea-3');
    expect(okValue(await ctx.pipeline.submit(result.id))).toEqual({
      type: 'result_submitted',
    });
    expect(okValue(await ctx.pipeline.submit(result.id))).toEqual({
      type: 'result_already_submitted',
    });
    const krea = ctx.models.get('krea-3');
    expect(krea?.requests).toHaveLength(1);
    expect(krea?.requests[0]).toMatchObject({
      sourceImageUrl: expect.stringContaining('working-images/base.png'),
      referenceUrls: [expect.stringContaining('item-cutouts/chair.png')],
      boxes: [box],
      maskUrl: null,
    });
    expect(resultFor('krea-3')).toMatchObject({
      status: 'submitted',
      providerRequestId: 'req-1',
      settings: { quality: 'high' },
      prompt: expect.stringContaining('@edit1'),
    });
  });

  it('sends mask models a mask in their own polarity', async () => {
    const { ctx, resultFor } = await submitted();
    await ctx.pipeline.submit(resultFor('ideogram-4-5').id);
    await ctx.pipeline.submit(resultFor('gpt-image-2').id);
    const editMaskKey = ctx.renders.renders[0]?.recipe.editMaskKey ?? '';
    const black = editMaskKey.replace('.png', '-black_edits.png');
    const white = editMaskKey.replace('.png', '-white_edits.png');
    expect(ctx.models.get('ideogram-4-5')?.requests[0]?.maskUrl).toContain(
      black
    );
    expect(ctx.models.get('gpt-image-2')?.requests[0]?.maskUrl).toContain(
      white
    );
    const inside = 10 * 40 + 15;
    expect(
      decode(ctx.storage.objects.get(black)?.bytes ?? new Uint8Array()).data[
        inside
      ]
    ).toBe(0);
    expect(
      decode(ctx.storage.objects.get(white)?.bytes ?? new Uint8Array()).data[
        inside
      ]
    ).toBe(255);
  });

  it('copies a finished output, registers it and logs the cost', async () => {
    const { ctx, resultFor } = await submitted();
    const result = resultFor('gpt-image-2');
    await ctx.pipeline.submit(result.id);
    const model = ctx.models.get('gpt-image-2');
    if (!model) throw new Error('model missing');
    ctx.storage.addRemoteSource('https://fal.test/out.png', {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });
    const polls: ModelPoll[] = [
      { type: 'model_pending' },
      {
        type: 'model_completed',
        outputUrl: 'https://fal.test/out.png',
        outputBytes: null,
        modelVersion: 'gpt-image-2-2026',
        costUsdMicros: null,
        costSource: 'unavailable',
      },
    ];
    model.adapter.poll = async () =>
      Result.Ok(polls.shift() ?? { type: 'model_pending' });

    expect(okValue(await ctx.pipeline.poll(result.id))).toEqual({
      type: 'result_pending',
    });
    expect(okValue(await ctx.pipeline.poll(result.id))).toEqual({
      type: 'result_succeeded',
    });

    const rawKey = `results/${result.id}/1/raw.img`;
    expect(ctx.storage.objects.has(rawKey)).toBe(true);
    expect(ctx.registered).toEqual([
      expect.objectContaining({
        objectKey: rawKey,
        renderSourceImageId: baseImageId,
      }),
    ]);
    expect(resultFor('gpt-image-2')).toMatchObject({
      status: 'succeeded',
      outputImageId: 'result-1',
      modelVersion: 'gpt-image-2-2026',
      framingChanged: false,
      costUsdMicros: 234_000,
      costSource: 'price_table',
      completedAt: now,
    });
    expect([...ctx.calls.calls.values()]).toEqual([
      expect.objectContaining({
        id: `render:${result.id}:1`,
        purpose: 'render',
        provider: 'fal',
        costSource: 'price_table',
      }),
    ]);
  });

  it('flags outputs whose framing changed', async () => {
    const { ctx, resultFor } = await submitted();
    ctx.resultSize.width = 20; // 20×20 vs a 40×20 source
    const result = resultFor('krea-3');
    await ctx.pipeline.submit(result.id);
    const model = ctx.models.get('krea-3');
    if (!model) throw new Error('model missing');
    model.adapter.poll = async () =>
      Result.Ok({
        type: 'model_completed',
        outputUrl: null,
        outputBytes: { bytes: new Uint8Array([9]), contentType: 'image/png' },
        modelVersion: null,
        costUsdMicros: 5,
        costSource: 'reported',
      });
    okValue(await ctx.pipeline.poll(result.id));
    expect(resultFor('krea-3')).toMatchObject({
      framingChanged: true,
      costUsdMicros: 5,
      costSource: 'reported',
    });
    expect(ctx.storage.objects.has(`results/${result.id}/1/raw.png`)).toBe(
      true
    );
  });

  it('marks a result failed when the model fails or the output is unusable', async () => {
    const { ctx, resultFor } = await submitted();
    const result = resultFor('flux-3-image');
    await ctx.pipeline.submit(result.id);
    const model = ctx.models.get('flux-3-image');
    if (!model) throw new Error('model missing');
    model.adapter.poll = async () =>
      Result.Ok({
        type: 'model_completed',
        outputUrl: 'https://bfl.test/expired.png',
        outputBytes: null,
        modelVersion: null,
        costUsdMicros: null,
        costSource: 'unavailable',
      });
    expect(okValue(await ctx.pipeline.poll(result.id))).toEqual({
      type: 'result_failed',
      reason: 'output_copy_source_unavailable',
    });
    expect(resultFor('flux-3-image')).toMatchObject({
      status: 'failed',
      errorMessage: 'output_copy_source_unavailable',
    });
  });
});

describe('reviewing results', () => {
  const finished = async () => {
    const ctx = setup({ enabledModelIds: ['krea-3', 'gpt-image-2'] });
    ctx.addItem('chair');
    await ctx.saveDraft({ edits: [placement('e1', 'chair')], prompt: '' });
    renderedIds(await ctx.submit());
    const [krea, gpt] = ctx.renders.renders[0]?.results ?? [];
    if (!krea || !gpt) throw new Error('results missing');
    return { ctx, krea, gpt };
  };

  it('retries only failed results, as a new attempt', async () => {
    const { ctx, krea } = await finished();
    expect(
      okValue(
        await ctx.useCases.retryResult({
          currentUserId: ownerId,
          resultId: krea.id,
        })
      )
    ).toEqual({ type: 'result_not_retryable' });

    await ctx.pipeline.markFailed({ resultId: krea.id, reason: 'boom' });
    const outcome = okValue(
      await ctx.useCases.retryResult({
        currentUserId: ownerId,
        resultId: krea.id,
      })
    );
    expect(outcome.type).toBe('render_updated');
    expect(krea).toMatchObject({
      status: 'pending',
      attempt: 2,
      errorMessage: null,
    });
    expect(ctx.scheduled.results).toEqual([krea.id]);
  });

  it('marks one preferred result per render, only once finished', async () => {
    const { ctx, krea, gpt } = await finished();
    const prefer = (resultId: RenderResultId, preferred = true) =>
      ctx.useCases.markPreferredResult({
        currentUserId: ownerId,
        resultId,
        preferred,
      });
    expect(okValue(await prefer(krea.id))).toEqual({
      type: 'result_not_ready',
    });

    krea.status = 'succeeded';
    gpt.status = 'succeeded';
    await prefer(krea.id);
    await prefer(gpt.id);
    expect(ctx.renders.renders[0]?.preferredResultId).toBe(gpt.id);
    await prefer(gpt.id, false);
    expect(ctx.renders.renders[0]?.preferredResultId).toBeNull();
  });

  it('names schemes and hides provider request ids from views', async () => {
    const { ctx, krea } = await finished();
    krea.providerRequestId = 'secret-polling-url';
    const outcome = okValue(
      await ctx.useCases.nameScheme({
        currentUserId: ownerId,
        resultId: krea.id,
        name: '  Scheme A ',
      })
    );
    expect(krea.schemeName).toBe('Scheme A');
    expect(outcome.type).toBe('render_updated');
    if (outcome.type !== 'render_updated') return;
    expect(outcome.render.results[0]).not.toHaveProperty('providerRequestId');
  });

  it('keeps other owners out', async () => {
    const { ctx, krea } = await finished();
    expect(
      okValue(
        await ctx.useCases.retryResult({
          currentUserId: strangerId,
          resultId: krea.id,
        })
      )
    ).toEqual({ type: 'result_not_found' });
  });
});

describe('edit masks from regions', () => {
  it('unions region masks (resampled) with placement boxes', async () => {
    const ctx = setup();
    // A 4×2 region mask whose left half is white.
    ctx.storage.objects.set('region-masks/door.png', {
      bytes: encode({
        width: 4,
        height: 2,
        channels: 1,
        depth: 8,
        data: new Uint8Array([255, 255, 0, 0, 255, 255, 0, 0]),
      }),
      contentType: 'image/png',
    });
    ctx.regions.set('door', {
      regionId: 'door',
      imageId: baseImageId,
      label: 'door',
      maskKey: key('region-masks/door.png'),
      box: { x: 0, y: 0, width: 0.5, height: 1 },
    });
    await ctx.saveDraft({
      edits: [{ kind: 'removal', id: 'e1', regionId: 'door', note: '' }],
      prompt: '',
    });
    renderedIds(await ctx.submit());
    const mask = decode(
      ctx.storage.objects.get(ctx.renders.renders[0]?.recipe.editMaskKey ?? '')
        ?.bytes ?? new Uint8Array()
    );
    expect(mask.data[10 * 40 + 5]).toBe(255); // left half
    expect(mask.data[10 * 40 + 39]).toBe(0); // far right, beyond dilation
  });

  it('rejects regions from another image', async () => {
    const ctx = setup();
    ctx.regions.set('elsewhere', {
      regionId: 'elsewhere',
      imageId: unwrapParseResult(toImageId('other')),
      label: 'door',
      maskKey: key('region-masks/x.png'),
      box,
    });
    await ctx.saveDraft({
      edits: [{ kind: 'removal', id: 'e1', regionId: 'elsewhere', note: '' }],
      prompt: '',
    });
    expect(await ctx.submit()).toEqual({
      type: 'region_missing',
      editId: 'e1',
    });
  });
});
