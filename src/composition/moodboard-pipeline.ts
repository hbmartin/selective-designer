import { Result } from '@bloodyowl/boxed';

import { createDesignPipelineUseCases } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';
import type { ProviderAccounting } from '@/modules/kernel';
import { getAiProvidersConfig } from '@/modules/kernel/backend';
import type { MoodboardPipelineDeps } from '@/modules/moodboard';
import {
  type BackgroundRemover,
  createMoodboardPipelineUseCases,
  type DesignAccess,
  type ItemRepository,
} from '@/modules/moodboard';
import {
  createFakeBackgroundRemover,
  createFalBackgroundRemover,
  createItemRepository,
} from '@/modules/moodboard/backend';

import { withAccountingDelivery } from './accounting-delivery';
import { getPipelineKernel, type PipelineKernel } from './pipeline-kernel';
import { createCachedFactory } from './shared/singleton';

/**
 * Pipeline-only wiring, imported lazily by workflow steps. It must not import
 * the workflows themselves (that would form an import cycle).
 */
export type MoodboardPipelineOverrides = {
  kernel?: PipelineKernel;
  itemRepository?: ItemRepository;
  designAccess?: DesignAccess;
  backgroundRemover?: BackgroundRemover;
  providerAccounting?: ProviderAccounting;
};

const designPipeline = (
  kernel: Pick<
    PipelineKernel,
    'db' | 'objectStorage' | 'idGenerator' | 'logger'
  >
) =>
  createDesignPipelineUseCases({
    designRepository: createDesignRepository({ db: kernel.db }),
    objectStorage: kernel.objectStorage,
    idGenerator: kernel.idGenerator,
    logger: kernel.logger,
  });

/** Ownership checks delegated to the design module's pipeline use cases. */
export const createDesignAccess = (
  kernel: Pick<
    PipelineKernel,
    'db' | 'objectStorage' | 'idGenerator' | 'logger'
  >
): DesignAccess => ({
  async isOwnedBy(input) {
    const owner = await designPipeline(kernel).findOwner(input.designId);
    if (owner.isError()) return Result.Error(owner.getError());
    const outcome = owner.get();
    return Result.Ok(
      outcome.type === 'design_owner' && outcome.ownerId === input.userId
        ? { type: 'owned' }
        : { type: 'not_owned' }
    );
  },
  async ownerOf(designId) {
    const owner = await designPipeline(kernel).findOwner(designId);
    if (owner.isError()) return Result.Error(owner.getError());
    const outcome = owner.get();
    return Result.Ok(
      outcome.type === 'design_owner'
        ? { type: 'owner', userId: outcome.ownerId }
        : { type: 'missing' }
    );
  },
});

const createBackgroundRemover = (kernel: PipelineKernel): BackgroundRemover => {
  const config = getAiProvidersConfig();
  return config.mode === 'live' && config.falKey
    ? createFalBackgroundRemover({ falKey: config.falKey })
    : createFakeBackgroundRemover({ objectStorage: kernel.objectStorage });
};

const buildPipelineUseCases = (overrides?: MoodboardPipelineOverrides) => {
  const kernel = overrides?.kernel ?? getPipelineKernel();
  const deps: MoodboardPipelineDeps = {
    itemRepository:
      overrides?.itemRepository ?? createItemRepository({ db: kernel.db }),
    designAccess: overrides?.designAccess ?? createDesignAccess(kernel),
    objectStorage: kernel.objectStorage,
    backgroundRemover:
      overrides?.backgroundRemover ?? createBackgroundRemover(kernel),
    providerAccounting:
      overrides?.providerAccounting ?? kernel.providerAccounting,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
  };
  const useCases = createMoodboardPipelineUseCases(deps);
  return {
    ...useCases,
    removeBackground: (
      input: Parameters<typeof useCases.removeBackground>[0]
    ) =>
      withAccountingDelivery({
        accounting: deps.providerAccounting,
        logger: kernel.logger,
        owner: 'workflow',
        operation: (providerAccounting) =>
          createMoodboardPipelineUseCases({
            ...deps,
            providerAccounting,
          }).removeBackground(input),
      }),
  };
};

const pipelineFactory = createCachedFactory(buildPipelineUseCases);

export const getMoodboardPipelineUseCases = (
  overrides?: MoodboardPipelineOverrides
) => pipelineFactory.get(overrides);

/** Test-only. */
export const __resetMoodboardPipelineComposition = () =>
  pipelineFactory.reset();
