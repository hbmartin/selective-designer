import { Result } from '@bloodyowl/boxed';

import { type ImageId, toRegionId } from '@/modules/kernel/domain/ids';
import { providerCallIdentity } from '@/modules/kernel/domain/provider-call-identity';

import { discardUnpublishedMasks, storeSegmentedMasks } from './store-masks';
import {
  type SegmentationPipelineDeps,
  type SegmentationResultOf,
  SIGNED_MASK_URL_SECONDS,
} from './types';
import type { DetectionIdentity } from '../ports/ports';
import {
  detectionRunFor,
  ownsDetectionLease,
} from '../../domain/detection-run';
import {
  detectionConcepts,
  isDetectionConceptSettled,
  isUserMadeSource,
} from '../../domain/region';
import { RegionWriteError } from '../../domain/region-write-error';

/** Concepts automatic detection looks for in this image's design. */
export async function detectionConceptsFor(
  deps: Pick<SegmentationPipelineDeps, 'imageAccess' | 'conceptSource'>,
  imageId: ImageId
): Promise<
  SegmentationResultOf<
    { type: 'concepts'; concepts: string[] } | { type: 'image_missing' }
  >
> {
  const image = await deps.imageAccess.find(imageId);
  if (image.isError()) return Result.Error(image.getError());
  const outcome = image.get();
  if (outcome.type === 'image_missing') return Result.Ok(outcome);
  const categories = await deps.conceptSource.categoriesOf(
    outcome.image.designId
  );
  if (categories.isError()) return Result.Error(categories.getError());
  return Result.Ok({
    type: 'concepts',
    concepts: detectionConcepts(categories.get()),
  });
}

/**
 * One workflow step: find every instance of one concept with a text prompt
 * and replace earlier detections of that concept on the image.
 */
export async function detectConcept(
  deps: SegmentationPipelineDeps,
  input: DetectionIdentity & { imageId: ImageId; concept: string }
): Promise<
  SegmentationResultOf<
    | { type: 'concept_detected'; count: number }
    | { type: 'concept_failed'; reason: string }
    | { type: 'concept_omitted' }
    | { type: 'detection_concept_already_completed' }
    | { type: 'detection_superseded' }
    | { type: 'image_missing' }
  >
> {
  const identity = detectionRunFor(input.imageId, input);
  if (identity.isError()) return Result.Error(identity.getError());
  const run = identity.get();
  if (run) {
    const found = await deps.regionRepository.findDetection(run.imageId);
    if (found.isError()) return Result.Error(found.getError());
    const lease = found.get();
    if (!ownsDetectionLease(lease, run, deps.clock.now()))
      return Result.Ok({ type: 'detection_superseded' });
    if (isDetectionConceptSettled(lease.progress, input.concept)) {
      return Result.Ok({ type: 'detection_concept_already_completed' });
    }
  }
  const omit = async (reason: 'prompt_rejected' | 'invalid_mask') => {
    if (!run) return Result.Ok({ type: 'concept_failed' as const, reason });
    const saved = await deps.regionRepository.omitConcept({
      ...run,
      now: deps.clock.now(),
      concept: input.concept,
      reason,
    });
    if (saved.isError()) return Result.Error(saved.getError());
    const outcome = saved.get();
    return Result.Ok(
      outcome.type === 'regions_saved'
        ? { type: 'concept_omitted' as const }
        : outcome
    );
  };

  const found = await deps.imageAccess.find(input.imageId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'image_missing') return Result.Ok(outcome);
  const { image } = outcome;

  const imageUrl = await deps.objectStorage.createSignedReadUrl({
    objectKey: image.workingKey,
    expiresInSeconds: SIGNED_MASK_URL_SECONDS,
  });
  if (imageUrl.isError()) return Result.Error(imageUrl.getError());

  const invocationId = deps.idGenerator.createId();
  if (invocationId.isError()) return Result.Error(invocationId.getError());
  const startedAt = deps.clock.now();
  const segmented = await deps.segmenter.segment({
    imageUrl: imageUrl.get().url,
    imageKey: image.workingKey,
    width: image.width,
    height: image.height,
    prompt: { type: 'text', text: input.concept },
    maxMasks: 8,
  });
  if (segmented.isError()) return Result.Error(segmented.getError());
  const result = segmented.get();

  const callId = providerCallIdentity({
    provider: result.provider,
    endpoint: result.endpoint,
    providerRequestId: result.providerRequestId,
    invocationId: invocationId.get(),
  });
  if (callId.isError()) return Result.Error(callId.getError());
  const logged = await deps.providerAccounting.capture({
    id: callId.get(),
    userId: image.ownerId,
    designId: image.designId,
    purpose: 'segmentation',
    provider: result.provider,
    endpoint: result.endpoint,
    subjectId: image.imageId,
    providerRequestId:
      result.type === 'segmented' ? result.providerRequestId : undefined,
    status: result.type === 'segmented' ? 'succeeded' : 'failed',
    costUsdMicros:
      result.type === 'segmented' ? result.costUsdMicros : undefined,
    costSource: result.type === 'segmented' ? result.costSource : 'unavailable',
    details: { concept: input.concept },
    startedAt: startedAt.toISOString(),
    completedAt: deps.clock.now().toISOString(),
  });
  if (logged.isError()) return Result.Error(logged.getError());
  if (result.type === 'segmentation_failed') {
    if (result.terminal && run?.workerId) return omit('prompt_rejected');
    return Result.Ok({ type: 'concept_failed', reason: result.reason });
  }

  const regions = await storeSegmentedMasks(deps, {
    image,
    result,
    source: 'detection',
    label: input.concept,
  });
  if (regions.isError()) return Result.Error(regions.getError());
  const stored = regions.get();
  if (stored.type === 'detection_mask_unavailable') {
    if (stored.reason === 'invalid_mask' && run?.workerId)
      return omit('invalid_mask');
    return Result.Ok({ type: 'concept_failed', reason: 'mask_unavailable' });
  }
  const saved = await deps.regionRepository.replaceDetections({
    ...run,
    imageId: image.imageId,
    concept: input.concept,
    regions: stored.regions,
    now: deps.clock.now(),
  });
  // A persistence error may have arrived after the commit.
  if (saved.isError()) {
    const error = saved.getError();
    if (error instanceof RegionWriteError && error.publication === 'rejected')
      await discardUnpublishedMasks(
        deps,
        stored.regions.map((region) => region.maskKey)
      );
    return Result.Error(error);
  }
  const published = saved.get();
  if (published.type !== 'regions_saved') {
    await discardUnpublishedMasks(
      deps,
      stored.regions.map((region) => region.maskKey)
    );
    return Result.Ok(published);
  }
  return Result.Ok({ type: 'concept_detected', count: stored.regions.length });
}

