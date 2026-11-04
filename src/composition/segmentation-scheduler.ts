import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  type AutoDetectionScheduler,
  DETECTION_LEASE_MS,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';
// Direct import (not via backend.ts) to avoid a cycle with the pipeline wiring.
import { autoDetectWorkflow } from '@/modules/segmentation/transport/workflows/auto-detect-workflow';

import type { PipelineKernel } from './pipeline-kernel';

export const createAutoDetectionScheduler = ({
  db,
  clock,
  logger,
  idGenerator,
}: Pick<
  PipelineKernel,
  'db' | 'clock' | 'logger' | 'idGenerator'
>): AutoDetectionScheduler => {
  const regions = createRegionRepository({ db });
  return {
    async schedule(input) {
      const id = idGenerator.createId();
      if (id.isError()) return Result.Error(id.getError());
      const run = { imageId: input.imageId, runId: id.get() };
      const now = clock.now();
      const started = await regions.startDetection({
        ...run,
        now,
        expiresAt: new Date(now.getTime() + DETECTION_LEASE_MS),
      });
      if (started.isError()) return Result.Error(started.getError());
      if (started.get().type === 'detection_already_started') {
        return Result.Ok({ type: 'auto_detection_scheduled' });
      }
      try {
        await start(autoDetectWorkflow, [{ ...input, runId: run.runId }]);
        return Result.Ok({ type: 'auto_detection_scheduled' });
      } catch (error) {
        const finished = await regions.finishDetection(run);
        if (finished.isError()) {
          logger.warn({
            event: 'segmentation.detection.cleanup_failed',
            details: run,
            exception: finished.getError(),
          });
        }
        return Result.Error(
          new AppError({
            code: 'WORKFLOW_START_FAILED',
            category: 'system',
            status: 503,
            message: 'Could not start automatic detection',
            cause: error,
          })
        );
      }
    },
  };
};
