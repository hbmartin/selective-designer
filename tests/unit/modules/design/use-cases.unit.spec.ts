import { Result } from '@bloodyowl/boxed';
import { createFakeDesignRepository } from '@tests/support/fake-design-repository';
import {
  createFakeObjectStorage,
  createFakeUploadIntentStore,
} from '@tests/support/fake-kernel-ports';
import { okValue } from '@tests/support/result';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDesignUseCases,
  type DesignCopiedListener,
  toDesignName,
} from '@/modules/design';
import { AppError } from '@/modules/kernel';
import {
  toDesignId,
  toGeneratedId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';

const ownerId = unwrapParseResult(toUserId('owner-1'));
const otherId = unwrapParseResult(toUserId('owner-2'));
const name = okValue(toDesignName('Lakeside Villa'));
const originalKey = unwrapParseResult(toObjectKey('base-images/orig1.png'));
const workingKey = unwrapParseResult(toObjectKey('working-images/work1.png'));
const now = new Date('2026-11-02T12:00:00.000Z');

const baseImage = {
  originalKey,
  original: { width: 6000, height: 4000 },
  workingKey,
  working: { width: 2048, height: 1365 },
};

const setup = (options?: { permission?: 'granted' | 'denied' }) => {
  let counter = 0;
  const repo = createFakeDesignRepository(() => now);
  const intents = createFakeUploadIntentStore();
  const storage = createFakeObjectStorage();
  const arrived = vi.fn(async () =>
    Result.Ok({ type: 'image_arrival_handled' as const })
  );
  const copied = vi.fn<DesignCopiedListener['designCopied']>(async () =>
    Result.Ok({ type: 'design_copy_handled' as const })
  );
  const useCases = createDesignUseCases({
    designRepository: repo.repository,
    uploadIntentStore: intents.store,
    objectStorage: storage.storage,
    permissionChecker: {
      hasPermission: async () =>
        Result.Ok({
          type:
            options?.permission === 'denied'
              ? 'permission_denied'
              : 'permission_granted',
        }),
    },
    idGenerator: {
      createId: () => {
        counter += 1;
        return toGeneratedId(`id${counter}`);
      },
    },
    clock: { now: () => now },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    imageArrivedListener: { imageArrived: arrived },
    designCopiedListener: { designCopied: copied },
  });
  return { useCases, repo, intents, storage, arrived, copied };
};

const rememberBaseUploads = async (
  intents: ReturnType<typeof createFakeUploadIntentStore>,
  userId = ownerId
) => {
  const expiresAt = new Date(now.getTime() + 60_000);
  await intents.store.remember({
    objectKey: originalKey,
    userId,
    purpose: 'base_image',
    contentType: 'image/png',
    expiresAt,
  });
  await intents.store.remember({
    objectKey: workingKey,
    userId,
    purpose: 'working_image',
    contentType: 'image/png',
    expiresAt,
  });
};

describe('design use cases', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('prepares uploads with server keys and remembers an intent', async () => {
    const outcome = okValue(
      await ctx.useCases.prepareUpload({
        currentUserId: ownerId,
        purpose: 'base_image',
        fileType: 'image/png',
      })
    );
    expect(outcome).toEqual({
      type: 'design_upload_prepared',
      objectKey: 'base-images/id1.png',
    });
    expect(ctx.intents.intents.get('base-images/id1.png')).toMatchObject({
      userId: ownerId,
      purpose: 'base_image',
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    });
    expect(
      okValue(
        await ctx.useCases.prepareUpload({
          currentUserId: ownerId,
          purpose: 'region_mask',
          fileType: 'image/jpeg',
        })
      ).type
    ).toBe('design_upload_invalid_file_type');
  });

  it('creates a design only from uploads issued to the caller', async () => {
    await rememberBaseUploads(ctx.intents, otherId);
    expect(
      okValue(
        await ctx.useCases.create({ currentUserId: ownerId, name, baseImage })
      ).type
    ).toBe('design_upload_unowned');

    const fresh = setup();
    await rememberBaseUploads(fresh.intents);
    const created = okValue(
      await fresh.useCases.create({ currentUserId: ownerId, name, baseImage })
    );
    expect(created.type).toBe('design_created');
    if (created.type !== 'design_created') return;
    expect(created.design).toMatchObject({
      name: 'Lakeside Villa',
      ownerId,
      archivedAt: null,
      baseImage: {
        kind: 'base',
        originalContentType: 'image/png',
        workingUrl: expect.stringContaining('working-images/work1.png'),
      },
    });

    expect(fresh.arrived).toHaveBeenCalledWith({
      designId: created.design.id,
      imageId: created.design.baseImage.id,
      kind: 'base',
      carryFromImageId: null,
    });

    // Intents are single-use.
    expect(
      okValue(
        await fresh.useCases.create({ currentUserId: ownerId, name, baseImage })
      ).type
    ).toBe('design_upload_unowned');
  });

  it('rejects inconsistent base images before consuming uploads', async () => {
    await rememberBaseUploads(ctx.intents);
    const outcome = okValue(
      await ctx.useCases.create({
        currentUserId: ownerId,
        name,
        baseImage: { ...baseImage, working: { width: 6000, height: 4000 } },
      })
    );
    expect(outcome.type).toBe('design_image_invalid');
    expect(ctx.intents.intents.get(originalKey)?.consumed).toBe(false);
  });

  it('refuses everything when the role lacks the design permission', async () => {
    const denied = setup({ permission: 'denied' });
    expect(
      okValue(
        await denied.useCases.list({
          currentUserId: ownerId,
          archived: false,
          searchTerm: '',
          cursor: undefined,
          limit: 10,
        })
      ).type
    ).toBe('design_forbidden');
    expect(
      okValue(
        await denied.useCases.prepareUpload({
          currentUserId: ownerId,
          purpose: 'base_image',
          fileType: 'image/png',
        })
      ).type
    ).toBe('design_upload_forbidden');
  });

  it('hides other owners designs and images', async () => {
    await rememberBaseUploads(ctx.intents);
    const created = okValue(
      await ctx.useCases.create({ currentUserId: ownerId, name, baseImage })
    );
    if (created.type !== 'design_created') throw new Error('not created');

    expect(
      okValue(
        await ctx.useCases.get({
          currentUserId: otherId,
          id: created.design.id,
        })
      ).type
    ).toBe('design_not_found');
    expect(
      okValue(
        await ctx.useCases.getImageDownloadUrl({
          currentUserId: otherId,
          imageId: created.design.baseImage.id,
        })
      ).type
    ).toBe('image_not_found');

    const download = okValue(
      await ctx.useCases.getImageDownloadUrl({
        currentUserId: ownerId,
        imageId: created.design.baseImage.id,
      })
    );
    expect(download).toEqual({
      type: 'image_download_url',
      url: expect.stringContaining(
        `download=${encodeURIComponent('Lakeside Villa-base-id2.png')}`
      ),
    });
  });

  it('archives with the clock time and restores', async () => {
    await rememberBaseUploads(ctx.intents);
    const created = okValue(
      await ctx.useCases.create({ currentUserId: ownerId, name, baseImage })
    );
    if (created.type !== 'design_created') throw new Error('not created');
    const id = created.design.id;

    const archived = okValue(
      await ctx.useCases.update({
        currentUserId: ownerId,
        id,
        change: { type: 'archive' },
      })
    );
    expect(archived).toMatchObject({
      type: 'design_updated',
      design: { archivedAt: now },
    });
    const listed = okValue(
      await ctx.useCases.list({
        currentUserId: ownerId,
        archived: true,
        searchTerm: 'lake',
        cursor: undefined,
        limit: 10,
      })
    );
    expect(listed.type === 'design_listed' && listed.page.items).toHaveLength(
      1
    );

    const restored = okValue(
      await ctx.useCases.update({
        currentUserId: ownerId,
        id,
        change: { type: 'unarchive' },
      })
    );
    expect(restored).toMatchObject({ design: { archivedAt: null } });
    expect(
      okValue(
        await ctx.useCases.update({
          currentUserId: otherId,
          id,
          change: { type: 'archive' },
        })
      ).type
    ).toBe('design_not_found');
  });

  it.each([false, true])(
    'copies before scheduling detection even when the copy fails (%s)',
    async (copyFails) => {
      if (copyFails) {
        ctx.copied.mockResolvedValueOnce(
          Result.Error(
            new AppError({
              code: 'COPY_FAILED',
              category: 'system',
              status: 500,
            })
          )
        );
      }
      await rememberBaseUploads(ctx.intents);
      const first = okValue(
        await ctx.useCases.create({ currentUserId: ownerId, name, baseImage })
      );
      if (first.type !== 'design_created') throw new Error('not created');
      const revisedKeys = {
        ...baseImage,
        originalKey: unwrapParseResult(toObjectKey('base-images/revised.png')),
        workingKey: unwrapParseResult(
          toObjectKey('working-images/revised.png')
        ),
      };
      await ctx.intents.store.remember({
        objectKey: revisedKeys.originalKey,
        userId: ownerId,
        purpose: 'base_image',
        contentType: 'image/png',
        expiresAt: new Date(now.getTime() + 60_000),
      });
      await ctx.intents.store.remember({
        objectKey: revisedKeys.workingKey,
        userId: ownerId,
        purpose: 'working_image',
        contentType: 'image/png',
        expiresAt: new Date(now.getTime() + 60_000),
      });
      const revised = okValue(
        await ctx.useCases.create({
          currentUserId: ownerId,
          name,
          baseImage: revisedKeys,
          copiedFromDesignId: first.design.id,
        })
      );
      if (revised.type !== 'design_created') throw new Error('not created');
      expect(ctx.copied).toHaveBeenCalledWith({
        fromDesignId: first.design.id,
        toDesignId: revised.design.id,
        toBaseImageId: revised.design.baseImage.id,
      });
      expect(ctx.arrived).toHaveBeenLastCalledWith({
        designId: revised.design.id,
        imageId: revised.design.baseImage.id,
        kind: 'base',
        carryFromImageId: null,
      });
      expect(ctx.copied.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.arrived.mock.invocationCallOrder[1] ?? 0
      );
    }
  );

  it('requires a revised design to copy from a design the caller owns', async () => {
    await rememberBaseUploads(ctx.intents);
    const outcome = okValue(
      await ctx.useCases.create({
        currentUserId: ownerId,
        name,
        baseImage,
        copiedFromDesignId: unwrapParseResult(toDesignId('missing')),
      })
    );
    expect(outcome.type).toBe('design_not_found');
  });
});
