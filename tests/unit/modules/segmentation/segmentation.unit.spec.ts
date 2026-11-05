import { Result } from '@bloodyowl/boxed';
import {
  createFakeObjectStorage,
  createFakeProviderCallLog,
  createFakeUploadIntentStore,
} from '@tests/support/fake-kernel-ports';
import { okValue } from '@tests/support/result';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';
import { ObjectCopySourceError } from '@/modules/kernel/application/ports/object-storage';
import {
  type DesignId,
  type ImageId,
  toDesignId,
  toGeneratedId,
  toImageId,
  toObjectKey,
  toRegionId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  createSegmentationPipelineUseCases,
  createSegmentationUseCases,
  detectionConcepts,
  type NewRegion,
  type Region,
  type RegionRepository,
  RegionWriteError,
  type Segmenter,
  toFractionalBox,
} from '@/modules/segmentation';
import { createFakeSegmenter } from '@/modules/segmentation/backend';

const now = new Date('2026-11-02T12:00:00.000Z');
const ownerId = unwrapParseResult(toUserId('owner-1'));
const strangerId = unwrapParseResult(toUserId('owner-2'));
const designId: DesignId = unwrapParseResult(toDesignId('design-1'));
const baseImageId: ImageId = unwrapParseResult(toImageId('base-1'));
const resultImageId: ImageId = unwrapParseResult(toImageId('result-1'));
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const fakeRegions = () => {
  const rows: Region[] = [];
  const toRegion = (region: NewRegion): Region => ({
    ...region,
    createdAt: now,
  });
  const repository: RegionRepository = {
    async matchImageWrite() {
      return Result.Ok({ type: 'image_write_not_matched' });
    },
    async unreferencedMaskKeys(keys) {
      return Result.Ok({
        type: 'unreferenced_mask_keys',
        keys: keys.filter((key) => !rows.some((row) => row.maskKey === key)),
      });
    },
    async findDetection() {
      return Result.Ok({
        type: 'detection_lease',
        runId: 'run-1',
        workerId: null,
        phase: null,
        failed: false,
        expiresAt: new Date(now.getTime() + 1000),
        progress: null,
      });
    },
    async detectionLabels() {
      return Result.Ok([]);
    },
    async claimDetection() {
      return Result.Ok({ type: 'detection_started' });
    },
    async failDispatch() {
      return Result.Ok({ type: 'dispatch_failure_recorded' });
    },
    async omitConcept() {
      return Result.Ok({ type: 'regions_saved' });
    },
    async startDetection() {
      return Result.Ok({ type: 'detection_started' });
    },
    async resumeDetection() {
      return Result.Ok({ type: 'detection_started' });
    },
    async prepareDetection() {
      return Result.Ok({ type: 'detection_superseded' });
    },
    async finalizeDetection() {
      return Result.Ok({ type: 'detection_finished' });
    },
    async finishDetection() {
      return Result.Ok({ type: 'detection_finished' });
    },
    async listByImage(imageId) {
      return Result.Ok({
        type: 'regions_listed',
        detection: { type: 'no_detection' },
        regions: rows.filter((r) => r.imageId === imageId),
      });
    },
    async findById(regionId) {
      const region = rows.find((r) => r.id === regionId);
      return Result.Ok(
        region ? { type: 'region_found', region } : { type: 'region_not_found' }
      );
    },
    async insertMany(regions) {
      rows.push(...regions.map(toRegion));
      return Result.Ok({ type: 'regions_saved' });
    },
    async replaceDetections(input) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (
          row &&
          row.imageId === input.imageId &&
          row.source === 'detection' &&
          row.label === input.concept
        ) {
          rows.splice(index, 1);
        }
      }
      rows.push(...input.regions.map(toRegion));
      return Result.Ok({ type: 'regions_saved' });
    },
    async update(input) {
      const region = rows.find((r) => r.id === input.regionId);
      if (!region) return Result.Ok({ type: 'region_not_found' });
      if (input.label !== undefined) region.label = input.label;
      if (input.isSuggestion !== undefined)
        region.isSuggestion = input.isSuggestion;
      return Result.Ok({ type: 'region_found', region });
    },
    async remove(regionId) {
      const index = rows.findIndex((r) => r.id === regionId);
      if (index >= 0) rows.splice(index, 1);
      return Result.Ok({ type: 'region_removed' });
    },
  };
  return { repository, rows };
};

