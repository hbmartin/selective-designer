import { Result } from '@bloodyowl/boxed';
import {
  createFakeObjectStorage,
  createFakeProviderCallLog,
  createFakeUploadIntentStore,
} from '@tests/support/fake-kernel-ports';
import { okValue } from '@tests/support/result';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';
import {
  type DesignId,
  type ImageId,
  toDesignId,
  toGeneratedId,
  toImageId,
  toObjectKey,
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
        detectionExpiresAt: null,
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
  return { useCases, pipeline, regions, storage, calls, intents };
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
});

describe('segmentation pipeline', () => {
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
      expect(ctx.storage.objects.size).toBe(0);
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
