import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { ImageId } from '@/modules/kernel/domain/ids';

import type { DetectionIdentity, DetectionRun } from './ports/ports';

export const detectionRunFor = (
  imageId: ImageId,
  { runId, workerId }: DetectionIdentity
): BoxedResult<DetectionRun | undefined, AppError> => {
  if (workerId !== undefined) {
    if (
      typeof runId !== 'string' ||
      !runId ||
      typeof workerId !== 'string' ||
      !workerId
    )
      return Result.Error(
        new AppError({
          code: 'DETECTION_IDENTITY_INVALID',
          category: 'system',
          status: 500,
          message: 'A claimed detection requires both a run ID and a worker ID',
        })
      );
    return Result.Ok({ imageId, runId, workerId });
  }
  return Result.Ok(runId === undefined ? undefined : { imageId, runId });
};
