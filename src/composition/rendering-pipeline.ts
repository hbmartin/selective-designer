import { Result } from '@bloodyowl/boxed';

import { createDesignPipelineUseCases } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';
import { getAiProvidersConfig } from '@/modules/kernel/backend';
import { toItemId, toRegionId } from '@/modules/kernel/domain/ids';
import { createItemRepository } from '@/modules/moodboard/backend';
import {
  createRenderingPipelineUseCases,
  type ImageModelAdapter,
  type ImageModels,
  type MaskCompositor,
  MODEL_CATALOG,
  type ModelId,
  type RenderInputs,
  type RenderRepository,
  type ResultImages,
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

import { getPipelineKernel, type PipelineKernel } from './pipeline-kernel';
import { createAutoDetectionScheduler } from './segmentation-scheduler';
import { createCachedFactory } from './shared/singleton';

/**
 * Pipeline-only wiring for render workflow steps: JSX-free, no auth, and it
 * must not import the render workflow itself (import cycle).
 */
export type RenderingPipelineOverrides = {
  kernel?: PipelineKernel;
  renderRepository?: RenderRepository;
  renderInputs?: RenderInputs;
  maskCompositor?: MaskCompositor;
  imageModels?: ImageModels;
  resultImages?: ResultImages;
};

type InputsKernel = Pick<
  PipelineKernel,
  'db' | 'objectStorage' | 'idGenerator' | 'logger'
>;

const designPipeline = (kernel: InputsKernel) =>
  createDesignPipelineUseCases({
    designRepository: createDesignRepository({ db: kernel.db }),
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
): ResultImages => ({
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
    const added = await designPipeline(kernel).addImage({
      designId: input.designId,
      image: {
        kind: 'result',
        originalKey: input.objectKey,
        originalContentType:
          contentTypeForFormat(dimensions.format) ?? input.contentType,
        original: size,
        // Results are shown and edited at their native size.
        workingKey: input.objectKey,
        working: size,
      },
    });
    if (added.isError()) return Result.Error(added.getError());
    const imageId = added.get().image.id;
    const scheduled = await scheduler.schedule({
      imageId,
      carryFromImageId: input.renderSourceImageId,
    });
    if (scheduled.isError()) {
      // Detection is a convenience; a result without it is still a result.
      kernel.logger.warn({
        event: 'rendering.result.detection_not_scheduled',
        details: { imageId },
      });
    }
    return Result.Ok({ type: 'result_image_registered', imageId, ...size });
  },
});

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

const build = (overrides?: RenderingPipelineOverrides) => {
  const kernel = overrides?.kernel ?? getPipelineKernel();
  return createRenderingPipelineUseCases({
    renderRepository:
      overrides?.renderRepository ?? createRenderRepository({ db: kernel.db }),
    renderInputs: overrides?.renderInputs ?? createRenderInputs(kernel),
    maskCompositor:
      overrides?.maskCompositor ??
      createPngMaskCompositor({ objectStorage: kernel.objectStorage }),
    imageModels: overrides?.imageModels ?? createImageModels(),
    resultImages: overrides?.resultImages ?? createResultImages(kernel),
    objectStorage: kernel.objectStorage,
    providerCallLog: kernel.providerCallLog,
    idGenerator: kernel.idGenerator,
    clock: kernel.clock,
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(build);

export const getRenderingPipelineUseCases = (
  overrides?: RenderingPipelineOverrides
) => factory.get(overrides);

/** Test-only. */
export const __resetRenderingPipelineComposition = () => factory.reset();
