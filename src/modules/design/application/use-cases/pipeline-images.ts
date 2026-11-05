import { Result } from '@bloodyowl/boxed';

import { type DesignId, type ImageId } from '@/modules/kernel/domain/ids';

import type { DesignPipelineDeps, DesignResult } from './types';
import type {
  ImageFoundOutcome,
  ImageNotFoundOutcome,
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
