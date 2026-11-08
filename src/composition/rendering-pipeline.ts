import { Result } from '@bloodyowl/boxed';

import {
  createDesignPipelineUseCases,
  type DesignRepository,
} from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';
import { getAiProvidersConfig } from '@/modules/kernel/backend';
import {
  type ProviderCallId,
  toItemId,
  toRegionId,
} from '@/modules/kernel/domain/ids';
import { createItemRepository } from '@/modules/moodboard/backend';
import type { RenderingPipelineDeps } from '@/modules/rendering';
import {
  createRenderingPipelineUseCases,
  hasFramingChanged,
  type ImageModelAdapter,
  type ImageModels,
  type MaskCompositor,
  MODEL_CATALOG,
  type ModelId,
  type RenderInputs,
  type RenderRepository,
  type ResultImages,
  type ResultOutputReferences,
} from '@/modules/rendering';
import {
  contentTypeForFormat,
  createBflFlux3Model,
  createFakeImageModel,
  createFalImageModel,
  createPngMaskCompositor,
  createRenderRepository,
  gptImageInput,
  ideogramInput,
  kreaInput,
  readImageDimensions,
} from '@/modules/rendering/backend';
import type { AutoDetectionScheduler } from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';

import { dispatchAccountingReceipt } from './accounting-delivery';
import {
  findRegisteredRenderImage,
  renderImageIdentity,
  writeRenderImageWithDetection,
} from './image-detection-intent';
import { getPipelineKernel, type PipelineKernel } from './pipeline-kernel';
import { createAutoDetectionScheduler } from './segmentation-scheduler';
import { createCachedFactory } from './shared/singleton';

/**
 * Pipeline-only wiring for render workflow steps: JSX-free, no auth, and it
 * must not import the render workflow itself (import cycle).
 */
export type RenderingPipelineOverrides = {
  kernel?: PipelineKernel;
  persistence?: {
    renderRepository: RenderRepository;
    resultImages: ResultImages;
    resultOutputReferences: ResultOutputReferences;
  };
  renderInputs?: RenderInputs;
  maskCompositor?: MaskCompositor;
  imageModels?: ImageModels;
};

type InputsKernel = Pick<
  PipelineKernel,
  'db' | 'objectStorage' | 'idGenerator' | 'logger'
>;

const designPipeline = (kernel: InputsKernel, repository?: DesignRepository) =>
  createDesignPipelineUseCases({
    designRepository: repository ?? createDesignRepository({ db: kernel.db }),
    objectStorage: kernel.objectStorage,
    idGenerator: kernel.idGenerator,
    logger: kernel.logger,
  });

/** Read access to images (design), items (moodboard) and regions (segmentation). */
export const createRenderInputs = (kernel: InputsKernel): RenderInputs => ({
  async sourceImage(imageId) {
    const found = await designPipeline(kernel).findImage(imageId);
    if (found.isError()) return Result.Error(found.getError());
    const outcome = found.get();
    if (outcome.type === 'image_not_found')
      return Result.Ok({ type: 'missing' });
    return Result.Ok({
      type: 'found',
      image: {
        imageId: outcome.image.id,
        designId: outcome.image.designId,
        ownerId: outcome.ownerId,
        workingKey: outcome.image.workingKey,
        width: outcome.image.working.width,
        height: outcome.image.working.height,
      },
    });
  },
  async item(itemId) {
    const id = toItemId(itemId);
    if (id.isError()) return Result.Ok({ type: 'missing' });
    const found = await createItemRepository({ db: kernel.db }).findById(
      id.get()
    );
    if (found.isError()) return Result.Error(found.getError());
    const outcome = found.get();
    if (outcome.type !== 'item_found') return Result.Ok({ type: 'missing' });
    const { item } = outcome;
    const version = item.currentVersion;
    const referenceKey =
      item.kind === 'swatch'
        ? version.photo.key
        : version.cutoutStatus === 'ready'
          ? version.cutoutKey
          : null;
    return Result.Ok({
      type: 'found',
      item: {
        itemId: item.id,
        designId: item.designId,
        itemVersionId: version.id,
        name: item.name,
        kind: item.kind,
        referenceKey,
      },
    });
  },
  async region(regionId) {
    const id = toRegionId(regionId);
    if (id.isError()) return Result.Ok({ type: 'missing' });
    const found = await createRegionRepository({ db: kernel.db }).findById(
      id.get()
    );
    if (found.isError()) return Result.Error(found.getError());
    const outcome = found.get();
    if (outcome.type === 'region_not_found')
      return Result.Ok({ type: 'missing' });
    return Result.Ok({
      type: 'found',
      region: {
        regionId: outcome.region.id,
        imageId: outcome.region.imageId,
        carriedFromRegionId: outcome.region.carriedFromRegionId,
        label: outcome.region.label,
        maskKey: outcome.region.maskKey,
        box: outcome.region.box,
      },
    });
  },
});

