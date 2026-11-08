import { Result } from '@bloodyowl/boxed';

import type { ProviderCallReceipt } from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { safeErrorDiagnostics } from '@/modules/kernel/domain/errors/safe-error-diagnostics';
import { sourceErrorDiagnostics } from '@/modules/kernel/domain/errors/source-error-diagnostics';
import {
  type DesignId,
  type ImageId,
  type ObjectKey,
  type ProviderCallId,
  type RenderResultId,
  toObjectKey,
} from '@/modules/kernel/domain/ids';
import { providerCallIdentity } from '@/modules/kernel/domain/provider-call-identity';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';

import {
  PROVIDER_INPUT_URL_SECONDS,
  type RenderingPipelineDeps,
  type RenderingResult,
} from './types';
import type {
  AcceptedRenderSubmission,
  ModelRequest,
  RenderExecution,
  RenderPublicationContext,
} from '../ports/ports';
import {
  SubmissionPersistenceError,
  SubmissionWriteError,
} from '../ports/submission-persistence-error';
import type { Edit } from '../../domain/edit-set';
import { MODEL_CATALOG } from '../../domain/model-catalog';
import { buildPrompt } from '../../domain/prompt-builder';
import { recipeReferences, targetBoxes } from '../../domain/recipe';
import type { Render, RenderResult } from '../../domain/render';
import type { RenderOutputCheckpoint } from '../../domain/render-output';
import {
  RENDER_OUTPUT_EXTENSIONS,
  renderOutputKey,
  safeRenderIdentity,
  validateRenderOutputTarget,
} from '../../domain/render-output-target';
import { RENDER_RETRY_AFTER_MS } from '../../domain/render-retry-policy';

const OUTPUT_MAX_BYTES = 40 * 1024 * 1024;
const OUTPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const loadResult = (deps: RenderingPipelineDeps, resultId: RenderResultId) =>
  deps.renderRepository.findResult(resultId);

/** Polling locators may contain credentials and never belong in diagnostics. */
const renderLogContext = ({
  resultId,
  attempt,
  workflowRunId,
}: RenderExecution) => ({ resultId, attempt, workflowRunId });

const buildRequest = async (
  deps: RenderingPipelineDeps,
  render: Render,
  result: RenderResult
): Promise<RenderingResult<ModelRequest>> => {
  const spec = MODEL_CATALOG[result.modelId];
  const { recipe } = render;
  const sign = (objectKey: string) =>
    deps.objectStorage.createSignedReadUrl({
      objectKey,
      expiresInSeconds: PROVIDER_INPUT_URL_SECONDS,
    });

  const source = await sign(recipe.source.workingKey);
  if (source.isError()) return Result.Error(source.getError());
  const referenceUrls: string[] = [];
  for (const item of recipeReferences(recipe)) {
    // oxlint-disable-next-line no-await-in-loop -- signing is local HMAC.
    const signed = await sign(item.referenceKey);
    if (signed.isError()) return Result.Error(signed.getError());
    referenceUrls.push(signed.get().url);
  }

  let maskUrl: string | null = null;
  if (spec.targeting === 'mask' && spec.maskPolarity && recipe.editMaskKey) {
    const editMaskKey = toObjectKey(recipe.editMaskKey);
    const variantKey = toObjectKey(
      recipe.editMaskKey.replace(/\.png$/u, `-${spec.maskPolarity}.png`)
    );
    if (editMaskKey.isError()) return Result.Error(editMaskKey.getError());
    if (variantKey.isError()) return Result.Error(variantKey.getError());
    const variant = await deps.maskCompositor.maskForModel({
      editMaskKey: editMaskKey.get(),
      polarity: spec.maskPolarity,
      objectKey: variantKey.get(),
    });
    if (variant.isError()) return Result.Error(variant.getError());
    const signedMask = await sign(variant.get().objectKey);
    if (signedMask.isError()) return Result.Error(signedMask.getError());
    maskUrl = signedMask.get().url;
  }

  return Result.Ok({
    sourceImageUrl: source.get().url,
    sourceSize: { width: recipe.source.width, height: recipe.source.height },
    referenceUrls,
    boxes: targetBoxes(recipe),
    maskUrl,
    prompt: buildPrompt(recipe, result.modelId),
  });
};

