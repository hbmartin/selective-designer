import { Result } from '@bloodyowl/boxed';
import { createFakeItemRepository } from '@tests/support/fake-item-repository';
import {
  createFakeObjectStorage,
  createFakeProviderCallLog,
  createFakeUploadIntentStore,
} from '@tests/support/fake-kernel-ports';
import { okValue } from '@tests/support/result';
import { describe, expect, it, vi } from 'vitest';

import {
  type DesignId,
  toDesignId,
  toGeneratedId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  type BackgroundRemover,
  categorySuggestions,
  createMoodboardPipelineUseCases,
  createMoodboardUseCases,
  initialCutoutStatus,
  isHttpUrl,
  toItemCategory,
  toItemName,
} from '@/modules/moodboard';

const now = new Date('2026-11-02T12:00:00.000Z');
const ownerId = unwrapParseResult(toUserId('owner-1'));
const strangerId = unwrapParseResult(toUserId('owner-2'));
const designId = unwrapParseResult(toDesignId('design-1'));
const photoKey = unwrapParseResult(toObjectKey('item-photos/p1.png'));
const name = okValue(toItemName('Brass sconce'));
const category = okValue(toItemCategory('Lighting'));
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const setup = () => {
  let counter = 0;
  const items = createFakeItemRepository(() => now);
  const intents = createFakeUploadIntentStore();
  const storage = createFakeObjectStorage();
  const calls = createFakeProviderCallLog();
  const schedule = vi.fn(async () =>
    Result.Ok({ type: 'background_removal_scheduled' as const })
  );
  const designAccess = {
    isOwnedBy: async (input: { designId: DesignId; userId: string }) =>
      Result.Ok(
        input.userId === ownerId && input.designId === designId
          ? ({ type: 'owned' } as const)
          : ({ type: 'not_owned' } as const)
      ),
    ownerOf: async () => Result.Ok({ type: 'owner' as const, userId: ownerId }),
  };
  const idGenerator = {
    createId: () => {
      counter += 1;
      return toGeneratedId(`id${counter}`);
    },
  };
  const useCases = createMoodboardUseCases({
    itemRepository: items.repository,
    designAccess,
    uploadIntentStore: intents.store,
    objectStorage: storage.storage,
    permissionChecker: {
      hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
    },
    backgroundRemovalScheduler: { schedule },
    idGenerator,
    clock: { now: () => now },
    logger,
  });
  const pipeline = (backgroundRemover: BackgroundRemover) =>
    createMoodboardPipelineUseCases({
      itemRepository: items.repository,
      designAccess,
      objectStorage: storage.storage,
      backgroundRemover,
      providerCallLog: calls.log,
      idGenerator,
      clock: { now: () => now },
      logger,
    });
  return { useCases, pipeline, items, intents, storage, calls, schedule };
};

const rememberPhoto = (ctx: ReturnType<typeof setup>, userId = ownerId) =>
  ctx.intents.store.remember({
    objectKey: photoKey,
    userId,
    purpose: 'item_photo',
    contentType: 'image/png',
    expiresAt: new Date(now.getTime() + 60_000),
  });

const createProduct = async (
  ctx: ReturnType<typeof setup>,
  kind: 'product' | 'swatch' = 'product'
) => {
  await rememberPhoto(ctx);
  const created = okValue(
    await ctx.useCases.createItem({
      currentUserId: ownerId,
      designId,
      kind,
      name,
      category,
      vendor: 'Acme',
      productUrl: 'https://acme.test/sconce',
      photo: { key: photoKey, width: 800, height: 600 },
    })
  );
  if (created.type !== 'item_created') throw new Error(created.type);
  return created.item;
};

