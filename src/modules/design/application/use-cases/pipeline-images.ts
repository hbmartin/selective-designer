import { Result } from '@bloodyowl/boxed';

import {
  type DesignId,
  type ImageId,
  toImageId,
} from '@/modules/kernel/domain/ids';

import type { DesignPipelineDeps, DesignResult } from './types';
import type {
  ImageAddedOutcome,
  ImageFoundOutcome,
  ImageNotFoundOutcome,
  NewDesignImage,
} from '../ports/design-repository';

/**
 * Pipeline use cases are called from workflow steps that already carry
 * ownership in persisted records; they do not re-check request permissions.
 */
export async function findImageForPipeline(
  deps: DesignPipelineDeps,
  imageId: ImageId
): Promise<DesignResult<ImageFoundOutcome | ImageNotFoundOutcome>> {
  return deps.designRepository.findImage(imageId);
}

export async function addImageForPipeline(
  deps: DesignPipelineDeps,
  input: {
    designId: DesignId;
    image: Omit<NewDesignImage, 'id'>;
  }
): Promise<DesignResult<ImageAddedOutcome>> {
  const raw = deps.idGenerator.createId();
  if (raw.isError()) return Result.Error(raw.getError());
  const id = toImageId(raw.get());
  if (id.isError()) return Result.Error(id.getError());
  return deps.designRepository.addImage({
    designId: input.designId,
    image: { ...input.image, id: id.get() },
  });
}

/** The design's base image id (for copying a revised design). */
export async function baseImageOfDesign(
  deps: DesignPipelineDeps,
  designId: DesignId
): Promise<
  DesignResult<
    { type: 'base_image'; imageId: ImageId } | { type: 'design_not_found' }
  >
> {
  const listed = await deps.designRepository.listImages({
    designId,
    kind: 'base',
  });
  if (listed.isError()) return Result.Error(listed.getError());
  const [image] = listed.get().images;
  return Result.Ok(
    image
      ? { type: 'base_image', imageId: image.id }
      : { type: 'design_not_found' }
  );
}