export type SubmitResultOutcome =
  | { type: 'result_accepted'; submission: AcceptedRenderSubmission }
  | {
      type: 'result_already_submitted';
      providerRequestId: string;
      receiptId?: ProviderCallId;
    }
  | { type: 'result_failed'; reason: string }
  | { type: 'result_not_runnable' }
  | { type: 'result_attempt_superseded' };

/** Claim one workflow execution before submitting a paid request. */
export async function submitResult(
  deps: RenderingPipelineDeps,
  input: RenderExecution
): Promise<RenderingResult<SubmitResultOutcome>> {
  const claimed = await deps.renderRepository.claimExecution(input);
  if (claimed.isError()) return Result.Error(claimed.getError());
  if (claimed.get().type === 'result_attempt_superseded')
    return Result.Ok({ type: 'result_attempt_superseded' });
  const loaded = await loadResult(deps, input.resultId);
  if (loaded.isError()) return Result.Error(loaded.getError());
  const outcome = loaded.get();
  if (outcome.type === 'result_not_found')
    return Result.Ok({ type: 'result_not_runnable' });
  const { result, render } = outcome;
  if (result.attempt !== input.attempt)
    return Result.Ok({ type: 'result_attempt_superseded' });
  if (
    (result.status === 'submitted' || result.status === 'succeeded') &&
    result.providerRequestId
  ) {
    const context = await deps.renderRepository.publicationContext(
      input.resultId
    );
    if (context.isError()) return Result.Error(context.getError());
    const current = context.get();
    return Result.Ok({
      type: 'result_already_submitted',
      providerRequestId: result.providerRequestId,
      receiptId:
        current.type === 'publication_context'
          ? current.context.accountingIdentity?.receipt?.id
          : undefined,
    });
  }
  if (result.status !== 'pending')
    return Result.Ok({ type: 'result_not_runnable' });
  const deadlineMs = result.attemptStartedAt.getTime() + RENDER_RETRY_AFTER_MS;
  if (!Number.isFinite(deadlineMs))
    return Result.Error(
      new AppError({
        code: 'RENDER_SUBMISSION_DEADLINE_INVALID',
        category: 'system',
        status: 500,
        retryable: false,
      })
    );
  const attemptDeadlineAt = new Date(deadlineMs).toISOString();
  const request = await buildRequest(deps, render, result);
  if (request.isError()) return Result.Error(request.getError());
  const invocationId = deps.idGenerator.createId();
  if (invocationId.isError()) return Result.Error(invocationId.getError());
  const startedAt = deps.clock.now().toISOString();
  const submitted = await deps.imageModels
    .adapterFor(result.modelId)
    .submit(request.get());
  if (submitted.isError()) return Result.Error(submitted.getError());
  const submission = submitted.get();
  if (submission.type === 'model_rejected')
    return failPoll(deps, input, submission.reason);
  const spec = MODEL_CATALOG[result.modelId];
  const callId = providerCallIdentity({
    provider: spec.provider,
    endpoint: spec.endpoint,
    providerRequestId: submission.accountingRequestId,
    invocationId: invocationId.get(),
  });
  if (callId.isError()) return Result.Error(callId.getError());
  return Result.Ok({
    type: 'result_accepted',
    submission: {
      ...input,
      attemptDeadlineAt,
      providerRequestId: submission.providerRequestId,
      settings: submission.settings,
      prompt: request.get().prompt,
      submittedAt: deps.clock.now().toISOString(),
      accountingIdentity: {
        invocationId: invocationId.get(),
        providerRequestId: submission.accountingRequestId,
        receipt: {
          id: callId.get(),
          provider: spec.provider,
          endpoint: spec.endpoint,
          providerRequestId: submission.accountingRequestId,
          userId: undefined,
          designId: render.designId,
          subjectId: input.resultId,
          purpose: 'render',
          status: 'submitted',
          costUsdMicros: undefined,
          costSource: 'unavailable',
          details: { modelId: result.modelId, attempt: input.attempt },
          startedAt,
          completedAt: undefined,
        },
      },
    },
  });
}

export type SubmissionPersistenceOutcome =
  | {
      type: 'result_submitted';
      providerRequestId: string;
      receiptCaptured: true;
    }
  | { type: 'result_attempt_superseded'; receiptCaptured: true };

export type SubmissionReconciliationOutcome =
  | {
      type: 'result_submitted';
      providerRequestId: string;
      receiptCaptured: true;
    }
  | { type: 'submission_recovery_window'; attemptDeadlineAt: string }
  | { type: 'result_attempt_superseded' };