const setup = (segmenter: Segmenter = createFakeSegmenter()) => {
  let counter = 0;
  const regions = fakeRegions();
  const storage = createFakeObjectStorage();
  const calls = createFakeProviderCallLog();
  const intents = createFakeUploadIntentStore();
  const imageAccess = {
    find: async (imageId: ImageId) =>
      Result.Ok({
        type: 'image_found' as const,
        image: {
          imageId,
          designId,
          ownerId,
          workingKey: unwrapParseResult(
            toObjectKey(`working-images/${imageId}.png`)
          ),
          width: 2048,
          height: 1024,
        },
      }),
  };
  const common = {
    regionRepository: regions.repository,
    imageAccess,
    segmenter,
    objectStorage: storage.storage,
    providerCallLog: calls.log,
    idGenerator: {
      createId: () => {
        counter += 1;
        return toGeneratedId(`r${counter}`);
      },
    },
    clock: { now: () => now },
    logger,
  };
  const useCases = createSegmentationUseCases({
    ...common,
    uploadIntentStore: intents.store,
    detectionRetry: {
      retry: async () => Result.Ok({ type: 'auto_detection_scheduled' }),
    },
    permissionChecker: {
      hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
    },
  });
  const pipeline = createSegmentationPipelineUseCases({
    ...common,
    conceptSource: {
      categoriesOf: async () => Result.Ok(['Lighting', 'Plants']),
    },
  });
  return {
    useCases,
    pipeline,
    regions,
    storage,
    calls,
    intents,
    idGenerator: common.idGenerator,
  };
};

describe('segmentation domain', () => {
  it('combines fixed concepts with mood-board categories, de-duplicated and capped', () => {
    const concepts = detectionConcepts(['Lighting', 'PLANT', ' Cladding ']);
    expect(concepts.slice(0, 8)).toContain('light fixture');
    expect(concepts).toContain('lighting');
    expect(concepts).toContain('cladding');
    expect(concepts.filter((concept) => concept === 'plant')).toHaveLength(1);
    expect(
      detectionConcepts(Array.from({ length: 40 }, (_, i) => `c${i}`))
    ).toHaveLength(16);
  });

  it('converts pixel boxes to fractional boxes', () => {
    expect(
      toFractionalBox([512, 256, 1024, 768], { width: 2048, height: 1024 })
    ).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.25,
      height: 0.5,
    });
  });
});

