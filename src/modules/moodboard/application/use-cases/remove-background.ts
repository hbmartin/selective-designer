import { Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { ObjectCopySourceError } from '@/modules/kernel/domain/errors/object-copy-source-error';
import { safeErrorDiagnostics } from '@/modules/kernel/domain/errors/safe-error-diagnostics';
import {
  type DesignId,
  type ItemVersionId,
  toObjectKey,
  toProviderCallId,
  type UserId,
} from '@/modules/kernel/domain/ids';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';

import type { MoodboardPipelineDeps, MoodboardResult } from './types';
import { SIGNED_ITEM_URL_SECONDS } from './types';
import type {
  BackgroundRemovalFailed,
  BackgroundRemovalResult,
} from '../ports/background-remover';

type CutoutAttempt = { versionId: ItemVersionId; attemptId: string };

const cutoutObjectKey = ({ versionId, attemptId }: CutoutAttempt) =>
  toObjectKey(`item-cutouts/${versionId}/${attemptId}.png`);

type CleanupDeps = Pick<
  MoodboardPipelineDeps,
  'itemRepository' | 'objectStorage' | 'logger'
>;

const cleanAbandonedCutout = async (
  deps: CleanupDeps,
  attempt: CutoutAttempt
) => {
  const key = cutoutObjectKey(attempt);
  if (key.isError()) return;
  const cutoutKey = key.get();
  const checked = await deps.itemRepository.checkAbandonedCutout({
    ...attempt,
    cutoutKey,
  });
  const warn = (code: string) =>
    deps.logger.warn({
      event: 'moodboard.cutout.cleanup_failed',
      details: { ...attempt, code },
    });
  if (checked.isError()) {
    warn(checked.getError().code);
    return;
  }
  if (checked.get().type === 'cutout_object_in_use') return;
  // After an attempt loses its write fence it cannot publish this key again.
  const deleted = await deps.objectStorage.deleteObject(cutoutKey);
  if (deleted.isError()) warn(deleted.getError().code);
};

const CUTOUT_MAX_BYTES = 30 * 1024 * 1024;
const CUTOUT_TYPES = ['image/png', 'image/webp'] as const;

export type RemoveBackgroundOutcome =
  | { type: 'cutout_ready' }
  | { type: 'cutout_failed'; reason: string }
  /** Already processed (a retried step after success) or no longer pending. */
  | { type: 'cutout_skipped' };

const recordRemoval = async (
  deps: MoodboardPipelineDeps,
  { versionId, attemptId }: CutoutAttempt,
  context: { userId: UserId | undefined; designId: DesignId; startedAt: Date },
  removal: BackgroundRemovalResult | BackgroundRemovalFailed
) => {
  const callId = toProviderCallId(`bg-${versionId}-${attemptId}`);
  if (callId.isError()) return Result.Error(callId.getError());
  return deps.providerCallLog.record({
    id: callId.get(),
    userId: context.userId,
    designId: context.designId,
    purpose: 'background_removal',
    provider: removal.provider,
    endpoint: removal.endpoint,
    subjectId: versionId,
    providerRequestId:
      removal.type === 'background_removed'
        ? removal.providerRequestId
        : undefined,
    status: removal.type === 'background_removed' ? 'succeeded' : 'failed',
    costUsdMicros:
      removal.type === 'background_removed' ? removal.costUsdMicros : undefined,
    costSource:
      removal.type === 'background_removed'
        ? removal.costSource
        : 'unavailable',
    details:
      removal.type === 'background_removal_failed'
        ? { reason: removal.reason }
        : {},
    startedAt: context.startedAt,
    completedAt: deps.clock.now(),
  });
};

/** Recover this attempt's paid output before invoking background removal. */
export async function removeBackgroundForVersion(
  deps: MoodboardPipelineDeps,
  input: CutoutAttempt
): Promise<MoodboardResult<RemoveBackgroundOutcome>> {
  const { versionId, attemptId } = input;
  const found = await deps.itemRepository.findVersion(versionId);
  if (found.isError()) return Result.Error(found.getError());
  const value = found.get();
  if (
    value.type !== 'item_version_found' ||
    value.version.cutoutStatus !== 'pending' ||
    value.cutoutAttemptId !== attemptId
  ) {
    await cleanAbandonedCutout(deps, input);
    return Result.Ok({ type: 'cutout_skipped' });
  }
  const logFailure = (
    phase: 'copy' | 'storage' | 'publication',
    error: AppError
  ) =>
    deps.logger.warn({
      event: 'moodboard.cutout.output_failed',
      details: {
        ...input,
        phase,
        code: error.code,
        ...safeErrorDiagnostics(error),
        ...(error instanceof ObjectCopySourceError
          ? { attempts: error.attempts, sourceStatus: error.sourceStatus }
          : {}),
      },
    });
  const markFailed = async (
    reason: string
  ): Promise<MoodboardResult<RemoveBackgroundOutcome>> => {
    const saved = await deps.itemRepository.finishCutoutAttempt({
      ...input,
      cutoutStatus: 'failed',
      cutoutKey: null,
    });
    if (saved.isError()) return Result.Error(saved.getError());
    await cleanAbandonedCutout(deps, input);
    if (saved.get().type !== 'cutout_result_saved')
      return Result.Ok({ type: 'cutout_skipped' });
    deps.logger.warn({
      event: 'moodboard.cutout.failed',
      details: { ...input, reason },
    });
    return Result.Ok({ type: 'cutout_failed', reason });
  };
  let checkpoint = value.cutoutOutput;
  if (!checkpoint) {
    const owner = await deps.designAccess.ownerOf(value.designId);
    if (owner.isError()) return Result.Error(owner.getError());
    const sourceUrl = await deps.objectStorage.createSignedReadUrl({
      objectKey: value.version.photo.key,
      expiresInSeconds: SIGNED_ITEM_URL_SECONDS,
    });
    if (sourceUrl.isError()) return Result.Error(sourceUrl.getError());
    const startedAt = deps.clock.now();
    const removed = await deps.backgroundRemover.removeBackground({
      sourceKey: value.version.photo.key,
      sourceUrl: sourceUrl.get().url,
    });
    if (removed.isError()) return Result.Error(removed.getError());
    const removal = removed.get();
    const ownerValue = owner.get();
    const logged = await recordRemoval(
      deps,
      input,
      {
        designId: value.designId,
        userId: ownerValue.type === 'owner' ? ownerValue.userId : undefined,
        startedAt,
      },
      removal
    );
    if (logged.isError()) return Result.Error(logged.getError());
    if (removal.type === 'background_removal_failed')
      return markFailed(removal.reason);
    // Check the fence again after the provider performed paid work.
    const current = await deps.itemRepository.findVersion(versionId);
    if (current.isError()) {
      logFailure('publication', current.getError());
      return Result.Error(current.getError());
    }
    const latest = current.get();
    if (
      latest.type !== 'item_version_found' ||
      latest.version.cutoutStatus !== 'pending' ||
      latest.cutoutAttemptId !== attemptId
    ) {
      await cleanAbandonedCutout(deps, input);
      return Result.Ok({ type: 'cutout_skipped' });
    }
    const key = cutoutObjectKey(input);
    if (key.isError()) return Result.Error(key.getError());
    if (removal.result.kind === 'bytes') {
      const stored = await deps.objectStorage.createObject({
        objectKey: key.get(),
        body: removal.result.bytes,
        contentType: removal.result.contentType,
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      });
      if (stored.isError()) {
        logFailure('storage', stored.getError());
        return Result.Error(stored.getError());
      }
    }
    const saved = await deps.itemRepository.saveCutoutOutput({
      ...input,
      checkpoint: {
        source:
          removal.result.kind === 'url'
            ? { kind: 'url', url: removal.result.url }
            : { kind: 'object' },
        objectKey: key.get(),
        contentType:
          removal.result.kind === 'bytes' ? removal.result.contentType : null,
        provider: removal.provider,
        endpoint: removal.endpoint,
        providerRequestId: removal.providerRequestId,
        costUsdMicros: removal.costUsdMicros,
        costSource: removal.costSource,
        completedAt: deps.clock.now().toISOString(),
      },
    });
    if (saved.isError()) {
      logFailure('publication', saved.getError());
      return Result.Error(saved.getError());
    }
    const savedValue = saved.get();
    if (savedValue.type === 'cutout_attempt_skipped') {
      await cleanAbandonedCutout(deps, input);
      return Result.Ok({ type: 'cutout_skipped' });
    }
    checkpoint = savedValue.checkpoint;
  }
  const stored = await deps.objectStorage.getObjectBytes(checkpoint.objectKey);
  if (stored.isError()) {
    logFailure('storage', stored.getError());
    return Result.Error(stored.getError());
  }
  if (stored.get().type === 'object_not_found') {
    if (checkpoint.source.kind === 'object')
      return markFailed('output_missing');
    const copied = await deps.objectStorage.copyNewObjectFromUrl({
      sourceUrl: checkpoint.source.url,
      objectKey: checkpoint.objectKey,
      acceptedContentTypes: CUTOUT_TYPES,
      maxBytes: CUTOUT_MAX_BYTES,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
    if (copied.isError()) {
      logFailure('copy', copied.getError());
      return Result.Error(copied.getError());
    }
    const copy = copied.get();
    if (copy.type !== 'object_created' && copy.type !== 'object_already_exists')
      return markFailed(`copy_${copy.type}`);
  }
  const saved = await deps.itemRepository.finishCutoutAttempt({
    ...input,
    cutoutStatus: 'ready',
    cutoutKey: checkpoint.objectKey,
  });
  if (saved.isError()) {
    logFailure('publication', saved.getError());
    return Result.Error(saved.getError());
  }
  if (saved.get().type === 'cutout_attempt_skipped') {
    await cleanAbandonedCutout(deps, input);
    return Result.Ok({ type: 'cutout_skipped' });
  }
  return Result.Ok({ type: 'cutout_ready' });
}

/**
 * Pipeline fallback when the removal step failed for good: leave the version
 * `failed` (not stuck `pending`) so the user can retry.
 */
export async function markCutoutFailed(
  deps: CleanupDeps,
  { failureCode, ...attempt }: CutoutAttempt & { failureCode?: string }
): Promise<
  MoodboardResult<{ type: 'cutout_marked_failed' } | { type: 'cutout_skipped' }>
> {
  const saved = await deps.itemRepository.finishCutoutAttempt({
    ...attempt,
    cutoutStatus: 'failed',
    cutoutKey: null,
  });
  if (saved.isError()) {
    deps.logger.warn({
      event: 'moodboard.cutout.failure_state_write_failed',
      details: { ...attempt, failureCode, code: saved.getError().code },
    });
    return Result.Error(saved.getError());
  }
  await cleanAbandonedCutout(deps, attempt);
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
