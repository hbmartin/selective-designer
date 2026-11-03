import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { AutoDetectionScheduler } from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';
// Direct import (not via backend.ts) to avoid a cycle with the pipeline wiring.
import { autoDetectWorkflow } from '@/modules/segmentation/transport/workflows/auto-detect-workflow';

import { getPipelineKernel } from './pipeline-kernel';

const DETECTION_LEASE_MS = 30 * 60 * 1000;

/**
 * Starts eager detection (and carry-over) for a newly stored image. Kept free
 * of the full kernel so workflow steps (render results) can use it too.
 */
export const workflowAutoDetectionScheduler: AutoDetectionScheduler = {
  async schedule(input) {
    const { clock, db, logger } = getPipelineKernel();
    const regions = createRegionRepository({ db });
    const expiresAt = new Date(clock.now().getTime() + DETECTION_LEASE_MS);
    const started = await regions.startDetection({
      imageId: input.imageId,
      expiresAt,
    });
    if (started.isError()) return Result.Error(started.getError());
    if (started.get().type === 'detection_already_started') {
      return Result.Ok({ type: 'auto_detection_scheduled' });
    }
    try {
      await start(autoDetectWorkflow, [
        { imageId: input.imageId, carryFromImageId: input.carryFromImageId },
      ]);
      return Result.Ok({ type: 'auto_detection_scheduled' });
    } catch (error) {
      const finished = await regions.finishDetection(input.imageId);
      if (finished.isError()) {
        logger.warn({
          event: 'segmentation.detection.cleanup_failed',
          details: { imageId: input.imageId },
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
