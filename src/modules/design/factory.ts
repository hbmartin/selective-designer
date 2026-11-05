import { createDesign } from './application/use-cases/create-design';
import { getDesign } from './application/use-cases/get-design';
import { getImageDownloadUrl } from './application/use-cases/image-access';
import { listDesigns } from './application/use-cases/list-designs';
import {
  baseImageOfDesign,
  findImageForPipeline,
} from './application/use-cases/pipeline-images';
import { prepareDesignUpload } from './application/use-cases/prepare-design-upload';
import {
  addSourcePhoto,
  listSourcePhotos,
} from './application/use-cases/source-photos';
import type {
  DesignPipelineDeps,
  DesignUseCaseDeps,
} from './application/use-cases/types';
import { updateDesign } from './application/use-cases/update-design';

type Input<TFn extends (deps: never, input: never) => unknown> =
  Parameters<TFn>[1];

export function createDesignUseCases(deps: DesignUseCaseDeps) {
  return {
    list: (input: Input<typeof listDesigns>) => listDesigns(deps, input),
    get: (input: Input<typeof getDesign>) => getDesign(deps, input),
    create: (input: Input<typeof createDesign>) => createDesign(deps, input),
    update: (input: Input<typeof updateDesign>) => updateDesign(deps, input),
    prepareUpload: (input: Input<typeof prepareDesignUpload>) =>
      prepareDesignUpload(deps, input),
    getImageDownloadUrl: (input: Input<typeof getImageDownloadUrl>) =>
      getImageDownloadUrl(deps, input),
    listSourcePhotos: (input: Input<typeof listSourcePhotos>) =>
      listSourcePhotos(deps, input),
    addSourcePhoto: (input: Input<typeof addSourcePhoto>) =>
      addSourcePhoto(deps, input),
  };
}

export type DesignUseCases = ReturnType<typeof createDesignUseCases>;

/** Use cases for workflow steps; see `pipeline-images.ts`. */
export function createDesignPipelineUseCases(deps: DesignPipelineDeps) {
  return {
    findImage: (imageId: Input<typeof findImageForPipeline>) =>
      findImageForPipeline(deps, imageId),
    baseImageOf: (designId: Input<typeof baseImageOfDesign>) =>
      baseImageOfDesign(deps, designId),
    findOwner: (
      designId: Parameters<
        DesignPipelineDeps['designRepository']['findOwner']
      >[0]
    ) => deps.designRepository.findOwner(designId),
  };
}

export type DesignPipelineUseCases = ReturnType<
  typeof createDesignPipelineUseCases
>;
