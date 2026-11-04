import { Result } from '@bloodyowl/boxed';
import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { okValue } from '@tests/support/result';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { writeImageWithDetection } from '@/composition/image-detection-intent';
import { type DesignRepository, toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import { AppError } from '@/modules/kernel';
import {
  toDesignId,
  toGeneratedId,
  toImageId,
  toObjectKey,
  toRegionId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  createDetectionScheduler,
  DETECTION_START_WINDOW_MS,
  newDetectionProgress,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/testing';

const ownerId = unwrapParseResult(toUserId('owner-1'));
const designId = unwrapParseResult(toDesignId('design-1'));
const imageId = unwrapParseResult(toImageId('base-1'));
const key = (value: string) => unwrapParseResult(toObjectKey(value));
const regionId = (value: string) => unwrapParseResult(toRegionId(value));

describe('RegionRepositoryDrizzle', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  let repository: ReturnType<typeof createRegionRepository>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
    repository = createRegionRepository({ db: database.db });
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
        original: { width: 100, height: 100 },
        workingKey: key('working-images/b.png'),
        working: { width: 100, height: 100 },
      },
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  const region = (
    id: string,
    label: string,
    source: 'detection' | 'click' = 'detection'
  ) => ({
    id: regionId(id),
    designId,
    imageId,
    source,
    label,
    maskKey: key(`region-masks/${id}.png`),
    box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    score: 0.8,
    isSuggestion: false,
    carriedFromRegionId: null,
  });

  it('returns pending detection on an empty image and clears it after the last regions commit', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    const run = { imageId, runId: 'first' };
    expect(
      okValue(
        await repository.startDetection({
          ...run,
          expiresAtMs: expiresAt.getTime(),
        })
      )
    ).toEqual({ type: 'detection_started' });
    expect(
      okValue(
        await repository.startDetection({
          ...run,
          expiresAtMs: expiresAt.getTime(),
        })
      )
    ).toEqual({ type: 'detection_already_started' });
    expect(okValue(await repository.listByImage(imageId))).toEqual({
      type: 'regions_listed',
      regions: [],
      detection: {
        type: 'detection_recorded',
        expiresAt,
        phase: null,
        failed: false,
        omissions: [],
      },
    });
    await repository.insertMany([region('last-region', 'window')]);
    await repository.finishDetection(run);
    expect(okValue(await repository.listByImage(imageId))).toMatchObject({
      detection: { type: 'no_detection' },
      regions: [{ id: 'last-region' }],
    });
  });

  it('lets an accepted worker publish even if its queue acknowledgement was lost', async () => {
    const now = new Date('2027-01-01T00:00:00.000Z');
    const enqueue = vi.fn(async () =>
      Result.Error(
        new AppError({
          code: 'WORKFLOW_START_FAILED',
          category: 'system',
          status: 503,
          message: 'Queue response unavailable',
        })
      )
    );
    const warn = vi.fn();
    const scheduler = createDetectionScheduler({
      regionRepository: repository,
      queue: { enqueue },
      imageAccess: {
        find: async () =>
          Result.Ok({
            type: 'image_found',
            image: {
              imageId,
              designId,
              ownerId,
              workingKey: key('working-images/b.png'),
              width: 100,
              height: 100,
            },
          }),
      },
      conceptSource: { categoriesOf: async () => Result.Ok([]) },
      findCarrySource: async () => Result.Ok({ type: 'no_carry_source' }),
      clock: { now: () => now },
      idGenerator: { createId: () => toGeneratedId('accepted-run') },
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn },
    });
    await repository.startDetection({
      imageId,
      runId: 'intent',
      phase: 'ready',
      expiresAtMs: now.getTime(),
    });
    expect(okValue(await scheduler.schedule({ imageId })).type).toBe(
      'detection_queue_uncertain'
    );
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({
      imageId,
      runId: 'accepted-run',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'segmentation.detection.queue_acceptance_unknown',
      })
    );
    expect(okValue(await scheduler.retry(imageId)).type).toBe(
      'detection_not_retryable'
    );
    const worker = {
      imageId,
      runId: 'accepted-run',
      workerId: 'worker-1',
      now,
    };
    const workerExpiry = new Date(now.getTime() + 30 * 60_000);
    expect(
      okValue(
        await repository.claimDetection({ ...worker, expiresAt: workerExpiry })
      ).type
    ).toBe('detection_started');
    expect(
      okValue(
        await repository.claimDetection({ ...worker, expiresAt: workerExpiry })
      ).type
    ).toBe('detection_started');
    expect(
      okValue(
        await repository.claimDetection({
          ...worker,
          workerId: 'duplicate',
          expiresAt: workerExpiry,
        })
      ).type
    ).toBe('detection_already_started');
    expect(
      okValue(
        await repository.replaceDetections({
          imageId,
          runId: 'accepted-run',
          workerId: 'worker-1',
          now,
          concept: 'window',
          regions: [region('accepted-region', 'window')],
        })
      ).type
    ).toBe('regions_saved');
  });

  it('retains checkpoints and region IDs when a partially failed run is retried', async () => {
    const now = new Date('2027-01-01T00:00:00.000Z');
    const expiresAtMs = now.getTime() + 30_000;
    const first = { imageId, runId: 'first' };
    const second = { imageId, runId: 'second' };
    await repository.startDetection({
      ...first,
      expiresAtMs,
      progress: {
        concepts: null,
        completedConcepts: [],
        carryFromImageId: 'parent',
        carryOverCompleted: false,
      },
    });
    await repository.prepareDetection({
      ...first,
      now,
      concepts: ['chair', 'window', 'lamp'],
    });
    await repository.insertMany([], first);
    await repository.insertMany([region('manual', 'chair', 'click')]);
    await repository.replaceDetections({
      ...first,
      now,
      concept: 'chair',
      regions: [region('chair-original', 'chair')],
    });
    await repository.replaceDetections({
      ...first,
      now,
      concept: 'window',
      regions: [],
    });
    expect(
      okValue(await repository.finalizeDetection({ ...first, now })).type
    ).toBe('detection_failed');

    expect(
      okValue(
        await repository.resumeDetection({
          previous: first,
          runId: second.runId,
          now,
          expiresAtMs,
        })
      ).type
    ).toBe('detection_started');
    expect(
      okValue(
        await repository.prepareDetection({
          ...second,
          now,
          concepts: ['should-not-replace-snapshot'],
        })
      )
    ).toMatchObject({
      type: 'detection_prepared',
      progress: {
        concepts: ['chair', 'window', 'lamp'],
        completedConcepts: ['chair', 'window'],
        carryOverCompleted: true,
      },
    });
    expect(
      okValue(
        await repository.replaceDetections({
          ...first,
          now,
          concept: 'lamp',
          regions: [region('stale', 'lamp')],
        })
      ).type
    ).toBe('detection_superseded');
    expect(
      okValue(
        await repository.replaceDetections({
          ...second,
          now,
          concept: 'chair',
          regions: [region('must-not-replace', 'chair')],
        })
      ).type
    ).toBe('detection_concept_already_completed');
    await repository.replaceDetections({
      ...second,
      now,
      concept: 'lamp',
      regions: [region('lamp-result', 'lamp')],
    });
    expect(
      okValue(await repository.finalizeDetection({ ...second, now })).type
    ).toBe('detection_finished');
    const listed = okValue(await repository.listByImage(imageId));
    expect(listed.detection.type).toBe('no_detection');
    expect(listed.regions.map(({ id }) => id).sort()).toEqual([
      'chair-original',
      'lamp-result',
      'manual',
    ]);
  });

  it('rolls back an image when its intent fails, and records an undispatched result', async () => {
    const resultId = okValue(toImageId('new-result-image'));
    const now = new Date('2027-01-01T00:00:00Z');
    const kernel = {
      db: database.db,
      clock: { now: () => now },
      idGenerator: { createId: () => toGeneratedId('intent-id') },
    };
    const save = (design: DesignRepository) =>
      design.addImage({
        designId,
        image: {
          id: resultId,
          kind: 'result',
          originalKey: key('results/generated.png'),
          originalContentType: 'image/png',
          original: { width: 100, height: 100 },
          workingKey: key('results/generated.png'),
          working: { width: 100, height: 100 },
        },
      });
    const options = { carryFromImageId: imageId, save };
    await repository.startDetection({
      imageId,
      runId: 'existing-intent',
      phase: 'ready',
      expiresAtMs: now.getTime(),
    });
    const failed = await writeImageWithDetection(kernel, {
      ...options,
      imageId: () => imageId,
    });
    expect(failed.isError()).toBe(true);
    const designs = createDesignRepository({ db: database.db });
    expect(okValue(await designs.findImage(resultId)).type).toBe(
      'image_not_found'
    );
    const saved = await writeImageWithDetection(kernel, {
      ...options,
      imageId: () => resultId,
    });
    expect(saved.isOk()).toBe(true);
    expect(okValue(await repository.findDetection(resultId))).toMatchObject({
      type: 'detection_lease',
      phase: 'ready',
      progress: { carryFromImageId: imageId, concepts: null },
    });
  });

  it('recovers an abandoned copy and freezes its saved categories across a rejected dispatch', async () => {
    let now = new Date('2027-01-01T00:00:00Z');
    let attempt = 0;
    let categories = ['sofa'];
    const enqueue = vi.fn(async () =>
      Result.Ok({ type: 'detection_not_enqueued' as const })
    );
    const scheduler = createDetectionScheduler({
      regionRepository: repository,
      queue: { enqueue },
      imageAccess: {
        find: async () =>
          Result.Ok({
            type: 'image_found',
            image: {
              imageId,
              designId,
              ownerId,
              workingKey: key('working-images/base.png'),
              width: 100,
              height: 100,
            },
          }),
      },
      conceptSource: { categoriesOf: async () => Result.Ok(categories) },
      findCarrySource: async () => Result.Ok({ type: 'no_carry_source' }),
      idGenerator: { createId: () => toGeneratedId(`attempt-${++attempt}`) },
      clock: { now: () => now },
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
    });
    await repository.startDetection({
      imageId,
      runId: 'copy-intent',
      phase: 'copying',
      expiresAtMs: now.getTime() + DETECTION_START_WINDOW_MS,
      progress: newDetectionProgress(null),
    });
    expect(okValue(await scheduler.retry(imageId)).type).toBe(
      'detection_not_retryable'
    );
    now = new Date(now.getTime() + DETECTION_START_WINDOW_MS);
    expect(okValue(await scheduler.retry(imageId)).type).toBe(
      'detection_queue_rejected'
    );
    categories = ['sofa', 'pendant light'];
    await scheduler.schedule({ imageId });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(okValue(await repository.findDetection(imageId))).toMatchObject({
      type: 'detection_lease',
      failed: true,
      phase: 'queued',
      progress: { concepts: expect.arrayContaining(['sofa']) },
    });
    expect(okValue(await scheduler.retry(imageId)).type).toBe(
      'detection_queue_rejected'
    );
    const latest = okValue(await repository.findDetection(imageId));
    expect(
      latest.type === 'detection_lease' && latest.progress?.concepts
    ).not.toContain('pendant light');
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('fences expired queue deliveries and retains visible omissions alongside successful regions', async () => {
    const now = new Date('2027-01-01T00:00:00Z');
    const intent = { imageId, runId: 'intent' };
    const expired = { imageId, runId: 'expired' };
    const worker = {
      imageId,
      runId: 'replacement',
      workerId: 'replacement-worker',
    };
    await repository.startDetection({
      ...intent,
      phase: 'ready',
      expiresAtMs: now.getTime(),
      progress: { ...newDetectionProgress(null), concepts: ['window', 'door'] },
    });
    await repository.resumeDetection({
      previous: intent,
      runId: expired.runId,
      now,
      expiresAtMs: now.getTime(),
      dispatch: { previousPhase: 'ready', initial: true },
    });
    await repository.resumeDetection({
      previous: expired,
      runId: worker.runId,
      now,
      expiresAtMs: now.getTime() + 120_000,
      dispatch: { previousPhase: 'queued', initial: false },
    });
    const expiresAt = new Date(now.getTime() + 30 * 60_000);
    expect(
      okValue(
        await repository.claimDetection({
          ...expired,
          now,
          expiresAt,
          workerId: 'late',
        })
      ).type
    ).toBe('detection_already_started');
    expect(
      okValue(await repository.claimDetection({ ...worker, now, expiresAt }))
        .type
    ).toBe('detection_started');
    await repository.omitConcept({
      ...worker,
      now,
      concept: 'door',
      reason: 'invalid_mask',
    });
    await repository.replaceDetections({
      ...worker,
      now,
      concept: 'window',
      regions: [region('valid-window', 'window')],
    });
    expect(
      okValue(await repository.finalizeDetection({ ...worker, now })).type
    ).toBe('detection_finished');
    expect(okValue(await repository.listByImage(imageId))).toMatchObject({
      regions: [{ id: 'valid-window' }],
      detection: {
        type: 'detection_recorded',
        phase: 'omissions',
        omissions: [{ concept: 'door', reason: 'invalid_mask' }],
      },
    });
  });

  it('reclaims an expired lease and fences the old workflow’s writes and cleanup', async () => {
    const expiresAt = new Date('2027-01-01T00:30:00.000Z');
    const nextExpiry = new Date('2027-01-01T01:00:00.000Z');
    const oldRun = { imageId, runId: 'old' };
    const newRun = { imageId, runId: 'new' };
    await repository.startDetection({
      ...oldRun,
      expiresAtMs: expiresAt.getTime(),
    });
    const claims = await Promise.all([
      repository.resumeDetection({
        previous: oldRun,
        runId: newRun.runId,
        now: expiresAt,
        expiresAtMs: nextExpiry.getTime(),
      }),
      repository.resumeDetection({
        previous: oldRun,
        runId: 'other',
        now: expiresAt,
        expiresAtMs: nextExpiry.getTime(),
      }),
    ]);
    expect(claims.map((claim) => okValue(claim).type).sort()).toEqual([
      'detection_already_started',
      'detection_started',
    ]);
    const winner =
      okValue(claims[0]!).type === 'detection_started'
        ? newRun
        : { ...newRun, runId: 'other' };
    await repository.finishDetection(oldRun);
    expect(
      okValue(await repository.listByImage(imageId)).detection
    ).toMatchObject({ type: 'detection_recorded', expiresAt: nextExpiry });
    expect(
      okValue(
        await repository.replaceDetections({
          ...oldRun,
          concept: 'window',
          regions: [region('old-result', 'window')],
        })
      ).type
    ).toBe('detection_superseded');
    expect(
      okValue(
        await repository.insertMany([region('stale-copy', 'window')], oldRun)
      ).type
    ).toBe('detection_superseded');
    expect(
      okValue(
        await repository.replaceDetections({
          ...winner,
          concept: 'window',
          regions: [region('new-result', 'window')],
        })
      ).type
    ).toBe('regions_saved');
    await repository.finishDetection(winner);
    expect(okValue(await repository.listByImage(imageId))).toMatchObject({
      detection: { type: 'no_detection' },
      regions: [{ id: 'new-result' }],
    });
  });

  it('replaces detections per concept and keeps user regions', async () => {
    await repository.insertMany([region('u1', 'door', 'click')]);
    await repository.replaceDetections({
      imageId,
      concept: 'window',
      regions: [region('d1', 'window')],
    });
    await repository.replaceDetections({
      imageId,
      concept: 'window',
      regions: [region('d2', 'window'), region('d3', 'window')],
    });
    const listed = okValue(await repository.listByImage(imageId)).regions;
    expect(listed.map((r) => r.id).sort()).toEqual(['d2', 'd3', 'u1']);
    expect(listed.find((r) => r.id === 'd2')?.box).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    });

    expect(
      okValue(
        await repository.update({
          regionId: regionId('u1'),
          label: 'Front door',
        })
      )
    ).toMatchObject({
      region: { label: 'Front door' },
    });
    await repository.remove(regionId('u1'));
    expect(okValue(await repository.findById(regionId('u1'))).type).toBe(
      'region_not_found'
    );
  });
});