describe('interactive segmentation', () => {
  it('stores the returned mask as a region and logs the call', async () => {
    const ctx = setup();
    const outcome = okValue(
      await ctx.useCases.segment({
        currentUserId: ownerId,
        imageId: baseImageId,
        label: 'Front door',
        prompt: { type: 'click', points: [{ x: 0.5, y: 0.5, positive: true }] },
      })
    );
    expect(outcome.type).toBe('regions_created');
    if (outcome.type !== 'regions_created') return;
    const [region] = outcome.regions;
    expect(region).toMatchObject({
      source: 'click',
      label: 'Front door',
      isSuggestion: false,
    });
    expect(ctx.storage.objects.has(`region-masks/${region?.id}.png`)).toBe(
      true
    );
    expect([...ctx.calls.calls.values()][0]).toMatchObject({
      purpose: 'segmentation',
      status: 'succeeded',
      userId: ownerId,
    });
  });

  it('hides images of other owners', async () => {
    const ctx = setup();
    expect(
      okValue(
        await ctx.useCases.list({
          currentUserId: strangerId,
          imageId: baseImageId,
        })
      ).type
    ).toBe('image_not_found');
  });

  it.each(['missing source', 'upload failure', 'cleanup failure'] as const)(
    'handles a multi-mask batch with %s',
    async (scenario) => {
      const bytes = { kind: 'bytes' as const, bytes: Uint8Array.of(1) };
      const ctx = setup({
        async segment() {
          return Result.Ok({
            type: 'segmented',
            provider: 'fake',
            endpoint: 'fake/segmentation',
            providerRequestId: undefined,
            costUsdMicros: 0,
            costSource: 'price_table',
            masks: [
              { mask: bytes, box: [0, 0, 10, 10], score: 1 },
              {
                mask:
                  scenario === 'missing source'
                    ? { kind: 'url', url: 'https://provider.test/missing.png' }
                    : bytes,
                box: [10, 0, 20, 10],
                score: 1,
              },
            ],
          });
        },
      });
      ctx.storage.objects.set('region-masks/previous.png', {
        bytes: bytes.bytes,
        contentType: 'image/png',
      });
      const uploadError = new AppError({
        code: 'UPLOAD_FAILED',
        category: 'system',
        status: 500,
      });
      if (scenario !== 'missing source') {
        const put = ctx.storage.storage.putObject;
        vi.spyOn(ctx.storage.storage, 'putObject')
          .mockImplementationOnce(put)
          .mockImplementationOnce(async (input) => {
            await put(input);
            return Result.Error(uploadError);
          });
      }
      if (scenario === 'cleanup failure') {
        vi.spyOn(ctx.storage.storage, 'deleteObject').mockResolvedValueOnce(
          Result.Error(
            new AppError({
              code: 'DELETE_FAILED',
              category: 'system',
              status: 500,
            })
          )
        );
      }

      const outcome = await ctx.useCases.segment({
        currentUserId: ownerId,
        imageId: baseImageId,
        label: 'Front door',
        prompt: { type: 'click', points: [{ x: 0.5, y: 0.5, positive: true }] },
      });
      if (scenario === 'missing source') {
        expect(okValue(outcome)).toMatchObject({
          type: 'regions_created',
          regions: [{ id: 'r1' }],
        });
        expect(ctx.regions.rows).toHaveLength(1);
      } else {
        expect(outcome.isError() && outcome.getError()).toBe(uploadError);
        expect(ctx.regions.rows).toHaveLength(0);
      }
      expect([...ctx.storage.objects.keys()]).toEqual(
        scenario === 'upload failure'
          ? ['region-masks/previous.png', 'region-masks/r2.png']
          : scenario === 'cleanup failure'
            ? [
                'region-masks/previous.png',
                'region-masks/r1.png',
                'region-masks/r2.png',
              ]
            : ['region-masks/previous.png', 'region-masks/r1.png']
      );
    }
  );
});

