import { Result } from '@bloodyowl/boxed';

import type {
  ObjectCopyOutcome,
  ObjectStoredOutcome,
} from '@/modules/kernel/application/ports/object-storage';
import {
  type ObjectKey,
  type ProviderCallId,
  type RegionId,
  toObjectKey,
  toProviderCallId,
  toRegionId,
} from '@/modules/kernel/domain/ids';
import { IMMUTABLE_OBJECT_CACHE_CONTROL } from '@/modules/kernel/domain/upload-policy';

import type { SegmentationPipelineDeps, SegmentationResultOf } from './types';
import type {
  NewRegion,
  SegmentableImage,
  SegmentationResult,
} from '../ports/ports';
import { type RegionSource, toFractionalBox } from '../../domain/region';

const MASK_MAX_BYTES = 15 * 1024 * 1024;

const newRegionMask = (idGenerator: SegmentationPipelineDeps['idGenerator']) =>
  idGenerator
    .createId()
    .flatMap(toRegionId)
    .flatMap((id) =>
      toObjectKey(`region-masks/${id}.png`).map((objectKey) => ({
        id,
        objectKey,
      }))
    );

type MaskStorageDeps = Pick<
  SegmentationPipelineDeps,
  'objectStorage' | 'logger'
>;

export async function discardUnpublishedMasks(
  deps: MaskStorageDeps,
  keys: readonly ObjectKey[]
) {
  await Promise.all(
    keys.map(async (objectKey) => {
      const deleted = await deps.objectStorage.deleteObject(objectKey);
      if (deleted.isError()) {
        deps.logger.warn({
          event: 'segmentation.mask.cleanup_failed',
          details: { objectKey, code: deleted.getError().code },
        });
      }
    })
  );
}

type StoreMaskDeps = MaskStorageDeps &
  Pick<SegmentationPipelineDeps, 'idGenerator'>;
type StoreMaskInput = {
  image: SegmentableImage;
  result: Extract<SegmentationResult, { type: 'segmented' }>;
  source: RegionSource;
  label: string;
};
type MasksStored = { type: 'masks_stored'; regions: NewRegion[] };
type MaskUnavailable = {
  type: 'detection_mask_unavailable';
  reason: 'invalid_mask' | 'mask_unavailable';
};

/** Store fresh masks. Automatic detection publishes a whole concept at once. */
export function storeSegmentedMasks(
  deps: StoreMaskDeps,
  input: StoreMaskInput & { source: Exclude<RegionSource, 'detection'> }
): Promise<SegmentationResultOf<MasksStored>>;
export function storeSegmentedMasks(
  deps: StoreMaskDeps,
  input: StoreMaskInput & { source: 'detection' }
): Promise<SegmentationResultOf<MasksStored | MaskUnavailable>>;
export async function storeSegmentedMasks(
  deps: StoreMaskDeps,
  input: StoreMaskInput
): Promise<SegmentationResultOf<MasksStored | MaskUnavailable>> {
  const regions: NewRegion[] = [];
  const attemptedKeys: ObjectKey[] = [];

  for (const mask of input.result.masks) {
    const identity = newRegionMask(deps.idGenerator);
    if (identity.isError()) {
      // oxlint-disable-next-line no-await-in-loop -- stop and clean this batch.
      await discardUnpublishedMasks(deps, attemptedKeys);
      return Result.Error(identity.getError());
    }

    const { id, objectKey } = identity.get();
    attemptedKeys.push(objectKey);
    // oxlint-disable-next-line no-await-in-loop -- a handful of masks per call.
    const stored: SegmentationResultOf<
      ObjectCopyOutcome | ObjectStoredOutcome
    > = await (mask.mask.kind === 'url'
      ? deps.objectStorage.copyFromUrl({
          sourceUrl: mask.mask.url,
          objectKey,
          acceptedContentTypes: ['image/png', 'image/webp'],
          maxBytes: MASK_MAX_BYTES,
          cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
        })
      : deps.objectStorage.putObject({
          objectKey,
          body: mask.mask.bytes,
          contentType: 'image/png',
          cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
        }));
    if (
      stored.isError() &&
      input.source !== 'detection' &&
      stored.getError().code === 'OBJECT_STORAGE_COPY_FAILED'
    ) {
      attemptedKeys.pop();
      continue;
    }
    if (stored.isError()) {
      // A failed upload may have written the destination before losing its response.
      // oxlint-disable-next-line no-await-in-loop -- stop and clean this batch.
      await discardUnpublishedMasks(deps, attemptedKeys);
      return Result.Error(stored.getError());
    }
    const outcome = stored.get();
    if (
      outcome.type === 'copy_source_rejected' ||
      outcome.type === 'copy_source_unavailable'
    ) {
      attemptedKeys.pop();
      deps.logger.warn({
        event: 'segmentation.mask.copy_failed',
        details: { outcome: outcome.type },
      });
      if (input.source === 'detection') {
        // oxlint-disable-next-line no-await-in-loop -- stop and clean this batch.
        await discardUnpublishedMasks(deps, attemptedKeys);
        return Result.Ok({
          type: 'detection_mask_unavailable',
          reason:
            outcome.type === 'copy_source_rejected' &&
            (outcome.reason === 'insecure_url' ||
              outcome.reason === 'too_large')
              ? 'invalid_mask'
              : 'mask_unavailable',
        });
      }
      continue;
    }

    regions.push({
      id,
      designId: input.image.designId,
      imageId: input.image.imageId,
      source: input.source,
      label: input.label,
      maskKey: objectKey,
      box: toFractionalBox(mask.box, input.image),
      score: mask.score,
      isSuggestion: false,
      carriedFromRegionId: null,
    });
  }
  return Result.Ok({ type: 'masks_stored', regions });
}

export const providerCallIdFor = (
  prefix: string,
  ...parts: string[]
): SegmentationResultOf<ProviderCallId> => {
  const id = toProviderCallId([prefix, ...parts].join(':').slice(0, 200));
  if (id.isError()) return Result.Error(id.getError());
  return Result.Ok(id.get());
};

export type { ObjectKey, RegionId };
