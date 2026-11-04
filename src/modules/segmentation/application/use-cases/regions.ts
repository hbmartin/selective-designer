import { Result } from '@bloodyowl/boxed';

import {
  type ImageId,
  type ObjectKey,
  type RegionId,
  toRegionId,
  type UserId,
} from '@/modules/kernel/domain/ids';
import { objectKeyMatchesPurpose } from '@/modules/kernel/domain/upload-policy';

import { providerCallIdFor, storeSegmentedMasks } from './store-masks';
import {
  type SegmentationResultOf,
  type SegmentationUseCaseDeps,
  SIGNED_MASK_URL_SECONDS,
} from './types';
import type {
  DetectionDispatch,
  DetectionOmission,
  DetectionSummary,
  SegmentableImage,
} from '../ports/ports';
import {
  type FractionalBox,
  isValidFractionalBox,
  type Region,
  REGION_LABEL_MAX_LENGTH,
  type SegmentationPrompt,
} from '../../domain/region';

export type RegionView = Region & { maskUrl: string; maskUrlExpiresAt: number };

type Forbidden = { type: 'segmentation_forbidden' };
type ImageNotFound = { type: 'image_not_found' };

const MAX_INTERACTIVE_MASKS = 3;

const loadOwnedImage = async (
  deps: SegmentationUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId; action: 'read' | 'update' }
): Promise<
  SegmentationResultOf<
    { type: 'ok'; image: SegmentableImage } | Forbidden | ImageNotFound
  >
> => {
  const permission = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    {
      design: [input.action],
    }
  );
  if (permission.isError()) return Result.Error(permission.getError());
  if (permission.get().type === 'permission_denied') {
    return Result.Ok({ type: 'segmentation_forbidden' });
  }
  const found = await deps.imageAccess.find(input.imageId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (
    outcome.type === 'image_missing' ||
    outcome.image.ownerId !== input.currentUserId
  ) {
    return Result.Ok({ type: 'image_not_found' });
  }
  return Result.Ok({ type: 'ok', image: outcome.image });
};

export const toRegionView = async (
  deps: Pick<SegmentationUseCaseDeps, 'objectStorage' | 'clock'>,
  region: Region
): Promise<SegmentationResultOf<RegionView>> => {
  const maskUrlExpiresAt =
    deps.clock.now().getTime() + SIGNED_MASK_URL_SECONDS * 1000;
  const signed = await deps.objectStorage.createSignedReadUrl({
    objectKey: region.maskKey,
    expiresInSeconds: SIGNED_MASK_URL_SECONDS,
  });
  if (signed.isError()) return Result.Error(signed.getError());
  return Result.Ok({ ...region, maskUrl: signed.get().url, maskUrlExpiresAt });
};

const toViews = async (
  deps: SegmentationUseCaseDeps,
  regions: Region[]
): Promise<SegmentationResultOf<RegionView[]>> => {
  const views: RegionView[] = [];
  for (const region of regions) {
    // oxlint-disable-next-line no-await-in-loop -- signing is local HMAC.
    const view = await toRegionView(deps, region);
    if (view.isError()) return Result.Error(view.getError());
    views.push(view.get());
  }
  return Result.Ok(views);
};

export type ListRegionsOutcome =
  | ({ type: 'regions_listed' } & RegionListView)
  | Forbidden
  | ImageNotFound;

export type RegionListView = {
  regions: RegionView[];
  detection: DetectionView;
};

type DetectionView = (
  | { type: 'idle' | 'retryable' | 'finished_with_omissions' }
  | { type: 'waiting' | 'running'; remainingMs: number }
) & { omissions: DetectionOmission[] };

const detectionView = (summary: DetectionSummary, now: Date): DetectionView => {
  if (summary.type === 'no_detection') return { type: 'idle', omissions: [] };
  const { phase, omissions, expiresAt, failed } = summary;
  if (phase === 'omissions')
    return { type: 'finished_with_omissions', omissions };
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (failed || phase === 'ready' || remainingMs <= 0)
    return { type: 'retryable', omissions };
  return {
    type: phase === 'copying' || phase === 'queued' ? 'waiting' : 'running',
    remainingMs,
    omissions,
  };
};