describe('segmentation pipeline', () => {
  it('rejects a worker without a run ID before looking up or segmenting an image', async () => {
    const segment = vi.fn(createFakeSegmenter().segment);
    const ctx = setup({ segment });
    const findDetection = vi.spyOn(ctx.regions.repository, 'findDetection');
    const replaceDetections = vi.spyOn(
      ctx.regions.repository,
      'replaceDetections'
    );
    const partial = {
      imageId: baseImageId,
      concept: 'window',
      workerId: 'worker',
    };
    // @ts-expect-error Simulate malformed input crossing the typed boundary.
    const outcome = await ctx.pipeline.detectConcept(partial);
    expect(outcome.isError() && outcome.getError().code).toBe(
      'DETECTION_IDENTITY_INVALID'
    );
    expect(findDetection).not.toHaveBeenCalled();
    expect(segment).not.toHaveBeenCalled();
    expect(replaceDetections).not.toHaveBeenCalled();
  });

  it('avoids paid calls for superseded and completed concepts', async () => {
    const segment = vi.fn(createFakeSegmenter().segment);
    const ctx = setup({ segment });
    const input = {
      imageId: baseImageId,
      concept: 'window',
      runId: 'current',
      workerId: 'worker',
    };
    expect(okValue(await ctx.pipeline.detectConcept(input)).type).toBe(
      'detection_superseded'
    );
    vi.spyOn(ctx.regions.repository, 'findDetection').mockResolvedValue(
      Result.Ok({
        type: 'detection_lease',
        phase: 'running',
        runId: input.runId,
        workerId: input.workerId,
        expiresAt: new Date(now.getTime() + 1000),
        failed: false,
        progress: {
          concepts: ['window'],
          completedConcepts: ['window'],
          carryFromImageId: null,
          carryOverCompleted: true,
        },
      })
    );
    expect(okValue(await ctx.pipeline.detectConcept(input)).type).toBe(
      'detection_concept_already_completed'
    );
    expect(segment).not.toHaveBeenCalled();
  });

  it.each([
    {
      rejection: 'prompt',
      expected: { type: 'concept_omitted' },
      reason: 'prompt_rejected',
    },
    {
      rejection: 'invalid mask',
      expected: { type: 'concept_omitted' },
      reason: 'invalid_mask',
    },
    ...(['missing mask', 'content_type', 'declared_too_large'] as const).map(
      (rejection) => ({
        rejection,
        expected: { type: 'concept_failed', reason: 'mask_unavailable' },
        reason: undefined,
      })
    ),
  ] as const)(
    'handles $rejection without publishing a partial concept',
    async ({ rejection, expected, reason }) => {
      const ctx = setup({
        async segment() {
          if (rejection === 'prompt')
            return Result.Ok({
              type: 'segmentation_failed',
              reason: 'provider_rejected_422',
              terminal: true,
              provider: 'fake',
              endpoint: 'fake/segmentation',
            });
          return Result.Ok({
            type: 'segmented',
            provider: 'fake',
            endpoint: 'fake/segmentation',
            providerRequestId: undefined,
            costUsdMicros: 0,
            costSource: 'price_table',
            masks: [
              {
                mask: { kind: 'bytes', bytes: Uint8Array.of(1) },
                box: [0, 0, 10, 10],
                score: 1,
              },
              {
                mask: { kind: 'url', url: 'https://provider.test/mask.png' },
                box: [10, 0, 20, 10],
                score: 1,
              },
            ],
          });
        },
      });
      if (rejection !== 'prompt' && rejection !== 'missing mask') {
        vi.spyOn(ctx.storage.storage, 'copyNewObjectFromUrl').mockResolvedValue(
          Result.Ok({
            type: 'copy_source_rejected',
            reason: rejection === 'invalid mask' ? 'too_large' : rejection,
          })
        );
      }
      const omit = vi.spyOn(ctx.regions.repository, 'omitConcept');
      vi.spyOn(ctx.regions.repository, 'findDetection').mockResolvedValue(
        Result.Ok({
          type: 'detection_lease',
          phase: 'running',
          runId: 'current',
          workerId: 'worker',
          expiresAt: new Date(now.getTime() + 1000),
          failed: false,
          progress: {
            concepts: ['window'],
            completedConcepts: [],
            carryFromImageId: null,
            carryOverCompleted: true,
          },
        })
      );
      expect(
        okValue(
          await ctx.pipeline.detectConcept({
            imageId: baseImageId,
            concept: 'window',
            runId: 'current',
            workerId: 'worker',
          })
        )
      ).toEqual(expected);
      expect(omit.mock.calls.map(([input]) => input.reason)).toEqual(
        reason ? [reason] : []
      );
      expect(ctx.storage.objects.size).toBe(0);
      expect(ctx.regions.rows).toHaveLength(0);
    }
  );

  it('detects each concept and replaces earlier detections on re-run', async () => {
    const ctx = setup();
    const concepts = okValue(await ctx.pipeline.concepts(baseImageId));
    expect(concepts.type === 'concepts' && concepts.concepts).toContain(
      'lighting'
    );
    await ctx.pipeline.detectConcept({
      imageId: baseImageId,
      concept: 'window',
    });
    await ctx.pipeline.detectConcept({
      imageId: baseImageId,
      concept: 'window',
    });
    expect(ctx.regions.rows.filter((r) => r.label === 'window')).toHaveLength(
      1
    );
  });

  it.each([
    'detection_superseded',
    'detection_concept_already_completed',
  ] as const)(
    'discards only its fresh mask when publish reports %s',
    async (type) => {
      const ctx = setup();
      const input = { imageId: baseImageId, concept: 'window', runId: 'run-1' };
      await ctx.pipeline.detectConcept(input);
      const [winner] = ctx.regions.rows;
      vi.spyOn(
        ctx.regions.repository,
        'replaceDetections'
      ).mockResolvedValueOnce(Result.Ok({ type }));
      expect(okValue(await ctx.pipeline.detectConcept(input))).toEqual({
        type,
      });
      expect(ctx.regions.rows).toEqual([winner]);
      expect([...ctx.storage.objects.keys()]).toEqual([winner?.maskKey]);
    }
  );

  it('keeps the uploaded mask when the publish commit is uncertain', async () => {
    const ctx = setup();
    const error = new AppError({
      code: 'DB_ERROR',
      category: 'system',
      status: 500,
    });
    vi.spyOn(ctx.regions.repository, 'replaceDetections').mockResolvedValueOnce(
      Result.Error(error)
    );
    const outcome = await ctx.pipeline.detectConcept({
      imageId: baseImageId,
      concept: 'window',
      runId: 'run-1',
    });
    expect(outcome.isError()).toBe(true);
    expect(ctx.storage.objects.size).toBe(1);
  });

  it.each(['zero masks', 'missing source', 'lost upload response'] as const)(
    'checks completion and cleanup for %s',
    async (scenario) => {
      const bytes = { kind: 'bytes' as const, bytes: Uint8Array.of(1) };
      const missing = {
        kind: 'url' as const,
        url: 'https://provider.test/mask.png',
      };
      const box: [number, number, number, number] = [0, 0, 10, 10];
      const masks =
        scenario === 'zero masks'
          ? []
          : [
              { mask: bytes, box, score: 1 },
              {
                mask: scenario === 'missing source' ? missing : bytes,
                box,
                score: 1,
              },
            ];
      const ctx = setup({
        async segment() {
          return Result.Ok({
            type: 'segmented',
            provider: 'fake',
            endpoint: 'fake/segmentation',
            providerRequestId: undefined,
            costUsdMicros: 0,
            costSource: 'price_table',
            masks,
          });
        },
      });
      const publish = vi.spyOn(ctx.regions.repository, 'replaceDetections');
      if (scenario === 'lost upload response') {
        const original = ctx.storage.storage.putObject;
        const upload = vi.spyOn(ctx.storage.storage, 'putObject');
        upload
          .mockImplementationOnce(original)
          .mockImplementationOnce(async (input) => {
            await original(input);
            return Result.Error(
              new AppError({
                code: 'UPLOAD_FAILED',
                category: 'system',
                status: 500,
              })
            );
          });
      }
      const outcome = await ctx.pipeline.detectConcept({
        imageId: baseImageId,
        concept: 'window',
        runId: 'run-1',
      });
      expect(ctx.storage.objects.size).toBe(
        scenario === 'lost upload response' ? 1 : 0
      );
      if (scenario === 'zero masks') {
        expect(okValue(outcome)).toEqual({
          type: 'concept_detected',
          count: 0,
        });
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({ regions: [] })
        );
      } else {
        expect(publish).not.toHaveBeenCalled();
        if (scenario === 'missing source') {
          expect(okValue(outcome)).toEqual({
            type: 'concept_failed',
            reason: 'mask_unavailable',
          });
        } else {
          expect(outcome.isError()).toBe(true);
        }
      }
    }
  );

  it('carries user-made regions over as suggestions, once', async () => {
    const ctx = setup();
    await ctx.useCases.segment({
      currentUserId: ownerId,
      imageId: baseImageId,
      label: 'Facade',
      prompt: { type: 'box', box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } },
    });
    await ctx.pipeline.detectConcept({ imageId: baseImageId, concept: 'roof' });
    const first = okValue(
      await ctx.pipeline.carryOver({
        fromImageId: baseImageId,
        toImageId: resultImageId,
      })
    );
    const second = okValue(
      await ctx.pipeline.carryOver({
        fromImageId: baseImageId,
        toImageId: resultImageId,
      })
    );
    expect(first).toEqual({ type: 'regions_carried_over', count: 1 });
    expect(second).toEqual({ type: 'regions_carried_over', count: 0 });
    const carried = ctx.regions.rows.filter((r) => r.imageId === resultImageId);
    expect(carried).toEqual([
      expect.objectContaining({
        label: 'Facade',
        isSuggestion: true,
        source: 'box',
      }),
    ]);
  });
});

