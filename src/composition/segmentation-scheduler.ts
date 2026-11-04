import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { createRenderRepository } from '@/modules/rendering/backend';
import {
  createDetectionScheduler,
  type RegionRepository,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';
import { claimedAutoDetectWorkflow } from '@/modules/segmentation/workflows/backend';

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
        let publicationAttempted = false;
        try {
          // The SDK can reject run creation after independently publishing the message.
          const world = await getWorld();
          const dispatchWorld = new Proxy(world, {
            get(target, property) {
              if (property === 'queue') {
                return (...args: Parameters<typeof world.queue>) => {
                  publicationAttempted = true;
                  return target.queue(...args);
                };
              }
              const value: unknown = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          await start(claimedAutoDetectWorkflow, [input], {
            world: dispatchWorld,
          });
          return Result.Ok({ type: 'detection_enqueued' });
        } catch (cause) {
          if (!publicationAttempted) {
            kernel.logger.warn({
              event: 'segmentation.detection.queue_rejected',
              details: input,
            });
            return Result.Ok({ type: 'detection_not_enqueued' });
          }
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
