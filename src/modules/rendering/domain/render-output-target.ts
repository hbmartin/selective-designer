import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  type ObjectKey,
  type RenderResultId,
  toObjectKey,
} from '@/modules/kernel/domain/ids';

export const RENDER_OUTPUT_EXTENSIONS = {
  url: 'img',
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
} as const;
const validIdentity = (resultId: string, attempt: number) =>
  /^[A-Za-z0-9_-]+$/u.test(resultId) &&
  Number.isSafeInteger(attempt) &&
  attempt > 0;
const invalidTarget = () =>
  new AppError({
    code: 'RENDER_OUTPUT_TARGET_INVALID',
    category: 'bad_request',
    status: 400,
    retryable: false,
  });
export function renderOutputKey(
  resultId: RenderResultId,
  attempt: number,
  format: keyof typeof RENDER_OUTPUT_EXTENSIONS
) {
  if (!validIdentity(resultId, attempt) || !RENDER_OUTPUT_EXTENSIONS[format])
    return Result.Error(invalidTarget());
  return toObjectKey(
    `results/${resultId}/${attempt}/raw.${RENDER_OUTPUT_EXTENSIONS[format]}`
  );
}

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
    validIdentity(target.resultId, target.attempt) &&
    (
      Object.keys(
        RENDER_OUTPUT_EXTENSIONS
      ) as (keyof typeof RENDER_OUTPUT_EXTENSIONS)[]
    ).some((format) => {
      const key = renderOutputKey(target.resultId, target.attempt, format);
      return key.isOk() && key.get() === target.objectKey;
    });
  return valid
    ? Result.Ok({ type: 'render_output_target_valid' as const })
    : Result.Error(invalidTarget());
}
