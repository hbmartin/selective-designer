import { Result } from '@bloodyowl/boxed';
import {
  createFakeObjectStorage,
  createFakeProviderCallLog,
} from '@tests/support/fake-kernel-ports';
import { createFakeRenderRepository } from '@tests/support/fake-render-repository';
import { okValue } from '@tests/support/result';
import { decode, encode } from 'fast-png';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';
import {
  type ImageId,
  type RenderId,
  type RenderResultId,
  toDesignId,
  toGeneratedId,
  toImageId,
  toObjectKey,
  toRenderResultId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { hasFramingChanged } from '@/modules/rendering';
import {
  createRenderingPipelineUseCases,
  createRenderingUseCases,
  type EditSet,
  type ImageModelAdapter,
  type InputItem,
  type InputRegion,
  MAX_EDITS,
  type ModelId,
  modelIds,
  type ModelPoll,
  type ModelRequest,
  type RenderInputs,
  type RenderResult,
  type ResultImages,
  type ResultOutputReferences,
  type SourceImage,
} from '@/modules/rendering';
import {
  createPngMaskCompositor,
  discardLostOutput,
} from '@/modules/rendering/testing';

const execution = (result: RenderResult) => ({
  resultId: result.id,
  attempt: result.attempt,
  workflowRunId: `workflow-${result.id}-${result.attempt}`,
});
const polling = (result: RenderResult) => ({
  ...execution(result),
  providerRequestId: result.providerRequestId!,
});

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
        accountingRequestId: `req-${requests.length}`,
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
  const renders = createFakeRenderRepository(() => now, calls.accounting);
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
  const resultOutputReferences: ResultOutputReferences = {
    check: async (objectKey) =>
      Result.Ok({
        type:
          [...renders.checkpoints.values()].some(
            (c) => c.objectKey === objectKey
          ) ||
          [...images.values()].some((image) => image.workingKey === objectKey)
            ? 'output_referenced'
            : 'output_unreferenced',
      }),
  };
  const useCases = createRenderingUseCases({
    resultOutputReferences,
    renderRepository: renders.repository,
    renderInputs,
    maskCompositor,
    renderScheduler: {
      async scheduleRender(input) {
        scheduled.renders.push(input.renderId);
        return Result.Ok({ type: 'render_scheduled' });
      },
      async scheduleResult(input) {
        scheduled.results.push(input.resultId);
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
  const resultImages: ResultImages = {
    async findRegistered(input) {
      const found = await renders.repository.findResult(input.resultId);
      if (found.isOk() && found.get().type === 'result_found') {
        const row = found.get();
        if (
          row.type === 'result_found' &&
          row.result.status === 'succeeded' &&
          row.result.outputImageId
        )
          return Result.Ok({
            type: 'result_image_registered',
            imageId: row.result.outputImageId,
            ...resultSize,
          });
      }
      return Result.Ok({ type: 'result_image_not_registered' });
    },
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
      await renders.repository.completeResultAttempt({
        ...input,
        imageId,
        completion: {
          ...input.completion,
          completedAt: new Date(input.completion.completedAt),
          framingChanged: hasFramingChanged(resultSize, input.sourceSize),
        },
      });
      return Result.Ok({
        type: 'result_image_registered',
        imageId,
        ...resultSize,
      });
    },
  };
  const rawPipeline = createRenderingPipelineUseCases({
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
    resultImages,
    resultOutputReferences,
    objectStorage: storage.storage,
    providerAccounting: calls.accounting,
    idGenerator,
    clock: { now: () => now },
    logger,
  });

  const pipeline = {
    ...rawPipeline,
    async submit(input: Parameters<typeof rawPipeline.submit>[0]): Promise<
      import('@/modules/kernel').ApplicationResult<{
        type: string;
        providerRequestId?: string;
      }>
    > {
      const result = await rawPipeline.submit(input);
      if (result.isError() || result.get().type !== 'result_accepted')
        return result;
      const accepted = result.get();
      return accepted.type === 'result_accepted'
        ? rawPipeline.persistSubmission(accepted.submission)
        : result;
    },
  };
  const addImage = (imageId: ImageId) =>
    images.set(imageId, {
      imageId,
      designId,
      ownerId,
      workingKey: key(`working-images/${imageId}.png`),
      width: 40,
      height: 20,
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
    rawPipeline,
    resultImages,
    resultOutputReferences,
    storage,
    calls,
    renders,
    items,
    regions,
    addItem,
    addImage,
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

  it('claims duplicate dispatches once and rejects concurrent manual retry claims', async () => {
    const { ctx, resultFor } = await submitted();
    const result = resultFor('krea-3');
    const first = execution(result);
    const outcomes = await Promise.all([
      ctx.pipeline.submit(first),
      ctx.pipeline.submit({ ...first, workflowRunId: 'duplicate-workflow' }),
    ]);
    expect(outcomes.map((outcome) => okValue(outcome).type).sort()).toEqual([
      'result_attempt_superseded',
      'result_submitted',
    ]);
    expect(ctx.models.get('krea-3')!.requests).toHaveLength(1);
    okValue(
      await ctx.pipeline.markFailed({
        ...first,
        providerRequestId: result.providerRequestId!,
        reason: 'failed',
      })
    );
    const claims = await Promise.all([
      ctx.useCases.retryResult({ currentUserId: ownerId, resultId: result.id }),
      ctx.useCases.retryResult({ currentUserId: ownerId, resultId: result.id }),
    ]);
    expect(claims.map((claim) => okValue(claim).type).sort()).toEqual([
      'render_updated',
      'result_not_retryable',
    ]);
    expect(result.attempt).toBe(2);
    expect(ctx.scheduled.results).toEqual([result.id]);
    expect(
      okValue(
        await ctx.pipeline.markFailed({ ...first, reason: 'stale timeout' })
      ).type
    ).toBe('result_attempt_superseded');
    expect(result.status).toBe('pending');
  });

  it.each(['source read', 'publication', 'checkpoint reply'] as const)(
    'resumes checkpointed output after %s fails without polling or purchasing again',
    async (phase) => {
      const { ctx, resultFor } = await submitted();
      const result = resultFor('krea-3');
      await ctx.pipeline.submit(execution(result));
      const provider = ctx.models.get('krea-3')!;
      const poll = vi.fn<ImageModelAdapter['poll']>().mockResolvedValue(
        Result.Ok({
          type: 'model_completed',
          outputUrl: 'https://provider.test/result',
          outputBytes: null,
          modelVersion: 'v1',
          costUsdMicros: 123,
          costSource: 'reported',
        })
      );
      provider.adapter.poll = poll;
      ctx.storage.addRemoteSource('https://provider.test/result', {
        bytes: Uint8Array.of(4, 5, 6),
        contentType: 'image/webp',
      });
      const error = new AppError({
        code: 'INJECTED_FAILURE',
        category: 'system',
        status: 502,
      });
      const copy = vi.spyOn(ctx.storage.storage, 'copyNewObjectFromUrl');
      const register = vi.spyOn(ctx.resultImages, 'register');
      if (phase === 'source read')
        copy.mockResolvedValueOnce(Result.Error(error));
      else if (phase === 'publication')
        register.mockResolvedValueOnce(Result.Error(error));
      else {
        const save = ctx.renders.repository.saveOutput;
        vi.spyOn(ctx.renders.repository, 'saveOutput').mockImplementationOnce(
          async (input) => {
            await save(input);
            return Result.Error(error);
          }
        );
      }
      const failed = await ctx.pipeline.poll(polling(result));
      expect(failed.isError() && failed.getError()).toBe(error);
      expect(ctx.renders.checkpoints.has(result.id)).toBe(true);
      poll.mockRejectedValue(
        new Error('provider result is no longer available')
      );
      if (phase === 'publication')
        copy.mockRejectedValue(new Error('provider URL expired'));
      expect(okValue(await ctx.pipeline.poll(polling(result)))).toEqual({
        type: 'result_succeeded',
      });
      expect(poll).toHaveBeenCalledOnce();
      expect(copy).toHaveBeenCalledTimes(phase === 'source read' ? 2 : 1);
      expect(provider.requests).toHaveLength(1);
      expect(ctx.calls.receipts.size).toBe(1);
      expect(ctx.storage.objects.get(`results/${result.id}/1/raw.img`)).toEqual(
        { bytes: Uint8Array.of(4, 5, 6), contentType: 'image/webp' }
      );
    }
  );

  it('does not fail or stop the replacement attempt when an older provider answers late', async () => {
    const { ctx, resultFor } = await submitted();
    const result = resultFor('krea-3');
    await ctx.pipeline.submit(execution(result));
    let answer!: (
      value: Awaited<ReturnType<ImageModelAdapter['poll']>>
    ) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    ctx.models.get('krea-3')!.adapter.poll = async () => {
      entered();
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    const previous = polling(result);
    const oldPoll = ctx.pipeline.poll(previous);
    await ready;
    await ctx.pipeline.markFailed({ ...previous, reason: 'old timeout' });
    await ctx.useCases.retryResult({
      currentUserId: ownerId,
      resultId: result.id,
    });
    await ctx.pipeline.submit(execution(result));
    answer(Result.Ok({ type: 'model_failed', reason: 'old request rejected' }));
    const warning = vi.spyOn(logger, 'warn');
    expect(okValue(await oldPoll)).toEqual({
      type: 'result_attempt_superseded',
    });
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
    expect(result).toMatchObject({
      attempt: 2,
      status: 'submitted',
      providerRequestId: 'req-2',
    });
    ctx.models.get('krea-3')!.adapter.poll = async () =>
      Result.Ok({
        type: 'model_completed',
        outputUrl: null,
        outputBytes: { bytes: Uint8Array.of(1), contentType: 'image/png' },
        modelVersion: null,
        costUsdMicros: 1,
        costSource: 'reported',
      });
    expect(okValue(await ctx.pipeline.poll(polling(result)))).toEqual({
      type: 'result_succeeded',
    });
  });

  it('submits once, even when the step is retried', async () => {
    const { ctx, resultFor } = await submitted();
    const result = resultFor('krea-3');
    expect(okValue(await ctx.pipeline.submit(execution(result)))).toEqual({
      type: 'result_submitted',
      providerRequestId: 'req-1',
    });
    expect(okValue(await ctx.pipeline.submit(execution(result)))).toEqual({
      type: 'result_already_submitted',
      providerRequestId: 'req-1',
      receiptId: expect.any(String),
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
    await ctx.pipeline.submit(execution(resultFor('ideogram-4-5')));
    await ctx.pipeline.submit(execution(resultFor('gpt-image-2')));
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
    await ctx.pipeline.submit(execution(result));
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

    expect(okValue(await ctx.pipeline.poll(polling(result)))).toEqual({
      type: 'result_pending',
    });
    expect(okValue(await ctx.pipeline.poll(polling(result)))).toEqual({
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
    expect([...ctx.calls.receipts.values()]).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^request:/u),
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
    await ctx.pipeline.submit(execution(result));
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
    okValue(await ctx.pipeline.poll(polling(result)));
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
    await ctx.pipeline.submit(execution(result));
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
    expect(okValue(await ctx.pipeline.poll(polling(result)))).toEqual({
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

    await ctx.renders.repository.claimExecution(execution(krea));
    await ctx.pipeline.markFailed({ ...execution(krea), reason: 'boom' });
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
      carriedFromRegionId: null,
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
      carriedFromRegionId: null,
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

describe('review', () => {
  const rendered = async (
    ctx: ReturnType<typeof setup>,
    editSet: EditSet,
    imageId = baseImageId
  ) => {
    const current = ctx.renders.drafts.get(imageId);
    await ctx.useCases.saveDraft({
      currentUserId: ownerId,
      imageId,
      editSet,
      revision: current?.revision ?? 0,
    });
    const outcome = okValue(
      await ctx.useCases.submitRender({
        currentUserId: ownerId,
        imageId,
        revision: (current?.revision ?? 0) + 1,
      })
    );
    const [renderId] = renderedIds(outcome);
    const render = ctx.renders.renders.find((r) => r.id === renderId);
    if (!render) throw new Error('render missing');
    return render;
  };

  it('returns one render with signed source and edit mask URLs', async () => {
    const ctx = setup();
    ctx.addItem('chair');
    const render = await rendered(ctx, {
      edits: [placement('e1', 'chair')],
      prompt: '',
    });
    const outcome = okValue(
      await ctx.useCases.getRender({
        currentUserId: ownerId,
        renderId: render.id,
      })
    );
    expect(outcome).toMatchObject({
      type: 'render_found',
      render: {
        sourceUrl: expect.stringContaining('working-images/base.png'),
        sourceSize: { width: 40, height: 20 },
        editMaskUrl: expect.stringContaining('edit-masks/'),
      },
    });
    expect(
      okValue(
        await ctx.useCases.getRender({
          currentUserId: strangerId,
          renderId: render.id,
        })
      )
    ).toEqual({ type: 'render_not_found' });
  });

  it('scores preferred results per model', async () => {
    const ctx = setup({ enabledModelIds: ['krea-3', 'gpt-image-2'] });
    ctx.addItem('chair');
    const render = await rendered(ctx, {
      edits: [placement('e1', 'chair')],
      prompt: '',
    });
    for (const result of render.results) result.status = 'succeeded';
    const gpt = render.results.find((r) => r.modelId === 'gpt-image-2');
    if (!gpt) throw new Error('missing');
    await ctx.useCases.markPreferredResult({
      currentUserId: ownerId,
      resultId: gpt.id,
      preferred: true,
    });
    const outcome = okValue(
      await ctx.useCases.getScorecard({ currentUserId: ownerId })
    );
    expect(outcome.type === 'scorecard' ? outcome.rows : []).toEqual(
      expect.arrayContaining([
        { modelId: 'gpt-image-2', succeeded: 1, preferred: 1, contested: 1 },
        { modelId: 'krea-3', succeeded: 1, preferred: 0, contested: 1 },
      ])
    );
  });

  it('reports no omissions for a rebuild that fits', async () => {
    const ctx = setup({ enabledModelIds: ['gpt-image-2'] });
    ctx.addItem('chair');
    const render = await rendered(ctx, {
      edits: [placement('first', 'chair')],
      prompt: '',
    });
    expect(
      okValue(
        await ctx.useCases.draftFromOriginal({
          currentUserId: ownerId,
          renderId: render.id,
        })
      )
    ).toMatchObject({
      edits: 1,
      omitted: { unmappableRegion: 0, editLimit: 0 },
    });
  });

  it.each([false, true])(
    'counts only mapped edits against the draft cap (with unmappable region: %s)',
    async (withUnmappableRegion) => {
      const ctx = setup({ enabledModelIds: ['gpt-image-2'] });
      ctx.addItem('chair');
      const first = await rendered(ctx, {
        edits: [placement('first', 'chair')],
        prompt: '',
      });
      const resultImageId = unwrapParseResult(toImageId('result-from-first'));
      const result = first.results[0]!;
      result.status = 'succeeded';
      result.outputImageId = resultImageId;
      ctx.addImage(resultImageId);
      const second = await rendered(
        ctx,
        {
          edits: [placement('second', 'chair')],
          prompt: '',
        },
        resultImageId
      );
      // Stored recipes are snapshots. Expand the fixture without involving model limits.
      const edit = first.recipe.edits[0]!;
      first.recipe.edits = Array.from(
        { length: MAX_EDITS - 1 },
        (_, index) => ({
          ...edit,
          id: `edit-${index}`,
        })
      );
      second.recipe.edits.push({ ...second.recipe.edits[0]!, id: 'overflow' });
      if (withUnmappableRegion) {
        second.recipe.edits.unshift({
          kind: 'removal',
          id: 'missing-region',
          region: {
            regionId: 'unknown',
            label: 'Missing',
            maskKey: key('region-masks/missing.png'),
            box,
          },
          note: '',
        });
      }

      expect(
        okValue(
          await ctx.useCases.draftFromOriginal({
            currentUserId: ownerId,
            renderId: second.id,
          })
        )
      ).toMatchObject({
        edits: MAX_EDITS,
        omitted: {
          unmappableRegion: withUnmappableRegion ? 1 : 0,
          editLimit: 1,
        },
      });
      expect(
        ctx.renders.drafts.get(baseImageId)?.editSet.edits.map(({ id }) => id)
      ).toEqual([
        ...Array.from(
          { length: MAX_EDITS - 1 },
          (_, index) => `r0-edit-${index}`
        ),
        'r1-second',
      ]);
    }
  );

  it('rebuilds the combined edits of a render chain on the base image', async () => {
    const ctx = setup({ enabledModelIds: ['gpt-image-2'] });
    ctx.addItem('chair');
    ctx.addItem('lamp');
    ctx.regions.set('door', {
      regionId: 'door',
      imageId: baseImageId,
      carriedFromRegionId: null,
      label: 'door',
      maskKey: key('region-masks/door.png'),
      box,
    });
    ctx.storage.objects.set('region-masks/door.png', {
      bytes: encode({
        width: 2,
        height: 2,
        channels: 1,
        depth: 8,
        data: new Uint8Array([255, 0, 0, 0]),
      }),
      contentType: 'image/png',
    });
    const first = await rendered(ctx, {
      edits: [
        placement('e1', 'chair'),
        { kind: 'removal', id: 'e2', regionId: 'door', note: '' },
      ],
      prompt: 'Dusk',
    });
    // The result becomes a render source with a carried region and a new one.
    const resultImageId = unwrapParseResult(toImageId('result-from-first'));
    const firstResult = first.results[0];
    if (!firstResult) throw new Error('missing result');
    firstResult.status = 'succeeded';
    firstResult.outputImageId = resultImageId;
    ctx.addImage(resultImageId);
    ctx.regions.set('door-copy', {
      regionId: 'door-copy',
      imageId: resultImageId,
      carriedFromRegionId: 'door',
      label: 'door',
      maskKey: key('region-masks/door.png'),
      box,
    });
    ctx.regions.set('only-on-result', {
      regionId: 'only-on-result',
      imageId: resultImageId,
      carriedFromRegionId: null,
      label: 'awning',
      maskKey: key('region-masks/door.png'),
      box,
    });
    const second = await rendered(
      ctx,
      {
        edits: [
          placement('e1', 'lamp'),
          {
            kind: 'material',
            id: 'e2',
            regionId: 'door-copy',
            swatchItemId: null,
            text: 'oak',
          },
          { kind: 'removal', id: 'e3', regionId: 'only-on-result', note: '' },
        ],
        prompt: 'Warm light',
      },
      resultImageId
    );

    const outcome = okValue(
      await ctx.useCases.draftFromOriginal({
        currentUserId: ownerId,
        renderId: second.id,
      })
    );
    expect(outcome).toEqual({
      type: 'draft_rebuilt',
      baseImageId,
      edits: 4,
      omitted: { unmappableRegion: 1, editLimit: 0 },
    });
    const draft = ctx.renders.drafts.get(baseImageId);
    expect(draft?.editSet.prompt).toBe('Dusk\nWarm light');
    expect(
      draft?.editSet.edits.map((e) => [
        e.kind,
        'regionId' in e ? e.regionId : e.itemId,
      ])
    ).toEqual([
      ['placement', 'chair'],
      ['removal', 'door'],
      ['placement', 'lamp'],
      ['material', 'door'],
    ]);
  });
});

describe('copying a design for a revised image', () => {
  it('copies placements with remapped items and counts region edits', async () => {
    const ctx = setup();
    ctx.addItem('chair');
    await ctx.saveDraft({
      edits: [
        placement('e1', 'chair'),
        { kind: 'removal', id: 'e2', regionId: 'door', note: '' },
      ],
      prompt: 'Dusk',
    });
    const newImage = unwrapParseResult(toImageId('revised-base'));
    const outcome = okValue(
      await ctx.pipeline.copyDraftPlacements({
        fromImageId: baseImageId,
        toImageId: newImage,
        toDesignId: designId,
        itemIds: { chair: 'chair-copy' },
      })
    );
    expect(outcome).toEqual({
      type: 'draft_copied',
      placements: 1,
      dropped: 1,
    });
    expect(ctx.renders.drafts.get(newImage)?.editSet).toEqual({
      edits: [{ ...placement('e1', 'chair-copy') }],
      prompt: 'Dusk',
    });
  });
});

describe('expired render recovery and output cleanup', () => {
  const prepared = async () => {
    const ctx = setup({ enabledModelIds: ['krea-3'] });
    ctx.addItem('chair');
    await ctx.saveDraft({ edits: [placement('first', 'chair')], prompt: '' });
    await ctx.submit();
    const result = ctx.renders.renders[0]!.results[0]!;
    return { ctx, result };
  };
  const output = {
    type: 'model_completed' as const,
    outputUrl: null,
    outputBytes: { bytes: Uint8Array.of(1), contentType: 'image/png' },
    modelVersion: null,
    costUsdMicros: 123,
    costSource: 'reported' as const,
  };
  it.each(['pending', 'submitted'] as const)(
    'offers and atomically claims expired %s work only at the deadline',
    async (status) => {
      const { ctx, result } = await prepared();
      if (status === 'submitted') await ctx.pipeline.submit(execution(result));
      const old = execution(result);
      result.attemptStartedAt = new Date(now.getTime() - 30 * 60_000 + 1);
      const view = okValue(
        await ctx.useCases.getRender({
          currentUserId: ownerId,
          renderId: result.renderId,
        })
      );
      expect(
        view.type === 'render_found' && view.render.results[0]!.retryable
      ).toBe(false);
      expect(
        okValue(
          await ctx.useCases.retryResult({
            currentUserId: ownerId,
            resultId: result.id,
          })
        ).type
      ).toBe('result_not_retryable');
      result.attemptStartedAt = new Date(now.getTime() - 30 * 60_000);
      const expired = okValue(
        await ctx.useCases.getRender({
          currentUserId: ownerId,
          renderId: result.renderId,
        })
      );
      expect(
        expired.type === 'render_found' && expired.render.results[0]!.retryable
      ).toBe(true);
      const outcomes = await Promise.all(
        [1, 2].map(() =>
          ctx.useCases.retryResult({
            currentUserId: ownerId,
            resultId: result.id,
          })
        )
      );
      expect(outcomes.map((value) => okValue(value).type).sort()).toEqual([
        'render_updated',
        'result_not_retryable',
      ]);
      expect(result.attemptStartedAt).toEqual(now);
      expect(result.attempt).toBe(2);
      expect(
        okValue(
          await ctx.pipeline.markFailed({ ...old, reason: 'late timeout' })
        ).type
      ).toBe('result_attempt_superseded');
    }
  );
  it('leaves unclaimed work pending until the existing expiry enables Retry', async () => {
    const { ctx, result } = await prepared();
    expect(
      okValue(
        await ctx.pipeline.markFailed({
          ...execution(result),
          reason: 'DATABASE_UNAVAILABLE',
        })
      ).type
    ).toBe('result_attempt_superseded');
    expect(result.status).toBe('pending');
    expect(
      okValue(
        await ctx.useCases.retryResult({
          currentUserId: ownerId,
          resultId: result.id,
        })
      ).type
    ).toBe('result_not_retryable');
    result.attemptStartedAt = new Date(now.getTime() - 30 * 60 * 1000);
    expect(
      okValue(
        await ctx.useCases.retryResult({
          currentUserId: ownerId,
          resultId: result.id,
        })
      ).type
    ).toBe('render_updated');
    expect(result.attempt).toBe(2);
  });
  it.each([
    'unreferenced',
    'image reference',
    'uncertain reference',
    'cleanup error',
    'create conflict',
    'uncertain checkpoint',
  ] as const)(
    'handles a losing byte object with %s conservatively',
    async (state) => {
      const { ctx, result } = await prepared();
      await ctx.pipeline.submit(execution(result));
      const objectKey = key(`results/${result.id}/1/raw.png`);
      if (state === 'create conflict')
        ctx.storage.objects.set(objectKey, {
          bytes: Uint8Array.of(9),
          contentType: 'image/png',
        });
      const failure = new AppError({
        code: 'DB_UNAVAILABLE',
        category: 'system',
        status: 502,
      });
      vi.spyOn(ctx.renders.repository, 'saveOutput').mockResolvedValue(
        state === 'uncertain checkpoint'
          ? Result.Error(failure)
          : Result.Ok({ type: 'result_attempt_superseded' })
      );
      if (state === 'image reference')
        ctx.resultOutputReferences.check = async () =>
          Result.Ok({ type: 'output_referenced' });
      if (state === 'uncertain reference')
        ctx.resultOutputReferences.check = async () => Result.Error(failure);
      const remove = vi.spyOn(ctx.storage.storage, 'deleteObject');
      if (state === 'cleanup error')
        remove.mockResolvedValue(Result.Error(failure));
      ctx.models.get('krea-3')!.adapter.poll = async () => Result.Ok(output);
      const outcome = await ctx.pipeline.poll(polling(result));
      if (state === 'uncertain checkpoint')
        expect(outcome.isError() && outcome.getError()).toBe(failure);
      else expect(okValue(outcome).type).toBe('result_attempt_superseded');
      expect(ctx.storage.objects.has(objectKey)).toBe(state !== 'unreferenced');
      expect(remove).toHaveBeenCalledTimes(
        state === 'unreferenced' || state === 'cleanup error' ? 1 : 0
      );
    }
  );
  it('cleans only the newly created different-format loser, preserving the canonical output', async () => {
    const { ctx, result } = await prepared();
    await ctx.pipeline.submit(execution(result));
    const winningKey = key(`results/${result.id}/1/raw.webp`);
    ctx.storage.objects.set(winningKey, {
      bytes: Uint8Array.of(7),
      contentType: 'image/webp',
    });
    const save = ctx.renders.repository.saveOutput;
    vi.spyOn(ctx.renders.repository, 'saveOutput').mockImplementationOnce(
      (input) =>
        save({
          ...input,
          checkpoint: {
            ...input.checkpoint,
            objectKey: winningKey,
            contentType: 'image/webp',
          },
        })
    );
    ctx.models.get('krea-3')!.adapter.poll = async () => Result.Ok(output);
    expect(okValue(await ctx.pipeline.poll(polling(result))).type).toBe(
      'result_succeeded'
    );
    expect(ctx.storage.objects.has(`results/${result.id}/1/raw.png`)).toBe(
      false
    );
    expect(ctx.storage.objects.get(winningKey)?.bytes).toEqual(
      Uint8Array.of(7)
    );
    expect(ctx.renders.checkpoints.get(result.id)?.source).toEqual({
      kind: 'retired',
    });
  });
  it('recovers a same-attempt completion that wins during checkpoint persistence', async () => {
    const { ctx, result } = await prepared();
    await ctx.pipeline.submit(execution(result));
    ctx.models.get('krea-3')!.adapter.poll = async () => Result.Ok(output);
    const save = ctx.renders.repository.saveOutput;
    vi.spyOn(ctx.renders.repository, 'saveOutput').mockImplementationOnce(
      async (input) => {
        await save(input);
        await ctx.resultImages.register({
          ...input,
          designId,
          renderSourceImageId: baseImageId,
          sourceSize: { width: 40, height: 20 },
          objectKey: input.checkpoint.objectKey,
          contentType: input.checkpoint.contentType ?? undefined,
          completion: input.checkpoint,
        });
        return save(input);
      }
    );
    const recover = vi.spyOn(ctx.resultImages, 'findRegistered');
    const remove = vi.spyOn(ctx.storage.storage, 'deleteObject');
    expect(okValue(await ctx.pipeline.poll(polling(result))).type).toBe(
      'result_succeeded'
    );
    expect(recover).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(ctx.storage.objects.has(`results/${result.id}/1/raw.png`)).toBe(
      true
    );
  });
  it('checks metadata without a byte read in the render pipeline', async () => {
    const { ctx, result } = await prepared();
    await ctx.pipeline.submit(execution(result));
    ctx.models.get('krea-3')!.adapter.poll = async () => Result.Ok(output);
    const read = vi.spyOn(ctx.storage.storage, 'getObjectBytes');
    const metadata = vi.spyOn(ctx.storage.storage, 'getObjectMetadata');
    expect(okValue(await ctx.pipeline.poll(polling(result))).type).toBe(
      'result_succeeded'
    );
    expect(read).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledOnce();
  });
});

describe('independent render accounting', () => {
  it('publishes through prolonged delivery failure and later delivers without provider work', async () => {
    const ctx = setup({ enabledModelIds: ['krea-3'] });
    ctx.addItem('chair');
    await ctx.saveDraft({ edits: [placement('first', 'chair')], prompt: '' });
    await ctx.submit();
    const result = ctx.renders.renders[0]!.results[0]!;
    await ctx.pipeline.submit(execution(result));
    const model = ctx.models.get(result.modelId)!;
    const poll = vi.fn<ImageModelAdapter['poll']>().mockResolvedValue(
      Result.Ok({
        type: 'model_completed',
        outputUrl: 'https://provider.test/paid',
        outputBytes: null,
        modelVersion: 'v1',
        costUsdMicros: 123,
        costSource: 'reported',
      })
    );
    model.adapter.poll = poll;
    ctx.storage.addRemoteSource('https://provider.test/paid', {
      bytes: Uint8Array.of(1),
      contentType: 'image/png',
    });
    const sink = vi
      .spyOn(ctx.calls.log, 'record')
      .mockResolvedValue(
        Result.Error(
          new AppError({ code: 'LOG_DOWN', category: 'system', status: 500 })
        )
      );
    expect(okValue(await ctx.pipeline.poll(polling(result))).type).toBe(
      'result_succeeded'
    );
    expect(ctx.calls.calls.size).toBe(0);
    expect(ctx.calls.receipts.size).toBe(1);
    const receipt = [...ctx.calls.receipts.values()][0]!;
    expect(ctx.renders.checkpoints.get(result.id)?.source).toEqual({
      kind: 'retired',
    });
    sink.mockRestore();
    expect(okValue(await ctx.calls.accounting.deliver(receipt.id)).type).toBe(
      'receipt_delivered'
    );
    expect(ctx.calls.calls.size).toBe(1);
    expect(poll).toHaveBeenCalledOnce();
  });
  it.each(['unreferenced', 'referenced', 'unknown', 'delete failure'] as const)(
    'starts a fresh attempt while safely handling a replaced %s object',
    async (state) => {
      const ctx = setup({ enabledModelIds: ['krea-3'] });
      ctx.addItem('chair');
      await ctx.saveDraft({ edits: [placement('first', 'chair')], prompt: '' });
      await ctx.submit();
      const result = ctx.renders.renders[0]!.results[0]!;
      await ctx.pipeline.submit(execution(result));
      ctx.models.get('krea-3')!.adapter.poll = async () =>
        Result.Ok({
          type: 'model_completed',
          outputBytes: { bytes: Uint8Array.of(1), contentType: 'image/png' },
          outputUrl: null,
          modelVersion: null,
          costUsdMicros: 123,
          costSource: 'reported',
        });
      vi.spyOn(ctx.resultImages, 'register').mockResolvedValueOnce(
        Result.Error(
          new AppError({
            code: 'PUBLICATION_DOWN',
            category: 'system',
            status: 500,
          })
        )
      );
      expect((await ctx.pipeline.poll(polling(result))).isError()).toBe(true);
      const objectKey = ctx.renders.checkpoints.get(result.id)!.objectKey;
      result.attemptStartedAt = new Date(now.getTime() - 30 * 60_000);
      if (state === 'referenced')
        vi.spyOn(ctx.resultOutputReferences, 'check').mockResolvedValue(
          Result.Ok({ type: 'output_referenced' })
        );
      if (state === 'unknown')
        vi.spyOn(ctx.resultOutputReferences, 'check').mockResolvedValue(
          Result.Error(
            new AppError({
              code: 'REFERENCE_DOWN',
              category: 'system',
              status: 500,
            })
          )
        );
      if (state === 'delete failure')
        vi.spyOn(ctx.storage.storage, 'deleteObject').mockResolvedValue(
          Result.Error(
            new AppError({
              code: 'DELETE_DOWN',
              category: 'system',
              status: 500,
            })
          )
        );
      expect(
        okValue(
          await ctx.useCases.retryResult({
            currentUserId: ownerId,
            resultId: result.id,
          })
        ).type
      ).toBe('render_updated');
      expect(result.attempt).toBe(2);
      // Retry returns after scheduling; the workflow owns reference checks/deletion.
      expect(ctx.storage.objects.has(objectKey)).toBe(true);
      const cleaned = await discardLostOutput(
        {
          logger,
          objectStorage: ctx.storage.storage,
          resultOutputReferences: ctx.resultOutputReferences,
        },
        { workflowRunId: 'test-cleanup', resultId: result.id, attempt: 1 },
        objectKey
      );
      expect(cleaned.isError()).toBe(
        state === 'unknown' || state === 'delete failure'
      );
      expect(ctx.storage.objects.has(objectKey)).toBe(state !== 'unreferenced');
      expect(ctx.calls.receipts.size).toBe(1);
    }
  );
  it.each([
    'item-cutouts/a.png',
    'region-masks/a.png',
    'item-photos/a.png',
    'results/other/1/raw.png',
    'results/result-1/2/raw.png',
  ])(
    'rejects cleanup of %s before reading references or storage',
    async (value) => {
      const ctx = setup();
      const refs = vi.spyOn(ctx.resultOutputReferences, 'check');
      const remove = vi.spyOn(ctx.storage.storage, 'deleteObject');
      expect(
        (
          await discardLostOutput(
            {
              logger,
              objectStorage: ctx.storage.storage,
              resultOutputReferences: ctx.resultOutputReferences,
            },
            {
              workflowRunId: 'test-cleanup',
              resultId: okValue(toRenderResultId('result-1')),
              attempt: 1,
            },
            key(value)
          )
        ).isError()
      ).toBe(true);
      expect(refs).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    }
  );
  it('keeps polling locators out of durable accounting receipts', async () => {
    const ctx = setup({ enabledModelIds: ['krea-3'] });
    ctx.addItem('chair');
    await ctx.saveDraft({ edits: [placement('first', 'chair')], prompt: '' });
    await ctx.submit();
    const result = ctx.renders.renders[0]!.results[0]!;
    const model = scriptedModel();
    ctx.models.set('krea-3', model);
    const locator = `fake:krea-3:${encodeURIComponent('https://storage.test/private?signature=synthetic-locator-token')}`;
    model.adapter.submit = async () =>
      Result.Ok({
        type: 'model_submitted',
        providerRequestId: locator,
        settings: {},
      });
    model.adapter.poll = async () =>
      Result.Ok({
        type: 'model_completed',
        outputBytes: { bytes: Uint8Array.of(1), contentType: 'image/png' },
        outputUrl: null,
        modelVersion: null,
        costUsdMicros: 123,
        costSource: 'reported',
      });
    await ctx.pipeline.submit(execution(result));
    expect(
      okValue(
        await ctx.pipeline.poll({
          ...execution(result),
          providerRequestId: locator,
        })
      ).type
    ).toBe('result_succeeded');
    const receipt = [...ctx.calls.receipts.values()][0]!;
    expect(receipt.providerRequestId).toBeUndefined();
    expect(receipt.id).toMatch(/^invocation:/u);
    expect(JSON.stringify(receipt)).not.toContain('synthetic-locator-token');
  });
});

describe('accepted submission handoff', () => {
  const acceptedSetup = async () => {
    const ctx = setup({ enabledModelIds: ['krea-3'] });
    ctx.addItem('chair');
    await ctx.saveDraft({ edits: [placement('one', 'chair')], prompt: '' });
    await ctx.submit();
    const result = ctx.renders.renders[0]!.results[0]!;
    const accepted = okValue(await ctx.rawPipeline.submit(execution(result)));
    expect(accepted.type).toBe('result_accepted');
    if (accepted.type !== 'result_accepted')
      throw new Error('Expected accepted request');
    return { ...ctx, result, accepted: accepted.submission };
  };
  it('interprets matching repository evidence as capture confirmation without reading or recapturing the receipt', async () => {
    const ctx = await acceptedSetup();
    okValue(await ctx.rawPipeline.persistSubmission(ctx.accepted));
    const capture = vi.spyOn(ctx.calls.accounting, 'capture');
    expect(
      okValue(await ctx.renders.repository.reconcileSubmission(ctx.accepted))
    ).toEqual({
      type: 'result_submitted',
      providerRequestId: ctx.accepted.providerRequestId,
    });
    expect(
      okValue(await ctx.rawPipeline.reconcileSubmission(ctx.accepted))
    ).toEqual({
      type: 'result_submitted',
      providerRequestId: ctx.accepted.providerRequestId,
      receiptCaptured: true,
    });
    expect(capture).not.toHaveBeenCalled();
  });
  it('does not infer capture from an unfinished attempt or supersession', async () => {
    const ctx = await acceptedSetup();
    expect(
      okValue(await ctx.rawPipeline.reconcileSubmission(ctx.accepted))
    ).toEqual({
      type: 'submission_recovery_window',
      attemptDeadlineAt: ctx.accepted.attemptDeadlineAt,
    });
    expect(
      okValue(
        await ctx.rawPipeline.reconcileSubmission({
          ...ctx.accepted,
          attempt: ctx.accepted.attempt + 1,
        })
      )
    ).toEqual({
      type: 'result_attempt_superseded',
    });
  });
  it('retries persistence of journaled acceptance without another provider purchase', async () => {
    const ctx = await acceptedSetup();
    const original = ctx.renders.repository.saveSubmission;
    const save = vi
      .spyOn(ctx.renders.repository, 'saveSubmission')
      .mockResolvedValueOnce(
        Result.Error(
          new AppError({
            code: 'DATABASE_DOWN',
            category: 'system',
            status: 500,
          })
        )
      );
    expect(
      (await ctx.rawPipeline.persistSubmission(ctx.accepted)).isError()
    ).toBe(true);
    expect(ctx.calls.receipts.size).toBe(1);
    expect(ctx.result.status).toBe('pending');
    save.mockImplementation(original);
    expect(
      okValue(await ctx.rawPipeline.persistSubmission(ctx.accepted)).type
    ).toBe('result_submitted');
    expect(
      okValue(await ctx.rawPipeline.persistSubmission(ctx.accepted)).type
    ).toBe('result_submitted');
    expect(ctx.models.get('krea-3')!.requests).toHaveLength(1);
  });
  it.each([
    'submission_recovery_failed',
    'PROVIDER_RECEIPT_IDENTITY_MISMATCH',
    'RENDER_ACCOUNTING_IDENTITY_MISSING',
  ])(
    'maps stored recovery reasons into presentation tags: %s',
    async (errorMessage) => {
      const ctx = await acceptedSetup();
      ctx.result.status = 'failed';
      ctx.result.errorMessage = errorMessage;
      const view = okValue(
        await ctx.useCases.getRender({
          currentUserId: ownerId,
          renderId: ctx.renders.renders[0]!.id,
        })
      );
      expect(view).toMatchObject({
        type: 'render_found',
        render: {
          results: [{ failure: { type: 'recovery_failed' }, retryable: true }],
        },
      });
    }
  );
  it.each([undefined, 'invalid'])(
    'persists a valid acceptance despite invalid deadline metadata: %s',
    async (attemptDeadlineAt) => {
      const ctx = await acceptedSetup();
      const result = await ctx.rawPipeline.persistSubmission({
        ...ctx.accepted,
        attemptDeadlineAt: attemptDeadlineAt as string,
      });
      expect(result.isOk() && result.get()).toMatchObject({
        type: 'result_submitted',
      });
      expect(ctx.calls.receipts.size).toBe(1);
      expect(ctx.result.status).toBe('submitted');
    }
  );
  it.each(['replacement', 'deletion'])(
    'captures accepted work after %s',
    async (loss) => {
      const ctx = await acceptedSetup();
      if (loss === 'replacement') ctx.result.attempt += 1;
      else ctx.renders.renders.splice(0);
      expect(
        okValue(await ctx.rawPipeline.persistSubmission(ctx.accepted)).type
      ).toBe('result_attempt_superseded');
      expect([...ctx.calls.receipts.values()]).toMatchObject([
        {
          status: 'submitted',
          costSource: 'unavailable',
          providerRequestId: 'req-1',
        },
      ]);
      expect(ctx.calls.calls.size).toBe(0);
    }
  );
  it('keeps completed historical registrations readable without a receipt', async () => {
    const ctx = await acceptedSetup();
    okValue(await ctx.rawPipeline.persistSubmission(ctx.accepted));
    ctx.result.status = 'succeeded';
    const original = ctx.renders.repository.publicationContext;
    vi.spyOn(ctx.renders.repository, 'publicationContext').mockImplementation(
      async (id) => {
        const found = await original(id);
        if (found.isOk()) {
          const value = found.get();
          if (
            value.type === 'publication_context' &&
            value.context.accountingIdentity
          )
            Reflect.deleteProperty(value.context.accountingIdentity, 'receipt');
        }
        return found;
      }
    );
    expect(
      okValue(await ctx.rawPipeline.submit(execution(ctx.result)))
    ).toMatchObject({
      type: 'result_already_submitted',
      providerRequestId: 'req-1',
    });
    expect(ctx.models.get('krea-3')!.requests).toHaveLength(1);
  });
  it('records provider-confirmed failure separately from local failure', async () => {
    const ctx = await acceptedSetup();
    okValue(await ctx.rawPipeline.persistSubmission(ctx.accepted));
    ctx.models.get('krea-3')!.adapter.poll = async () =>
      Result.Ok({ type: 'model_failed', reason: 'provider_rejected' });
    expect(okValue(await ctx.rawPipeline.poll(polling(ctx.result))).type).toBe(
      'result_failed'
    );
    expect([...ctx.calls.receipts.values()]).toMatchObject([
      { status: 'failed' },
    ]);
  });
});