/** Retried separately from the paid provider step, including after a lost write reply. */
export async function persistSubmission(
  deps: RenderingPipelineDeps,
  input: AcceptedRenderSubmission
): Promise<RenderingResult<SubmissionPersistenceOutcome>> {
  const captured = await deps.providerAccounting.capture(
    input.accountingIdentity.receipt
  );
  if (captured.isError()) {
    deps.logger.warn({
      event: 'rendering.result.submission_persistence_failed',
      details: {
        ...renderLogContext(input),
        phase: 'receipt',
        code: captured.getError().code,
        ...safeErrorDiagnostics(captured.getError()),
      },
    });
    return Result.Error(
      new SubmissionPersistenceError(captured.getError(), false)
    );
  }
  const saved = await deps.renderRepository.saveSubmission(input);
  if (saved.isError()) {
    deps.logger.warn({
      event: 'rendering.result.submission_persistence_failed',
      details: {
        ...renderLogContext(input),
        phase: 'submission',
        code: saved.getError().code,
        ...safeErrorDiagnostics(saved.getError()),
      },
    });
    const error = saved.getError();
    return Result.Error(
      new SubmissionPersistenceError(
        error,
        true,
        error instanceof SubmissionWriteError ? error.certainty : 'unknown'
      )
    );
  }
  if (saved.get().type === 'result_attempt_superseded')
    return Result.Ok({
      type: 'result_attempt_superseded',
      receiptCaptured: true,
    });
  return Result.Ok({
    type: 'result_submitted',
    providerRequestId: input.providerRequestId,
    receiptCaptured: true,
  });
}

/** A matching saved submission proves the production capture-before-save invariant. */
export async function reconcileSubmission(
  deps: RenderingPipelineDeps,
  input: AcceptedRenderSubmission
): Promise<RenderingResult<SubmissionReconciliationOutcome>> {
  const result = await deps.renderRepository.reconcileSubmission(input);
  if (result.isError()) {
    deps.logger.warn({
      event: 'rendering.result.submission_reconciliation_failed',
      details: {
        ...renderLogContext(input),
        code: result.getError().code,
        ...safeErrorDiagnostics(result.getError()),
      },
    });
    return Result.Error(result.getError());
  }
  const outcome = result.get();
  return Result.Ok(
    outcome.type === 'result_submitted'
      ? { ...outcome, receiptCaptured: true as const }
      : outcome
  );
}

export type PollResultOutcome =
  | { type: 'result_pending' }
  | { type: 'result_succeeded' }
  | { type: 'result_failed'; reason: string }
  | { type: 'result_not_runnable' }
  | { type: 'result_attempt_superseded' };

type PollExecution = RenderExecution & { providerRequestId: string };

const failPoll = async (
  deps: RenderingPipelineDeps,
  input: RenderExecution & { providerRequestId?: string },
  reason: string
): Promise<
  RenderingResult<
    | { type: 'result_failed'; reason: string }
    | { type: 'result_attempt_superseded' }
  >
> => {
  const saved = await markResultFailed(deps, { ...input, reason });
  if (saved.isError()) return Result.Error(saved.getError());
  return Result.Ok(
    saved.get().type === 'result_marked_failed'
      ? { type: 'result_failed', reason }
      : { type: 'result_attempt_superseded' }
  );
};

export const discardLostOutput = async (
  deps: Pick<
    RenderingPipelineDeps,
    'logger' | 'resultOutputReferences' | 'objectStorage'
  >,
  input: RenderExecution,
  objectKey: ObjectKey
): Promise<
  RenderingResult<{ type: 'output_deleted' } | { type: 'output_retained' }>
> => {
  const target = validateRenderOutputTarget({ ...input, objectKey });
  if (target.isError()) {
    deps.logger.warn({
      event: 'rendering.result.cleanup_failed',
      details: {
        ...safeRenderIdentity(input),
        code: target.getError().code,
      },
    });
    return Result.Error(target.getError());
  }
  const referenced = await deps.resultOutputReferences.check(objectKey);
  if (referenced.isError()) {
    deps.logger.warn({
      event: 'rendering.result.cleanup_failed',
      details: { ...renderLogContext(input), code: referenced.getError().code },
    });
    return Result.Error(referenced.getError());
  }
  if (referenced.get().type === 'output_referenced')
    return Result.Ok({ type: 'output_retained' as const });
  const deleted = await deps.objectStorage.deleteObject(objectKey);
  if (deleted.isError()) {
    deps.logger.warn({
      event: 'rendering.result.cleanup_failed',
      details: { ...renderLogContext(input), code: deleted.getError().code },
    });
    return Result.Error(deleted.getError());
  }
  return Result.Ok({ type: 'output_deleted' as const });
};