/** Copied outputs become design images (native size), then get detection. */
export const createResultImages = (
  kernel: InputsKernel & Pick<PipelineKernel, 'clock'>,
  scheduler: AutoDetectionScheduler = createAutoDetectionScheduler(kernel)
): ResultImages => {
  const dispatch = async (
    input: Parameters<ResultImages['findRegistered']>[0],
    imageId: Parameters<AutoDetectionScheduler['schedule']>[0]['imageId']
  ) => {
    // Historical registrations are already published and may have no intent.
    if (renderImageIdentity(input).imageId !== imageId) return;
    const scheduled = await scheduler.schedule({ imageId });
    if (scheduled.isError())
      kernel.logger.warn({
        event: 'rendering.result.detection_not_scheduled',
        details: { imageId },
      });
  };
  return {
    async findRegistered(input) {
      const found = await findRegisteredRenderImage(kernel, input);
      if (found.isError()) return Result.Error(found.getError());
      const saved = found.get();
      if (saved.type === 'result_image_registered')
        await dispatch(input, saved.imageId);
      return found;
    },
    async register(input) {
      const object = await kernel.objectStorage.getObjectBytes(input.objectKey);
      if (object.isError()) return Result.Error(object.getError());
      const found = object.get();
      if (found.type === 'object_not_found')
        return Result.Ok({ type: 'result_image_unreadable' });
      const dimensions = readImageDimensions(found.bytes);
      if (dimensions.type === 'unreadable')
        return Result.Ok({ type: 'result_image_unreadable' });
      const size = { width: dimensions.width, height: dimensions.height };
      const saved = await writeRenderImageWithDetection(kernel, {
        ...input,
        carryFromImageId: input.renderSourceImageId,
        image: {
          kind: 'result',
          originalKey: input.objectKey,
          originalContentType:
            contentTypeForFormat(dimensions.format) ??
            found.contentType ??
            input.contentType ??
            'application/octet-stream',
          original: size,
          workingKey: input.objectKey,
          working: size,
        },
        completion: {
          ...input.completion,
          completedAt: new Date(input.completion.completedAt),
          framingChanged: hasFramingChanged(size, input.sourceSize),
        },
      });
      if (saved.isError()) return Result.Error(saved.getError());
      const outcome = saved.get();
      if (outcome.type === 'result_image_registered')
        await dispatch(input, outcome.imageId);
      return Result.Ok(outcome);
    },
  };
};

const createLiveAdapter = (
  modelId: ModelId,
  config: ReturnType<typeof getAiProvidersConfig>
): ImageModelAdapter | null => {
  const spec = MODEL_CATALOG[modelId];
  if (spec.provider === 'bfl') {
    return config.bflApiKey
      ? createBflFlux3Model({ apiKey: config.bflApiKey })
      : null;
  }
  if (!config.falKey) return null;
  const buildInput =
    modelId === 'krea-3'
      ? kreaInput
      : modelId === 'ideogram-4-5'
        ? ideogramInput
        : gptImageInput;
  return createFalImageModel({
    falKey: config.falKey,
    endpoint: spec.endpoint,
    buildInput,
  });
};

/** Live adapters when PROVIDER_MODE=live and the key exists, otherwise fakes. */
export const createImageModels = (): ImageModels => {
  const config = getAiProvidersConfig();
  const adapters = new Map<ModelId, ImageModelAdapter>();
  return {
    adapterFor(modelId) {
      let adapter = adapters.get(modelId);
      if (!adapter) {
        adapter =
          (config.mode === 'live'
            ? createLiveAdapter(modelId, config)
            : null) ?? createFakeImageModel({ modelId });
        adapters.set(modelId, adapter);
      }
      return adapter;
    },
  };
};

export const createResultOutputReferences = (
  designs: Pick<DesignRepository, 'referencedImageKeys'>,
  renders: Pick<RenderRepository, 'referencedOutputKeys'>
): ResultOutputReferences => ({
  async check(key) {
    const [images, outputs] = await Promise.all([
      designs.referencedImageKeys([key]),
      renders.referencedOutputKeys([key]),
    ]);
    if (images.isError()) return Result.Error(images.getError());
    if (outputs.isError()) return Result.Error(outputs.getError());
    return Result.Ok({
      type:
        images.get().keys.length || outputs.get().keys.length
          ? 'output_referenced'
          : 'output_unreferenced',
    });
  },
});

const build = (overrides?: RenderingPipelineOverrides) => {
  const kernel = overrides?.kernel ?? getPipelineKernel();
  const renderRepository =
    overrides?.persistence?.renderRepository ??
    createRenderRepository({ clock: kernel.clock, db: kernel.db });
  const deps: RenderingPipelineDeps = {
    renderRepository,
    resultOutputReferences:
      overrides?.persistence?.resultOutputReferences ??
      createResultOutputReferences(
        createDesignRepository({ db: kernel.db }),
        renderRepository
      ),
    renderInputs: overrides?.renderInputs ?? createRenderInputs(kernel),
    maskCompositor:
      overrides?.maskCompositor ??
      createPngMaskCompositor({ objectStorage: kernel.objectStorage }),
    imageModels: overrides?.imageModels ?? createImageModels(),
    resultImages:
      overrides?.persistence?.resultImages ?? createResultImages(kernel),
    objectStorage: kernel.objectStorage,
    providerAccounting: kernel.providerAccounting,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
  };
  const useCases = createRenderingPipelineUseCases(deps);
  return {
    ...useCases,
    dispatchAccounting: (receiptId: ProviderCallId) =>
      dispatchAccountingReceipt({ receiptId, logger: kernel.logger }),
  };
};

const factory = createCachedFactory(build);

export const getRenderingPipelineUseCases = (
  overrides?: RenderingPipelineOverrides
) => factory.get(overrides);

/** Test-only. */
export const __resetRenderingPipelineComposition = () => factory.reset();
