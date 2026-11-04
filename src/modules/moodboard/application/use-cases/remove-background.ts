import { Result } from '@bloodyowl/boxed';

import {
  type ItemVersionId,
  toObjectKey,
  toProviderCallId,
} from '@/modules/kernel/domain/ids';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';

import type { MoodboardPipelineDeps, MoodboardResult } from './types';
import { SIGNED_ITEM_URL_SECONDS } from './types';

type CutoutAttempt = { versionId: ItemVersionId; attemptId: string | null };

const CUTOUT_MAX_BYTES = 30 * 1024 * 1024;
const CUTOUT_TYPES = ['image/png', 'image/webp'] as const;

export type RemoveBackgroundOutcome =
  | { type: 'cutout_ready' }
  | { type: 'cutout_failed'; reason: string }
  /** Already processed (a retried step after success) or no longer pending. */
  | { type: 'cutout_skipped' };

/**
 * Pipeline step: remove the background of an item version's photo, copy the
 * result into owned storage at a deterministic key (safe to retry), record
 * the provider call, and mark the version ready or failed.
 */
export async function removeBackgroundForVersion(
  deps: MoodboardPipelineDeps,
  input: CutoutAttempt
): Promise<MoodboardResult<RemoveBackgroundOutcome>> {
  const { versionId, attemptId } = input;
  const found = await deps.itemRepository.findVersion(versionId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'item_version_not_found') {
    return Result.Ok({ type: 'cutout_skipped' });
  }
  const { version, designId } = outcome;
  if (
    version.cutoutStatus !== 'pending' ||
    outcome.cutoutAttemptId !== attemptId
  ) {
    return Result.Ok({ type: 'cutout_skipped' });
  }

  const owner = await deps.designAccess.ownerOf(designId);
  if (owner.isError()) return Result.Error(owner.getError());
  const ownerOutcome = owner.get();

  const sourceUrl = await deps.objectStorage.createSignedReadUrl({
    objectKey: version.photo.key,
    expiresInSeconds: SIGNED_ITEM_URL_SECONDS,
  });
  if (sourceUrl.isError()) return Result.Error(sourceUrl.getError());

  const startedAt = deps.clock.now();
  const removed = await deps.backgroundRemover.removeBackground({
    sourceKey: version.photo.key,
    sourceUrl: sourceUrl.get().url,
  });
  if (removed.isError()) return Result.Error(removed.getError());
  const removal = removed.get();

  const callId = toProviderCallId(
    attemptId === null ? `bg-${versionId}` : `bg-${versionId}-${attemptId}`
  );
  if (callId.isError()) return Result.Error(callId.getError());
  const logCall = (input: {
    status: 'succeeded' | 'failed';
    providerRequestId?: string;
    costUsdMicros?: number;
    costSource: 'reported' | 'price_table' | 'unavailable';
    details: Record<string, unknown>;
  }) =>
    deps.providerCallLog.record({
      id: callId.get(),
      userId: ownerOutcome.type === 'owner' ? ownerOutcome.userId : undefined,
      designId,
      purpose: 'background_removal',
      provider: removal.provider,
      endpoint: removal.endpoint,
      subjectId: versionId,
      providerRequestId: input.providerRequestId,
      status: input.status,
      costUsdMicros: input.costUsdMicros,
      costSource: input.costSource,
      details: input.details,
      startedAt,
      completedAt: deps.clock.now(),
    });

  const markFailed = async (reason: string) => {
    const saved = await deps.itemRepository.finishCutoutAttempt({
      ...input,
      cutoutStatus: 'failed',
      cutoutKey: null,
    });
    if (saved.isError()) return Result.Error(saved.getError());
    if (saved.get().type !== 'cutout_result_saved') {
      return Result.Ok({ type: 'cutout_skipped' as const });
    }
    deps.logger.warn({
      event: 'moodboard.cutout.failed',
      details: { ...input, reason },
    });
    return Result.Ok({ type: 'cutout_failed' as const, reason });
  };

  if (removal.type === 'background_removal_failed') {
    await logCall({
      status: 'failed',
      costSource: 'unavailable',
      details: { reason: removal.reason },
    });
    return markFailed(removal.reason);
  }

  const cutoutKey = toObjectKey(
    attemptId === null
      ? `item-cutouts/${versionId}.png`
      : `item-cutouts/${versionId}/${attemptId}.png`
  );
  if (cutoutKey.isError()) return Result.Error(cutoutKey.getError());

  if (removal.result.kind === 'url') {
    const copied = await deps.objectStorage.copyFromUrl({
      sourceUrl: removal.result.url,
      objectKey: cutoutKey.get(),
      acceptedContentTypes: CUTOUT_TYPES,
      maxBytes: CUTOUT_MAX_BYTES,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
    if (copied.isError()) return Result.Error(copied.getError());
    if (copied.get().type !== 'object_copied') {
      await logCall({
        status: 'failed',
        costSource: removal.costSource,
        ...(removal.costUsdMicros !== undefined
          ? { costUsdMicros: removal.costUsdMicros }
          : {}),
        details: { copy: copied.get().type },
      });
      return markFailed(`copy_${copied.get().type}`);
    }
  } else {
    const stored = await deps.objectStorage.putObject({
      objectKey: cutoutKey.get(),
      body: removal.result.bytes,
      contentType: removal.result.contentType,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
    if (stored.isError()) return Result.Error(stored.getError());
  }

  const logged = await logCall({
    status: 'succeeded',
    ...(removal.providerRequestId
      ? { providerRequestId: removal.providerRequestId }
      : {}),
    ...(removal.costUsdMicros !== undefined
      ? { costUsdMicros: removal.costUsdMicros }
      : {}),
    costSource: removal.costSource,
    details: {},
  });
  if (logged.isError()) return Result.Error(logged.getError());

  const saved = await deps.itemRepository.finishCutoutAttempt({
    ...input,
    cutoutStatus: 'ready',
    cutoutKey: cutoutKey.get(),
  });
  if (saved.isError()) return Result.Error(saved.getError());
  return Result.Ok({
    type:
      saved.get().type === 'cutout_result_saved'
        ? 'cutout_ready'
        : 'cutout_skipped',
  });
}

/**
 * Pipeline fallback when the removal step failed for good: leave the version
 * `failed` (not stuck `pending`) so the user can retry.
 */
export async function markCutoutFailed(
  deps: Pick<MoodboardPipelineDeps, 'itemRepository' | 'logger'>,
  { failureCode, ...attempt }: CutoutAttempt & { failureCode?: string }
): Promise<
  MoodboardResult<{ type: 'cutout_marked_failed' } | { type: 'cutout_skipped' }>
> {
  const saved = await deps.itemRepository.finishCutoutAttempt({
    ...attempt,
    cutoutStatus: 'failed',
    cutoutKey: null,
  });
  if (saved.isError()) return Result.Error(saved.getError());
  deps.logger.warn({
    event: 'moodboard.cutout.workflow_failed',
    details: { ...attempt, failureCode, outcome: saved.get().type },
  });
  return Result.Ok({
    type:
      saved.get().type === 'cutout_result_saved'
        ? 'cutout_marked_failed'
        : 'cutout_skipped',
  });
}