const outputReceipt = (
  original: ProviderCallReceipt,
  checkpoint: Omit<RenderOutputCheckpoint, 'receipt'>
): ProviderCallReceipt => ({
  ...original,
  status: 'succeeded',
  costUsdMicros: checkpoint.costUsdMicros ?? undefined,
  costSource: checkpoint.costSource,
  completedAt: checkpoint.completedAt,
});
const recordOutput = (
  deps: RenderingPipelineDeps,
  checkpoint: RenderOutputCheckpoint
) => deps.providerAccounting.capture(checkpoint.receipt);
const warnCostRecord = (
  deps: RenderingPipelineDeps,
  input: PollExecution,
  code: string
) =>
  deps.logger.warn({
    event: 'rendering.result.cost_record_failed',
    details: { ...renderLogContext(input), code },
  });

const recoverCompletedResult = async (
  deps: RenderingPipelineDeps,
  input: PollExecution
): Promise<
  RenderingResult<
    { type: 'result_succeeded' } | { type: 'result_attempt_superseded' }
  >
> => {
  const recovered = await deps.resultImages.findRegistered(input);
  if (recovered.isError()) return Result.Error(recovered.getError());
  return Result.Ok({
    type:
      recovered.get().type === 'result_image_registered'
        ? 'result_succeeded'
        : 'result_attempt_superseded',
  });
};

const outputKeyFor = (
  keys: { url: ObjectKey; png: ObjectKey; jpeg: ObjectKey; webp: ObjectKey },
  contentType: string | undefined
): ObjectKey => {
  if (contentType === undefined) return keys.url;
  const typed: Record<string, ObjectKey> = {
    'image/png': keys.png,
    'image/jpeg': keys.jpeg,
    'image/webp': keys.webp,
  };
  return typed[contentType] ?? keys.png;
};

const checkpointProviderOutput = async (
  deps: RenderingPipelineDeps,
  input: PollExecution,
  context: RenderPublicationContext & {
    accountingIdentity: { receipt: ProviderCallReceipt };
  }
): Promise<
  RenderingResult<
    | {
        type: 'output_checkpointed';
        checkpoint: RenderOutputCheckpoint;
        createdKey?: ObjectKey;
      }
    | { type: 'result_succeeded' }
    | { type: 'result_pending' }
    | { type: 'result_failed'; reason: string }
    | { type: 'result_attempt_superseded' }
  >