export async function listRegions(
  deps: SegmentationUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId }
): Promise<SegmentationResultOf<ListRegionsOutcome>> {
  const owned = await loadOwnedImage(deps, { ...input, action: 'read' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  const listed = await deps.regionRepository.listByImage(input.imageId);
  if (listed.isError()) return Result.Error(listed.getError());
  const { regions, detection } = listed.get();
  const views = await toViews(deps, regions);
  if (views.isError()) return Result.Error(views.getError());
  return Result.Ok({
    type: 'regions_listed',
    regions: views.get(),
    detection: detectionView(detection, deps.clock.now()),
  });
}

type RetryDetectionOutcome =
  | Forbidden
  | ImageNotFound
  | DetectionDispatch
  | { type: 'detection_not_retryable' };

export async function retryDetection(
  deps: SegmentationUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId }
): Promise<SegmentationResultOf<RetryDetectionOutcome>> {
  const owned = await loadOwnedImage(deps, { ...input, action: 'update' });
  if (owned.isError()) return Result.Error(owned.getError());
  const outcome = owned.get();
  if (outcome.type !== 'ok') return Result.Ok(outcome);
  const scheduled = await deps.detectionRetry.retry(input.imageId);
  if (scheduled.isError()) return Result.Error(scheduled.getError());
  return Result.Ok(scheduled.get());
}

export type SegmentByPromptOutcome =
  | { type: 'regions_created'; regions: RegionView[] }
  | { type: 'segmentation_failed'; reason: string }
  | Forbidden
  | ImageNotFound;

/**
 * Interactive selection: click points, a box or a text description run
 * through the segmenter synchronously; returned masks become regions.
 */
export async function segmentByPrompt(
  deps: SegmentationUseCaseDeps,
  input: {
    currentUserId: UserId;
    imageId: ImageId;
    prompt: SegmentationPrompt;
    label: string;
  }
): Promise<SegmentationResultOf<SegmentByPromptOutcome>> {
  const owned = await loadOwnedImage(deps, { ...input, action: 'update' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  const { image } = ownedOutcome;

  const imageUrl = await deps.objectStorage.createSignedReadUrl({
    objectKey: image.workingKey,
    expiresInSeconds: SIGNED_MASK_URL_SECONDS,
  });
  if (imageUrl.isError()) return Result.Error(imageUrl.getError());

  const startedAt = deps.clock.now();
  const segmented = await deps.segmenter.segment({
    imageUrl: imageUrl.get().url,
    imageKey: image.workingKey,
    width: image.width,
    height: image.height,
    prompt: input.prompt,
    maxMasks: input.prompt.type === 'text' ? MAX_INTERACTIVE_MASKS : 1,
  });
  if (segmented.isError()) return Result.Error(segmented.getError());
  const result = segmented.get();

  const callId = providerCallIdFor(
    'sam',
    image.imageId,
    String(startedAt.getTime())
  );
  if (callId.isError()) return Result.Error(callId.getError());
  const logged = await deps.providerCallLog.record({
    id: callId.get(),
    userId: input.currentUserId,
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
    details: { prompt: input.prompt.type },
    startedAt,
    completedAt: deps.clock.now(),
  });
  if (logged.isError()) return Result.Error(logged.getError());

  if (result.type === 'segmentation_failed') {
    return Result.Ok({ type: 'segmentation_failed', reason: result.reason });
  }
  const label =
    input.label.trim().slice(0, REGION_LABEL_MAX_LENGTH) ||
    (input.prompt.type === 'text' ? input.prompt.text : input.prompt.type);
  const regions = await storeSegmentedMasks(deps, {
    image,
    result,
    source: input.prompt.type,
    label,
  });
  if (regions.isError()) return Result.Error(regions.getError());
  const stored = regions.get();
  const saved = await deps.regionRepository.insertMany(stored.regions);
  if (saved.isError()) return Result.Error(saved.getError());
  const views = await toViews(
    deps,
    stored.regions.map((region) => ({ ...region, createdAt: deps.clock.now() }))
  );
  if (views.isError()) return Result.Error(views.getError());
  return Result.Ok({ type: 'regions_created', regions: views.get() });
}

export type CreateManualRegionOutcome =
  | { type: 'regions_created'; regions: RegionView[] }
  | { type: 'region_upload_unowned' }
  | { type: 'region_invalid' }
  | Forbidden
  | ImageNotFound;

/** A brush or lasso mask drawn in the browser and uploaded as a PNG. */
export async function createManualRegion(
  deps: SegmentationUseCaseDeps,
  input: {
    currentUserId: UserId;
    imageId: ImageId;
    source: 'brush' | 'lasso';
    label: string;
    maskKey: ObjectKey;
    box: FractionalBox;
  }
): Promise<SegmentationResultOf<CreateManualRegionOutcome>> {
  const owned = await loadOwnedImage(deps, { ...input, action: 'update' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  if (
    !isValidFractionalBox(input.box) ||
    !objectKeyMatchesPurpose(input.maskKey, 'region_mask')
  ) {
    return Result.Ok({ type: 'region_invalid' });
  }
  const consumed = await deps.uploadIntentStore.consume({
    objectKey: input.maskKey,
    userId: input.currentUserId,
    purpose: 'region_mask',
    now: deps.clock.now(),
  });
  if (consumed.isError()) return Result.Error(consumed.getError());
  if (consumed.get().type === 'upload_intent_unowned') {
    return Result.Ok({ type: 'region_upload_unowned' });
  }
  const raw = deps.idGenerator.createId();
  if (raw.isError()) return Result.Error(raw.getError());
  const regionId = toRegionId(raw.get());
  if (regionId.isError()) return Result.Error(regionId.getError());
  const region = {
    id: regionId.get(),
    designId: ownedOutcome.image.designId,
    imageId: ownedOutcome.image.imageId,
    source: input.source,
    label: input.label.trim().slice(0, REGION_LABEL_MAX_LENGTH) || input.source,
    maskKey: input.maskKey,
    box: input.box,
    score: null,
    isSuggestion: false,
    carriedFromRegionId: null,
  };
  const saved = await deps.regionRepository.insertMany([region]);
  if (saved.isError()) return Result.Error(saved.getError());
  const view = await toRegionView(deps, {
    ...region,
    createdAt: deps.clock.now(),
  });
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'regions_created', regions: [view.get()] });
}

export type UpdateRegionOutcome =
  | { type: 'region_updated'; region: RegionView }
  | { type: 'region_removed' }
  | { type: 'region_not_found' }
  | Forbidden;

const loadOwnedRegion = async (
  deps: SegmentationUseCaseDeps,
  input: { currentUserId: UserId; regionId: RegionId }
): Promise<
  SegmentationResultOf<
    | { type: 'region_found'; region: Region }
    | { type: 'region_not_found' }
    | Forbidden
  >
> => {
  const found = await deps.regionRepository.findById(input.regionId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'region_not_found') return Result.Ok(outcome);
  const owned = await loadOwnedImage(deps, {
    currentUserId: input.currentUserId,
    imageId: outcome.region.imageId,
    action: 'update',
  });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type === 'image_not_found') {
    return Result.Ok({ type: 'region_not_found' });
  }
  if (ownedOutcome.type === 'segmentation_forbidden')
    return Result.Ok(ownedOutcome);
  return Result.Ok(outcome);
};

/** Rename a region or confirm a carried-over suggestion. */
export async function updateRegion(
  deps: SegmentationUseCaseDeps,
  input: {
    currentUserId: UserId;
    regionId: RegionId;
    label?: string;
    confirm?: boolean;
  }
): Promise<SegmentationResultOf<UpdateRegionOutcome>> {
  const owned = await loadOwnedRegion(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'region_found') return Result.Ok(ownedOutcome);
  const updated = await deps.regionRepository.update({
    regionId: input.regionId,
    ...(input.label !== undefined
      ? { label: input.label.trim().slice(0, REGION_LABEL_MAX_LENGTH) }
      : {}),
    ...(input.confirm ? { isSuggestion: false } : {}),
  });
  if (updated.isError()) return Result.Error(updated.getError());
  const updatedOutcome = updated.get();
  if (updatedOutcome.type === 'region_not_found')
    return Result.Ok(updatedOutcome);
  const view = await toRegionView(deps, updatedOutcome.region);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'region_updated', region: view.get() });
}

export async function removeRegion(
  deps: SegmentationUseCaseDeps,
  input: { currentUserId: UserId; regionId: RegionId }
): Promise<SegmentationResultOf<UpdateRegionOutcome>> {
  const owned = await loadOwnedRegion(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'region_found') return Result.Ok(ownedOutcome);
  const removed = await deps.regionRepository.remove(input.regionId);
  if (removed.isError()) return Result.Error(removed.getError());
  return Result.Ok({ type: 'region_removed' });
}