describe('moodboard domain', () => {
  it('suggests used categories first, then unused defaults', () => {
    expect(
      categorySuggestions([
        { category: 'Plants', count: 1 },
        { category: 'Cladding', count: 4 },
        { category: 'plants', count: 9 },
      ]).slice(0, 4)
    ).toEqual(['plants', 'Cladding', 'Furniture', 'Lighting']);
    expect(initialCutoutStatus('swatch')).toBe('not_needed');
    expect(initialCutoutStatus('extract')).toBe('pending');
    expect(isHttpUrl('https://acme.test')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('moodboard use cases', () => {
  it('creates products from an owned upload and schedules background removal', async () => {
    const ctx = setup();
    const item = await createProduct(ctx);
    expect(item).toMatchObject({
      kind: 'product',
      vendor: 'Acme',
      currentVersion: {
        number: 1,
        cutoutStatus: 'pending',
        photo: { width: 800 },
      },
      photoUrl: expect.stringContaining('item-photos/p1.png'),
      cutoutUrl: null,
    });
    expect(ctx.schedule).toHaveBeenCalledWith({
      itemVersionId: item.currentVersion.id,
    });
  });

  it('does not schedule removal for swatches', async () => {
    const ctx = setup();
    const swatch = await createProduct(ctx, 'swatch');
    expect(swatch.currentVersion.cutoutStatus).toBe('not_needed');
    expect(ctx.schedule).not.toHaveBeenCalled();
  });

  it('rejects uploads not issued to the caller and other owners designs', async () => {
    const ctx = setup();
    await rememberPhoto(ctx, strangerId);
    const input = {
      designId,
      kind: 'product' as const,
      name,
      category,
      vendor: null,
      productUrl: null,
      photo: { key: photoKey, width: 800, height: 600 },
    };
    expect(
      okValue(
        await ctx.useCases.createItem({ currentUserId: ownerId, ...input })
      ).type
    ).toBe('item_upload_unowned');
    expect(
      okValue(
        await ctx.useCases.createItem({ currentUserId: strangerId, ...input })
      ).type
    ).toBe('design_not_found');
    expect(
      okValue(await ctx.useCases.list({ currentUserId: strangerId, designId }))
        .type
    ).toBe('design_not_found');
  });

  it('saves cut-out corrections as a new version and hides items from strangers', async () => {
    const ctx = setup();
    const item = await createProduct(ctx);
    const cutoutKey = unwrapParseResult(toObjectKey('item-cutouts/c2.png'));
    const maskKey = unwrapParseResult(toObjectKey('item-masks/m2.png'));
    for (const [objectKey, purpose] of [
      [cutoutKey, 'item_cutout'],
      [maskKey, 'item_mask'],
    ] as const) {
      await ctx.intents.store.remember({
        objectKey,
        userId: ownerId,
        purpose,
        contentType: 'image/png',
        expiresAt: new Date(now.getTime() + 60_000),
      });
    }
    expect(
      okValue(
        await ctx.useCases.correctCutout({
          currentUserId: strangerId,
          itemId: item.id,
          cutoutKey,
          maskKey,
        })
      ).type
    ).toBe('item_not_found');

    const corrected = okValue(
      await ctx.useCases.correctCutout({
        currentUserId: ownerId,
        itemId: item.id,
        cutoutKey,
        maskKey,
      })
    );
    expect(corrected).toMatchObject({
      type: 'item_updated',
      item: {
        currentVersion: {
          number: 2,
          cutoutKey,
          maskKey,
          cutoutStatus: 'ready',
        },
        cutoutUrl: expect.stringContaining('item-cutouts/c2.png'),
      },
    });
    // The first version stays intact for recipes that pinned it.
    expect(ctx.items.versions.get(item.currentVersion.id)?.number).toBe(1);
  });

  it('only retries failed cut-outs', async () => {
    const ctx = setup();
    const item = await createProduct(ctx);
    expect(
      okValue(
        await ctx.useCases.retryCutout({
          currentUserId: ownerId,
          itemId: item.id,
        })
      ).type
    ).toBe('cutout_not_retryable');
    await ctx.items.repository.setCutoutResult({
      versionId: item.currentVersion.id,
      cutoutStatus: 'failed',
      cutoutKey: null,
    });
    expect(
      okValue(
        await ctx.useCases.retryCutout({
          currentUserId: ownerId,
          itemId: item.id,
        })
      )
    ).toMatchObject({
      type: 'item_updated',
      item: { currentVersion: { cutoutStatus: 'pending' } },
    });
    expect(ctx.schedule).toHaveBeenCalledTimes(2);
  });
});

describe('background removal pipeline', () => {
  it('copies a provider result into owned storage and logs the call', async () => {
    const ctx = setup();
    const item = await createProduct(ctx);
    ctx.storage.addRemoteSource('https://fal.test/result.png', {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });
    const remover: BackgroundRemover = {
      removeBackground: async () =>
        Result.Ok({
          type: 'background_removed',
          result: { kind: 'url', url: 'https://fal.test/result.png' },
          provider: 'fal',
          endpoint: 'fal-ai/birefnet/v2',
          providerRequestId: 'req-1',
          costUsdMicros: undefined,
          costSource: 'unavailable',
        }),
    };
    const outcome = okValue(
      await ctx.pipeline(remover).removeBackground(item.currentVersion.id)
    );
    expect(outcome).toEqual({ type: 'cutout_ready' });
    const cutoutKey = `item-cutouts/${item.currentVersion.id}.png`;
    expect(ctx.storage.objects.get(cutoutKey)?.bytes).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(ctx.items.versions.get(item.currentVersion.id)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutKey,
    });
    expect([...ctx.calls.calls.values()]).toEqual([
      expect.objectContaining({
        purpose: 'background_removal',
        status: 'succeeded',
        providerRequestId: 'req-1',
        costSource: 'unavailable',
        costUsdMicros: undefined,
        userId: ownerId,
      }),
    ]);

    // A retried step after success is a no-op.
    expect(
      okValue(
        await ctx.pipeline(remover).removeBackground(item.currentVersion.id)
      )
    ).toEqual({
      type: 'cutout_skipped',
    });
  });

  it('marks the version failed when the provider rejects the photo', async () => {
    const ctx = setup();
    const item = await createProduct(ctx);
    const outcome = okValue(
      await ctx
        .pipeline({
          removeBackground: async () =>
            Result.Ok({
              type: 'background_removal_failed',
              reason: 'provider_rejected_422',
              provider: 'fal',
              endpoint: 'fal-ai/birefnet/v2',
            }),
        })
        .removeBackground(item.currentVersion.id)
    );
    expect(outcome).toEqual({
      type: 'cutout_failed',
      reason: 'provider_rejected_422',
    });
    expect(ctx.items.versions.get(item.currentVersion.id)?.cutoutStatus).toBe(
      'failed'
    );
  });
});

describe('background removal fallback', () => {
  it('marks a still-pending version failed after the workflow gives up', async () => {
    const ctx = setup();
    const item = await createProduct(ctx);
    const pipeline = ctx.pipeline({
      removeBackground: async () => {
        throw new Error('unused');
      },
    });
    expect(
      okValue(await pipeline.markCutoutFailed(item.currentVersion.id))
    ).toEqual({
      type: 'cutout_marked_failed',
    });
    expect(
      okValue(await pipeline.markCutoutFailed(item.currentVersion.id))
    ).toEqual({
      type: 'cutout_skipped',
    });
  });
});

describe('copying a mood board', () => {
  it('copies every item into another design, reusing the image objects', async () => {
    const ctx = setup();
    const item = await createProduct(ctx);
    const target = unwrapParseResult(toDesignId('design-revised'));
    const outcome = okValue(
      await ctx
        .pipeline({
          removeBackground: async () =>
            Result.Ok({
              type: 'background_removal_rejected',
              reason: 'unused',
            }),
        } as unknown as BackgroundRemover)
        .copyItems({ fromDesignId: item.designId, toDesignId: target })
    );
    const copiedId = outcome.itemIds[item.id];
    expect(copiedId).toBeDefined();
    expect(copiedId).not.toBe(item.id);
    const copies = okValue(
      await ctx.items.repository.listByDesign(target)
    ).items;
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      id: copiedId,
      name: item.name,
      kind: item.kind,
      currentVersion: { photo: item.currentVersion.photo },
    });
  });
});
