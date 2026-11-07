import { Result } from '@bloodyowl/boxed';
import { makeUserRow } from '@tests/server/db-fixtures';
import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { makeTestKernel } from '@tests/support/composition-kernel';
import { createFakeItemRepository } from '@tests/support/fake-item-repository';
import {
  createFakeObjectStorage,
  createFakeProviderCallLog,
} from '@tests/support/fake-kernel-ports';
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

const host = vi.hoisted(() => ({
  start: vi.fn(),
  tasks: [] as Promise<unknown>[],
  release: [] as (() => void)[],
}));
vi.mock('workflow/api', () => ({ start: host.start }));
vi.mock('@vercel/functions', () => ({
  getEnv: () => ({ VERCEL: '1', VERCEL_ENV: 'production' }),
  waitUntil: (task: Promise<unknown>) => {
    host.tasks.push(task);
  },
}));

import { getMoodboardPipelineUseCases } from '@/composition/moodboard-pipeline';
import { getSegmentationUseCases } from '@/composition/segmentation';
import { getSegmentationPipelineUseCases } from '@/composition/segmentation-pipeline';
import { toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import {
  toDesignId,
  toGeneratedId,
  toImageId,
  toItemId,
  toItemVersionId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { user } from '@/modules/kernel/infrastructure/db/schema';
import { toItemCategory, toItemName } from '@/modules/moodboard';
import { createFakeBackgroundRemover } from '@/modules/moodboard/backend';
import {
  createFakeSegmenter,
  createRegionRepository,
} from '@/modules/segmentation/backend';

describe('production accounting facades', { timeout: 15000 }, () => {
  let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;
  const ownerId = okValue(toUserId('owner-1'));
  const designId = okValue(toDesignId('design-1'));
  const imageId = okValue(toImageId('base-1'));
  const objectKey = okValue(toObjectKey('working-images/base.png'));
  const now = new Date('2026-11-06T19:00:00Z');
  beforeAll(async () => {
    database = await createRecoveryTestDatabase();
  });
  beforeEach(async () => {
    await database.truncate();
    host.tasks.length = 0;
    host.release.length = 0;
    host.start
      .mockReset()
      .mockImplementation(
        () => new Promise((resolve) => host.release.push(() => resolve({})))
      );
    await database.db.insert(user).values(makeUserRow({ id: ownerId }));
    okValue(
      await createDesignRepository({ db: database.db }).create({
        id: designId,
        ownerId,
        name: okValue(toDesignName('Room')),
        copiedFromDesignId: null,
        baseImage: {
          id: imageId,
          kind: 'base',
          originalKey: objectKey,
          originalContentType: 'image/png',
          original: { width: 100, height: 50 },
          workingKey: objectKey,
          working: { width: 100, height: 50 },
        },
      })
    );
  });
  afterEach(async () => {
    for (const release of host.release) release();
    host.start.mockResolvedValue({});
    await Promise.allSettled(host.tasks);
  });
  afterAll(async () => {
    await database?.close();
  });
  const setup = () => {
    const storage = createFakeObjectStorage();
    const calls = createFakeProviderCallLog();
    let counter = 0;
    const kernel = makeTestKernel({
      db: database.db,
      objectStorage: storage.storage,
      providerAccounting: calls.accounting,
      clock: { now: () => now },
      idGenerator: { createId: () => toGeneratedId(`id-${++counter}`) },
    });
    return { kernel, storage, calls };
  };

  it('returns actual interactive SAM regions while Vercel owns unresolved dispatch', async () => {
    const { kernel, storage, calls } = setup();
    const facade = getSegmentationUseCases({
      kernel,
      segmenter: createFakeSegmenter(),
    });
    const result = okValue(
      await facade.segment({
        currentUserId: ownerId,
        imageId,
        prompt: { type: 'text', text: 'sofa' },
        label: 'sofa',
      })
    );
    expect(result.type).toBe('regions_created');
    expect(storage.objects.size).toBe(1);
    expect(calls.receipts.size).toBe(1);
    expect(host.tasks).toHaveLength(1);
  });

  it('publishes actual automatic SAM regions before its workflow dispatch completes', async () => {
    const { kernel, calls } = setup();
    const regionRepository = createRegionRepository({ db: database.db });
    const facade = getSegmentationPipelineUseCases({
      kernel,
      regionRepository,
      segmenter: createFakeSegmenter(),
      conceptSource: { categoriesOf: async () => Result.Ok(['sofa']) },
    });
    const run = { imageId, runId: 'attempt-1', workerId: 'worker-1' };
    okValue(
      await regionRepository.startDetection({
        imageId,
        runId: run.runId,
        phase: 'ready',
        progress: {
          concepts: null,
          completedConcepts: [],
          carryFromImageId: null,
          carryOverCompleted: true,
        },
        expiresAtMs: now.getTime() + 120000,
      })
    );
    okValue(
      await regionRepository.resumeDetection({
        previous: { imageId, runId: run.runId },
        runId: run.runId,
        now,
        expiresAtMs: now.getTime() + 120000,
        dispatch: { previousPhase: 'ready', initial: true },
      })
    );
    expect(okValue(await facade.claimDetection(run)).type).toBe(
      'detection_started'
    );
    expect(okValue(await facade.prepareDetection(run)).type).toBe(
      'detection_prepared'
    );
    const running = facade.detectConcept({ ...run, concept: 'sofa' });
    await vi.waitFor(() => expect(host.start).toHaveBeenCalled());
    expect(
      okValue(await regionRepository.listByImage(imageId)).regions
    ).toHaveLength(1);
    expect(calls.receipts.size).toBe(1);
    for (const release of host.release) release();
    expect(okValue(await running).type).toBe('concept_detected');
  });

  it('publishes an actual cutout before its workflow dispatch completes', async () => {
    const { kernel, storage, calls } = setup();
    const items = createFakeItemRepository(() => now);
    const itemId = okValue(toItemId('item-1'));
    const versionId = okValue(toItemVersionId('version-1'));
    okValue(
      await storage.storage.createObject({
        objectKey,
        body: Uint8Array.of(1, 2, 3),
        contentType: 'image/png',
      })
    );
    okValue(
      await items.repository.create({
        id: itemId,
        designId,
        kind: 'product',
        name: okValue(toItemName('Chair')),
        category: okValue(toItemCategory('Chair')),
        vendor: null,
        productUrl: null,
        version: {
          id: versionId,
          photo: {
            key: objectKey,
            width: 100,
            height: 50,
            contentType: 'image/png',
          },
          cutoutKey: null,
          maskKey: null,
          cutoutStatus: 'pending',
          cutoutAttempt: { id: 'attempt-1', startedAt: now },
        },
      })
    );
    const facade = getMoodboardPipelineUseCases({
      kernel,
      itemRepository: items.repository,
      backgroundRemover: createFakeBackgroundRemover({
        objectStorage: storage.storage,
      }),
      designAccess: {
        isOwnedBy: async () => Result.Ok({ type: 'owned' }),
        ownerOf: async () => Result.Ok({ type: 'owner', userId: ownerId }),
      },
    });
    const running = facade.removeBackground({
      versionId,
      attemptId: 'attempt-1',
    });
    await vi.waitFor(() => expect(host.start).toHaveBeenCalled());
    expect(
      okValue(await items.repository.findVersion(versionId))
    ).toMatchObject({ version: { cutoutStatus: 'ready' } });
    expect(calls.receipts.size).toBe(1);
    for (const release of host.release) release();
    expect(okValue(await running).type).toBe('cutout_ready');
  });
});
