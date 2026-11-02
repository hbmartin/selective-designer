import {
  createDesignPipelineUseCases,
  createDesignUseCases,
  type DesignRepository,
} from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';

import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

export type DesignOverrides = {
  kernel?: Kernel;
  designRepository?: DesignRepository;
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