it.each([
  { count: 0, expected: { type: 'regions_created', regions: [] } },
  {
    count: 1,
    expected: { type: 'segmentation_failed', reason: 'mask_unavailable' },
  },
])(
  'distinguishes $count unavailable masks from a genuine empty result',
  async ({ count, expected }) => {
    const ctx = setup({
      async segment() {
        return Result.Ok({
          type: 'segmented',
          provider: 'fake',
          endpoint: 'fake/segmentation',
          providerRequestId: undefined,
          costUsdMicros: 0,
          costSource: 'price_table',
          masks: Array.from({ length: count }, () => ({
            mask: {
              kind: 'url' as const,
              url: 'https://provider.test/missing.png',
            },
            box: [0, 0, 10, 10] as [number, number, number, number],
            score: 1,
          })),
        });
      },
    });
    expect(
      okValue(
        await ctx.useCases.segment({
          currentUserId: ownerId,
          imageId: baseImageId,
          prompt: { type: 'text', text: 'chair' },
          label: 'Chair',
        })
      )
    ).toEqual(expected);
    expect(ctx.calls.calls.size).toBe(1);
    expect(ctx.regions.rows).toHaveLength(0);
  }
);

it.each([
  { publication: 'rejected' as const, keys: ['region-masks/previous.png'] },
  {
    publication: 'unknown' as const,
    keys: ['region-masks/previous.png', 'region-masks/r1.png'],
  },
])(
  'cleans interactive masks only when publication is $publication',
  async ({ publication, keys }) => {
    const ctx = setup();
    ctx.storage.objects.set('region-masks/previous.png', {
      bytes: Uint8Array.of(1),
      contentType: 'image/png',
    });
    const error = new RegionWriteError(publication, new Error('insert failed'));
    vi.spyOn(ctx.regions.repository, 'insertMany').mockResolvedValue(
      Result.Error(error)
    );
    const result = await ctx.useCases.segment({
      currentUserId: ownerId,
      imageId: baseImageId,
      prompt: { type: 'click', points: [{ x: 0.5, y: 0.5, positive: true }] },
      label: 'Chair',
    });
    expect(result.isError() && result.getError()).toBe(error);
    expect([...ctx.storage.objects.keys()]).toEqual(keys);
  }
);

