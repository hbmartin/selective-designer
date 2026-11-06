import { Result } from '@bloodyowl/boxed';

import type { ProviderCallReceipt } from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { sourceErrorDiagnostics } from '@/modules/kernel/domain/errors/source-error-diagnostics';
import {
  type DesignId,
  type ItemVersionId,
  toObjectKey,
  toProviderCallId,
  type UserId,
} from '@/modules/kernel/domain/ids';
import { providerCallIdentity } from '@/modules/kernel/domain/provider-call-identity';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';

import type { MoodboardPipelineDeps, MoodboardResult } from './types';
import { SIGNED_ITEM_URL_SECONDS } from './types';
import type { BackgroundRemovalFailed } from '../ports/background-remover';
import type { VersionFound, VersionNotFound } from '../ports/item-repository';
import type { CutoutOutputCheckpoint } from '../../domain/cutout-output';

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

const isCompletedCutout = (
  value: VersionFound | VersionNotFound,
  attemptId: string
) =>
  value.type === 'item_version_found' &&
  value.cutoutAttemptId === attemptId &&
  value.version.cutoutStatus === 'ready';

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
  removal: BackgroundRemovalFailed,
  invocationId: string
) => {
  const callId = providerCallIdentity({
    provider: removal.provider,
    endpoint: removal.endpoint,
    providerRequestId: removal.providerRequestId,
    invocationId,
  });
  if (callId.isError()) return Result.Error(callId.getError());
  return deps.providerAccounting.capture({
    id: callId.get(),
    userId: context.userId,
    designId: context.designId,
    purpose: 'background_removal',
    provider: removal.provider,
    endpoint: removal.endpoint,
    subjectId: versionId,
    providerRequestId: removal.providerRequestId,
    status: 'failed',
    costUsdMicros: undefined,
    costSource: 'unavailable',
    details: { reason: removal.reason, attemptId },
    startedAt: context.startedAt.toISOString(),
    completedAt: deps.clock.now().toISOString(),
  });
};

const logCutoutFailure = (
  deps: MoodboardPipelineDeps,
  input: CutoutAttempt,
  phase: 'storage' | 'copy' | 'publication' | 'accounting',
  error: AppError
) =>
  deps.logger.warn({
    event: 'moodboard.cutout.output_failed',
    details: {
      ...input,
      phase,
      code: error.code,
      ...sourceErrorDiagnostics(error),
    },
  });

