import { Result } from '@bloodyowl/boxed';

import type { ItemVersionId } from '@/modules/kernel/domain/ids';

import type { MoodboardResult, MoodboardUseCaseDeps } from './types';

/** A reported start failure must leave the persisted version retryable. */
export async function scheduleCutoutAttempt(
  deps: Pick<
    MoodboardUseCaseDeps,
    'backgroundRemovalScheduler' | 'itemRepository' | 'logger'
  >,
  input: { itemVersionId: ItemVersionId; attemptId: string },
  onStartFailure: 'report_error' | 'keep_copy'
): Promise<MoodboardResult<{ type: 'cutout_start_handled' }>> {
  const scheduled = await deps.backgroundRemovalScheduler.schedule(input);
  if (scheduled.isOk()) return Result.Ok({ type: 'cutout_start_handled' });

  const error = scheduled.getError();
  const failed = await deps.itemRepository.finishCutoutAttempt({
    versionId: input.itemVersionId,
    attemptId: input.attemptId,
    cutoutStatus: 'failed',
    cutoutKey: null,
  });
  deps.logger.warn({
    event: 'moodboard.cutout.start_failed',
    details: {
      ...input,
      code: error.code,
      ...(failed.isError() ? { recoveryCode: failed.getError().code } : {}),
    },
  });

  if (failed.isError()) return Result.Error(failed.getError());
  if (onStartFailure === 'report_error') return Result.Error(error);
  return Result.Ok({ type: 'cutout_start_handled' });
}
