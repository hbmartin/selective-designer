import { Result } from '@bloodyowl/boxed';

import {
  type RenderId,
  type RenderResultId,
  toObjectKey,
  toProviderCallId,
} from '@/modules/kernel/domain/ids';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';

import {
  PROVIDER_INPUT_URL_SECONDS,
  type RenderingPipelineDeps,
  type RenderingResult,
} from './types';
import type { ModelRequest } from '../ports/ports';
import { MODEL_CATALOG } from '../../domain/model-catalog';
import { buildPrompt } from '../../domain/prompt-builder';
import { recipeReferences, targetBoxes } from '../../domain/recipe';
import type { Render, RenderResult } from '../../domain/render';

const OUTPUT_MAX_BYTES = 40 * 1024 * 1024;
const OUTPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Aspect ratios within 1% count as the same framing. */
const sameFraming = (
  a: { width: number; height: number },
  b: { width: number; height: number }
) =>
  Math.abs(a.width / a.height - b.width / b.height) / (b.width / b.height) <=
  0.01;

const loadResult = (deps: RenderingPipelineDeps, resultId: RenderResultId) =>
  deps.renderRepository.findResult(resultId);

/** Results of a render that still need a model run. */
export async function runnableResults(
  deps: RenderingPipelineDeps,
  renderId: RenderId
): Promise<RenderingResult<{ type: 'runnable'; resultIds: string[] }>> {
  const found = await deps.renderRepository.findRender(renderId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'render_not_found')
    return Result.Ok({ type: 'runnable', resultIds: [] });
  return Result.Ok({
    type: 'runnable',
    resultIds: outcome.render.results
      .filter(
        (result) => result.status === 'pending' || result.status === 'submitted'
      )
      .map((result) => result.id),
  });
}

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
  | { type: 'result_submitted' }
  | { type: 'result_already_submitted' }
  | { type: 'result_failed'; reason: string }
  | { type: 'result_not_runnable' };

/**
 * Send one model its request. Idempotent: a retried step after a successful
 * submit finds the stored provider request id and does not pay twice.
 */
export async function submitResult(
  deps: RenderingPipelineDeps,
  resultId: RenderResultId
): Promise<RenderingResult<SubmitResultOutcome>> {
  const loaded = await loadResult(deps, resultId);
  if (loaded.isError()) return Result.Error(loaded.getError());
  const outcome = loaded.get();
  if (outcome.type === 'result_not_found')
    return Result.Ok({ type: 'result_not_runnable' });
  const { result, render } = outcome;
  if (result.status === 'submitted' && result.providerRequestId) {
    return Result.Ok({ type: 'result_already_submitted' });
  }
  if (result.status !== 'pending')
    return Result.Ok({ type: 'result_not_runnable' });

  const request = await buildRequest(deps, render, result);
  if (request.isError()) return Result.Error(request.getError());
  const submitted = await deps.imageModels
    .adapterFor(result.modelId)
    .submit(request.get());
  if (submitted.isError()) return Result.Error(submitted.getError());
  const submission = submitted.get();
  if (submission.type === 'model_rejected') {
    const failed = await markResultFailed(deps, {
      resultId,
      reason: submission.reason,
    });
    if (failed.isError()) return Result.Error(failed.getError());
    return Result.Ok({ type: 'result_failed', reason: submission.reason });
  }
  const saved = await deps.renderRepository.updateResult({
    resultId,
    changes: {
      status: 'submitted',
      providerRequestId: submission.providerRequestId,
      settings: submission.settings,
      prompt: request.get().prompt,
      submittedAt: deps.clock.now(),
    },
  });
  if (saved.isError()) return Result.Error(saved.getError());
  return Result.Ok({ type: 'result_submitted' });
}

export type PollResultOutcome =
  | { type: 'result_pending' }
  | { type: 'result_succeeded' }
  | { type: 'result_failed'; reason: string }
  | { type: 'result_not_runnable' };

/**
 * Check a submitted model run. On completion the output is copied into owned
 * storage right away (provider links expire), registered as a design image
 * (which starts eager detection), and the cost is logged.
 */