const publishCutout = async (
  deps: MoodboardPipelineDeps,
  input: CutoutAttempt,
  checkpoint: CutoutOutputCheckpoint,
  markFailed: (
    reason: string
  ) => Promise<MoodboardResult<RemoveBackgroundOutcome>>
): Promise<MoodboardResult<RemoveBackgroundOutcome>> => {
  const logFailure = (
    phase: 'storage' | 'copy' | 'publication',
    error: AppError
  ) => logCutoutFailure(deps, input, phase, error);
  const stored = await deps.objectStorage.getObjectMetadata(
    checkpoint.objectKey
  );
  if (stored.isError()) {
    logFailure('storage', stored.getError());
    return Result.Error(stored.getError());
  }
  if (stored.get().type === 'object_not_found') {
    if (checkpoint.source.kind !== 'url') return markFailed('output_missing');
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
    if (
      copied.get().type !== 'object_created' &&
      copied.get().type !== 'object_already_exists'
    )
      return markFailed(`copy_${copied.get().type}`);
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
};

const recordCutoutCheckpoint = async (
  deps: MoodboardPipelineDeps,
  input: CutoutAttempt,
  value: VersionFound,
  output: CutoutOutputCheckpoint
) => {
  const { versionId, attemptId } = input;
  if (output.receipt) return deps.providerAccounting.capture(output.receipt);

  let userId = output.userId ?? undefined;
  if (output.userId === undefined) {
    const owner = await deps.designAccess.ownerOf(value.designId);
    if (owner.isError()) return Result.Error(owner.getError());
    const actor = owner.get();
    userId = actor.type === 'owner' ? actor.userId : undefined;
  }
  const id = toProviderCallId(`bg-${versionId}-${attemptId}`);
  if (id.isError()) return Result.Error(id.getError());
  return deps.providerAccounting.capture({
    id: id.get(),
    userId,
    designId: value.designId,
    purpose: 'background_removal',
    provider: output.provider,
    endpoint: output.endpoint,
    subjectId: versionId,
    providerRequestId: output.providerRequestId,
    status: 'succeeded',
    costUsdMicros: output.costUsdMicros,
    costSource: output.costSource,
    details: {},
    startedAt:
      output.startedAt ??
      value.version.cutoutAttemptStartedAt?.toISOString() ??
      output.completedAt,
    completedAt: output.completedAt,
  });
};

const storeCutoutBytes = async (
  deps: MoodboardPipelineDeps,
  input: CutoutAttempt,
  output: CutoutOutputCheckpoint,
  bytes: { bytes: Uint8Array; contentType: string },
  recordPerformed: () => Promise<void>
): Promise<
  MoodboardResult<
    | { type: 'cutout_bytes_stored' }
    | { type: 'cutout_ready' }
    | { type: 'cutout_skipped' }
  >
> => {
  // URL checkpoints use their atomic save as the first post-provider fence.
  const current = await deps.itemRepository.findVersion(input.versionId);
  if (current.isError()) {
    await recordPerformed();
    return Result.Error(current.getError());
  }
  const latest = current.get();
  if (
    latest.type !== 'item_version_found' ||
    latest.cutoutAttemptId !== input.attemptId ||
    latest.version.cutoutStatus !== 'pending'
  ) {
    await recordPerformed();
    return Result.Ok({
      type: isCompletedCutout(latest, input.attemptId)
        ? 'cutout_ready'
        : 'cutout_skipped',
    });
  }
  const stored = await deps.objectStorage.createObject({
    objectKey: output.objectKey,
    body: bytes.bytes,
    contentType: bytes.contentType,
    cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
  });
  if (stored.isError()) {
    await recordPerformed();
    logCutoutFailure(deps, input, 'storage', stored.getError());
    return Result.Error(stored.getError());
  }
  return Result.Ok({ type: 'cutout_bytes_stored' });
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
  if (isCompletedCutout(value, attemptId))
    return Result.Ok({ type: 'cutout_ready' });
  if (
    value.type !== 'item_version_found' ||
    value.version.cutoutStatus !== 'pending' ||
    value.cutoutAttemptId !== attemptId
  ) {
    await cleanAbandonedCutout(deps, input);
    return Result.Ok({ type: 'cutout_skipped' });
  }
  const logFailure = (
    phase: 'storage' | 'copy' | 'publication' | 'accounting',
    error: AppError
  ) => logCutoutFailure(deps, input, phase, error);
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
  const recordCheckpoint = (output: CutoutOutputCheckpoint) =>
    recordCutoutCheckpoint(deps, input, value, output);
  let checkpoint = value.cutoutOutput;
  if (!checkpoint) {
    const owner = await deps.designAccess.ownerOf(value.designId);
    if (owner.isError()) return Result.Error(owner.getError());
    const sourceUrl = await deps.objectStorage.createSignedReadUrl({
      objectKey: value.version.photo.key,
      expiresInSeconds: SIGNED_ITEM_URL_SECONDS,
    });
    if (sourceUrl.isError()) return Result.Error(sourceUrl.getError());
    const key = cutoutObjectKey(input);
    if (key.isError()) return Result.Error(key.getError());
    const invocationId = deps.idGenerator.createId();
    if (invocationId.isError()) return Result.Error(invocationId.getError());
    const startedAt = deps.clock.now();
    const removed = await deps.backgroundRemover.removeBackground({
      sourceKey: value.version.photo.key,
      sourceUrl: sourceUrl.get().url,
    });
    if (removed.isError()) return Result.Error(removed.getError());
    const removal = removed.get();
    const actor = owner.get();
    const userId = actor.type === 'owner' ? actor.userId : undefined;
    if (removal.type === 'background_removal_failed') {
      const logged = await recordRemoval(
        deps,
        input,
        {
          designId: value.designId,
          userId,
          startedAt,
        },
        removal,
        invocationId.get()
      );
      if (logged.isError()) return Result.Error(logged.getError());
      return markFailed(removal.reason);
    }
    const callId = providerCallIdentity({
      provider: removal.provider,
      endpoint: removal.endpoint,
      providerRequestId: removal.providerRequestId,
      invocationId: invocationId.get(),
    });
    if (callId.isError()) return Result.Error(callId.getError());
    const completedAt = deps.clock.now().toISOString();
    const receipt: ProviderCallReceipt = {
      id: callId.get(),
      userId,
      designId: value.designId,
      purpose: 'background_removal',
      provider: removal.provider,
      endpoint: removal.endpoint,
      subjectId: versionId,
      providerRequestId: removal.providerRequestId,
      status: 'succeeded',
      costUsdMicros: removal.costUsdMicros,
      costSource: removal.costSource,
      details: { attemptId },
      startedAt: startedAt.toISOString(),
      completedAt,
    };
    const output: CutoutOutputCheckpoint = {
      receipt,
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
      startedAt: startedAt.toISOString(),
      userId: userId ?? null,
      completedAt,
    };
    const recordPerformed = async () => {
      const logged = await recordCheckpoint(output);
      if (logged.isError()) logFailure('accounting', logged.getError());
    };
    if (removal.result.kind === 'bytes') {
      const stored = await storeCutoutBytes(
        deps,
        input,
        output,
        removal.result,
        recordPerformed
      );
      if (stored.isError()) return Result.Error(stored.getError());
      const outcome = stored.get();
      if (outcome.type !== 'cutout_bytes_stored') return Result.Ok(outcome);
    }
    const saved = await deps.itemRepository.saveCutoutOutput({
      ...input,
      checkpoint: output,
    });
    if (saved.isError()) {
      await recordPerformed();
      logFailure('publication', saved.getError());
      return Result.Error(saved.getError());
    }
    const savedValue = saved.get();
    if (savedValue.type !== 'cutout_output_saved') {
      await recordPerformed();
      await cleanAbandonedCutout(deps, input);
      return Result.Ok({
        type:
          savedValue.type === 'cutout_already_ready'
            ? 'cutout_ready'
            : 'cutout_skipped',
      });
    }
    if (savedValue.checkpoint.receipt?.id !== output.receipt?.id)
      await recordPerformed();
    checkpoint = savedValue.checkpoint;
  }
  const logged = await recordCheckpoint(checkpoint);
  if (logged.isError()) {
    logFailure('accounting', logged.getError());
    if (!checkpoint.receipt) return Result.Error(logged.getError());
  }
  return publishCutout(deps, input, checkpoint, markFailed);
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
