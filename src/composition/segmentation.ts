import type { SegmentationUseCaseDeps } from '@/modules/segmentation';
import {
  createSegmentationUseCases,
  type RegionRepository,
  type Segmenter,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';

import { withAccountingDelivery } from './accounting-delivery';
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
  const deps: SegmentationUseCaseDeps = {
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
  };
  const useCases = createSegmentationUseCases(deps);
  return {
    ...useCases,
    segment: (input: Parameters<typeof useCases.segment>[0]) =>
      withAccountingDelivery({
        accounting: deps.providerAccounting,
        logger: kernel.logger,
        owner: 'http',
        operation: (providerAccounting) =>
          createSegmentationUseCases({ ...deps, providerAccounting }).segment(
            input
          ),
      }),
  };
};

const factory = createCachedFactory(build);

export const getSegmentationUseCases = (overrides?: SegmentationOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetSegmentationComposition = () => factory.reset();
