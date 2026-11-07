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
export const validRenderResultIdentity = (resultId: string) =>
  /^[A-Za-z0-9_-]+$/u.test(resultId);
export const validRenderAttempt = (attempt: number) =>
  Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 2147483647;
export const safeRenderIdentity = (input: {
  resultId: string;
  attempt: number;
}) => ({
  resultId: validRenderResultIdentity(input.resultId)
    ? input.resultId
    : undefined,
  attempt: validRenderAttempt(input.attempt) ? input.attempt : undefined,
});
const validIdentity = (resultId: string, attempt: number) =>
  validRenderResultIdentity(resultId) && validRenderAttempt(attempt);
/** Retain exact bucket-relative locators only; never normalize unsafe evidence. */
export function safeBlockedObjectKey(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/u.test(value) ||
    !value.includes('/')
  )
    return null;
  return value
    .split('/')
    .some((segment) => !segment || segment === '.' || segment === '..')
    ? null
    : value;
}
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
  const prefix = `results/${target.resultId}/${target.attempt}/raw.`;
  const valid =
    validIdentity(target.resultId, target.attempt) &&
    target.objectKey.startsWith(prefix) &&
    Object.values(RENDER_OUTPUT_EXTENSIONS).some(
      (extension) => target.objectKey === `${prefix}${extension}`
    );
  return valid
    ? Result.Ok({ type: 'render_output_target_valid' as const })
    : Result.Error(invalidTarget());
}
