import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';

import { AppError } from '@/modules/kernel';
import {
  type AutoDetectionScheduler,
  createSegmentationUseCases,
  type RegionRepository,
  type Segmenter,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';
// Direct import (not via backend.ts) to avoid a cycle with the pipeline wiring.
import { autoDetectWorkflow } from '@/modules/segmentation/transport/workflows/auto-detect-workflow';

import { getKernel, type Kernel } from './kernel';
import { createImageAccess, createSegmenter } from './segmentation-pipeline';
import { createCachedFactory } from './shared/singleton';

export type SegmentationOverrides = {
  kernel?: Kernel;
  regionRepository?: RegionRepository;
  segmenter?: Segmenter;
};

/** Starts eager detection (and carry-over) for a newly stored image. */
export const workflowAutoDetectionScheduler: AutoDetectionScheduler = {
  async schedule(input) {
    try {
      await start(autoDetectWorkflow, [
        { imageId: input.imageId, carryFromImageId: input.carryFromImageId },
      ]);
      return Result.Ok({ type: 'auto_detection_scheduled' });
    } catch (error) {
      return Result.Error(
        new AppError({
          code: 'WORKFLOW_START_FAILED',
          category: 'system',
          status: 503,
          message: 'Could not start automatic detection',
          cause: error,
        })
      );
    }
  },
};

const build = (overrides?: SegmentationOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  return createSegmentationUseCases({
    regionRepository:
      overrides?.regionRepository ?? createRegionRepository({ db: kernel.db }),
    imageAccess: createImageAccess(kernel),
    segmenter: overrides?.segmenter ?? createSegmenter(),
    objectStorage: kernel.objectStorage,
    providerCallLog: kernel.providerCallLog,
    uploadIntentStore: kernel.uploadIntentStore,
    permissionChecker: kernel.permissionChecker,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(build);

export const getSegmentationUseCases = (overrides?: SegmentationOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetSegmentationComposition = () => factory.reset();