it('never overwrites or deletes a published mask after an ID collision', async () => {
  const ctx = setup();
  const input = {
    currentUserId: ownerId,
    imageId: baseImageId,
    prompt: { type: 'text' as const, text: 'chair' },
    label: 'Chair',
  };
  await ctx.useCases.segment(input);
  const original = { bytes: Uint8Array.of(90, 91), contentType: 'image/png' };
  ctx.storage.objects.set('region-masks/r1.png', original);
  vi.spyOn(ctx.idGenerator, 'createId').mockReturnValue(toGeneratedId('r1'));
  const deleted = vi.spyOn(ctx.storage.storage, 'deleteObject');
  const result = await ctx.useCases.segment(input);
  expect(result.isError() && result.getError().code).toBe('MASK_KEY_COLLISION');
  expect(ctx.storage.objects.get('region-masks/r1.png')).toEqual(original);
  expect(ctx.regions.rows).toHaveLength(1);
  expect(deleted).not.toHaveBeenCalled();
});

it('preserves masks when the reference lookup cannot establish cleanup safety', async () => {
  const ctx = setup();
  const original = new RegionWriteError(
    'rejected',
    new Error('constraint failed')
  );
  vi.spyOn(ctx.regions.repository, 'insertMany').mockResolvedValue(
    Result.Error(original)
  );
  vi.spyOn(ctx.regions.repository, 'unreferencedMaskKeys').mockResolvedValue(
    Result.Error(
      new AppError({ code: 'LOOKUP_FAILED', category: 'system', status: 500 })
    )
  );
  const deleted = vi.spyOn(ctx.storage.storage, 'deleteObject');
  const result = await ctx.useCases.segment({
    currentUserId: ownerId,
    imageId: baseImageId,
    prompt: { type: 'text', text: 'chair' },
    label: 'Chair',
  });
  expect(result.isError() && result.getError()).toBe(original);
  expect(ctx.storage.objects.has('region-masks/r1.png')).toBe(true);
  expect(deleted).not.toHaveBeenCalled();
});