/**
 * Copy the user-made regions of a render source onto a result continued from
 * it, as editable suggestions. Mask objects are immutable, so they are shared.
 * Idempotent: regions already carried over are not duplicated.
 */
export async function carryOverRegions(
  deps: SegmentationPipelineDeps,
  input: DetectionIdentity & { fromImageId: ImageId; toImageId: ImageId }
): Promise<
  SegmentationResultOf<
    | { type: 'regions_carried_over'; count: number }
    | { type: 'image_missing' }
    | { type: 'detection_superseded' }
  >
> {
  const identity = detectionRunFor(input.toImageId, input);
  if (identity.isError()) return Result.Error(identity.getError());
  const run = identity.get();

  const target = await deps.imageAccess.find(input.toImageId);
  if (target.isError()) return Result.Error(target.getError());
  const targetOutcome = target.get();
  if (targetOutcome.type === 'image_missing') return Result.Ok(targetOutcome);

  const [source, existing] = await Promise.all([
    deps.regionRepository.listByImage(input.fromImageId),
    deps.regionRepository.listByImage(input.toImageId),
  ]);
  if (source.isError()) return Result.Error(source.getError());
  if (existing.isError()) return Result.Error(existing.getError());
  const alreadyCarried = new Set(
    existing
      .get()
      .regions.map((region) => region.carriedFromRegionId)
      .filter(Boolean)
  );

  const copies = [];
  for (const region of source.get().regions) {
    if (!isUserMadeSource(region.source) || alreadyCarried.has(region.id))
      continue;
    const raw = deps.idGenerator.createId();
    if (raw.isError()) return Result.Error(raw.getError());
    const id = toRegionId(raw.get());
    if (id.isError()) return Result.Error(id.getError());
    copies.push({
      id: id.get(),
      designId: targetOutcome.image.designId,
      imageId: input.toImageId,
      source: region.source,
      label: region.label,
      maskKey: region.maskKey,
      box: region.box,
      score: region.score,
      isSuggestion: true,
      carriedFromRegionId: region.id,
    });
  }
  if (copies.length > 0 || run) {
    const saved = await deps.regionRepository.insertMany(
      copies,
      run && { ...run, now: deps.clock.now() }
    );
    if (saved.isError()) return Result.Error(saved.getError());
    if (saved.get().type === 'detection_superseded')
      return Result.Ok({ type: 'detection_superseded' });
  }
  return Result.Ok({ type: 'regions_carried_over', count: copies.length });
}
