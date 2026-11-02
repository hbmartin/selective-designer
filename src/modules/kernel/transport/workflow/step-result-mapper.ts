import { FatalError, RetryableError } from 'workflow';

import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { AppError } from '@/modules/kernel/domain/errors/app-error';

/** Failures worth retrying: provider/system faults, throttling and 5xx. */
export const isRetryableAppError = (error: AppError) =>
  error.category === 'system' ||
  error.category === 'rate_limit' ||
  error.status >= 500;

/**
 * Unwrap a use-case result inside a Workflow SDK step. Expected business
 * outcomes are plain `Ok` values and pass through. `Error(AppError)` becomes a
 * `RetryableError` for transient faults (the SDK retries the step) or a
 * `FatalError` otherwise (the step fails without retrying). Steps must return
 * plain serializable values, never Boxed `Result` objects.
 */
export const unwrapStepResult = <TOutcome>(
  result: ApplicationResult<TOutcome>
): TOutcome => {
  if (result.isOk()) return result.get();
  const error = result.getError();
  const message = `${error.code}: ${error.message}`;
  if (isRetryableAppError(error)) {
    throw new RetryableError(message, {
      retryAfter: error.category === 'rate_limit' ? '30s' : '5s',
    });
  }
  throw new FatalError(message);
};
