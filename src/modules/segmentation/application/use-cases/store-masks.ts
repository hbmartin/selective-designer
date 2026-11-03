import { Result } from '@bloodyowl/boxed';

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

const newRegionId = (deps: Pick<SegmentationPipelineDeps, 'idGenerator'>) => {
  const raw = deps.idGenerator.createId();
  if (raw.isError()) return Result.Error(raw.getError());
  return toRegionId(raw.get());
};

/**
 * Copy each returned mask into owned storage at `region-masks/<regionId>.png`
 * and build the region rows. Masks the provider cannot deliver are skipped.
 */
export async function storeSegmentedMasks(
  deps: Pick<
    SegmentationPipelineDeps,
    'idGenerator' | 'objectStorage' | 'logger'
  >,
  input: {
    image: SegmentableImage;
    result: Extract<SegmentationResult, { type: 'segmented' }>;
    source: RegionSource;
    label: string;
  }
): Promise<SegmentationResultOf<NewRegion[]>> {
  const regions: NewRegion[] = [];
  for (const mask of input.result.masks) {
    const regionId = newRegionId(deps);
    if (regionId.isError()) return Result.Error(regionId.getError());
    const maskKey = toObjectKey(`region-masks/${regionId.get()}.png`);
    if (maskKey.isError()) return Result.Error(maskKey.getError());

    if (mask.mask.kind === 'url') {
      // oxlint-disable-next-line no-await-in-loop -- a handful of masks per call.
      const copied = await deps.objectStorage.copyFromUrl({
        sourceUrl: mask.mask.url,
        objectKey: maskKey.get(),
        acceptedContentTypes: ['image/png', 'image/webp'],
        maxBytes: MASK_MAX_BYTES,
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      });
      if (copied.isError()) return Result.Error(copied.getError());
      if (copied.get().type !== 'object_copied') {
        deps.logger.warn({
          event: 'segmentation.mask.copy_failed',
          details: { outcome: copied.get().type },
        });
        continue;
      }
    } else {
      // oxlint-disable-next-line no-await-in-loop -- a handful of masks per call.
      const stored = await deps.objectStorage.putObject({
        objectKey: maskKey.get(),
        body: mask.mask.bytes,
        contentType: 'image/png',
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      });
      if (stored.isError()) return Result.Error(stored.getError());
    }

    regions.push({
      id: regionId.get(),
      designId: input.image.designId,
      imageId: input.image.imageId,
      source: input.source,
      label: input.label,
      maskKey: maskKey.get(),
      box: toFractionalBox(mask.box, input.image),
      score: mask.score,
      isSuggestion: false,
      carriedFromRegionId: null,
    });
  }
  return Result.Ok(regions);
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
