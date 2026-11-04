import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { createRenderRepository } from '@/modules/rendering/backend';
import {
  createDetectionScheduler,
  type RegionRepository,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';
import { recoverableAutoDetectWorkflow } from '@/modules/segmentation/transport/workflows/auto-detect-workflow';

import type { PipelineKernel } from './pipeline-kernel';
import {
  createConceptSource,
  createImageAccess,
} from './segmentation-pipeline';

export const createAutoDetectionScheduler = (
  kernel: Pick<
    PipelineKernel,
    'db' | 'clock' | 'logger' | 'idGenerator' | 'objectStorage'
  >,
  regionRepository: RegionRepository = createRegionRepository({ db: kernel.db })
) =>
  createDetectionScheduler({
    regionRepository,
    clock: kernel.clock,
    logger: kernel.logger,
    idGenerator: kernel.idGenerator,
    imageAccess: createImageAccess(kernel),
    conceptSource: createConceptSource(kernel),
    findCarrySource: async (imageId) => {
      const found = await createRenderRepository({
        db: kernel.db,
      }).findRenderByOutputImage(imageId);
      if (found.isError()) return Result.Error(found.getError());
      const outcome = found.get();
      return Result.Ok(
        outcome.type === 'render_found'
          ? {
              type: 'carry_source_found',
              imageId: outcome.render.renderSourceImageId,
            }
          : { type: 'no_carry_source' }
      );
    },
    queue: {
      async enqueue(input) {
        try {
          await start(recoverableAutoDetectWorkflow, [input]);
          return Result.Ok({ type: 'detection_enqueued' });
        } catch (cause) {
          return Result.Error(
            new AppError({
              code: 'WORKFLOW_START_FAILED',
              category: 'system',
              status: 503,
              message: 'Automatic detection queue acceptance is unknown',
              cause,
            })
          );
        }
      },
    },
  });
