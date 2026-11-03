import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';

import { AppError } from '@/modules/kernel';
import {
  type BackgroundRemovalScheduler,
  createMoodboardUseCases,
  type DesignAccess,
  type ItemRepository,
} from '@/modules/moodboard';
import { createItemRepository } from '@/modules/moodboard/backend';
// Imported directly (not via backend.ts): the workflow lazily imports the
// pipeline composition, which uses backend.ts.
import { removeBackgroundWorkflow } from '@/modules/moodboard/transport/workflows/remove-background-workflow';

import { getKernel, type Kernel } from './kernel';
import { createDesignAccess } from './moodboard-pipeline';
import { createCachedFactory } from './shared/singleton';

export type MoodboardOverrides = {
  kernel?: Kernel;
  itemRepository?: ItemRepository;
  designAccess?: DesignAccess;
  backgroundRemovalScheduler?: BackgroundRemovalScheduler;
};

/** Starts the durable Workflow SDK run for one item version. */
const workflowBackgroundRemovalScheduler: BackgroundRemovalScheduler = {
  async schedule(input) {
    try {
      await start(removeBackgroundWorkflow, [
        { itemVersionId: input.itemVersionId },
      ]);
      return Result.Ok({ type: 'background_removal_scheduled' });
    } catch (error) {
      return Result.Error(
        new AppError({
          code: 'WORKFLOW_START_FAILED',
          category: 'system',
          status: 503,
          message: 'Could not start background removal',
          cause: error,
        })
      );
    }
  },
};

const buildUseCases = (overrides?: MoodboardOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  return createMoodboardUseCases({
    itemRepository:
      overrides?.itemRepository ?? createItemRepository({ db: kernel.db }),
    designAccess: overrides?.designAccess ?? createDesignAccess(kernel),
    uploadIntentStore: kernel.uploadIntentStore,
    objectStorage: kernel.objectStorage,
    permissionChecker: kernel.permissionChecker,
    backgroundRemovalScheduler:
      overrides?.backgroundRemovalScheduler ??
      workflowBackgroundRemovalScheduler,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(buildUseCases);

export const getMoodboardUseCases = (overrides?: MoodboardOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetMoodboardComposition = () => factory.reset();
