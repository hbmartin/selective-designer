import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';

import { AppError } from '@/modules/kernel';
import { getAiProvidersConfig } from '@/modules/kernel/backend';
import {
  createRenderingUseCases,
  type RenderInputs,
  type RenderRepository,
  type RenderScheduler,
} from '@/modules/rendering';
import {
  createPngMaskCompositor,
  createRenderRepository,
} from '@/modules/rendering/backend';
import {
  renderResultWorkflow,
  renderWorkflow,
} from '@/modules/rendering/workflows/backend';

import { getKernel, type Kernel } from './kernel';
import { createRenderInputs } from './rendering-pipeline';
import { createCachedFactory } from './shared/singleton';

export type RenderingOverrides = {
  kernel?: Kernel;
  renderRepository?: RenderRepository;
  renderInputs?: RenderInputs;
  renderScheduler?: RenderScheduler;
  enabledModelIds?: readonly string[];
};

const startFailed = (cause: unknown) =>
  new AppError({
    code: 'WORKFLOW_START_FAILED',
    category: 'system',
    status: 503,
    message: 'Could not start the render',
    cause,
  });

/** Durable Workflow SDK runs: one per render, or one per retried result. */
export const workflowRenderScheduler: RenderScheduler = {
  async scheduleRender(renderId) {
    try {
      await start(renderWorkflow, [{ renderId }]);
      return Result.Ok({ type: 'render_scheduled' });
    } catch (error) {
      return Result.Error(startFailed(error));
    }
  },
  async scheduleResult(resultId) {
    try {
      await start(renderResultWorkflow, [{ resultId }]);
      return Result.Ok({ type: 'render_scheduled' });
    } catch (error) {
      return Result.Error(startFailed(error));
    }
  },
};

const build = (overrides?: RenderingOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  const enabledModelIds =
    overrides?.enabledModelIds ?? getAiProvidersConfig().enabledModelIds;
  return createRenderingUseCases({
    renderRepository:
      overrides?.renderRepository ??
      createRenderRepository({ db: kernel.db, modelOrder: enabledModelIds }),
    renderInputs: overrides?.renderInputs ?? createRenderInputs(kernel),
    maskCompositor: createPngMaskCompositor({
      objectStorage: kernel.objectStorage,
    }),
    renderScheduler: overrides?.renderScheduler ?? workflowRenderScheduler,
    permissionChecker: kernel.permissionChecker,
    objectStorage: kernel.objectStorage,
    enabledModelIds,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(build);

export const getRenderingUseCases = (overrides?: RenderingOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetRenderingComposition = () => factory.reset();
