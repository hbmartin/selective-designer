import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { ObjectKey, RenderResultId } from '@/modules/kernel/domain/ids';

/** The original attempt, including when a replacement requests cleanup. */
export type RenderOutputTarget = {
  resultId: RenderResultId;
  attempt: number;
  objectKey: ObjectKey;
};

export function validateRenderOutputTarget(
  target: RenderOutputTarget
): BoxedResult<{ type: 'render_output_target_valid' }, AppError> {
  const valid =
    /^[A-Za-z0-9_-]+$/u.test(target.resultId) &&
    Number.isSafeInteger(target.attempt) &&
    target.attempt > 0 &&
    ['img', 'png', 'jpg', 'webp'].some(
      (extension) =>
        target.objectKey ===
        `results/${target.resultId}/${target.attempt}/raw.${extension}`
    );
  return valid
    ? Result.Ok({ type: 'render_output_target_valid' as const })
    : Result.Error(
        new AppError({
          code: 'RENDER_OUTPUT_TARGET_INVALID',
          category: 'bad_request',
          status: 400,
          retryable: false,
        })
      );
}