it('logs a skipped interactive download and retains the paid provider record', async () => {
  const ctx = setup({
    async segment() {
      return Result.Ok({
        type: 'segmented',
        provider: 'fake',
        endpoint: 'fake/sam',
        providerRequestId: undefined,
        costUsdMicros: 20,
        costSource: 'price_table',
        masks: [
          {
            mask: {
              kind: 'url',
              url: 'https://provider.test/expired.png?secret=hidden',
            },
            box: [0, 0, 10, 10],
            score: 1,
          },
        ],
      });
    },
  });
  const warn = vi.spyOn(logger, 'warn');
  const outcome = await ctx.useCases.segment({
    currentUserId: ownerId,
    imageId: baseImageId,
    prompt: { type: 'text', text: 'chair' },
    label: 'Chair',
  });
  expect(okValue(outcome)).toEqual({
    type: 'segmentation_failed',
    reason: 'mask_unavailable',
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'segmentation.mask.copy_failed',
      details: expect.objectContaining({
        status: 404,
        reason: 'http',
        imageId: baseImageId,
      }),
    })
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('secret=hidden');
  expect([...ctx.calls.calls.values()]).toMatchObject([
    { status: 'succeeded', costUsdMicros: 20 },
  ]);
  warn.mockRestore();
});

it('cleans only its confirmed creation when an ID repeats within a batch', async () => {
  const ctx = setup({
    async segment() {
      return Result.Ok({
        type: 'segmented',
        provider: 'fake',
        endpoint: 'fake/sam',
        providerRequestId: undefined,
        costUsdMicros: 20,
        costSource: 'price_table',
        masks: [1, 2].map(() => ({
          mask: { kind: 'bytes' as const, bytes: Uint8Array.of(1) },
          box: [0, 0, 10, 10] as [number, number, number, number],
          score: 1,
        })),
      });
    },
  });
  vi.spyOn(ctx.idGenerator, 'createId').mockReturnValue(
    toGeneratedId('repeated')
  );
  const result = await ctx.useCases.segment({
    currentUserId: ownerId,
    imageId: baseImageId,
    prompt: { type: 'text', text: 'chair' },
    label: 'Chair',
  });
  expect(result.isError() && result.getError().code).toBe('MASK_KEY_COLLISION');
  expect(ctx.storage.objects.size).toBe(0);
  expect(ctx.regions.rows).toHaveLength(0);
  expect(ctx.calls.calls.size).toBe(1);
});

it('preserves a confirmed-created object referenced by a copied region', async () => {
  const ctx = setup();
  ctx.regions.rows.push({
    id: okValue(toRegionId('copied-region')),
    imageId: resultImageId,
    designId,
    maskKey: okValue(toObjectKey('region-masks/r1.png')),
    source: 'click',
    label: 'Copied',
    box: { x: 0, y: 0, width: 1, height: 1 },
    score: null,
    isSuggestion: true,
    carriedFromRegionId: null,
    createdAt: now,
  });
  const error = new RegionWriteError('rejected', new Error('insert rejected'));
  vi.spyOn(ctx.regions.repository, 'insertMany').mockResolvedValue(
    Result.Error(error)
  );
  const deleted = vi.spyOn(ctx.storage.storage, 'deleteObject');
  const result = await ctx.useCases.segment({
    currentUserId: ownerId,
    imageId: baseImageId,
    prompt: { type: 'text', text: 'chair' },
    label: 'Chair',
  });
  expect(result.isError() && result.getError()).toBe(error);
  expect(ctx.storage.objects.has('region-masks/r1.png')).toBe(true);
  expect(deleted).not.toHaveBeenCalled();
});

