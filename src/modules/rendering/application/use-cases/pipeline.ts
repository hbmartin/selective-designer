import { Result } from '@bloodyowl/boxed';

import type { ProviderCallReceipt } from '@/modules/kernel';
import { sourceErrorDiagnostics } from '@/modules/kernel/domain/errors/source-error-diagnostics';
import {
  type DesignId,
  type ImageId,
  type ObjectKey,
  type RenderResultId,
  toObjectKey,
  toProviderCallId,
} from '@/modules/kernel/domain/ids';
import { providerCallIdentity } from '@/modules/kernel/domain/provider-call-identity';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';

import {
  PROVIDER_INPUT_URL_SECONDS,
  type RenderingPipelineDeps,
  type RenderingResult,
} from './types';
import type {
  ModelRequest,
  RenderExecution,
  RenderPublicationContext,
} from '../ports/ports';
import type { Edit } from '../../domain/edit-set';
import { MODEL_CATALOG } from '../../domain/model-catalog';
import { buildPrompt } from '../../domain/prompt-builder';
import { recipeReferences, targetBoxes } from '../../domain/recipe';
import type { Render, RenderResult } from '../../domain/render';
import type { RenderOutputCheckpoint } from '../../domain/render-output';

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
  | { type: 'result_submitted'; providerRequestId: string }
  | { type: 'result_already_submitted'; providerRequestId: string }
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
  )
    return Result.Ok({
      type: 'result_already_submitted',
      providerRequestId: result.providerRequestId,
    });
  if (result.status !== 'pending')
    return Result.Ok({ type: 'result_not_runnable' });
  const request = await buildRequest(deps, render, result);
  if (request.isError()) return Result.Error(request.getError());
  const invocationId = deps.idGenerator.createId();
  if (invocationId.isError()) return Result.Error(invocationId.getError());
  const submitted = await deps.imageModels
    .adapterFor(result.modelId)
    .submit(request.get());
  if (submitted.isError()) return Result.Error(submitted.getError());
  const submission = submitted.get();
  if (submission.type === 'model_rejected')
    return failPoll(deps, input, submission.reason);
  const saved = await deps.renderRepository.saveSubmission({
    ...input,
    providerRequestId: submission.providerRequestId,
    settings: submission.settings,
    prompt: request.get().prompt,
    submittedAt: deps.clock.now(),
    accountingIdentity: {
      invocationId: invocationId.get(),
      providerRequestId: submission.accountingRequestId,
    },
  });
  if (saved.isError()) return Result.Error(saved.getError());
  if (saved.get().type === 'result_attempt_superseded')
    return Result.Ok({ type: 'result_attempt_superseded' });
  return Result.Ok({
    type: 'result_submitted',
    providerRequestId: submission.providerRequestId,
  });
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

const discardLostOutput = async (
  deps: RenderingPipelineDeps,
  input: PollExecution,
  objectKey: ObjectKey
) => {
  const referenced = await deps.resultOutputReferences.check(objectKey);
  if (referenced.isError()) {
    deps.logger.warn({
      event: 'rendering.result.cleanup_failed',
      details: { ...renderLogContext(input), code: referenced.getError().code },
    });
    return;
  }
  if (referenced.get().type === 'output_referenced') return;
  const deleted = await deps.objectStorage.deleteObject(objectKey);
  if (deleted.isError())
    deps.logger.warn({
      event: 'rendering.result.cleanup_failed',
      details: { ...renderLogContext(input), code: deleted.getError().code },
    });
};

