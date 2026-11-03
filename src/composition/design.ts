import { Result } from '@bloodyowl/boxed';

import {
  createDesignPipelineUseCases,
  createDesignUseCases,
  type DesignRepository,
  type ImageArrivedListener,
} from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';

import { getKernel, type Kernel } from './kernel';
import { workflowAutoDetectionScheduler } from './segmentation';
import { createCachedFactory } from './shared/singleton';

export type DesignOverrides = {
  kernel?: Kernel;
  designRepository?: DesignRepository;
  imageArrivedListener?: ImageArrivedListener;
};

/** New base images and results get eager segmentation (and carry-over). */
const segmentationOnArrival: ImageArrivedListener = {
  async imageArrived(input) {
    if (input.kind === 'source_photo') {
      return Result.Ok({ type: 'image_arrival_handled' });
    }
    const scheduled = await workflowAutoDetectionScheduler.schedule({
      imageId: input.imageId,
      carryFromImageId: input.carryFromImageId,
    });
    if (scheduled.isError()) return Result.Error(scheduled.getError());
    return Result.Ok({ type: 'image_arrival_handled' });
  },
};

const buildDesignUseCases = (overrides?: DesignOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  return createDesignUseCases({
    designRepository:
      overrides?.designRepository ?? createDesignRepository({ db: kernel.db }),
    uploadIntentStore: kernel.uploadIntentStore,
    objectStorage: kernel.objectStorage,
    permissionChecker: kernel.permissionChecker,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
    imageArrivedListener:
      overrides?.imageArrivedListener ?? segmentationOnArrival,
  });
};

const buildDesignPipelineUseCases = (overrides?: DesignOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  return createDesignPipelineUseCases({
    designRepository:
      overrides?.designRepository ?? createDesignRepository({ db: kernel.db }),
    objectStorage: kernel.objectStorage,
    idGenerator: kernel.idGenerator,
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(buildDesignUseCases);
const pipelineFactory = createCachedFactory(buildDesignPipelineUseCases);

export const getDesignUseCases = (overrides?: DesignOverrides) =>
  factory.get(overrides);

export const getDesignPipelineUseCases = (overrides?: DesignOverrides) =>
  pipelineFactory.get(overrides);

/** Test-only. */
export const __resetDesignComposition = () => {
  factory.reset();
  pipelineFactory.reset();
};