it('preserves the original insert rejection when cleanup fails', async () => {
  const ctx = setup();
  const original = new RegionWriteError(
    'rejected',
    new Error('insert rejected')
  );
  vi.spyOn(ctx.regions.repository, 'insertMany').mockResolvedValue(
    Result.Error(original)
  );
  vi.spyOn(ctx.storage.storage, 'deleteObject').mockResolvedValue(
    Result.Error(
      new AppError({ code: 'CLEANUP_FAILED', category: 'system', status: 500 })
    )
  );
  const warn = vi.spyOn(logger, 'warn');
  const result = await ctx.useCases.segment({
    currentUserId: ownerId,
    imageId: baseImageId,
    prompt: { type: 'text', text: 'chair' },
    label: 'Chair',
  });
  expect(result.isError() && result.getError()).toBe(original);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'segmentation.mask.cleanup_failed' })
  );
  expect(ctx.storage.objects.has('region-masks/r1.png')).toBe(true);
  warn.mockRestore();
});

it.each(['rejected', 'unknown'] as const)(
  'uses publication proof for an automatic batch with %s persistence',
  async (publication) => {
    const ctx = setup();
    const error = new RegionWriteError(
      publication,
      new Error('publication failed')
    );
    vi.spyOn(ctx.regions.repository, 'replaceDetections').mockResolvedValue(
      Result.Error(error)
    );
    const result = await ctx.pipeline.detectConcept({
      imageId: baseImageId,
      concept: 'chair',
    });
    expect(result.isError() && result.getError()).toBe(error);
    expect(ctx.storage.objects.has('region-masks/r1.png')).toBe(
      publication === 'unknown'
    );
    expect(ctx.calls.calls.size).toBe(1);
  }
);

it('shows a completed record as idle even after its execution deadline', async () => {
  const ctx = setup();
  vi.spyOn(ctx.regions.repository, 'listByImage').mockResolvedValue(
    Result.Ok({
      type: 'regions_listed',
      regions: [],
      detection: {
        type: 'detection_recorded',
        phase: 'completed',
        failed: false,
        expiresAt: new Date('2020-01-01T00:00:00Z'),
        omissions: [],
      },
    })
  );
  expect(
    okValue(
      await ctx.useCases.list({ currentUserId: ownerId, imageId: baseImageId })
    )
  ).toMatchObject({ detection: { type: 'idle', omissions: [] } });
});

it.each([true, false])(
  'keeps interactive partial success when a source fails: usable=%s',
  async (usable) => {
    const ctx = setup({
      async segment() {
        return Result.Ok({
          type: 'segmented',
          provider: 'fake',
          endpoint: 'fake/sam',
          costUsdMicros: 10,
          costSource: 'reported',
          providerRequestId: 'paid',
          masks: [
            ...(usable
              ? [
                  {
                    mask: { kind: 'bytes' as const, bytes: Uint8Array.of(1) },
                    box: [0, 0, 1, 1] as [number, number, number, number],
                    score: 1,
                  },
                ]
              : []),
            {
              mask: {
                kind: 'url' as const,
                url: 'https://provider.test/mask?token=private',
              },
              box: [0, 0, 1, 1],
              score: 1,
            },
          ],
        });
      },
    });
    const error = new ObjectCopySourceError({
      reason: 'network',
      attempts: 3,
      cause: Object.assign(new Error('private URL must not appear in logs'), {
        code: 'ECONNRESET',
      }),
    });
    vi.spyOn(ctx.storage.storage, 'copyNewObjectFromUrl').mockResolvedValue(
      Result.Error(error)
    );
    const result = await ctx.useCases.segment({
      currentUserId: ownerId,
      imageId: baseImageId,
      prompt: { type: 'text', text: 'chair' },
      label: 'chair',
    });
    if (usable)
      expect(okValue(result)).toMatchObject({
        type: 'regions_created',
        regions: [expect.anything()],
      });
    else expect(result.isError() && result.getError()).toBe(error);
    expect([...ctx.calls.calls.values()]).toMatchObject([
      { status: 'succeeded', costUsdMicros: 10 },
    ]);
  }
);