const outputReceipt = (
  input: PollExecution,
  context: RenderPublicationContext,
  checkpoint: RenderOutputCheckpoint
): RenderingResult<ProviderCallReceipt> => {
  if (checkpoint.receipt) return Result.Ok(checkpoint.receipt);
  const spec = MODEL_CATALOG[context.result.modelId];
  // New submissions explicitly distinguish accounting identity from polling locators.
  const providerRequestId = context.accountingIdentity
    ? context.accountingIdentity.providerRequestId
    : /^[A-Za-z0-9_-]+$/u.test(input.providerRequestId)
      ? input.providerRequestId
      : undefined;
  const id =
    context.accountingIdentity === null
      ? toProviderCallId(`render:${input.resultId}:${input.attempt}`)
      : providerCallIdentity({
          provider: checkpoint.provider ?? spec.provider,
          endpoint: checkpoint.endpoint ?? spec.endpoint,
          providerRequestId,
          invocationId: context.accountingIdentity.invocationId,
        });
  if (id.isError()) return Result.Error(id.getError());
  const receipt: ProviderCallReceipt = {
    id: id.get(),
    userId: undefined,
    designId: context.designId,
    purpose: 'render',
    provider: checkpoint.provider ?? spec.provider,
    endpoint: checkpoint.endpoint ?? spec.endpoint,
    subjectId: input.resultId,
    providerRequestId: providerRequestId,
    status: 'succeeded',
    costUsdMicros: checkpoint.costUsdMicros ?? undefined,
    costSource: checkpoint.costSource,
    details: { modelId: context.result.modelId, attempt: input.attempt },
    startedAt:
      checkpoint.startedAt ??
      context.result.submittedAt?.toISOString() ??
      checkpoint.completedAt,
    completedAt: checkpoint.completedAt,
  };
  return Result.Ok(receipt);
};
const recordOutput = async (
  deps: RenderingPipelineDeps,
  input: PollExecution,
  context: RenderPublicationContext,
  checkpoint: RenderOutputCheckpoint
) => {
  const receipt = outputReceipt(input, context, checkpoint);
  if (receipt.isError()) return Result.Error(receipt.getError());
  return deps.providerAccounting.capture(receipt.get());
};
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
  context: RenderPublicationContext
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
  const urlKey = toObjectKey(
    `results/${input.resultId}/${input.attempt}/raw.img`
  );
  const pngKey = toObjectKey(
    `results/${input.resultId}/${input.attempt}/raw.png`
  );
  const jpegKey = toObjectKey(
    `results/${input.resultId}/${input.attempt}/raw.jpg`
  );
  const webpKey = toObjectKey(
    `results/${input.resultId}/${input.attempt}/raw.webp`
  );
  if (urlKey.isError()) return Result.Error(urlKey.getError());
  if (pngKey.isError()) return Result.Error(pngKey.getError());
  if (jpegKey.isError()) return Result.Error(jpegKey.getError());
  if (webpKey.isError()) return Result.Error(webpKey.getError());
  const polled = await deps.imageModels
    .adapterFor(result.modelId)
    .poll(input.providerRequestId);
  if (polled.isError()) return Result.Error(polled.getError());
  const poll = polled.get();
  if (poll.type === 'model_pending')
    return Result.Ok({ type: 'result_pending' });
  if (poll.type === 'model_failed') return failPoll(deps, input, poll.reason);
  const key = outputKeyFor(
    {
      url: urlKey.get(),
      png: pngKey.get(),
      jpeg: jpegKey.get(),
      webp: webpKey.get(),
    },
    poll.outputBytes?.contentType
  );
  const spec = MODEL_CATALOG[result.modelId];
  const costUsdMicros = poll.costUsdMicros ?? spec.estimatedCostUsdMicros;
  const costSource =
    poll.costUsdMicros !== null
      ? poll.costSource
      : costUsdMicros !== null
        ? 'price_table'
        : 'unavailable';
  const now = deps.clock.now();
  let checkpoint: RenderOutputCheckpoint = {
    source: poll.outputBytes
      ? { kind: 'object' }
      : poll.outputUrl
        ? { kind: 'url', url: poll.outputUrl }
        : { kind: 'retired' },
    objectKey: key,
    contentType: poll.outputBytes?.contentType ?? null,
    provider: spec.provider,
    endpoint: spec.endpoint,
    startedAt: (result.submittedAt ?? now).toISOString(),
    modelVersion: poll.modelVersion,
    costUsdMicros,
    costSource,
    completedAt: now.toISOString(),
  };
  const receipt = outputReceipt(input, context, checkpoint);
  if (receipt.isError()) return Result.Error(receipt.getError());
  checkpoint = { ...checkpoint, receipt: receipt.get() };
  if (!poll.outputBytes && !poll.outputUrl) {
    const logged = await recordOutput(deps, input, context, checkpoint);
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
      const logged = await recordOutput(deps, input, context, checkpoint);
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
    const logged = await recordOutput(deps, input, context, checkpoint);
    if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
    return Result.Error(saved.getError());
  }
  const savedValue = saved.get();
  if (savedValue.type === 'result_attempt_superseded') {
    const logged = await recordOutput(deps, input, context, checkpoint);
    if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
    if (createdKey) await discardLostOutput(deps, input, createdKey);
    return Result.Ok(savedValue);
  }
  if (savedValue.type === 'result_already_completed') {
    const logged = await recordOutput(deps, input, context, checkpoint);
    if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
    if (createdKey) await discardLostOutput(deps, input, createdKey);
    return recoverCompletedResult(deps, input);
  }
  if (checkpoint.receipt?.id !== savedValue.checkpoint.receipt?.id) {
    const logged = await recordOutput(deps, input, context, checkpoint);
    if (logged.isError()) warnCostRecord(deps, input, logged.getError().code);
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

  let checkpoint = context.checkpoint;
  let createdKey: ObjectKey | undefined;
  if (!checkpoint) {
    const prepared = await checkpointProviderOutput(deps, input, context);
    if (prepared.isError()) return Result.Error(prepared.getError());
    const output = prepared.get();
    if (output.type !== 'output_checkpointed') return Result.Ok(output);
    checkpoint = output.checkpoint;
    createdKey = output.createdKey;
  }

  const logged = await recordOutput(deps, input, context, checkpoint);
  if (logged.isError()) {
    // New checkpoints already committed their receipt atomically. Legacy recovery must capture first.
    if (!checkpoint.receipt) return Result.Error(logged.getError());
    warnCostRecord(deps, input, logged.getError().code);
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
  input: RenderExecution & { reason: string; providerRequestId?: string }
): Promise<
  RenderingResult<
    { type: 'result_marked_failed' } | { type: 'result_attempt_superseded' }
  >
> {
  const saved = await deps.renderRepository.failResultAttempt({
    ...input,
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
