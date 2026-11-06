import { Result } from '@bloodyowl/boxed';

import { createDesignPipelineUseCases } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';
import { getAiProvidersConfig } from '@/modules/kernel/backend';
import { createItemRepository } from '@/modules/moodboard/backend';
import type { SegmentationPipelineDeps } from '@/modules/segmentation';
import {
  type ConceptSource,
  createSegmentationPipelineUseCases,
  type ImageAccess,
  type RegionRepository,
  type Segmenter,
} from '@/modules/segmentation';
import {
  createFakeSegmenter,
  createFalSam3Segmenter,
  createRegionRepository,
} from '@/modules/segmentation/backend';

import { withAccountingDelivery } from './accounting-delivery';
import { getPipelineKernel, type PipelineKernel } from './pipeline-kernel';
import { createCachedFactory } from './shared/singleton';

/** Pipeline-only wiring (workflow steps); JSX-free, no auth. */
export type SegmentationPipelineOverrides = {
  kernel?: PipelineKernel;
  regionRepository?: RegionRepository;
  imageAccess?: ImageAccess;
  conceptSource?: ConceptSource;
  segmenter?: Segmenter;
};

type ImageKernel = Pick<
  PipelineKernel,
  'db' | 'objectStorage' | 'idGenerator' | 'logger'
>;

/** Images resolved through the design module's pipeline use cases. */
export const createImageAccess = (kernel: ImageKernel): ImageAccess => ({
  async find(imageId) {
    const design = createDesignPipelineUseCases({
      designRepository: createDesignRepository({ db: kernel.db }),
      objectStorage: kernel.objectStorage,
      idGenerator: kernel.idGenerator,
      logger: kernel.logger,
    });
    const found = await design.findImage(imageId);
    if (found.isError()) return Result.Error(found.getError());
    const outcome = found.get();
    if (outcome.type === 'image_not_found')
      return Result.Ok({ type: 'image_missing' });
    return Result.Ok({
      type: 'image_found',
      image: {
        imageId: outcome.image.id,
        designId: outcome.image.designId,
        ownerId: outcome.ownerId,
        workingKey: outcome.image.workingKey,
        width: outcome.image.working.width,
        height: outcome.image.working.height,
      },
    });
  },
});

/** Mood-board categories become detection concepts. */
export const createConceptSource = (
  kernel: Pick<PipelineKernel, 'db'>
): ConceptSource => ({
  async categoriesOf(designId) {
    const items = await createItemRepository({ db: kernel.db }).listByDesign(
      designId
    );
    if (items.isError()) return Result.Error(items.getError());
    return Result.Ok(items.get().items.map((item) => item.category));
  },
});

export const createSegmenter = (): Segmenter => {
  const config = getAiProvidersConfig();
  return config.mode === 'live' && config.falKey
    ? createFalSam3Segmenter({ falKey: config.falKey })
    : createFakeSegmenter();
};

const build = (overrides?: SegmentationPipelineOverrides) => {
  const kernel = overrides?.kernel ?? getPipelineKernel();
  const deps: SegmentationPipelineDeps = {
    regionRepository:
      overrides?.regionRepository ?? createRegionRepository({ db: kernel.db }),
    imageAccess: overrides?.imageAccess ?? createImageAccess(kernel),
    conceptSource: overrides?.conceptSource ?? createConceptSource(kernel),
    segmenter: overrides?.segmenter ?? createSegmenter(),
    objectStorage: kernel.objectStorage,
    providerAccounting: kernel.providerAccounting,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
  };
  const useCases = createSegmentationPipelineUseCases(deps);
  return {
    ...useCases,
    detectConcept: (input: Parameters<typeof useCases.detectConcept>[0]) =>
      withAccountingDelivery({
        accounting: deps.providerAccounting,
        logger: kernel.logger,
        owner: 'workflow',
        operation: (providerAccounting) =>
          createSegmentationPipelineUseCases({
            ...deps,
            providerAccounting,
          }).detectConcept(input),
      }),
  };
};

const factory = createCachedFactory(build);

export const getSegmentationPipelineUseCases = (
  overrides?: SegmentationPipelineOverrides
) => factory.get(overrides);

/** Test-only. */
export const __resetSegmentationPipelineComposition = () => factory.reset();
