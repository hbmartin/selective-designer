import { Result } from '@bloodyowl/boxed';

import {
  createDesignPipelineUseCases,
  createDesignUseCases,
  type DesignCopiedListener,
  type DesignRepository,
  type ImageArrivedListener,
} from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';

import { getKernel, type Kernel } from './kernel';
import { getMoodboardPipelineUseCases } from './moodboard-pipeline';
import { getRenderingPipelineUseCases } from './rendering-pipeline';
import { workflowAutoDetectionScheduler } from './segmentation-scheduler';
import { createCachedFactory } from './shared/singleton';

export type DesignOverrides = {
  kernel?: Kernel;
  designRepository?: DesignRepository;
  imageArrivedListener?: ImageArrivedListener;
  designCopiedListener?: DesignCopiedListener;
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

/**
 * A revised architect image: copy the earlier design's mood board, then its
 * base-image placements (remapped to the copied items).
 */
const copyIntoRevisedDesign = (kernel: Kernel): DesignCopiedListener => ({
  async designCopied(input) {
    const design = createDesignPipelineUseCases({
      designRepository: createDesignRepository({ db: kernel.db }),
      objectStorage: kernel.objectStorage,
      idGenerator: kernel.idGenerator,
      logger: kernel.logger,
    });
    const items = await getMoodboardPipelineUseCases().copyItems({
      fromDesignId: input.fromDesignId,
      toDesignId: input.toDesignId,
    });
    if (items.isError()) return Result.Error(items.getError());
    const base = await design.baseImageOf(input.fromDesignId);
    if (base.isError()) return Result.Error(base.getError());
    const baseOutcome = base.get();
    if (baseOutcome.type === 'base_image') {
      const draft = await getRenderingPipelineUseCases().copyDraftPlacements({
        fromImageId: baseOutcome.imageId,
        toImageId: input.toBaseImageId,
        toDesignId: input.toDesignId,
        itemIds: items.get().itemIds,
      });
      if (draft.isError()) return Result.Error(draft.getError());
      kernel.logger.info({
        event: 'design.copy.completed',
        details: { designId: input.toDesignId, ...draft.get() },
      });
    }
    return Result.Ok({ type: 'design_copy_handled' });
  },
});

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
    designCopiedListener:
      overrides?.designCopiedListener ?? copyIntoRevisedDesign(kernel),
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