> => {
  const { result } = context;
  const keys: Record<'url' | 'png' | 'jpeg' | 'webp', ObjectKey> = {} as Record<
    'url' | 'png' | 'jpeg' | 'webp',
    ObjectKey
  >;
  for (const format of Object.keys(
    RENDER_OUTPUT_EXTENSIONS
  ) as (keyof typeof RENDER_OUTPUT_EXTENSIONS)[]) {
    const key = renderOutputKey(input.resultId, input.attempt, format);
    if (key.isError()) return Result.Error(key.getError());
    keys[format] = key.get();
  }
  const polled = await deps.imageModels
    .adapterFor(result.modelId)
    .poll(input.providerRequestId);
  if (polled.isError()) return Result.Error(polled.getError());
  const poll = polled.get();
  if (poll.type === 'model_pending')
    return Result.Ok({ type: 'result_pending' });
  if (poll.type === 'model_failed') {
    const receipt = context.accountingIdentity?.receipt;
    const captured = await deps.providerAccounting.capture({
      ...receipt,
      status: 'failed',
      completedAt: deps.clock.now().toISOString(),
    });
    if (captured.isError()) return Result.Error(captured.getError());
    return failPoll(deps, input, poll.reason);
  }
  const key = outputKeyFor(keys, poll.outputBytes?.contentType);
  const spec = MODEL_CATALOG[result.modelId];
  const costUsdMicros = poll.costUsdMicros ?? spec.estimatedCostUsdMicros;
  const costSource =
    poll.costUsdMicros !== null
      ? poll.costSource
      : costUsdMicros !== null
        ? 'price_table'
        : 'unavailable';
  const now = deps.clock.now();
  const metadata: Omit<RenderOutputCheckpoint, 'receipt'> = {
    source: poll.outputBytes
      ? { kind: 'object' }
      : poll.outputUrl
        ? { kind: 'url', url: poll.outputUrl }
        : { kind: 'retired' },
    objectKey: key,
    contentType: poll.outputBytes?.contentType ?? null,
    provider: spec.provider,
    endpoint: spec.endpoint,
    startedAt: context.accountingIdentity?.receipt.startedAt,
    modelVersion: poll.modelVersion,
    costUsdMicros,
    costSource,
    completedAt: now.toISOString(),
  };
  const checkpoint: RenderOutputCheckpoint = {
    ...metadata,
    receipt: outputReceipt(context.accountingIdentity.receipt, metadata),
  };
  if (!poll.outputBytes && !poll.outputUrl) {
    const logged = await recordOutput(deps, checkpoint);
    if (logged.isError()) return Result.Error(logged.getError());
    return failPoll(deps, input, 'no_output');
  }
  let createdKey: ObjectKey | undefined;
  if (poll.outputBytes) {
    const stored = await deps.objectStorage.createObject({
      objectKey: key,
      body: poll.outputBytes.bytes,
      contentType: poll.outputBytes.contentType,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
    if (stored.isError()) {
      const logged = await recordOutput(deps, checkpoint);
      if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
      return Result.Error(stored.getError());
    }
    if (stored.get().type === 'object_created') createdKey = key;
  }
  const saved = await deps.renderRepository.saveOutput({
    ...input,
    checkpoint,
  });
  if (saved.isError()) {
    const logged = await recordOutput(deps, checkpoint);
    if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
    return Result.Error(saved.getError());
  }
  const savedValue = saved.get();
  if (savedValue.type === 'result_attempt_superseded') {
    const logged = await recordOutput(deps, checkpoint);
    if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
    if (createdKey) await discardLostOutput(deps, input, createdKey);
    return Result.Ok(savedValue);
  }
  if (savedValue.type === 'result_already_completed') {
    const logged = await recordOutput(deps, checkpoint);
    if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
    if (createdKey) await discardLostOutput(deps, input, createdKey);
    return recoverCompletedResult(deps, input);
  }
  if (createdKey && savedValue.checkpoint.objectKey !== createdKey) {
    await discardLostOutput(deps, input, createdKey);
    createdKey = undefined;
  }
  return Result.Ok({
    type: 'output_checkpointed',
    checkpoint: savedValue.checkpoint,
    createdKey,
  });
};

/** Recover checkpointed paid work, then atomically publish image/intent/completion.
 * Provider accounting is durably captured; cost-log delivery is independent.
 */
export async function pollResult(
  deps: RenderingPipelineDeps,
  input: PollExecution
): Promise<RenderingResult<PollResultOutcome>> {
  const loaded = await deps.renderRepository.publicationContext(input.resultId);
  if (loaded.isError()) return Result.Error(loaded.getError());
  const value = loaded.get();
  if (value.type === 'result_not_found')
    return Result.Ok({ type: 'result_not_runnable' });
  const context = value.context;
  const { result } = context;
  if (
    result.attempt !== input.attempt ||
    result.providerRequestId !== input.providerRequestId ||
    context.workflowRunId !== input.workflowRunId
  )
    return Result.Ok({ type: 'result_attempt_superseded' });
  if (result.status === 'succeeded') return recoverCompletedResult(deps, input);
  if (result.status !== 'submitted')
    return Result.Ok({ type: 'result_not_runnable' });

  if (
    !context.accountingIdentity?.receipt ||
    (context.checkpoint && !context.checkpoint.receipt)
  )
    return Result.Error(
      new AppError({
        code: 'RENDER_ACCOUNTING_IDENTITY_MISSING',
        category: 'system',
        status: 500,
        retryable: false,
      })
    );

  let checkpoint = context.checkpoint;
  let createdKey: ObjectKey | undefined;
  if (!checkpoint) {
    const prepared = await checkpointProviderOutput(deps, input, {
      ...context,
      accountingIdentity: context.accountingIdentity,
    });
    if (prepared.isError()) return Result.Error(prepared.getError());
    const output = prepared.get();
    if (output.type !== 'output_checkpointed') return Result.Ok(output);
    checkpoint = output.checkpoint;
    createdKey = output.createdKey;
  }

  // An interrupted publication must never depend on the provider link again.
  const object = await deps.objectStorage.getObjectMetadata(
    checkpoint.objectKey
  );
  if (object.isError()) return Result.Error(object.getError());
  if (object.get().type === 'object_not_found') {
    if (checkpoint.source.kind !== 'url')
      return failPoll(deps, input, 'output_unreadable');
    const copied = await deps.objectStorage.copyNewObjectFromUrl({
      sourceUrl: checkpoint.source.url,
      objectKey: checkpoint.objectKey,
      acceptedContentTypes: OUTPUT_TYPES,
      maxBytes: OUTPUT_MAX_BYTES,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
    if (copied.isError()) {
      const error = copied.getError();
      deps.logger.warn({
        event: 'rendering.result.output_failed',
        details: {
          resultId: input.resultId,
          attempt: input.attempt,
          code: error.code,
          ...sourceErrorDiagnostics(error),
        },
      });
      return Result.Error(error);
    }
    const copy = copied.get();
    if (copy.type !== 'object_created' && copy.type !== 'object_already_exists')
      return failPoll(deps, input, `output_${copy.type}`);
    if (copy.type === 'object_created') createdKey = checkpoint.objectKey;
  }
  const registered = await deps.resultImages.register({
    ...input,
    designId: context.designId,
    renderSourceImageId: context.renderSourceImageId,
    sourceSize: context.sourceSize,
    objectKey: checkpoint.objectKey,
    contentType: checkpoint.contentType ?? undefined,
    completion: {
      modelVersion: checkpoint.modelVersion,
      costUsdMicros: checkpoint.costUsdMicros,
      costSource: checkpoint.costSource,
      completedAt: checkpoint.completedAt,
    },
  });
  if (registered.isError()) return Result.Error(registered.getError());
  const registration = registered.get();
  if (registration.type === 'result_attempt_superseded') {
    if (createdKey) await discardLostOutput(deps, input, createdKey);
    return Result.Ok(registration);
  }
  if (registration.type === 'result_image_unreadable')
    return failPoll(deps, input, 'output_unreadable');
  return Result.Ok({ type: 'result_succeeded' });
}

export async function markResultFailed(
  deps: Pick<RenderingPipelineDeps, 'renderRepository' | 'clock' | 'logger'>,
  input: RenderExecution & {
    reason: string;
    providerRequestId?: string;
    submissionPersistenceFailure?: true;
  }
): Promise<
  RenderingResult<
    { type: 'result_marked_failed' } | { type: 'result_attempt_superseded' }
  >
> {
  const saved = await deps.renderRepository.failResultAttempt({
    ...input,
    reason: input.submissionPersistenceFailure
      ? 'submission_recovery_failed'
      : input.reason,
    now: deps.clock.now(),
  });
  if (saved.isError()) return Result.Error(saved.getError());
  if (saved.get().type === 'result_marked_failed')
    deps.logger.warn({
      event: 'rendering.result.failed',
      details: { ...renderLogContext(input), reason: input.reason },
    });
  return saved;
}

/**
 * Copy the placements of one image's draft onto another design's base image
 * (revised architect image). Region edits cannot move between images and are
 * counted, not copied; items are remapped to the copied ones.
 */
export async function copyDraftPlacements(
  deps: Pick<RenderingPipelineDeps, 'renderRepository'>,
  input: {
    fromImageId: ImageId;
    toImageId: ImageId;
    toDesignId: DesignId;
    itemIds: Record<string, string>;
  }
): Promise<
  RenderingResult<{ type: 'draft_copied'; placements: number; dropped: number }>
> {
  const found = await deps.renderRepository.findDraft(input.fromImageId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'draft_missing') {
    return Result.Ok({ type: 'draft_copied', placements: 0, dropped: 0 });
  }
  const edits: Edit[] = [];
  let dropped = 0;
  for (const edit of outcome.draft.editSet.edits) {
    const itemId =
      edit.kind === 'placement' ? input.itemIds[edit.itemId] : undefined;
    if (edit.kind === 'placement' && itemId) edits.push({ ...edit, itemId });
    else dropped += 1;
  }
  if (edits.length === 0 && !outcome.draft.editSet.prompt) {
    return Result.Ok({ type: 'draft_copied', placements: 0, dropped });
  }
  const saved = await deps.renderRepository.saveDraft({
    designId: input.toDesignId,
    renderSourceImageId: input.toImageId,
    editSet: { edits, prompt: outcome.draft.editSet.prompt },
    expectedRevision: 0,
  });
  if (saved.isError()) return Result.Error(saved.getError());
  return Result.Ok({ type: 'draft_copied', placements: edits.length, dropped });
}
