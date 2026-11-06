import {
  createSegmentationUseCases,
  type RegionRepository,
  type Segmenter,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';

import { getKernel, type Kernel } from './kernel';
import { createImageAccess, createSegmenter } from './segmentation-pipeline';
import { createAutoDetectionScheduler } from './segmentation-scheduler';
import { createCachedFactory } from './shared/singleton';

export type SegmentationOverrides = {
  kernel?: Kernel;
  regionRepository?: RegionRepository;
  segmenter?: Segmenter;
};

const build = (overrides?: SegmentationOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  const regionRepository =
    overrides?.regionRepository ?? createRegionRepository({ db: kernel.db });
  return createSegmentationUseCases({
    regionRepository,
    detectionRetry: createAutoDetectionScheduler(kernel, regionRepository),
    imageAccess: createImageAccess(kernel),
    segmenter: overrides?.segmenter ?? createSegmenter(),
    objectStorage: kernel.objectStorage,
    providerAccounting: kernel.providerAccounting,
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