export async function pollResult(
  deps: RenderingPipelineDeps,
  resultId: RenderResultId
): Promise<RenderingResult<PollResultOutcome>> {
  const loaded = await loadResult(deps, resultId);
  if (loaded.isError()) return Result.Error(loaded.getError());
  const outcome = loaded.get();
  if (outcome.type === 'result_not_found')
    return Result.Ok({ type: 'result_not_runnable' });
  const { result, render } = outcome;
  if (result.status === 'succeeded')
    return Result.Ok({ type: 'result_succeeded' });
  if (result.status !== 'submitted' || !result.providerRequestId) {
    return Result.Ok({ type: 'result_not_runnable' });
  }

  const polled = await deps.imageModels
    .adapterFor(result.modelId)
    .poll(result.providerRequestId);
  if (polled.isError()) return Result.Error(polled.getError());
  const poll = polled.get();
  if (poll.type === 'model_pending')
    return Result.Ok({ type: 'result_pending' });
  if (poll.type === 'model_failed') {
    const failed = await markResultFailed(deps, {
      resultId,
      reason: poll.reason,
    });
    if (failed.isError()) return Result.Error(failed.getError());
    return Result.Ok({ type: 'result_failed', reason: poll.reason });
  }

  // Deterministic key per attempt: a retried step overwrites, never duplicates.
  const rawKey = (extension: string) =>
    toObjectKey(`results/${resultId}/${result.attempt}/raw.${extension}`);
  let objectKey;
  let contentType: string;
  if (poll.outputBytes) {
    contentType = poll.outputBytes.contentType;
    const key = rawKey(EXTENSION[contentType] ?? 'png');
    if (key.isError()) return Result.Error(key.getError());
    const stored = await deps.objectStorage.putObject({
      objectKey: key.get(),
      body: poll.outputBytes.bytes,
      contentType,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
    if (stored.isError()) return Result.Error(stored.getError());
    objectKey = key.get();
  } else if (poll.outputUrl) {
    const key = rawKey('img');
    if (key.isError()) return Result.Error(key.getError());
    const copied = await deps.objectStorage.copyFromUrl({
      sourceUrl: poll.outputUrl,
      objectKey: key.get(),
      acceptedContentTypes: OUTPUT_TYPES,
      maxBytes: OUTPUT_MAX_BYTES,
      cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
    });
    if (copied.isError()) return Result.Error(copied.getError());
    const copy = copied.get();
    if (copy.type !== 'object_copied') {
      const failed = await markResultFailed(deps, {
        resultId,
        reason: `output_${copy.type}`,
      });
      if (failed.isError()) return Result.Error(failed.getError());
      return Result.Ok({
        type: 'result_failed',
        reason: `output_${copy.type}`,
      });
    }
    contentType = copy.contentType;
    objectKey = key.get();
  } else {
    const failed = await markResultFailed(deps, {
      resultId,
      reason: 'no_output',
    });
    if (failed.isError()) return Result.Error(failed.getError());
    return Result.Ok({ type: 'result_failed', reason: 'no_output' });
  }

  const registered = await deps.resultImages.register({
    designId: render.designId,
    renderSourceImageId: render.renderSourceImageId,
    objectKey,
    contentType,
  });
  if (registered.isError()) return Result.Error(registered.getError());
  const image = registered.get();
  if (image.type === 'result_image_unreadable') {
    const failed = await markResultFailed(deps, {
      resultId,
      reason: 'output_unreadable',
    });
    if (failed.isError()) return Result.Error(failed.getError());
    return Result.Ok({ type: 'result_failed', reason: 'output_unreadable' });
  }

  const spec = MODEL_CATALOG[result.modelId];
  const costUsdMicros = poll.costUsdMicros ?? spec.estimatedCostUsdMicros;
  const costSource =
    poll.costUsdMicros !== null
      ? poll.costSource
      : costUsdMicros !== null
        ? 'price_table'
        : 'unavailable';
  const now = deps.clock.now();
  const saved = await deps.renderRepository.updateResult({
    resultId,
    changes: {
      status: 'succeeded',
      outputImageId: image.imageId,
      modelVersion: poll.modelVersion,
      framingChanged: !sameFraming(
        { width: image.width, height: image.height },
        render.recipe.source
      ),
      costUsdMicros,
      costSource,
      completedAt: now,
    },
  });
  if (saved.isError()) return Result.Error(saved.getError());

  const callId = toProviderCallId(`render:${resultId}:${result.attempt}`);
  if (callId.isError()) return Result.Error(callId.getError());
  const logged = await deps.providerCallLog.record({
    id: callId.get(),
    userId: undefined,
    designId: render.designId,
    purpose: 'render',
    provider: spec.provider,
    endpoint: spec.endpoint,
    subjectId: resultId,
    providerRequestId: result.providerRequestId,
    status: 'succeeded',
    costUsdMicros: costUsdMicros ?? undefined,
    costSource,
    details: { modelId: result.modelId, attempt: result.attempt },
    startedAt: result.submittedAt ?? now,
    completedAt: now,
  });
  if (logged.isError()) return Result.Error(logged.getError());
  return Result.Ok({ type: 'result_succeeded' });
}

export async function markResultFailed(
  deps: Pick<RenderingPipelineDeps, 'renderRepository' | 'clock' | 'logger'>,
  input: { resultId: RenderResultId; reason: string }
): Promise<RenderingResult<{ type: 'result_marked_failed' }>> {
  const saved = await deps.renderRepository.updateResult({
    resultId: input.resultId,
    changes: {
      status: 'failed',
      errorMessage: input.reason.slice(0, 500),
      completedAt: deps.clock.now(),
    },
  });
  if (saved.isError()) return Result.Error(saved.getError());
  deps.logger.warn({ event: 'rendering.result.failed', details: input });
  return Result.Ok({ type: 'result_marked_failed' });
}
