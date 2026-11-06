import { Result } from '@bloodyowl/boxed';

import type {
  ObjectCopyNewOutcome,
  ObjectCreateOutcome,
} from '@/modules/kernel/application/ports/object-storage';
import { ObjectCopySourceError } from '@/modules/kernel/application/ports/object-storage';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { sourceErrorDiagnostics } from '@/modules/kernel/domain/errors/source-error-diagnostics';
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
  'objectStorage' | 'logger' | 'regionRepository'
>;

export async function discardUnpublishedMasks(
  deps: MaskStorageDeps,
  keys: readonly ObjectKey[]
) {
  if (keys.length === 0) return;
  const checked = await deps.regionRepository.unreferencedMaskKeys(keys);
  if (checked.isError()) {
    deps.logger.warn({
      event: 'segmentation.mask.cleanup_check_failed',
      details: { code: checked.getError().code },
    });
    return;
  }
  await Promise.all(
    checked.get().keys.map(async (objectKey) => {
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
  const createdKeys: ObjectKey[] = [];
  let sourceError: ObjectCopySourceError | undefined;

  for (const mask of input.result.masks) {
    const identity = newRegionMask(deps.idGenerator);
    if (identity.isError()) {
      // oxlint-disable-next-line no-await-in-loop -- stop and clean this batch.
      await discardUnpublishedMasks(deps, createdKeys);
      return Result.Error(identity.getError());
    }

    const { id, objectKey } = identity.get();
    // oxlint-disable-next-line no-await-in-loop -- a handful of masks per call.
    const stored: SegmentationResultOf<
      ObjectCopyNewOutcome | ObjectCreateOutcome
    > = await (mask.mask.kind === 'url'
      ? deps.objectStorage.copyNewObjectFromUrl({
          sourceUrl: mask.mask.url,
          objectKey,
          acceptedContentTypes: ['image/png', 'image/webp'],
          maxBytes: MASK_MAX_BYTES,
          cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
        })
      : deps.objectStorage.createObject({
          objectKey,
          body: mask.mask.bytes,
          contentType: 'image/png',
          cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
        }));
    if (stored.isError()) {
      const error = stored.getError();
      // An uncertain destination is not ours to delete. Earlier confirmed creations are.
      deps.logger.warn({
        event: 'segmentation.mask.storage_failed',
        details: {
          imageId: input.image.imageId,
          source: input.source,
          objectKey,
          code: stored.getError().code,
          status:
            error instanceof ObjectCopySourceError
              ? error.sourceStatus
              : error.status,
          ...sourceErrorDiagnostics(error),
        },
      });
      if (
        error instanceof ObjectCopySourceError &&
        input.source !== 'detection'
      ) {
        sourceError ??= error;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- stop and clean this batch.
      await discardUnpublishedMasks(deps, createdKeys);
      return Result.Error(stored.getError());
    }
    const outcome = stored.get();
    if (outcome.type === 'object_already_exists') {
      deps.logger.warn({
        event: 'segmentation.mask.key_collision',
        details: { imageId: input.image.imageId, objectKey },
      });
      // oxlint-disable-next-line no-await-in-loop -- stop and clean this batch.
      await discardUnpublishedMasks(deps, createdKeys);
      return Result.Error(
        new AppError({
          code: 'MASK_KEY_COLLISION',
          category: 'system',
          status: 500,
          message: 'Could not create a fresh region mask',
        })
      );
    }
    if (
      outcome.type === 'copy_source_rejected' ||
      outcome.type === 'copy_source_unavailable'
    ) {
      deps.logger.warn({
        event: 'segmentation.mask.copy_failed',
        details: {
          imageId: input.image.imageId,
          source: input.source,
          outcome: outcome.type,
          ...(outcome.type === 'copy_source_rejected'
            ? { reason: outcome.reason }
            : {
                status: outcome.status,
                reason: 'http',
              }),
        },
      });
      if (input.source === 'detection') {
        // oxlint-disable-next-line no-await-in-loop -- stop and clean this batch.
        await discardUnpublishedMasks(deps, createdKeys);
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

    createdKeys.push(objectKey);
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
  if (regions.length === 0 && sourceError) return Result.Error(sourceError);
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
