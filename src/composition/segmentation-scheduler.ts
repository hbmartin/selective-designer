import { Result } from '@bloodyowl/boxed';
import { start } from 'workflow/api';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { AutoDetectionScheduler } from '@/modules/segmentation';
// Direct import (not via backend.ts) to avoid a cycle with the pipeline wiring.
import { autoDetectWorkflow } from '@/modules/segmentation/transport/workflows/auto-detect-workflow';

/**
 * Starts eager detection (and carry-over) for a newly stored image. Kept free
 * of the full kernel so workflow steps (render results) can use it too.
 */
export const workflowAutoDetectionScheduler: AutoDetectionScheduler = {
  async schedule(input) {
    try {
      await start(autoDetectWorkflow, [
        { imageId: input.imageId, carryFromImageId: input.carryFromImageId },
      ]);
      return Result.Ok({ type: 'auto_detection_scheduled' });
    } catch (error) {
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
